-- 계산 4: 기회 없음 대체값을 만점 대신 모드별 관측 평균으로 채운다(docs/specs/2026-10-17-tactical-score-v4.md).
-- 계산 2·3 결과는 그대로 읽고, 검증된 재계산만 계산 4로 올린다. 버전 하향 방지 트리거는 그대로 둔다.

-- 1. 텔레메트리 재분석 결과의 계산 4 저장을 허용한다(계산 2·3과 같은 CAS·계정·모집단 검증).
CREATE OR REPLACE FUNCTION public.upgrade_analysis_calculation(
  p_match_id text, p_platform text, p_player_id text,
  p_expected_data jsonb, p_expected_benchmark jsonb,
  p_full_result jsonb, p_benchmark jsonb
) RETURNS boolean LANGUAGE plpgsql SECURITY INVOKER SET search_path = '' AS $$
DECLARE previous public.processed_match_telemetry%ROWTYPE;
  benchmark public.global_benchmarks%ROWTYPE;
BEGIN
  IF p_platform IS NULL OR p_platform NOT IN ('steam','kakao') OR p_player_id IS NULL OR p_match_id IS NULL
    OR p_full_result->>'matchId' IS DISTINCT FROM p_match_id
    OR p_full_result->>'platform' IS DISTINCT FROM p_platform
    OR p_full_result->>'player_id' IS DISTINCT FROM p_player_id
    OR lower(trim(p_full_result #>> '{stats,name}')) IS DISTINCT FROM p_player_id
    OR p_full_result->'v' IS DISTINCT FROM '73'::jsonb
    OR p_full_result->'calculationVersion' IS NULL OR p_full_result->'calculationVersion' NOT IN ('2'::jsonb,'3'::jsonb,'4'::jsonb)
    OR p_full_result->'populationEvidenceVersion' IS DISTINCT FROM '1'::jsonb
    OR p_benchmark->>'match_id' IS DISTINCT FROM p_match_id
    OR p_benchmark->>'platform' IS DISTINCT FROM p_platform
    OR p_benchmark->>'player_id' IS DISTINCT FROM p_player_id
    OR p_benchmark->'calculation_version' IS DISTINCT FROM p_full_result->'calculationVersion'
    OR p_benchmark->'filter_version' IS DISTINCT FROM '8'::jsonb
    OR p_benchmark->'population_evidence_version' IS DISTINCT FROM '1'::jsonb
    OR p_full_result->>'gameMode' IS DISTINCT FROM p_benchmark->>'game_mode'
    OR p_full_result->>'matchType' IS DISTINCT FROM p_benchmark->>'match_type'
    OR p_benchmark->>'game_mode' IS NULL
    OR (p_benchmark->>'game_mode') NOT IN ('solo','solo-fpp','duo','duo-fpp','squad','squad-fpp')
    OR p_benchmark->>'match_type' IS NULL
    OR (p_benchmark->>'match_type') NOT IN ('official','competitive')
  THEN RAISE EXCEPTION 'calculation-upgrade-invalid-input' USING ERRCODE='22023'; END IF;
  SELECT * INTO previous FROM public.processed_match_telemetry
    WHERE match_id=p_match_id AND platform=p_platform AND player_id=p_player_id FOR UPDATE;
  IF NOT FOUND OR previous.data IS DISTINCT FROM p_expected_data
    OR previous.data #> '{fullResult,v}' IS DISTINCT FROM '73'::jsonb
    OR previous.data #>> '{fullResult,matchId}' IS DISTINCT FROM p_match_id
    OR previous.data #>> '{fullResult,platform}' IS DISTINCT FROM p_platform
    OR previous.data #>> '{fullResult,player_id}' IS DISTINCT FROM p_player_id
    OR (previous.data #> '{fullResult,calculationVersion}' IS NOT NULL AND previous.data #> '{fullResult,calculationVersion}' <> 'null'::jsonb
      AND (previous.data #> '{fullResult,calculationVersion}' NOT IN ('1'::jsonb,'2'::jsonb,'3'::jsonb)
        OR previous.data #> '{fullResult,calculationVersion}' >= p_full_result->'calculationVersion'))
    OR coalesce(previous.data #>> '{fullResult,stats,playerId}', previous.data #>> '{fullResult,stats,accountId}') IS DISTINCT FROM coalesce(p_full_result #>> '{stats,playerId}', p_full_result #>> '{stats,accountId}')
    OR coalesce(p_full_result #>> '{stats,playerId}', p_full_result #>> '{stats,accountId}') IS NULL
  THEN RETURN false; END IF;
  SELECT * INTO benchmark FROM public.global_benchmarks
    WHERE match_id=p_match_id AND platform=p_platform AND player_id=p_player_id FOR UPDATE;
  IF NOT FOUND OR to_jsonb(benchmark) IS DISTINCT FROM p_expected_benchmark OR (benchmark.calculation_version IS NOT NULL AND (benchmark.calculation_version NOT IN (1,2,3)
      OR benchmark.calculation_version >= (p_full_result->>'calculationVersion')::integer)) THEN RETURN false; END IF;
  UPDATE public.processed_match_telemetry SET data=jsonb_set(previous.data,'{fullResult}',p_full_result), updated_at=now()
    WHERE match_id=p_match_id AND platform=p_platform AND player_id=p_player_id;
  UPDATE public.global_benchmarks SET (damage, kills, win_place, game_mode, map_name, counter_latency_ms, initiative_rate, revive_rate, is_crossfire, utility_count, smoke_count, frag_count, pressure_index, enemy_death_distance, survival_time, isolation_index, min_dist, height_diff, smoke_rate, trade_rate, solo_kill_rate, reversal_rate, duel_win_rate, trade_latency_ms, lethal_throw_count, score, combat_score, tactical_score, survival_score, supp_count, team_wipes, match_type, death_phase, calculation_version, filter_version, population_evidence_version, source, tier) =
    (SELECT damage, kills, win_place, game_mode, map_name, counter_latency_ms, initiative_rate, revive_rate, is_crossfire, utility_count, smoke_count, frag_count, pressure_index, enemy_death_distance, survival_time, isolation_index, min_dist, height_diff, smoke_rate, trade_rate, solo_kill_rate, reversal_rate, duel_win_rate, trade_latency_ms, lethal_throw_count, score, combat_score, tactical_score, survival_score, supp_count, team_wipes, match_type, death_phase, calculation_version, filter_version, population_evidence_version, source, tier FROM jsonb_populate_record(NULL::public.global_benchmarks, to_jsonb(benchmark)||p_benchmark))
    WHERE id=benchmark.id;
  RETURN true;
END $$;
REVOKE ALL ON FUNCTION public.upgrade_analysis_calculation(text,text,text,jsonb,jsonb,jsonb,jsonb) FROM public, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.upgrade_analysis_calculation(text,text,text,jsonb,jsonb,jsonb,jsonb) TO service_role;

CREATE OR REPLACE FUNCTION public.upgrade_analysis_calculation_canonical(
  p_match_id text, p_platform text, p_player_id text,
  p_expected_data jsonb, p_full_result jsonb
) RETURNS boolean LANGUAGE plpgsql SECURITY INVOKER SET search_path = '' AS $$
DECLARE previous public.processed_match_telemetry%ROWTYPE;
BEGIN
  IF p_platform IS NULL OR p_platform NOT IN ('steam','kakao') OR nullif(p_player_id,'') IS NULL OR nullif(p_match_id,'') IS NULL
    OR p_full_result->>'matchId' IS DISTINCT FROM p_match_id
    OR p_full_result->>'platform' IS DISTINCT FROM p_platform
    OR p_full_result->>'player_id' IS DISTINCT FROM p_player_id
    OR lower(trim(p_full_result #>> '{stats,name}')) IS DISTINCT FROM p_player_id
    OR p_full_result->'v' IS DISTINCT FROM '73'::jsonb
    OR p_full_result->'calculationVersion' IS NULL OR p_full_result->'calculationVersion' NOT IN ('2'::jsonb,'3'::jsonb,'4'::jsonb)
    OR p_full_result->'populationEvidenceVersion' IS DISTINCT FROM '1'::jsonb
    OR p_full_result->>'gameMode' IS NULL OR p_full_result->>'gameMode' NOT IN ('solo','solo-fpp','duo','duo-fpp','squad','squad-fpp')
    OR p_full_result->>'matchType' IS NULL OR p_full_result->>'matchType' NOT IN ('official','competitive')
  THEN RAISE EXCEPTION 'canonical-calculation-invalid-input' USING ERRCODE='22023'; END IF;
  SELECT * INTO previous FROM public.processed_match_telemetry
    WHERE match_id=p_match_id AND platform=p_platform AND player_id=p_player_id FOR UPDATE;
  IF NOT FOUND OR previous.data IS DISTINCT FROM p_expected_data
    OR previous.data #> '{fullResult,v}' IS NULL OR previous.data #> '{fullResult,v}' NOT IN ('72'::jsonb,'73'::jsonb)
    OR coalesce(previous.data #>> '{fullResult,matchId}',previous.data #>> '{fullResult,match_id}',previous.data #>> '{fullResult,id}') IS DISTINCT FROM p_match_id
    OR previous.data #>> '{fullResult,platform}' IS DISTINCT FROM p_platform
    OR previous.data #>> '{fullResult,player_id}' IS DISTINCT FROM p_player_id
    OR lower(trim(previous.data #>> '{fullResult,stats,name}')) IS DISTINCT FROM p_player_id
    OR (previous.data #> '{fullResult,calculationVersion}' IS NOT NULL AND previous.data #> '{fullResult,calculationVersion}' <> 'null'::jsonb
      AND (previous.data #> '{fullResult,calculationVersion}' NOT IN ('1'::jsonb,'2'::jsonb,'3'::jsonb)
        OR previous.data #> '{fullResult,calculationVersion}' >= p_full_result->'calculationVersion'))
    OR coalesce(previous.data #>> '{fullResult,stats,playerId}', previous.data #>> '{fullResult,stats,accountId}') IS DISTINCT FROM coalesce(p_full_result #>> '{stats,playerId}', p_full_result #>> '{stats,accountId}')
    OR nullif(coalesce(p_full_result #>> '{stats,playerId}', p_full_result #>> '{stats,accountId}'),'') IS NULL
  THEN RETURN false; END IF;
  -- A normal eligible comparison row must use the paired CAS RPC instead.
  -- This function never inserts or changes comparison samples.
  IF p_full_result->'isValidBenchmark' IS DISTINCT FROM 'false'::jsonb AND EXISTS (
    SELECT 1 FROM public.global_benchmarks WHERE match_id=p_match_id AND platform=p_platform AND player_id=p_player_id
      AND filter_version=8 AND population_evidence_version=1
      AND match_type IN ('official','competitive') AND game_mode IN ('solo','solo-fpp','duo','duo-fpp','squad','squad-fpp')
  ) THEN RETURN false; END IF;
  UPDATE public.processed_match_telemetry SET data=jsonb_set(previous.data,'{fullResult}',p_full_result),updated_at=now()
    WHERE match_id=p_match_id AND platform=p_platform AND player_id=p_player_id;
  RETURN true;
END $$;
REVOKE ALL ON FUNCTION public.upgrade_analysis_calculation_canonical(text,text,text,jsonb,jsonb) FROM public,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.upgrade_analysis_calculation_canonical(text,text,text,jsonb,jsonb) TO service_role;

-- 2. 저장 데이터 기반 계산 4 보정. 계산 3→4는 기회 없음 대체값만 바꾸므로 텔레메트리 없이
-- fullResult.benchmark의 점수 필드와 global_benchmarks의 점수 컬럼만 바꾼다. 원본 관측값은 건드리지 않는다.
-- 점수 계산은 lib/pubg-analysis/calculation4StoredUpgrade.ts가 하고, 이 함수는 읽은 시점의 버전·점수가
-- 그대로인지(CAS)와 입력 형식만 검증한다.
CREATE OR REPLACE FUNCTION public.upgrade_analysis_calculation_stored_v4(
  p_match_id text, p_platform text, p_player_id text,
  p_expected_version integer, p_expected_score numeric, p_benchmark jsonb
) RETURNS boolean LANGUAGE plpgsql SECURITY INVOKER SET search_path = '' AS $$
DECLARE previous public.processed_match_telemetry%ROWTYPE;
  benchmark public.global_benchmarks%ROWTYPE;
  has_benchmark boolean;
  next_full_result jsonb;
BEGIN
  IF p_platform IS NULL OR p_platform NOT IN ('steam','kakao') OR nullif(p_player_id,'') IS NULL OR nullif(p_match_id,'') IS NULL
    OR p_expected_version IS NULL OR p_expected_version NOT IN (2,3) OR p_expected_score IS NULL
    OR jsonb_typeof(p_benchmark) IS DISTINCT FROM 'object'
    OR jsonb_typeof(p_benchmark->'score') IS DISTINCT FROM 'number'
    OR (p_benchmark->>'score')::numeric < 0 OR (p_benchmark->>'score')::numeric > 100
    OR jsonb_typeof(p_benchmark->'breakdown') IS DISTINCT FROM 'object'
    OR jsonb_typeof(p_benchmark #> '{breakdown,combat}') IS DISTINCT FROM 'number'
    OR jsonb_typeof(p_benchmark #> '{breakdown,tactical}') IS DISTINCT FROM 'number'
    OR jsonb_typeof(p_benchmark #> '{breakdown,survival}') IS DISTINCT FROM 'number'
    OR jsonb_typeof(p_benchmark->'impactScore') IS DISTINCT FROM 'number'
    OR (p_benchmark->>'impactGrade') NOT IN ('NORMAL','GOOD','CARRY','HARD_CARRY','LEGEND')
    OR ((p_benchmark->>'score')::numeric > 0 AND (p_benchmark->>'tier') NOT IN ('S+','S','A+','A','A-','B+','B','B-','C+','C','C-','D+','D','D-'))
    OR ((p_benchmark->>'score')::numeric = 0 AND p_benchmark->'tier' IS NOT NULL AND p_benchmark->'tier' <> 'null'::jsonb)
  THEN RAISE EXCEPTION 'stored-calculation-v4-invalid-input' USING ERRCODE='22023'; END IF;
  SELECT * INTO previous FROM public.processed_match_telemetry
    WHERE match_id=p_match_id AND platform=p_platform AND player_id=p_player_id FOR UPDATE;
  IF NOT FOUND
    OR previous.data #> '{fullResult,v}' IS DISTINCT FROM '73'::jsonb
    OR previous.data #>> '{fullResult,matchId}' IS DISTINCT FROM p_match_id
    OR previous.data #>> '{fullResult,platform}' IS DISTINCT FROM p_platform
    OR previous.data #>> '{fullResult,player_id}' IS DISTINCT FROM p_player_id
    OR previous.data #> '{fullResult,calculationVersion}' IS DISTINCT FROM to_jsonb(p_expected_version)
    OR jsonb_typeof(previous.data #> '{fullResult,benchmark,score}') IS DISTINCT FROM 'number'
    OR (previous.data #>> '{fullResult,benchmark,score}')::numeric <> p_expected_score
  THEN RETURN false; END IF;
  SELECT * INTO benchmark FROM public.global_benchmarks
    WHERE match_id=p_match_id AND platform=p_platform AND player_id=p_player_id FOR UPDATE;
  has_benchmark := FOUND;
  -- 비교 표본 행이 있으면 같은 버전·같은 점수일 때만 함께 올린다. 하나만 바뀌는 일은 없다.
  IF has_benchmark AND (benchmark.calculation_version IS DISTINCT FROM p_expected_version
    OR benchmark.score IS DISTINCT FROM p_expected_score::double precision) THEN RETURN false; END IF;
  next_full_result := jsonb_set(
    jsonb_set(previous.data->'fullResult', '{benchmark}',
      (previous.data #> '{fullResult,benchmark}')
        || jsonb_build_object('score', p_benchmark->'score', 'tier', p_benchmark->'tier', 'breakdown', p_benchmark->'breakdown',
          'impactScore', p_benchmark->'impactScore', 'impactGrade', p_benchmark->'impactGrade')),
    '{calculationVersion}', '4'::jsonb);
  UPDATE public.processed_match_telemetry SET data=jsonb_set(previous.data,'{fullResult}',next_full_result), updated_at=now()
    WHERE match_id=p_match_id AND platform=p_platform AND player_id=p_player_id;
  IF has_benchmark THEN
    UPDATE public.global_benchmarks SET
      score=(p_benchmark->>'score')::double precision,
      tier=p_benchmark->>'tier',
      combat_score=(p_benchmark #>> '{breakdown,combat}')::double precision,
      tactical_score=(p_benchmark #>> '{breakdown,tactical}')::double precision,
      survival_score=(p_benchmark #>> '{breakdown,survival}')::double precision,
      calculation_version=4
    WHERE id=benchmark.id;
  END IF;
  RETURN true;
END $$;
REVOKE ALL ON FUNCTION public.upgrade_analysis_calculation_stored_v4(text,text,text,integer,numeric,jsonb) FROM public,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.upgrade_analysis_calculation_stored_v4(text,text,text,integer,numeric,jsonb) TO service_role;

-- 3. 텔레메트리 복구 결과의 계산 버전 provenance에 4를 추가한다.
DO $migration$
DECLARE definition text; updated_definition text;
BEGIN
  SELECT pg_get_functiondef(p.oid) INTO STRICT definition
  FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
  WHERE n.nspname='public' AND p.proname='finalize_telemetry_cache_recovery';
  updated_definition := replace(definition,
    $old$v_processed.data #> '{fullResult,calculationVersion}' IN ('2'::jsonb,'3'::jsonb) AND v_benchmark.calculation_version::text$old$,
    $new$v_processed.data #> '{fullResult,calculationVersion}' IN ('2'::jsonb,'3'::jsonb,'4'::jsonb) AND v_benchmark.calculation_version::text$new$);
  IF definition = updated_definition THEN RAISE EXCEPTION 'calculation-v4: unexpected recovery function'; END IF;
  EXECUTE updated_definition;
END $migration$;

-- 4. 랭킹은 계산 4 요청에서 2·3·4를 함께 쓴다(설계 5절, 2026-10-17 결정). 같은 경기는 높은 버전이 우선이다.
create or replace function public.get_pubg_rankings(p_tab text,p_modes text[],p_match_type text,p_calculation integer,p_filter integer,p_population integer,p_result integer,p_excluded text[] default '{}',p_from timestamptz default null,p_to timestamptz default null)
returns table(platform text,player_id text,account_id text,value double precision,secondary double precision,tier text,game_mode text,map_name text,played_at timestamptz,match_count bigint)
language sql stable security invoker set search_path='' as $$
with tier_match_keys as materialized (
    select b.platform,b.player_id,b.match_id from public.global_benchmarks b
    where p_tab='tier'
      and (b.calculation_version=p_calculation or (p_calculation in (3,4) and b.calculation_version between 2 and p_calculation-1))
      and b.filter_version=p_filter and b.population_evidence_version=p_population
      and b.match_type in ('official','competitive') and b.score is not null
    union
    select m.platform,m.player_id,m.match_id from public.pubg_match_performance f
    join public.pubg_player_matches m on m.platform=f.platform and m.account_id=f.account_id and m.match_id=f.match_id
    where p_tab='tier'
      and (f.calculation_version=p_calculation or (p_calculation in (3,4) and f.calculation_version between 2 and p_calculation-1))
      and f.result_version=p_result and f.ranking_eligible
      and m.played_at>=coalesce(p_from,now()-interval '7 days') and m.played_at<coalesce(p_to,now()+interval '1 microsecond')
  ), candidate_matches as (
    select m.* from tier_match_keys k join public.pubg_player_matches m using (platform,player_id,match_id) where p_tab='tier'
    union all
    select m.* from public.pubg_player_matches m where p_tab<>'tier'
  ), candidates as (
    select m.platform,m.player_id,m.account_id,m.match_id,m.played_at,m.kills,m.damage,m.ranking_eligible,
      case when m.account_id ~ '^account\.[A-Za-z0-9_-]+$' then m.account_id else 'legacy:'||m.player_id end as identity
    from candidate_matches m
    where m.played_at>=coalesce(p_from,now()-interval '7 days') and m.played_at<coalesce(p_to,now()+interval '1 microsecond')
      and m.platform in ('steam','kakao') and m.game_mode=any(p_modes)
      and m.match_type in ('official','competitive') and (p_match_type='all' or m.match_type=p_match_type)
      and not ((m.platform||':'||lower(m.player_id))=any(p_excluded)
        or (m.account_id is not null and (m.platform||':account:'||m.account_id)=any(p_excluded))
        or (m.account_id is null and exists (
          select 1 from public.pubg_player_match_discovery discovery
          where discovery.platform=m.platform and discovery.match_id=m.match_id
            and (discovery.platform||':account:'||discovery.account_id)=any(p_excluded)
        ))
        or (m.account_id is null and exists (
          select 1 from public.pubg_player_cache cache
          where cache.platform=m.platform
            and cache.lower_nickname=lower(m.player_id)
            and (cache.platform||':account:'||cache.id)=any(p_excluded)
        )))
      and m.kills>=0 and m.damage>=0
  ), eligible as (
    select m.*,
      case when p_tab='tier' or m.ranking_eligible is not true then (
        select source.score from (
          select b.score,b.calculation_version,1 as source_priority
          from public.global_benchmarks b
          where b.platform=m.platform and b.player_id=m.player_id and b.match_id=m.match_id
            and (b.calculation_version=p_calculation or (p_calculation in (3,4) and b.calculation_version between 2 and p_calculation-1))
            and b.filter_version=p_filter and b.population_evidence_version=p_population
            and b.match_type in ('official','competitive') and b.score is not null
          union all
          select f.score,f.calculation_version,2 as source_priority
          from public.pubg_match_performance f
          where f.platform=m.platform and f.account_id=m.account_id and f.match_id=m.match_id
            and (f.calculation_version=p_calculation or (p_calculation in (3,4) and f.calculation_version between 2 and p_calculation-1))
            and f.result_version=p_result and f.ranking_eligible
        ) source order by source.calculation_version desc,source.source_priority limit 1
      ) end as performance_score
    from candidates m
  ), ranked as (
    select e.platform,e.player_id,e.match_id,e.identity,e.played_at,
      case p_tab when 'damage' then e.damage::double precision when 'kills' then e.kills::double precision else e.performance_score end as metric,
      case p_tab when 'damage' then e.kills::double precision else e.damage::double precision end as extra
    from eligible e where p_tab in ('damage','kills','tier')
      and (e.ranking_eligible is true or e.performance_score is not null)
      and (p_tab<>'tier' or e.performance_score is not null)
  ), best as (
    select r.*,row_number() over player_matches as pos,count(*) over player_matches as n
    from ranked r
    -- 전체 경기 수를 세되, 최고 경기 선택과 같은 정렬을 한 번만 수행한다.
    window player_matches as (partition by r.platform,r.identity
      order by r.metric desc,r.extra desc,r.played_at desc,r.match_id
      rows between unbounded preceding and unbounded following)
  ), winners as (
    select b.* from best b where pos=1
    order by metric desc,extra desc,played_at desc,b.platform,b.identity limit 30
  )
  select b.platform,b.player_id,m.account_id,b.metric,b.extra,s.tier,m.game_mode,m.map_name,b.played_at,b.n
  from winners b join public.pubg_player_matches m using (platform,player_id,match_id)
  left join lateral (
    select source.score,source.tier from (
        select b.score,b.tier,b.calculation_version,1 as source_priority
        from public.global_benchmarks b
        where b.platform=m.platform and b.player_id=m.player_id and b.match_id=m.match_id
          and (b.calculation_version=p_calculation or (p_calculation in (3,4) and b.calculation_version between 2 and p_calculation-1))
          and b.filter_version=p_filter and b.population_evidence_version=p_population
          and b.match_type in ('official','competitive') and b.score is not null
        union all
        select f.score,f.tier,f.calculation_version,2 as source_priority
        from public.pubg_match_performance f
        where f.platform=m.platform and f.account_id=m.account_id and f.match_id=m.match_id
          and (f.calculation_version=p_calculation or (p_calculation in (3,4) and f.calculation_version between 2 and p_calculation-1))
          and f.result_version=p_result and f.ranking_eligible
      ) source order by source.calculation_version desc,source.source_priority limit 1
  ) s on true
  order by b.metric desc,b.extra desc,b.played_at desc,b.platform,b.identity;
$$;
revoke all on function public.get_pubg_rankings(text,text[],text,integer,integer,integer,integer,text[],timestamptz,timestamptz) from public,anon,authenticated;
grant execute on function public.get_pubg_rankings(text,text[],text,integer,integer,integer,integer,text[],timestamptz,timestamptz) to service_role;

-- 5. 성과 작업 등록: 이전 계산 버전(2 이상 현재 미만) 자료가 있는 경기는 다시 계산하지 않는다.
-- 계산 3 도입 때의 guard(p_calculation<>3이면 꺼짐)를 일반화해, 계산 4 배포 후 대량 재계산을 막는다.
create or replace function public.seed_pubg_performance_jobs(p_calculation integer,p_result integer)
returns integer language plpgsql security invoker set search_path='' as $$
declare n integer;
begin
  -- Serialize seeding with claims so the backlog cap is a real global bound.
  perform pg_advisory_xact_lock(73130900);

  -- A deploy/version change must not leave old work retrying forever. Expired
  -- leases are safe to terminalize; an active worker keeps its lease intact.
  update public.pubg_performance_jobs j set state='excluded',
    last_error='stale performance job',lease_token=null,lease_expires_at=null,updated_at=now()
  where j.state in ('pending','retry')
    and (j.calculation_version<>p_calculation or j.result_version<>p_result
      or exists(select 1 from public.pubg_player_matches m
        where m.platform=j.platform and m.account_id=j.account_id and m.match_id=j.match_id
          and m.played_at < now()-interval '7 days'));
  update public.pubg_performance_jobs j set state='excluded',
    last_error='stale performance lease',lease_token=null,lease_expires_at=null,updated_at=now()
  where j.state='running' and j.lease_expires_at<=now()
    and (j.calculation_version<>p_calculation or j.result_version<>p_result
      or exists(select 1 from public.pubg_player_matches m
        where m.platform=j.platform and m.account_id=j.account_id and m.match_id=j.match_id
          and m.played_at < now()-interval '7 days'));

  -- Keep pending/retry/running work bounded even if an older runner filled the
  -- table before this guard existed. Preserve rows as excluded audit records.
  with overflow as (
    select ctid from (
      select ctid,row_number() over(order by next_attempt_at,updated_at,match_id) as pos
      from public.pubg_performance_jobs where state in ('pending','retry')
    ) ranked where pos>greatest(0,300-(select count(*) from public.pubg_performance_jobs where state='running'))
  )
  update public.pubg_performance_jobs j set state='excluded',last_error='performance backlog limit',updated_at=now()
  where j.ctid in (select ctid from overflow);

  insert into public.pubg_performance_jobs(platform,account_id,match_id,player_id,calculation_version,result_version)
  select m.platform,m.account_id,m.match_id,m.player_id,p_calculation,p_result
  from public.pubg_player_matches m
  where m.played_at between now()-interval '7 days' and now()
    and m.account_id ~ '^account\.[A-Za-z0-9_-]+$' and m.ranking_eligible is true
    and exists(select 1 from public.profiles p where lower(trim(p.pubg_nickname))=m.player_id
      and coalesce(p.pubg_platform,'steam')=m.platform and p.last_active_at >= now()-interval '7 days')
    and not exists(select 1 from public.pubg_performance_jobs j where
      (j.platform,j.account_id,j.match_id,j.calculation_version,j.result_version)=
      (m.platform,m.account_id,m.match_id,p_calculation,p_result))
    -- 이미 저장된 이전 계산 버전(2 이상 현재 미만) 자료와 활성 작업을 다시 계산하지 않는다.
    and (p_calculation not in (3,4) or (
      not exists(select 1 from public.pubg_match_performance f
        where f.platform=m.platform and f.account_id=m.account_id and f.match_id=m.match_id
          and f.calculation_version between 2 and p_calculation-1)
      and not exists(select 1 from public.pubg_performance_jobs old
        where old.platform=m.platform and old.account_id=m.account_id and old.match_id=m.match_id
          and old.calculation_version between 2 and p_calculation-1
          and (old.state='done' or (old.state='running' and old.lease_expires_at>now())))
      and not exists(select 1 from public.processed_match_telemetry old
        where old.platform=m.platform and old.player_id=m.player_id and old.match_id=m.match_id
          and jsonb_typeof(old.data #> '{fullResult,calculationVersion}')='number'
          and (old.data #>> '{fullResult,calculationVersion}')::numeric between 2 and p_calculation-1)
      and not exists(select 1 from public.global_benchmarks old
        where old.platform=m.platform and old.player_id=m.player_id and old.match_id=m.match_id
          and old.calculation_version between 2 and p_calculation-1)
    ))
  order by m.played_at desc
  limit least(50,greatest(0,300-(select count(*) from public.pubg_performance_jobs where state in ('pending','retry','running'))))
  on conflict do nothing;
  get diagnostics n=row_count; return n;
end $$;
REVOKE ALL ON FUNCTION public.seed_pubg_performance_jobs(integer,integer) FROM public,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.seed_pubg_performance_jobs(integer,integer) TO service_role;
