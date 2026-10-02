-- Keep existing rows and the existing match_id unique constraint while allowing
-- one story per competitive mode and KST date.
alter table public.daily_ranker_stories
  drop constraint if exists daily_ranker_stories_mode_check;
alter table public.daily_ranker_stories
  add constraint daily_ranker_stories_mode_check check (mode in ('solo', 'duo', 'squad'));

do $$
declare
  primary_key_name text;
begin
  select conname into primary_key_name
  from pg_constraint
  where conrelid = 'public.daily_ranker_stories'::regclass
    and contype = 'p'
    and pg_get_constraintdef(oid) <> 'PRIMARY KEY (day_kst, mode)';

  if primary_key_name is not null then
    execute format('alter table public.daily_ranker_stories drop constraint %I', primary_key_name);
  end if;

  if not exists (
    select 1 from pg_constraint
    where conrelid = 'public.daily_ranker_stories'::regclass
      and contype = 'p'
      and pg_get_constraintdef(oid) = 'PRIMARY KEY (day_kst, mode)'
  ) then
    alter table public.daily_ranker_stories
      add constraint daily_ranker_stories_pkey primary key (day_kst, mode);
  end if;
end
$$;

alter table public.daily_ranker_stories enable row level security;
revoke all on public.daily_ranker_stories from public, anon, authenticated;
grant select, insert on public.daily_ranker_stories to service_role;
