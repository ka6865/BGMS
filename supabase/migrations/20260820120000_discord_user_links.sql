-- Discord User Links table
create table if not exists public.discord_user_links (
  discord_user_id text primary key,
  pubg_nickname text not null,
  pubg_platform text not null default 'steam',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists discord_user_links_nickname_idx
  on public.discord_user_links (pubg_platform, lower(btrim(pubg_nickname)));

alter table public.discord_user_links enable row level security;

-- Only service_role can read and write
drop policy if exists discord_user_links_service_role_all on public.discord_user_links;
create policy discord_user_links_service_role_all
  on public.discord_user_links
  to service_role
  using (true)
  with check (true);

