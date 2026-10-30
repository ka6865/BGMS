begin;
set local lock_timeout = '2s';

-- 랭킹·장인 게시본. 공개 화면은 서버가 이 표를 읽어 PUUID 없이 표시 행만 만든다.
-- 시점별 이력은 남기지 않고, 저장 때 한 트랜잭션으로 교체한다.
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

create table public.lol_mastery_publication (
  champion_id integer primary key check (champion_id between 1 and 100000),
  status text not null check (status in ('ok', 'insufficient')),
  sample_size integer not null check (sample_size between 0 and 1000),
  player_count integer not null check (player_count between 0 and 1000),
  entries jsonb not null check (jsonb_typeof(entries) = 'array' and jsonb_array_length(entries) <= 10),
  observed_at timestamptz not null,
  check ((status = 'insufficient' and jsonb_array_length(entries) = 0) or status = 'ok')
);
alter table public.lol_mastery_publication enable row level security;
revoke all on public.lol_mastery_publication from public, anon, authenticated;
grant select, insert, update, delete on public.lol_mastery_publication to service_role;

-- 삭제를 요청한 Riot ID의 HMAC. 다음 게시와 기존 게시본에서 모두 빠진다.
create table public.lol_ranking_exclusions (
  riot_id_hmac text primary key check (riot_id_hmac ~ '^[0-9a-f]{64}$'),
  created_at timestamptz not null default now()
);
alter table public.lol_ranking_exclusions enable row level security;
revoke all on public.lol_ranking_exclusions from public, anon, authenticated;
grant select, insert, delete on public.lol_ranking_exclusions to service_role;

-- 게시 입력 검증: PUUID 키 금지, 허용 키만 허용, 순위 중복 금지, 제외 HMAC 형식 확인.
create function public.save_lol_ranking_publication(p_rows jsonb, p_player_count integer, p_masteries jsonb, p_observed_at timestamptz)
returns void language plpgsql security invoker set search_path = '' as $$
begin
  if p_observed_at is null or not pg_catalog.isfinite(p_observed_at) or p_observed_at > now() + interval '5 minutes' then
    raise exception 'invalid ranking snapshot' using errcode = '22023';
  end if;
  if jsonb_typeof(p_rows) is distinct from 'array' or jsonb_array_length(p_rows) > 1000
    or p_player_count is null or p_player_count < jsonb_array_length(p_rows) or p_player_count > 1000 then
    raise exception 'invalid ranking rows' using errcode = '22023';
  end if;
  if exists (select 1 from jsonb_array_elements(p_rows) r where jsonb_typeof(r) <> 'object') then
    raise exception 'invalid ranking row' using errcode = '22023';
  end if;
  if exists (select 1 from jsonb_array_elements(p_rows) r where r ? 'puuid') then
    raise exception 'ranking row must not carry PUUID' using errcode = '22023';
  end if;
  if exists (select 1 from jsonb_array_elements(p_rows) r cross join lateral jsonb_object_keys(r) k
    where k not in ('rank','riot_id','tier','league_points','wins','losses','riot_id_hmac')) then
    raise exception 'unknown ranking field' using errcode = '22023';
  end if;
  if exists (select 1 from jsonb_array_elements(p_rows) r where not (r ? 'rank' and r ? 'riot_id' and r ? 'tier'
    and r ? 'league_points' and r ? 'wins' and r ? 'losses' and r ? 'riot_id_hmac')) then
    raise exception 'missing ranking field' using errcode = '22023';
  end if;
  if exists (select 1 from jsonb_array_elements(p_rows) r where
    case when jsonb_typeof(r->'rank') = 'number' then (r->>'rank')::numeric else -1 end not between 1 and 1000
    or jsonb_typeof(r->'riot_id') <> 'string' or char_length(r->>'riot_id') not between 3 and 60
    or position('#' in r->>'riot_id') < 2
    or r->>'tier' not in ('CHALLENGER','GRANDMASTER')
    or case when jsonb_typeof(r->'league_points') = 'number' then (r->>'league_points')::numeric else -1 end not between 0 and 100000
    or case when jsonb_typeof(r->'wins') = 'number' then (r->>'wins')::numeric else -1 end not between 0 and 1000000
    or case when jsonb_typeof(r->'losses') = 'number' then (r->>'losses')::numeric else -1 end not between 0 and 1000000
    or jsonb_typeof(r->'riot_id_hmac') <> 'string' or (r->>'riot_id_hmac') !~ '^[0-9a-f]{64}$') then
    raise exception 'invalid ranking row' using errcode = '22023';
  end if;
  if (select count(distinct (r->>'rank')) from jsonb_array_elements(p_rows) r) <> jsonb_array_length(p_rows)
    or (select count(distinct (r->>'riot_id_hmac')) from jsonb_array_elements(p_rows) r) <> jsonb_array_length(p_rows) then
    raise exception 'duplicate ranking row' using errcode = '22023';
  end if;
  if jsonb_typeof(p_masteries) is distinct from 'array' or jsonb_array_length(p_masteries) > 1000 then
    raise exception 'invalid mastery rows' using errcode = '22023';
  end if;
  if exists (select 1 from jsonb_array_elements(p_masteries) m where jsonb_typeof(m) <> 'object' or m ? 'puuid') then
    raise exception 'invalid mastery row' using errcode = '22023';
  end if;
  if exists (select 1 from jsonb_array_elements(p_masteries) m cross join lateral jsonb_object_keys(m) k
    where k not in ('champion_id','status','sample_size','entries')) then
    raise exception 'unknown mastery field' using errcode = '22023';
  end if;
  if exists (select 1 from jsonb_array_elements(p_masteries) m where not (m ? 'champion_id' and m ? 'status'
    and m ? 'sample_size' and m ? 'entries')
    or case when jsonb_typeof(m->'champion_id') = 'number' then (m->>'champion_id')::numeric else 0 end not between 1 and 100000
    or m->>'status' not in ('ok','insufficient')
    or jsonb_typeof(m->'entries') is distinct from 'array' or jsonb_array_length(m->'entries') > 10) then
    raise exception 'invalid mastery row' using errcode = '22023';
  end if;
  if exists (select 1 from jsonb_array_elements(p_masteries) m cross join lateral jsonb_array_elements(m->'entries') e
    where jsonb_typeof(e) <> 'object' or e ? 'puuid'
    or not (e ? 'rank' and e ? 'riot_id' and e ? 'champion_points' and e ? 'champion_level' and e ? 'riot_id_hmac')
    or jsonb_typeof(e->'riot_id_hmac') <> 'string' or (e->>'riot_id_hmac') !~ '^[0-9a-f]{64}$'
    or case when jsonb_typeof(e->'champion_points') = 'number' then (e->>'champion_points')::numeric else -1 end < 0) then
    raise exception 'invalid mastery entry' using errcode = '22023';
  end if;
  if (select count(distinct (m->>'champion_id')) from jsonb_array_elements(p_masteries) m) <> jsonb_array_length(p_masteries) then
    raise exception 'duplicate mastery row' using errcode = '22023';
  end if;
  -- 더 오래된 실행이 뒤늦게 끝나 최신 게시본을 덮지 못하게 한다.
  if exists (select 1 from public.lol_ranking_publication where board = 'solo_apex' and observed_at > p_observed_at) then
    raise exception 'stale ranking snapshot' using errcode = '55000';
  end if;
  delete from public.lol_ranking_publication where board = 'solo_apex';
  insert into public.lol_ranking_publication (board, payload, player_count, observed_at)
  values ('solo_apex', p_rows, p_player_count, p_observed_at);
  delete from public.lol_mastery_publication;
  insert into public.lol_mastery_publication (champion_id, status, sample_size, player_count, entries, observed_at)
  select (m->>'champion_id')::integer, m->>'status', (m->>'sample_size')::integer, p_player_count, m->'entries', p_observed_at
  from jsonb_array_elements(p_masteries) m;
end $$;

create function public.get_lol_ranking_publication()
returns jsonb language sql stable security invoker set search_path = '' as $$
  select jsonb_build_object('payload', payload, 'playerCount', player_count, 'observedAt', observed_at)
  from public.lol_ranking_publication where board = 'solo_apex';
$$;

create function public.get_lol_mastery_publication()
returns jsonb language sql stable security invoker set search_path = '' as $$
  select jsonb_build_object(
    'observedAt', max(observed_at),
    'playerCount', max(player_count),
    'champions', coalesce(jsonb_agg(jsonb_build_object('championId', champion_id, 'status', status, 'sampleSize', sample_size,
      'entries', entries) order by champion_id), '[]'::jsonb))
  from public.lol_mastery_publication;
$$;

create function public.list_lol_ranking_exclusion_keys()
returns jsonb language sql stable security invoker set search_path = '' as $$
  select coalesce(jsonb_agg(riot_id_hmac order by riot_id_hmac), '[]'::jsonb) from public.lol_ranking_exclusions;
$$;

-- 제외 키를 넣고 기존 게시본에서 해당 행과 장인 항목을 지운 뒤 순위를 다시 매긴다.
create function public.add_lol_ranking_exclusion(p_hmac text)
returns integer language plpgsql security invoker set search_path = '' as $$
declare
  v_removed integer := 0;
begin
  if p_hmac is null or p_hmac !~ '^[0-9a-f]{64}$' then
    raise exception 'invalid exclusion key' using errcode = '22023';
  end if;
  insert into public.lol_ranking_exclusions (riot_id_hmac) values (p_hmac) on conflict (riot_id_hmac) do nothing;
  select count(*)::integer into v_removed from public.lol_ranking_publication p, jsonb_array_elements(p.payload) r
    where p.board = 'solo_apex' and r->>'riot_id_hmac' = p_hmac;
  update public.lol_ranking_publication set
    payload = (select coalesce(jsonb_agg(jsonb_set(x.value, '{rank}', to_jsonb(x.n::integer)) order by x.n), '[]'::jsonb)
      from (select value, row_number() over (order by ord) as n
        from jsonb_array_elements(payload) with ordinality e(value, ord) where value->>'riot_id_hmac' <> p_hmac) x),
    player_count = greatest(0, player_count - v_removed)
  where board = 'solo_apex' and v_removed > 0;
  update public.lol_mastery_publication set
    entries = (select coalesce(jsonb_agg(jsonb_set(x.value, '{rank}', to_jsonb(x.n::integer)) order by x.n), '[]'::jsonb)
      from (select value, row_number() over (order by ord) as n
        from jsonb_array_elements(entries) with ordinality e(value, ord) where value->>'riot_id_hmac' <> p_hmac) x)
  where entries @> jsonb_build_array(jsonb_build_object('riot_id_hmac', p_hmac));
  update public.lol_mastery_publication set player_count = greatest(0, player_count - v_removed) where v_removed > 0;
  return v_removed;
end $$;

revoke all on function public.save_lol_ranking_publication(jsonb, integer, jsonb, timestamptz) from public, anon, authenticated;
revoke all on function public.get_lol_ranking_publication() from public, anon, authenticated;
revoke all on function public.get_lol_mastery_publication() from public, anon, authenticated;
revoke all on function public.list_lol_ranking_exclusion_keys() from public, anon, authenticated;
revoke all on function public.add_lol_ranking_exclusion(text) from public, anon, authenticated;
grant execute on function public.save_lol_ranking_publication(jsonb, integer, jsonb, timestamptz) to service_role;
grant execute on function public.get_lol_ranking_publication() to service_role;
grant execute on function public.get_lol_mastery_publication() to service_role;
grant execute on function public.list_lol_ranking_exclusion_keys() to service_role;
grant execute on function public.add_lol_ranking_exclusion(text) to service_role;

commit;
