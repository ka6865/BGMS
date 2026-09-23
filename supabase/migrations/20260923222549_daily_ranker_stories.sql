-- One evidence-checked public story per KST match day. Service workers are
-- the only writers; published prose is read through the server-side page.
create table if not exists public.daily_ranker_stories (
  day_kst date primary key,
  platform text not null check (platform = 'steam'),
  match_id text not null unique,
  account_id text not null check (account_id ~ '^account\.[A-Za-z0-9_-]+$'),
  nickname text not null,
  mode text not null check (mode in ('solo','squad')),
  map_name text not null,
  leaderboard_rank integer not null check (leaderboard_rank > 0),
  played_at timestamptz not null,
  kills integer not null check (kills >= 0),
  damage integer not null check (damage >= 0),
  team_kills integer not null check (team_kills >= 0),
  story jsonb not null,
  evidence jsonb not null,
  model text not null,
  prompt_version text not null,
  created_at timestamptz not null default now(),
  published_at timestamptz not null default now(),
  constraint daily_ranker_stories_story_object check (jsonb_typeof(story) = 'object'),
  constraint daily_ranker_stories_evidence_object check (jsonb_typeof(evidence) = 'object')
);

alter table public.daily_ranker_stories enable row level security;
revoke all on public.daily_ranker_stories from public, anon, authenticated;
grant select, insert on public.daily_ranker_stories to service_role;
create index if not exists daily_ranker_stories_published_at_idx
  on public.daily_ranker_stories (published_at desc);
