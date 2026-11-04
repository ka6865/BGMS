-- 공식 원본은 기존 게임 계산 데이터와 분리해 출처와 함께 보관한다.
create table public.official_game_catalog (
  category text primary key check (category in ('weapons', 'vehicles')),
  source_url text not null,
  fetched_at timestamptz not null default now(),
  items jsonb not null check (jsonb_typeof(items) = 'array')
);

alter table public.official_game_catalog enable row level security;
revoke all on public.official_game_catalog from public, anon, authenticated;
grant select on public.official_game_catalog to anon, authenticated;
grant all on public.official_game_catalog to service_role;
create policy "official_game_catalog_public_read" on public.official_game_catalog
  for select to anon, authenticated using (true);
