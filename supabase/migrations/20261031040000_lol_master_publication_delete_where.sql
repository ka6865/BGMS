-- 운영 PostgREST는 safeupdate로 WHERE 없는 DELETE를 거부한다. 장인 게시본 교체가 실패하던 함수를 고친다.
begin;
set local lock_timeout = '2s';

create or replace function public.save_lol_master_publication(p_season_key text, p_coverage integer, p_player_count integer,
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
  delete from public.lol_master_publication where true;
  insert into public.lol_master_publication (champion_id, season_key, coverage, player_count, eligible_count, rows, observed_at)
  select (c->>'champion_id')::integer, p_season_key, p_coverage, p_player_count, (c->>'eligible_count')::integer, c->'rows', p_observed_at
  from jsonb_array_elements(p_champions) c;
end $$;

commit;
