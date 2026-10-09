BEGIN;
INSERT INTO public.profiles(id,pubg_nickname,pubg_platform,last_active_at)
VALUES ('00000000-0000-0000-0000-000000000903','coexist','steam',now());
INSERT INTO public.pubg_player_matches(player_id,platform,account_id,match_id,played_at,game_mode,map_name,match_type,kills,damage,win_place,ranking_eligible)
SELECT 'coexist','steam','account.coexist',id,now()-interval '1 day',
  CASE WHEN id='coexist-mixed' THEN 'duo' ELSE 'squad' END,'Baltic_Main','official',5,500,1,true
FROM unnest(ARRAY['coexist-benchmark','coexist-retained','coexist-done','coexist-running','coexist-canonical','coexist-new','coexist-mixed']) id;
INSERT INTO public.global_benchmarks(match_id,platform,player_id,game_mode,match_type,tier,score,filter_version,population_evidence_version,calculation_version)
VALUES ('coexist-benchmark','steam','coexist','squad','official','A+',77,8,1,2);
INSERT INTO public.processed_match_telemetry(match_id,platform,player_id,data)
VALUES ('coexist-canonical','steam','coexist','{"fullResult":{"calculationVersion":2,"v":73}}');
INSERT INTO public.pubg_match_performance(platform,account_id,match_id,player_id,calculation_version,result_version,score,tier,benchmark,ranking_eligible)
VALUES ('steam','account.coexist','coexist-retained','coexist',2,73,75,'A+','{"score":75}',true),
  ('steam','account.coexist','coexist-mixed','coexist',2,73,92,'S+','{"score":92}',true),
  ('steam','account.coexist','coexist-mixed','coexist',3,73,74,'A','{"score":74}',true);
INSERT INTO public.pubg_performance_jobs(platform,account_id,match_id,player_id,calculation_version,result_version,state,lease_token,lease_expires_at)
VALUES ('steam','account.coexist','coexist-done','coexist',2,73,'done',null,null),
  ('steam','account.coexist','coexist-running','coexist',2,73,'running',gen_random_uuid(),now()+interval '5 minutes');
DO $$
DECLARE r record; n integer;
BEGIN
  SELECT * INTO r FROM public.get_pubg_rankings('tier',ARRAY['squad'],'official',3,8,1,73,'{}');
  IF r.value IS DISTINCT FROM 77::double precision OR r.match_count IS DISTINCT FROM 2::bigint
    THEN RAISE EXCEPTION 'FAIL: existing v2 ranking disappeared'; END IF;
  SELECT * INTO r FROM public.get_pubg_rankings('tier',ARRAY['duo'],'official',3,8,1,73,'{}');
  IF r.value IS DISTINCT FROM 74::double precision OR r.match_count IS DISTINCT FROM 1::bigint
    THEN RAISE EXCEPTION 'FAIL: mixed retained match duplicated or older result selected'; END IF;
  SELECT * INTO r FROM public.get_pubg_rankings('tier',ARRAY['duo'],'official',2,8,1,73,'{}');
  IF r.value IS DISTINCT FROM 92::double precision THEN RAISE EXCEPTION 'FAIL: old reader changed'; END IF;
  SELECT count(*) INTO n FROM public.get_pubg_rankings('tier',ARRAY['duo','squad'],'official',3,8,1,73,ARRAY['steam:coexist']);
  IF n<>0 THEN RAISE EXCEPTION 'FAIL: mixed-version ranking privacy'; END IF;
  SELECT public.seed_pubg_performance_jobs(3,73) INTO n;
  IF n<>1 OR NOT EXISTS(SELECT 1 FROM public.pubg_performance_jobs WHERE match_id='coexist-new' AND calculation_version=3)
    THEN RAISE EXCEPTION 'FAIL: new-only v3 seeding'; END IF;
  IF EXISTS(SELECT 1 FROM public.pubg_performance_jobs WHERE match_id LIKE 'coexist-%' AND match_id<>'coexist-new' AND calculation_version=3)
    THEN RAISE EXCEPTION 'FAIL: old calculation was scheduled again'; END IF;
  IF (SELECT data #> '{fullResult,calculationVersion}' FROM public.processed_match_telemetry WHERE match_id='coexist-canonical') IS DISTINCT FROM '2'::jsonb
    THEN RAISE EXCEPTION 'FAIL: legacy relabel'; END IF;
  RAISE NOTICE 'PASS: v2/v3 ranking, privacy, deduplication, existing result preservation, new-only seed';
END $$;
ROLLBACK;
