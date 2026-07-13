-- SFMC quiz private device sync and consent-gated analytics.
-- Run this file in the Supabase SQL editor after creating the project.

create extension if not exists pgcrypto;
create schema if not exists private;

create table if not exists public.quiz_profiles (
  id uuid primary key default gen_random_uuid(),
  join_token_hash text not null,
  analytics_consent boolean not null default false,
  stats_generation bigint not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.quiz_profile_devices (
  profile_id uuid not null references public.quiz_profiles(id) on delete cascade,
  auth_user_id uuid not null references auth.users(id) on delete cascade,
  device_id text not null,
  device_class text not null default 'unknown',
  quiz_count integer not null default 0 check (quiz_count >= 0),
  first_seen_at timestamptz not null default now(),
  last_seen_at timestamptz not null default now(),
  primary key (profile_id, device_id),
  unique (auth_user_id)
);

create table if not exists public.quiz_device_sync (
  profile_id uuid not null,
  device_id text not null,
  encrypted_payload text not null,
  updated_at timestamptz not null default now(),
  primary key (profile_id, device_id),
  foreign key (profile_id, device_id)
    references public.quiz_profile_devices(profile_id, device_id)
    on delete cascade
);

create table if not exists public.quiz_profile_settings (
  profile_id uuid primary key references public.quiz_profiles(id) on delete cascade,
  encrypted_payload text not null,
  updated_at timestamptz not null default now()
);

create table if not exists public.quiz_analytics_profiles (
  profile_id uuid primary key references public.quiz_profiles(id) on delete cascade,
  stats jsonb not null,
  updated_at timestamptz not null default now()
);

create table if not exists public.quiz_device_locations (
  profile_id uuid not null,
  device_id text not null,
  country_code text,
  region_code text,
  region_name text,
  updated_at timestamptz not null default now(),
  primary key (profile_id, device_id),
  foreign key (profile_id, device_id)
    references public.quiz_profile_devices(profile_id, device_id)
    on delete cascade
);

create table if not exists public.quiz_admins (
  user_id uuid primary key references auth.users(id) on delete cascade,
  created_at timestamptz not null default now()
);

alter table public.quiz_profiles enable row level security;
alter table public.quiz_profile_devices enable row level security;
alter table public.quiz_device_sync enable row level security;
alter table public.quiz_profile_settings enable row level security;
alter table public.quiz_analytics_profiles enable row level security;
alter table public.quiz_device_locations enable row level security;
alter table public.quiz_admins enable row level security;

revoke all on public.quiz_profiles from anon, authenticated;
revoke all on public.quiz_profile_devices from anon, authenticated;
revoke all on public.quiz_device_sync from anon, authenticated;
revoke all on public.quiz_profile_settings from anon, authenticated;
revoke all on public.quiz_analytics_profiles from anon, authenticated;
revoke all on public.quiz_device_locations from anon, authenticated;
revoke all on public.quiz_admins from anon, authenticated;

create or replace function private.is_quiz_member(p_profile_id uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1
    from public.quiz_profile_devices d
    where d.profile_id = p_profile_id
      and d.auth_user_id = (select auth.uid())
  );
$$;

create or replace function private.is_quiz_admin()
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1
    from public.quiz_admins a
    where a.user_id = (select auth.uid())
  );
$$;

revoke all on function private.is_quiz_member(uuid) from public;
revoke all on function private.is_quiz_admin() from public;

create or replace function public.create_quiz_profile(
  p_join_token_hash text,
  p_device_id text,
  p_device_class text
)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_profile_id uuid;
begin
  if auth.uid() is null then raise exception 'Authentication required'; end if;
  if length(coalesce(p_join_token_hash, '')) <> 64 then raise exception 'Invalid pairing token'; end if;
  if length(coalesce(p_device_id, '')) not between 8 and 128 then raise exception 'Invalid device identifier'; end if;

  insert into public.quiz_profiles(join_token_hash)
  values (lower(p_join_token_hash))
  returning id into v_profile_id;

  insert into public.quiz_profile_devices(profile_id, auth_user_id, device_id, device_class)
  values (v_profile_id, auth.uid(), p_device_id, left(coalesce(p_device_class, 'unknown'), 20));

  return v_profile_id;
end;
$$;

create or replace function public.join_quiz_profile(
  p_profile_id uuid,
  p_join_token_hash text,
  p_device_id text,
  p_device_class text
)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_old_profile uuid;
  v_expected_hash text;
begin
  if auth.uid() is null then raise exception 'Authentication required'; end if;
  if length(coalesce(p_device_id, '')) not between 8 and 128 then raise exception 'Invalid device identifier'; end if;
  select p.join_token_hash into v_expected_hash
  from public.quiz_profiles p
  where p.id = p_profile_id
  for update;

  if v_expected_hash is null or v_expected_hash <> lower(coalesce(p_join_token_hash, '')) then
    return false;
  end if;

  select d.profile_id into v_old_profile
  from public.quiz_profile_devices d
  where d.auth_user_id = auth.uid();

  delete from public.quiz_profile_devices where auth_user_id = auth.uid();
  insert into public.quiz_profile_devices(profile_id, auth_user_id, device_id, device_class)
  values (p_profile_id, auth.uid(), p_device_id, left(coalesce(p_device_class, 'unknown'), 20));

  if v_old_profile is not null and v_old_profile <> p_profile_id
     and not exists (select 1 from public.quiz_profile_devices where profile_id = v_old_profile) then
    delete from public.quiz_profiles where id = v_old_profile;
  end if;
  return true;
end;
$$;

create or replace function public.rotate_quiz_pairing_token(p_profile_id uuid, p_join_token_hash text)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
begin
  if not private.is_quiz_member(p_profile_id) then raise exception 'Access denied'; end if;
  if length(coalesce(p_join_token_hash, '')) <> 64 then raise exception 'Invalid pairing token'; end if;
  update public.quiz_profiles
  set join_token_hash = lower(p_join_token_hash), updated_at = now()
  where id = p_profile_id;
  return found;
end;
$$;

create or replace function public.get_quiz_profile_status(p_profile_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_result jsonb;
begin
  if not private.is_quiz_member(p_profile_id) then raise exception 'Access denied'; end if;
  select jsonb_build_object(
    'analytics_consent', p.analytics_consent,
    'stats_generation', p.stats_generation
  ) into v_result
  from public.quiz_profiles p
  where p.id = p_profile_id;
  return coalesce(v_result, '{}'::jsonb);
end;
$$;

create or replace function public.upsert_quiz_device_sync(
  p_profile_id uuid,
  p_device_id text,
  p_encrypted_payload text,
  p_quiz_count integer,
  p_device_class text
)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
begin
  if not exists (
    select 1 from public.quiz_profile_devices d
    where d.profile_id = p_profile_id
      and d.device_id = p_device_id
      and d.auth_user_id = auth.uid()
  ) then raise exception 'Access denied'; end if;
  if octet_length(coalesce(p_encrypted_payload, '')) > 4000000 then raise exception 'Sync record is too large'; end if;

  update public.quiz_profile_devices
  set quiz_count = greatest(0, coalesce(p_quiz_count, 0)),
      device_class = left(coalesce(p_device_class, 'unknown'), 20),
      last_seen_at = now()
  where profile_id = p_profile_id and device_id = p_device_id;

  insert into public.quiz_device_sync(profile_id, device_id, encrypted_payload, updated_at)
  values (p_profile_id, p_device_id, p_encrypted_payload, now())
  on conflict (profile_id, device_id) do update
  set encrypted_payload = excluded.encrypted_payload,
      updated_at = excluded.updated_at;
  return true;
end;
$$;

create or replace function public.get_quiz_profile_sync(p_profile_id uuid)
returns table(device_id text, encrypted_payload text, updated_at timestamptz)
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  if not private.is_quiz_member(p_profile_id) then raise exception 'Access denied'; end if;
  return query
  select s.device_id, s.encrypted_payload, s.updated_at
  from public.quiz_device_sync s
  where s.profile_id = p_profile_id
  order by s.updated_at;
end;
$$;

create or replace function public.upsert_quiz_profile_settings(p_profile_id uuid, p_encrypted_payload text)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
begin
  if not private.is_quiz_member(p_profile_id) then raise exception 'Access denied'; end if;
  if octet_length(coalesce(p_encrypted_payload, '')) > 20000 then raise exception 'Settings record is too large'; end if;
  insert into public.quiz_profile_settings(profile_id, encrypted_payload, updated_at)
  values (p_profile_id, p_encrypted_payload, now())
  on conflict (profile_id) do update
  set encrypted_payload = excluded.encrypted_payload,
      updated_at = excluded.updated_at;
  return true;
end;
$$;

create or replace function public.get_quiz_profile_settings(p_profile_id uuid)
returns table(encrypted_payload text, updated_at timestamptz)
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  if not private.is_quiz_member(p_profile_id) then raise exception 'Access denied'; end if;
  return query
  select s.encrypted_payload, s.updated_at
  from public.quiz_profile_settings s
  where s.profile_id = p_profile_id;
end;
$$;

create or replace function public.get_quiz_analytics_consent(p_profile_id uuid)
returns boolean
language plpgsql
stable
security definer
set search_path = ''
as $$
declare v_enabled boolean;
begin
  if not private.is_quiz_member(p_profile_id) then raise exception 'Access denied'; end if;
  select analytics_consent into v_enabled from public.quiz_profiles where id = p_profile_id;
  return coalesce(v_enabled, false);
end;
$$;

create or replace function public.set_quiz_analytics_consent(p_profile_id uuid, p_enabled boolean)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
begin
  if not private.is_quiz_member(p_profile_id) then raise exception 'Access denied'; end if;
  update public.quiz_profiles
  set analytics_consent = coalesce(p_enabled, false), updated_at = now()
  where id = p_profile_id;
  if not coalesce(p_enabled, false) then
    delete from public.quiz_analytics_profiles where profile_id = p_profile_id;
    delete from public.quiz_device_locations where profile_id = p_profile_id;
  end if;
  return coalesce(p_enabled, false);
end;
$$;

create or replace function public.upsert_quiz_analytics(p_profile_id uuid, p_stats jsonb)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
begin
  if not private.is_quiz_member(p_profile_id) then raise exception 'Access denied'; end if;
  if not exists (select 1 from public.quiz_profiles where id = p_profile_id and analytics_consent) then
    raise exception 'Analytics consent is off';
  end if;
  if pg_column_size(coalesce(p_stats, '{}'::jsonb)) > 4000000 then raise exception 'Analytics record is too large'; end if;
  insert into public.quiz_analytics_profiles(profile_id, stats, updated_at)
  values (p_profile_id, coalesce(p_stats, '{}'::jsonb), now())
  on conflict (profile_id) do update
  set stats = excluded.stats, updated_at = excluded.updated_at;
  return true;
end;
$$;

create or replace function public.upsert_quiz_device_location(
  p_profile_id uuid,
  p_device_id text,
  p_country_code text,
  p_region_code text,
  p_region_name text
)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
begin
  if not exists (
    select 1 from public.quiz_profile_devices d
    join public.quiz_profiles p on p.id = d.profile_id
    where d.profile_id = p_profile_id
      and d.device_id = p_device_id
      and d.auth_user_id = auth.uid()
      and p.analytics_consent
  ) then raise exception 'Access denied'; end if;
  insert into public.quiz_device_locations(profile_id, device_id, country_code, region_code, region_name, updated_at)
  values (
    p_profile_id,
    p_device_id,
    nullif(left(upper(coalesce(p_country_code, '')), 2), ''),
    nullif(left(upper(coalesce(p_region_code, '')), 12), ''),
    nullif(left(coalesce(p_region_name, ''), 80), ''),
    now()
  )
  on conflict (profile_id, device_id) do update
  set country_code = coalesce(excluded.country_code, public.quiz_device_locations.country_code),
      region_code = coalesce(excluded.region_code, public.quiz_device_locations.region_code),
      region_name = coalesce(excluded.region_name, public.quiz_device_locations.region_name),
      updated_at = excluded.updated_at;
  return true;
end;
$$;

create or replace function public.reset_quiz_profile_stats(p_profile_id uuid)
returns bigint
language plpgsql
security definer
set search_path = ''
as $$
declare v_generation bigint;
begin
  if not private.is_quiz_member(p_profile_id) then raise exception 'Access denied'; end if;
  update public.quiz_profiles
  set stats_generation = stats_generation + 1, updated_at = now()
  where id = p_profile_id
  returning stats_generation into v_generation;
  delete from public.quiz_device_sync where profile_id = p_profile_id;
  update public.quiz_profile_devices set quiz_count = 0 where profile_id = p_profile_id;
  delete from public.quiz_analytics_profiles where profile_id = p_profile_id;
  delete from public.quiz_device_locations where profile_id = p_profile_id;
  return v_generation;
end;
$$;

create or replace function public.admin_quiz_snapshot()
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare v_result jsonb;
begin
  if not private.is_quiz_admin() then raise exception 'Admin access denied'; end if;
  select coalesce(jsonb_agg(
    jsonb_build_object(
      'profileId', p.id,
      'label', 'Player-' || upper(substr(replace(p.id::text, '-', ''), 1, 6)),
      'createdAt', p.created_at,
      'updatedAt', a.updated_at,
      'stats', a.stats,
      'devices', coalesce((
        select jsonb_agg(jsonb_build_object(
          'deviceId', d.device_id,
          'deviceClass', d.device_class,
          'quizCount', d.quiz_count,
          'firstSeenAt', d.first_seen_at,
          'lastSeenAt', d.last_seen_at,
          'countryCode', l.country_code,
          'regionCode', l.region_code,
          'regionName', l.region_name,
          'locationUpdatedAt', l.updated_at
        ) order by d.first_seen_at)
        from public.quiz_profile_devices d
        left join public.quiz_device_locations l
          on l.profile_id = d.profile_id and l.device_id = d.device_id
        where d.profile_id = p.id
      ), '[]'::jsonb)
    ) order by a.updated_at desc
  ), '[]'::jsonb) into v_result
  from public.quiz_profiles p
  join public.quiz_analytics_profiles a on a.profile_id = p.id
  where p.analytics_consent;
  return v_result;
end;
$$;

revoke all on function public.create_quiz_profile(text, text, text) from public;
revoke all on function public.join_quiz_profile(uuid, text, text, text) from public;
revoke all on function public.rotate_quiz_pairing_token(uuid, text) from public;
revoke all on function public.get_quiz_profile_status(uuid) from public;
revoke all on function public.upsert_quiz_device_sync(uuid, text, text, integer, text) from public;
revoke all on function public.get_quiz_profile_sync(uuid) from public;
revoke all on function public.upsert_quiz_profile_settings(uuid, text) from public;
revoke all on function public.get_quiz_profile_settings(uuid) from public;
revoke all on function public.get_quiz_analytics_consent(uuid) from public;
revoke all on function public.set_quiz_analytics_consent(uuid, boolean) from public;
revoke all on function public.upsert_quiz_analytics(uuid, jsonb) from public;
revoke all on function public.upsert_quiz_device_location(uuid, text, text, text, text) from public;
revoke all on function public.reset_quiz_profile_stats(uuid) from public;
revoke all on function public.admin_quiz_snapshot() from public;

grant execute on function public.create_quiz_profile(text, text, text) to authenticated;
grant execute on function public.join_quiz_profile(uuid, text, text, text) to authenticated;
grant execute on function public.rotate_quiz_pairing_token(uuid, text) to authenticated;
grant execute on function public.get_quiz_profile_status(uuid) to authenticated;
grant execute on function public.upsert_quiz_device_sync(uuid, text, text, integer, text) to authenticated;
grant execute on function public.get_quiz_profile_sync(uuid) to authenticated;
grant execute on function public.upsert_quiz_profile_settings(uuid, text) to authenticated;
grant execute on function public.get_quiz_profile_settings(uuid) to authenticated;
grant execute on function public.get_quiz_analytics_consent(uuid) to authenticated;
grant execute on function public.set_quiz_analytics_consent(uuid, boolean) to authenticated;
grant execute on function public.upsert_quiz_analytics(uuid, jsonb) to authenticated;
grant execute on function public.upsert_quiz_device_location(uuid, text, text, text, text) to authenticated;
grant execute on function public.reset_quiz_profile_stats(uuid) to authenticated;
grant execute on function public.admin_quiz_snapshot() to authenticated;

create index if not exists quiz_profile_devices_profile_idx on public.quiz_profile_devices(profile_id);
create index if not exists quiz_profile_devices_active_idx on public.quiz_profile_devices(profile_id, quiz_count);
create index if not exists quiz_analytics_profiles_updated_idx on public.quiz_analytics_profiles(updated_at desc);
