begin;
set local lock_timeout = '2s';

-- 명단 순위 게시본. 공개 화면은 서버가 이 표를 읽어 표시 행만 만든다. 키(HMAC)와 PUUID는 넣지 않는다.
create table public.lol_ranking_publication (
  board text primary key check (board = 'solo_apex'),
  payload jsonb not null check (jsonb_typeof(payload) = 'array' and jsonb_array_length(payload) between 0 and 1000),
  player_count integer not null check (player_count between 0 and 1000),
  observed_at timestamptz not null,
  check (pg_column_size(payload) <= 2097152)
);
alter table public.lol_ranking_publication enable row level security;
revoke all on public.lol_ranking_publication from public, anon, authenticated;
grant select, insert, update, delete on public.lol_ranking_publication to service_role;

-- 장인 게시본(D안). 챔피언마다 자격자 상위 50명을 둔다. 공개 행에는 키가 없다.
create table public.lol_master_publication (
  champion_id integer primary key check (champion_id between 1 and 100000),
  season_key text not null check (season_key ~ '^\d{4}-\d{2}-\d{2}$'),
  coverage integer not null check (coverage between 0 and 100),
  player_count integer not null check (player_count between 0 and 100000),
  eligible_count integer not null check (eligible_count between 0 and 100000),
  rows jsonb not null check (jsonb_typeof(rows) = 'array' and jsonb_array_length(rows) between 0 and 50),
  observed_at timestamptz not null
);
alter table public.lol_master_publication enable row level security;
revoke all on public.lol_master_publication from public, anon, authenticated;
grant select, insert, update, delete on public.lol_master_publication to service_role;

-- 삭제 요청 계정의 Riot ID HMAC. 다음 수집에서 다시 들어오지 않는다.
create table public.lol_ranking_exclusions (
  riot_id_hmac text primary key check (riot_id_hmac ~ '^[0-9a-f]{64}$'),
  created_at timestamptz not null default now()
);
alter table public.lol_ranking_exclusions enable row level security;
revoke all on public.lol_ranking_exclusions from public, anon, authenticated;
grant select, insert, delete on public.lol_ranking_exclusions to service_role;

-- 시즌 누적 작업 테이블. 계정 키는 PUUID의 HMAC이고, 경기 원문과 다른 참가자 정보는 저장하지 않는다.
create table public.lol_ranking_season_accounts (
  season_key text not null check (season_key ~ '^\d{4}-\d{2}-\d{2}$'),
  account_hmac text not null check (account_hmac ~ '^[0-9a-f]{64}$'),
  riot_id_hmac text not null check (riot_id_hmac ~ '^[0-9a-f]{64}$'),
  riot_id text not null check (char_length(riot_id) between 3 and 60 and position('#' in riot_id) >= 2),
  tier text not null check (tier in ('CHALLENGER', 'GRANDMASTER')),
  league_points integer not null check (league_points between 0 and 100000),
  cursor_ms bigint check (cursor_ms is null or cursor_ms > 0),
  cursor_ids text[] not null default '{}',
  resolved_at timestamptz,
  listed_at timestamptz not null,
  season_end timestamptz,
  checked_at timestamptz,
  primary key (season_key, account_hmac),
  check (cardinality(cursor_ids) <= 500),
  check ((cursor_ms is null) = (cardinality(cursor_ids) = 0))
);
create index lol_ranking_season_accounts_riot on public.lol_ranking_season_accounts (riot_id_hmac);
alter table public.lol_ranking_season_accounts enable row level security;
revoke all on public.lol_ranking_season_accounts from public, anon, authenticated;
grant select, insert, update, delete on public.lol_ranking_season_accounts to service_role;

create table public.lol_ranking_season_champions (
  season_key text not null,
  account_hmac text not null,
  champion_id integer not null check (champion_id between 1 and 100000),
  games integer not null check (games >= 0),
  wins integer not null check (wins >= 0),
  primary key (season_key, account_hmac, champion_id),
  foreign key (season_key, account_hmac) references public.lol_ranking_season_accounts (season_key, account_hmac) on delete cascade,
  check (wins <= games)
);
alter table public.lol_ranking_season_champions enable row level security;
revoke all on public.lol_ranking_season_champions from public, anon, authenticated;
grant select, insert, update, delete on public.lol_ranking_season_champions to service_role;

-- 명단 게시. 입력 전체를 검사하고 한 트랜잭션으로 교체한다. 더 오래된 실행은 최신 게시본을 덮지 못한다.
create function public.save_lol_ranking_publication(p_rows jsonb, p_player_count integer, p_observed_at timestamptz)
returns void language plpgsql security invoker set search_path = '' as $$
begin
  if p_observed_at is null or not pg_catalog.isfinite(p_observed_at) or p_observed_at > now() + interval '5 minutes' then
    raise exception 'invalid ranking snapshot' using errcode = '22023';
  end if;
  if jsonb_typeof(p_rows) is distinct from 'array' or jsonb_array_length(p_rows) > 1000
    or p_player_count is null or p_player_count < jsonb_array_length(p_rows) or p_player_count > 1000 then
    raise exception 'invalid ranking rows' using errcode = '22023';
  end if;
  if exists (select 1 from jsonb_array_elements(p_rows) r where jsonb_typeof(r) <> 'object' or r ? 'puuid' or r ? 'riot_id_hmac') then
    raise exception 'ranking row must not carry keys' using errcode = '22023';
  end if;
  if exists (select 1 from jsonb_array_elements(p_rows) r cross join lateral jsonb_object_keys(r) k
    where k not in ('rank','riot_id','tier','league_points','wins','losses')) then
    raise exception 'unknown ranking field' using errcode = '22023';
  end if;
  if exists (select 1 from jsonb_array_elements(p_rows) r where not (r ? 'rank' and r ? 'riot_id' and r ? 'tier'
    and r ? 'league_points' and r ? 'wins' and r ? 'losses')) then
    raise exception 'missing ranking field' using errcode = '22023';
  end if;
  if exists (select 1 from jsonb_array_elements(p_rows) r where
    case when jsonb_typeof(r->'rank') = 'number' then (r->>'rank')::numeric else -1 end not between 1 and 1000
    or jsonb_typeof(r->'riot_id') <> 'string' or char_length(r->>'riot_id') not between 3 and 60
    or position('#' in r->>'riot_id') < 2
    or r->>'tier' not in ('CHALLENGER','GRANDMASTER')
    or case when jsonb_typeof(r->'league_points') = 'number' then (r->>'league_points')::numeric else -1 end not between 0 and 100000
    or case when jsonb_typeof(r->'wins') = 'number' then (r->>'wins')::numeric else -1 end not between 0 and 1000000
    or case when jsonb_typeof(r->'losses') = 'number' then (r->>'losses')::numeric else -1 end not between 0 and 1000000) then
    raise exception 'invalid ranking row' using errcode = '22023';
  end if;
  if (select count(distinct (r->>'rank')) from jsonb_array_elements(p_rows) r) <> jsonb_array_length(p_rows) then
    raise exception 'duplicate ranking row' using errcode = '22023';
  end if;
  if exists (select 1 from public.lol_ranking_publication where board = 'solo_apex' and observed_at > p_observed_at) then
    raise exception 'stale ranking snapshot' using errcode = '55000';
  end if;
  delete from public.lol_ranking_publication where board = 'solo_apex';
  insert into public.lol_ranking_publication (board, payload, player_count, observed_at)
  values ('solo_apex', p_rows, p_player_count, p_observed_at);
end $$;

-- 장인 게시. 전체 챔피언을 한 번에 교체한다. 자격자 행에는 키가 없어야 한다.
create function public.save_lol_master_publication(p_season_key text, p_coverage integer, p_player_count integer,
  p_champions jsonb, p_observed_at timestamptz)
returns void language plpgsql security invoker set search_path = '' as $$
begin
  if p_observed_at is null or not pg_catalog.isfinite(p_observed_at) or p_observed_at > now() + interval '5 minutes'
    or p_season_key is null or p_season_key !~ '^\d{4}-\d{2}-\d{2}$'
    or p_coverage is null or p_coverage not between 0 and 100
    or p_player_count is null or p_player_count not between 0 and 100000 then
    raise exception 'invalid master snapshot' using errcode = '22023';
  end if;
  if jsonb_typeof(p_champions) is distinct from 'array' or jsonb_array_length(p_champions) > 500 then
    raise exception 'invalid master champions' using errcode = '22023';
  end if;
  if exists (select 1 from jsonb_array_elements(p_champions) c where jsonb_typeof(c) <> 'object'
    or exists (select 1 from jsonb_object_keys(c) k where k not in ('champion_id','eligible_count','rows'))
    or not (c ? 'champion_id' and c ? 'eligible_count' and c ? 'rows')
    or case when jsonb_typeof(c->'champion_id') = 'number' then (c->>'champion_id')::numeric else 0 end not between 1 and 100000
    or case when jsonb_typeof(c->'eligible_count') = 'number' then (c->>'eligible_count')::numeric else -1 end not between 1 and 100000
    or jsonb_typeof(c->'rows') is distinct from 'array' or jsonb_array_length(c->'rows') not between 1 and 50) then
    raise exception 'invalid master champion' using errcode = '22023';
  end if;
  if exists (select 1 from jsonb_array_elements(p_champions) c cross join lateral jsonb_array_elements(c->'rows') e
    where jsonb_typeof(e) <> 'object' or e ? 'puuid' or e ? 'riot_id_hmac' or e ? 'account_hmac'
    or exists (select 1 from jsonb_object_keys(e) k where k not in ('rank','riot_id','tier','league_points','games','wins'))
    or not (e ? 'rank' and e ? 'riot_id' and e ? 'tier' and e ? 'league_points' and e ? 'games' and e ? 'wins')
    or case when jsonb_typeof(e->'rank') = 'number' then (e->>'rank')::numeric else -1 end not between 1 and 50
    or jsonb_typeof(e->'riot_id') <> 'string' or char_length(e->>'riot_id') not between 3 and 60
    or position('#' in e->>'riot_id') < 2
    or e->>'tier' not in ('CHALLENGER','GRANDMASTER')
    or case when jsonb_typeof(e->'league_points') = 'number' then (e->>'league_points')::numeric else -1 end not between 0 and 100000
    or case when jsonb_typeof(e->'games') = 'number' then (e->>'games')::numeric else -1 end not between 15 and 1000000
    or case when jsonb_typeof(e->'wins') = 'number' then (e->>'wins')::numeric else -1 end not between 0 and 1000000
    or (case when jsonb_typeof(e->'wins') = 'number' and jsonb_typeof(e->'games') = 'number' then (e->>'wins')::numeric * 100 < 50 * (e->>'games')::numeric else true end)
    or (case when jsonb_typeof(e->'wins') = 'number' and jsonb_typeof(e->'games') = 'number' then (e->>'wins')::numeric > (e->>'games')::numeric else true end)
  ) then
    raise exception 'invalid master row' using errcode = '22023';
  end if;
  if (select count(distinct (c->>'champion_id')) from jsonb_array_elements(p_champions) c) <> jsonb_array_length(p_champions) then
    raise exception 'duplicate master champion' using errcode = '22023';
  end if;
  if exists (select 1 from public.lol_master_publication where observed_at > p_observed_at) then
    raise exception 'stale master snapshot' using errcode = '55000';
  end if;
  delete from public.lol_master_publication;
  insert into public.lol_master_publication (champion_id, season_key, coverage, player_count, eligible_count, rows, observed_at)
  select (c->>'champion_id')::integer, p_season_key, p_coverage, p_player_count, (c->>'eligible_count')::integer, c->'rows', p_observed_at
  from jsonb_array_elements(p_champions) c;
end $$;

create function public.get_lol_ranking_publication()
returns jsonb language sql stable security invoker set search_path = '' as $$
  select jsonb_build_object('payload', payload, 'playerCount', player_count, 'observedAt', observed_at)
  from public.lol_ranking_publication where board = 'solo_apex';
$$;

create function public.get_lol_master_publication()
returns jsonb language sql stable security invoker set search_path = '' as $$
  select jsonb_build_object(
    'observedAt', max(observed_at),
    'season', max(season_key),
    'coverage', min(coverage),
    'playerCount', max(player_count),
    'champions', coalesce(jsonb_agg(jsonb_build_object('championId', champion_id, 'eligibleCount', eligible_count,
      'rows', rows) order by champion_id), '[]'::jsonb))
  from public.lol_master_publication;
$$;

create function public.list_lol_ranking_exclusion_keys()
returns jsonb language sql stable security invoker set search_path = '' as $$
  select coalesce(jsonb_agg(riot_id_hmac order by riot_id_hmac), '[]'::jsonb) from public.lol_ranking_exclusions;
$$;

-- 삭제 요청: 제외 키를 넣고, 시즌 누적 행을 지우고, 게시본에서 같은 Riot ID를 빼고 순위를 다시 매긴다.
create function public.add_lol_ranking_exclusion(p_hmac text, p_riot_id text)
returns integer language plpgsql security invoker set search_path = '' as $$
declare
  v_removed integer := 0;
begin
  if p_hmac is null or p_hmac !~ '^[0-9a-f]{64}$' or p_riot_id is null or char_length(p_riot_id) not between 3 and 60 then
    raise exception 'invalid exclusion key' using errcode = '22023';
  end if;
  insert into public.lol_ranking_exclusions (riot_id_hmac) values (p_hmac) on conflict (riot_id_hmac) do nothing;
  delete from public.lol_ranking_season_accounts where riot_id_hmac = p_hmac;
  select count(*)::integer into v_removed from public.lol_ranking_publication p, jsonb_array_elements(p.payload) r
    where p.board = 'solo_apex' and lower(r->>'riot_id') = lower(p_riot_id);
  update public.lol_ranking_publication set
    payload = (select coalesce(jsonb_agg(jsonb_set(x.value, '{rank}', to_jsonb(x.n::integer)) order by x.n), '[]'::jsonb)
      from (select value, row_number() over (order by ord) as n
        from jsonb_array_elements(payload) with ordinality e(value, ord) where lower(value->>'riot_id') <> lower(p_riot_id)) x),
    player_count = greatest(0, player_count - v_removed)
  where board = 'solo_apex' and v_removed > 0;
  update public.lol_master_publication m set
    rows = (select coalesce(jsonb_agg(jsonb_set(x.value, '{rank}', to_jsonb(x.n::integer)) order by x.n), '[]'::jsonb)
      from (select value, row_number() over (order by ord) as n
        from jsonb_array_elements(m.rows) with ordinality e(value, ord) where lower(value->>'riot_id') <> lower(p_riot_id)) x),
    eligible_count = greatest(0, m.eligible_count - (select count(*) from jsonb_array_elements(m.rows) e where lower(e->>'riot_id') = lower(p_riot_id)))
  where exists (select 1 from jsonb_array_elements(m.rows) e where lower(e->>'riot_id') = lower(p_riot_id));
  return v_removed;
end $$;

-- 계정 행을 만들거나 갱신한다. 제외된 Riot ID는 행을 만들지 않는다.
create function public.upsert_lol_season_account(p_season_key text, p_account_hmac text, p_riot_id_hmac text, p_riot_id text,
  p_tier text, p_league_points integer, p_resolved_at timestamptz, p_listed_at timestamptz, p_season_end timestamptz)
returns void language plpgsql security invoker set search_path = '' as $$
begin
  if p_season_key !~ '^\d{4}-\d{2}-\d{2}$' or p_account_hmac !~ '^[0-9a-f]{64}$' or p_riot_id_hmac !~ '^[0-9a-f]{64}$'
    or p_riot_id is null or char_length(p_riot_id) not between 3 and 60 or position('#' in p_riot_id) < 2
    or p_tier not in ('CHALLENGER','GRANDMASTER') or p_league_points is null or p_league_points not between 0 and 100000
    or p_listed_at is null or p_season_end is null then
    raise exception 'invalid season account' using errcode = '22023';
  end if;
  if exists (select 1 from public.lol_ranking_exclusions where riot_id_hmac = p_riot_id_hmac) then
    raise exception 'excluded account' using errcode = '23514';
  end if;
  insert into public.lol_ranking_season_accounts (season_key, account_hmac, riot_id_hmac, riot_id, tier, league_points, resolved_at, listed_at, season_end)
  values (p_season_key, p_account_hmac, p_riot_id_hmac, p_riot_id, p_tier, p_league_points, p_resolved_at, p_listed_at, p_season_end)
  on conflict (season_key, account_hmac) do update set riot_id_hmac = excluded.riot_id_hmac, riot_id = excluded.riot_id,
    tier = excluded.tier, league_points = excluded.league_points,
    resolved_at = coalesce(excluded.resolved_at, public.lol_ranking_season_accounts.resolved_at),
    listed_at = excluded.listed_at, season_end = excluded.season_end;
end $$;

-- 수집기가 계정별 커서와 확인 시각을 읽는다.
create function public.get_lol_season_account_states(p_season_key text, p_account_hmacs text[])
returns jsonb language sql stable security invoker set search_path = '' as $$
  select coalesce(jsonb_agg(jsonb_build_object('accountHmac', account_hmac, 'riotId', riot_id, 'riotIdHmac', riot_id_hmac,
    'resolvedAt', resolved_at, 'cursorMs', cursor_ms, 'cursorIds', to_jsonb(cursor_ids), 'checkedAt', checked_at)), '[]'::jsonb)
  from public.lol_ranking_season_accounts
  where season_key = p_season_key and account_hmac = any(p_account_hmacs);
$$;

-- 계정 한 명의 판수 증가와 커서 진행을 한 트랜잭션으로 저장한다. 읽은 커서와 다르면 40001로 거절해 이중 집계를 막는다.
create function public.commit_lol_season_progress(p_season_key text, p_account_hmac text, p_expected_cursor_ms bigint,
  p_cursor_ms bigint, p_cursor_ids text[], p_champions jsonb, p_checked_at timestamptz)
returns void language plpgsql security invoker set search_path = '' as $$
declare
  v_current bigint;
begin
  if jsonb_typeof(p_champions) is distinct from 'array' or jsonb_array_length(p_champions) > 500 then
    raise exception 'invalid champion deltas' using errcode = '22023';
  end if;
  if exists (select 1 from jsonb_array_elements(p_champions) c
    where jsonb_typeof(c) <> 'object' or exists (select 1 from jsonb_object_keys(c) k where k not in ('champion_id','games','wins'))
    or not (c ? 'champion_id' and c ? 'games' and c ? 'wins')
    or case when jsonb_typeof(c->'champion_id') = 'number' then (c->>'champion_id')::numeric else 0 end not between 1 and 100000
    or case when jsonb_typeof(c->'games') = 'number' then (c->>'games')::numeric else -1 end not between 0 and 100000
    or case when jsonb_typeof(c->'wins') = 'number' then (c->>'wins')::numeric else -1 end not between 0 and 100000
    or case when jsonb_typeof(c->'wins') = 'number' and jsonb_typeof(c->'games') = 'number' then (c->>'wins')::numeric > (c->>'games')::numeric else true end) then
    raise exception 'invalid champion delta' using errcode = '22023';
  end if;
  if p_cursor_ids is not null and cardinality(p_cursor_ids) > 500 then
    raise exception 'cursor too large' using errcode = '22023';
  end if;
  select cursor_ms into v_current from public.lol_ranking_season_accounts
    where season_key = p_season_key and account_hmac = p_account_hmac for update;
  if not found then
    raise exception 'season account missing' using errcode = 'P0002';
  end if;
  if v_current is distinct from p_expected_cursor_ms then
    raise exception 'stale cursor' using errcode = '40001';
  end if;
  insert into public.lol_ranking_season_champions (season_key, account_hmac, champion_id, games, wins)
  select p_season_key, p_account_hmac, (c->>'champion_id')::integer, (c->>'games')::integer, (c->>'wins')::integer
  from jsonb_array_elements(p_champions) c
  on conflict (season_key, account_hmac, champion_id) do update set
    games = public.lol_ranking_season_champions.games + excluded.games,
    wins = public.lol_ranking_season_champions.wins + excluded.wins;
  update public.lol_ranking_season_accounts set
    cursor_ms = coalesce(p_cursor_ms, cursor_ms),
    cursor_ids = case when p_cursor_ms is null then cursor_ids else coalesce(p_cursor_ids, '{}') end,
    checked_at = p_checked_at
  where season_key = p_season_key and account_hmac = p_account_hmac;
end $$;

-- 장인 게시용 계정별 챔피언 판수. 명단에 있는 계정만 넘긴다.
create function public.list_lol_season_champion_counts(p_season_key text, p_account_hmacs text[])
returns jsonb language sql stable security invoker set search_path = '' as $$
  select coalesce(jsonb_agg(jsonb_build_object('accountHmac', c.account_hmac, 'championId', c.champion_id,
    'games', c.games, 'wins', c.wins)), '[]'::jsonb)
  from public.lol_ranking_season_champions c
  where c.season_key = p_season_key and c.account_hmac = any(p_account_hmacs);
$$;

-- 장인 작업 데이터(계정 해시, 챔피언별 판수·승수)는 시즌 종료 후 30일에 지운다. 종료 시각이 없는 행은 지우지 않는다.
create function public.purge_lol_expired_season_accounts(p_now timestamptz)
returns integer language plpgsql security invoker set search_path = '' as $$
declare
  v_rows integer;
begin
  if p_now is null or not pg_catalog.isfinite(p_now) then
    raise exception 'invalid purge time' using errcode = '22023';
  end if;
  delete from public.lol_ranking_season_accounts where season_end is not null and season_end + interval '30 days' <= p_now;
  get diagnostics v_rows = row_count;
  return v_rows;
end $$;

revoke all on function public.save_lol_ranking_publication(jsonb, integer, timestamptz) from public, anon, authenticated;
revoke all on function public.save_lol_master_publication(text, integer, integer, jsonb, timestamptz) from public, anon, authenticated;
revoke all on function public.get_lol_ranking_publication() from public, anon, authenticated;
revoke all on function public.get_lol_master_publication() from public, anon, authenticated;
revoke all on function public.list_lol_ranking_exclusion_keys() from public, anon, authenticated;
revoke all on function public.add_lol_ranking_exclusion(text, text) from public, anon, authenticated;
revoke all on function public.upsert_lol_season_account(text, text, text, text, text, integer, timestamptz, timestamptz, timestamptz) from public, anon, authenticated;
revoke all on function public.get_lol_season_account_states(text, text[]) from public, anon, authenticated;
revoke all on function public.commit_lol_season_progress(text, text, bigint, bigint, text[], jsonb, timestamptz) from public, anon, authenticated;
revoke all on function public.list_lol_season_champion_counts(text, text[]) from public, anon, authenticated;
revoke all on function public.purge_lol_expired_season_accounts(timestamptz) from public, anon, authenticated;
grant execute on function public.save_lol_ranking_publication(jsonb, integer, timestamptz) to service_role;
grant execute on function public.save_lol_master_publication(text, integer, integer, jsonb, timestamptz) to service_role;
grant execute on function public.get_lol_ranking_publication() to service_role;
grant execute on function public.get_lol_master_publication() to service_role;
grant execute on function public.list_lol_ranking_exclusion_keys() to service_role;
grant execute on function public.add_lol_ranking_exclusion(text, text) to service_role;
grant execute on function public.upsert_lol_season_account(text, text, text, text, text, integer, timestamptz, timestamptz, timestamptz) to service_role;
grant execute on function public.get_lol_season_account_states(text, text[]) to service_role;
grant execute on function public.commit_lol_season_progress(text, text, bigint, bigint, text[], jsonb, timestamptz) to service_role;
grant execute on function public.list_lol_season_champion_counts(text, text[]) to service_role;
grant execute on function public.purge_lol_expired_season_accounts(timestamptz) to service_role;

commit;
