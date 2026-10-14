-- Runs only in the verifier's disposable PostgreSQL database.
-- 소량 데이터에서는 순차 탐색이 더 싸므로 끄고, 실제 쿼리 모양이 새 인덱스를 쓸 수 있는지만 확인한다.
begin;
set local enable_seqscan = off;
set local enable_bitmapscan = off;
do $$
declare plan text;
begin
  if not exists(select 1 from pg_indexes where indexname='pubg_player_matches_unknown_type_idx'
      and indexdef like '%(played_at DESC) WHERE (match_type = ''unknown''::text)%')
    or not exists(select 1 from pg_indexes where indexname='pubg_player_cache_keep_recent_idx'
      and indexdef like '%(updated_at DESC NULLS LAST, id DESC)%')
    or not exists(select 1 from pg_indexes where indexname='pubg_player_cache_compaction_candidates_idx'
      and indexdef like '%(updated_at, id) INCLUDE (last_seen_at) WHERE ((search_count = 0) AND (season_stats_data IS NULL))%') then
    raise exception 'FAIL: slow query indexes missing';
  end if;

  execute 'explain (format json) select match_id, player_id, platform from public.pubg_player_matches
    where match_type = ''unknown'' order by played_at desc limit 50' into plan;
  if plan not like '%pubg_player_matches_unknown_type_idx%' then raise exception 'FAIL: backfill query plan %', plan; end if;

  execute 'explain (format json) select cache.updated_at, cache.id from public.pubg_player_cache as cache
    order by cache.updated_at desc nulls last, cache.id desc offset 149999 limit 1' into plan;
  if plan not like '%pubg_player_cache_keep_recent_idx%' or plan like '%"Sort"%' then
    raise exception 'FAIL: keep-recent boundary plan %', plan;
  end if;

  execute 'explain (format json) select count(*) from public.pubg_player_cache as cache
    where cache.search_count = 0 and cache.season_stats_data is null
      and (cache.last_seen_at is null or cache.last_seen_at < now() - interval ''90 days'')
      and (cache.updated_at, cache.id) < (now(), ''zzz'')' into plan;
  if plan not like '%Index Only Scan%pubg_player_cache_compaction_candidates_idx%' then
    raise exception 'FAIL: compaction count plan %', plan;
  end if;
  if not exists(select 1 from pg_class where oid='public.pubg_player_cache'::regclass
      and reloptions @> array['autovacuum_vacuum_scale_factor=0.05','autovacuum_vacuum_insert_scale_factor=0.05','autovacuum_analyze_scale_factor=0.05']) then
    raise exception 'FAIL: player cache autovacuum settings';
  end if;
  if exists(select 1 from pg_indexes where indexname='pubg_player_cache_retention_idx') then
    raise exception 'FAIL: redundant player cache retention index remains';
  end if;
  execute 'explain (format json) select 1 from public.pubg_match_performance p
    where p.match_id = ''m'' and p.platform = ''steam'' and p.player_id = ''p''' into plan;
  if plan not like '%pubg_match_performance_match_player_idx%' then
    raise exception 'FAIL: legacy recovery performance lookup plan %', plan;
  end if;
  raise notice 'PASS: slow query indexes are usable';
end $$;
rollback;

-- 조건을 나눈 뒤에도 updated_at 이 null 인 행을 먼저, 그다음 오래된 순으로 지우고 최근 N개를 보존한다.
begin;
truncate public.pubg_player_cache;
do $$
declare result jsonb;
begin
  insert into public.pubg_player_cache(id, nickname, lower_nickname, platform, updated_at) values
    ('null-b', 'f', 'f', 'steam', null), ('null-a', 'f', 'f', 'steam', null),
    ('old-1', 'f', 'f', 'steam', now() - interval '3 days'), ('old-2', 'f', 'f', 'steam', now() - interval '2 days'),
    ('new-1', 'f', 'f', 'steam', now() - interval '1 day'), ('new-2', 'f', 'f', 'steam', now() - interval '1 hour');
  execute 'set local role service_role';
  -- 최근 2개(new-1, new-2) 보존. 대상 4개 중 3개를 null 먼저 id 순, 그다음 오래된 순으로 지운다.
  result := public.compact_pubg_player_cache(90, true, 10, 2);
  if result @> '{"candidate_count":4,"deleted_count":4,"remaining_count":0,"total_count":2}'::jsonb is not true then
    raise exception 'FAIL: split compaction counts %', result;
  end if;
  execute 'reset role';
  if (select array_agg(id order by id) from public.pubg_player_cache) is distinct from array['new-1','new-2'] then
    raise exception 'FAIL: split compaction kept wrong rows';
  end if;

  insert into public.pubg_player_cache(id, nickname, lower_nickname, platform, updated_at) values
    ('null-c', 'f', 'f', 'steam', null), ('old-3', 'f', 'f', 'steam', now() - interval '3 days');
  execute 'set local role service_role';
  result := public.compact_pubg_player_cache(90, true, 10, 0);
  execute 'reset role';
  if result @> '{"candidate_count":4,"deleted_count":4,"total_count":0}'::jsonb is not true then
    raise exception 'FAIL: compaction without recent limit %', result;
  end if;

  -- 보존 경계가 null 구간에 걸리면 updated_at 이 있는 행은 모두 보존하고 null 행만 id 순으로 비교한다.
  insert into public.pubg_player_cache(id, nickname, lower_nickname, platform, updated_at) values
    ('null-x', 'f', 'f', 'steam', null), ('null-y', 'f', 'f', 'steam', null), ('dated', 'f', 'f', 'steam', now() - interval '1 year');
  execute 'set local role service_role';
  result := public.compact_pubg_player_cache(90, true, 10, 2);
  execute 'reset role';
  if result @> '{"candidate_count":1,"deleted_count":1,"total_count":2}'::jsonb is not true
    or (select array_agg(id order by id) from public.pubg_player_cache) is distinct from array['dated','null-y'] then
    raise exception 'FAIL: null-region boundary %', result;
  end if;
  raise notice 'PASS: split player cache compaction keeps order and recent rows';
end $$;
rollback;
