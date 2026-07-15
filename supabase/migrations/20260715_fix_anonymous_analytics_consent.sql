-- Decouple stopping future analytics sharing from deleting previously shared data.

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
  return coalesce(p_enabled, false);
end;
$$;

create or replace function public.delete_quiz_analytics_history(p_profile_id uuid)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
begin
  if not private.is_quiz_member(p_profile_id) then raise exception 'Access denied'; end if;
  delete from public.quiz_analytics_profiles where profile_id = p_profile_id;
  delete from public.quiz_device_locations where profile_id = p_profile_id;
  return true;
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
  join public.quiz_analytics_profiles a on a.profile_id = p.id;
  return v_result;
end;
$$;

revoke all on function public.delete_quiz_analytics_history(uuid) from public;
grant execute on function public.delete_quiz_analytics_history(uuid) to authenticated;
