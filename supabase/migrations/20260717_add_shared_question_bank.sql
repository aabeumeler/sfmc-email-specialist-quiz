-- Shared question-bank changes. The app's bundled questions remain the base bank;
-- administrator edits/additions and deletion tombstones are applied over that base.

create table if not exists public.quiz_question_bank_changes (
  id text primary key,
  question jsonb,
  is_deleted boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint quiz_question_bank_changes_payload_check check (
    (is_deleted and question is null)
    or
    (not is_deleted and jsonb_typeof(question) = 'object')
  )
);

alter table public.quiz_question_bank_changes enable row level security;
revoke all on public.quiz_question_bank_changes from anon, authenticated;

create or replace function public.get_quiz_question_bank_changes()
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce(
    jsonb_agg(
      jsonb_build_object(
        'id', change.id,
        'deleted', change.is_deleted,
        'question', change.question,
        'updatedAt', change.updated_at
      )
      order by change.updated_at, change.id
    ),
    '[]'::jsonb
  )
  from public.quiz_question_bank_changes change;
$$;

create or replace function public.admin_upsert_quiz_question(p_question jsonb)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_id text;
  v_test text;
  v_number integer;
  v_text text;
  v_explanation text;
  v_options jsonb;
  v_correct_indexes jsonb;
  v_option_count integer;
  v_correct_count integer;
  v_question jsonb;
begin
  if not private.is_quiz_admin() then raise exception 'Admin access denied'; end if;
  if jsonb_typeof(p_question) is distinct from 'object' then raise exception 'Question data is invalid'; end if;

  v_id := left(coalesce(nullif(btrim(p_question->>'id'), ''), 'admin-' || replace(gen_random_uuid()::text, '-', '')), 180);
  v_test := left(btrim(coalesce(p_question->>'test', '')), 100);
  v_text := left(btrim(coalesce(p_question->>'question', '')), 4000);
  v_explanation := left(btrim(coalesce(p_question->>'explanation', '')), 8000);

  if v_test = '' then raise exception 'A category or test name is required'; end if;
  if coalesce(p_question->>'number', '') !~ '^[1-9][0-9]{0,5}$' then raise exception 'A valid question number is required'; end if;
  v_number := (p_question->>'number')::integer;
  if v_text = '' then raise exception 'Question text is required'; end if;
  if v_explanation = '' then raise exception 'An explanation is required'; end if;
  if jsonb_typeof(p_question->'options') is distinct from 'array' then raise exception 'Answer choices are required'; end if;

  select
    jsonb_agg(
      jsonb_build_object(
        'text', left(btrim(coalesce(option.value->>'text', '')), 2000),
        'correct', coalesce((option.value->>'correct')::boolean, false)
      )
      order by option.ordinality
    ),
    count(*)::integer,
    count(*) filter (where coalesce((option.value->>'correct')::boolean, false))::integer
  into v_options, v_option_count, v_correct_count
  from jsonb_array_elements(p_question->'options') with ordinality option(value, ordinality);

  if v_option_count < 2 or v_option_count > 8 then raise exception 'Use between 2 and 8 answer choices'; end if;
  if exists (
    select 1
    from jsonb_array_elements(v_options) option(value)
    where btrim(coalesce(option.value->>'text', '')) = ''
  ) then raise exception 'Every answer choice needs text'; end if;
  if v_correct_count < 1 then raise exception 'Select at least one correct answer'; end if;
  if v_correct_count = v_option_count then raise exception 'At least one answer choice must be incorrect'; end if;

  select coalesce(jsonb_agg(option.ordinality - 1 order by option.ordinality), '[]'::jsonb)
  into v_correct_indexes
  from jsonb_array_elements(v_options) with ordinality option(value, ordinality)
  where coalesce((option.value->>'correct')::boolean, false);

  v_question := jsonb_build_object(
    'id', v_id,
    'test', v_test,
    'number', v_number,
    'question', v_text,
    'options', v_options,
    'correctIndexes', v_correct_indexes,
    'multi', v_correct_count > 1,
    'explanation', v_explanation
  );

  insert into public.quiz_question_bank_changes(id, question, is_deleted, updated_at)
  values (v_id, v_question, false, now())
  on conflict (id) do update
  set question = excluded.question,
      is_deleted = false,
      updated_at = excluded.updated_at;

  return v_question;
end;
$$;

create or replace function public.admin_delete_quiz_question(p_question_id text)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare v_id text := left(btrim(coalesce(p_question_id, '')), 180);
begin
  if not private.is_quiz_admin() then raise exception 'Admin access denied'; end if;
  if v_id = '' then raise exception 'Question ID is required'; end if;

  insert into public.quiz_question_bank_changes(id, question, is_deleted, updated_at)
  values (v_id, null, true, now())
  on conflict (id) do update
  set question = null,
      is_deleted = true,
      updated_at = excluded.updated_at;
  return true;
end;
$$;

revoke all on function public.get_quiz_question_bank_changes() from public;
revoke all on function public.admin_upsert_quiz_question(jsonb) from public;
revoke all on function public.admin_delete_quiz_question(text) from public;

grant execute on function public.get_quiz_question_bank_changes() to anon, authenticated;
grant execute on function public.admin_upsert_quiz_question(jsonb) to authenticated;
grant execute on function public.admin_delete_quiz_question(text) to authenticated;
