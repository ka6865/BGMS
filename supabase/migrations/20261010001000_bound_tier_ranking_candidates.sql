-- 티어는 점수가 있는 경기부터 조회한다. 피해량/킬 후보와 기존 점수·프라이버시는 유지한다.
DO $migration$
DECLARE definition text; updated_definition text;
BEGIN
  SELECT pg_get_functiondef(p.oid) INTO STRICT definition
  FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
  WHERE n.nspname='public' AND p.proname='get_pubg_rankings';
  IF strpos(definition, 'with candidates as materialized (')=0
    OR strpos(definition, E'from public.pubg_player_matches m\n    where m.played_at')=0
  THEN RAISE EXCEPTION 'tier-ranking: unexpected ranking function'; END IF;
  updated_definition := replace(definition,
    'with candidates as materialized (',
    $new$with tier_match_keys as materialized (
    select b.platform,b.player_id,b.match_id from public.global_benchmarks b
    where p_tab='tier'
      and (b.calculation_version=p_calculation or (p_calculation=3 and b.calculation_version=2))
      and b.filter_version=p_filter and b.population_evidence_version=p_population
      and b.match_type in ('official','competitive') and b.score is not null
    union
    select m.platform,m.player_id,m.match_id from public.pubg_match_performance f
    join public.pubg_player_matches m on m.platform=f.platform and m.account_id=f.account_id and m.match_id=f.match_id
    where p_tab='tier'
      and (f.calculation_version=p_calculation or (p_calculation=3 and f.calculation_version=2))
      and f.result_version=p_result and f.ranking_eligible
      and m.played_at>=now()-interval '7 days' and m.played_at<=now()
  ), candidate_matches as (
    select m.* from tier_match_keys k join public.pubg_player_matches m using (platform,player_id,match_id) where p_tab='tier'
    union all
    select m.* from public.pubg_player_matches m where p_tab<>'tier'
  ), candidates as materialized ($new$);
  updated_definition := replace(updated_definition,
    E'from public.pubg_player_matches m\n    where m.played_at',
    E'from candidate_matches m\n    where m.played_at');
  EXECUTE updated_definition;
END $migration$;
