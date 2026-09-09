BEGIN;
DO $$
DECLARE patch text:='qa-meta-'||gen_random_uuid(); boundary timestamptz:='2000-01-15T00:00:00Z'; report jsonb; strict_report jsonb;
BEGIN
 INSERT INTO public.weapon_meta_match_samples(match_id,platform,player_id,played_at,patch_version,weapon_category,weapon_name,active_pick,total_damage,match_type,filter_version,population_evidence_version,first_sec_hits,sustained_hits,sustained_burst_count)
 SELECT patch||'-p-'||n,'steam','qa',boundary+interval '1 hour',patch,'AR','AKM',true,100,'official',8,1,1,2,1 FROM generate_series(1,1005) n;
 INSERT INTO public.weapon_meta_match_samples(match_id,platform,player_id,played_at,patch_version,weapon_category,weapon_name,active_pick,match_type)
 VALUES (patch||'-p-1','steam','qa',boundary+interval '1 hour',patch,'AR','M416',true,'official');
 -- A partial weapon row in an otherwise trusted match: it must not count as complete.
 UPDATE public.weapon_meta_match_samples SET filter_version=8,population_evidence_version=1 WHERE match_id=patch||'-p-1' AND weapon_name='M416';
 INSERT INTO public.weapon_meta_match_samples(match_id,platform,player_id,played_at,patch_version,weapon_category,weapon_name,active_pick,total_damage,match_type)
 SELECT patch||'-l-'||n,'steam','qa',boundary-interval '1 day','pre_'||patch,'AR','AKM',true,50,'official' FROM generate_series(1,2) n;
 INSERT INTO public.weapon_meta_match_samples(match_id,platform,player_id,played_at,patch_version,weapon_category,weapon_name,match_type)
 VALUES(patch||'-unknown','steam','qa',boundary-interval '1 day','pre_'||patch,'AR','AKM','unknown');
 report:=public.get_weapon_meta_report(patch,boundary,'all','auto');
 IF report->>'baselineSource'<>'legacy_reference' OR (report#>>'{population,pre,stored}')::int<>3
 OR (report#>>'{burstCollection,pre,total}')::int<>2 OR (report#>>'{burstCollection,post,total}')::int<>1005
 OR (report#>>'{burstCollection,post,completed}')::int<>1004 THEN RAISE EXCEPTION 'Incorrect aggregate or legacy fallback: %',report->'burstCollection'; END IF;
 IF NOT EXISTS(SELECT 1 FROM jsonb_array_elements(report->'scopePickShares') s WHERE s->>'period'='post' AND s->>'weapon_category'='ALL' AND (s->>'player_match_count')::int=1005 AND (s->>'weapon_pick_count')::int=1005) THEN RAISE EXCEPTION 'Category counted weapons instead of player matches'; END IF;
 strict_report:=public.get_weapon_meta_report(patch,boundary,'all','verified');
 IF (strict_report#>>'{burstCollection,pre,total}')::int<>0 THEN RAISE EXCEPTION 'Legacy leaked into verified baseline'; END IF;
 IF EXISTS(SELECT 1 FROM public.get_weapon_meta_comparison(patch,boundary,14,'all') WHERE period='pre') THEN RAISE EXCEPTION 'Original strict RPC changed'; END IF;
 UPDATE public.weapon_meta_match_samples SET filter_version=8,population_evidence_version=1 WHERE match_id=patch||'-l-1';
 report:=public.get_weapon_meta_report(patch,boundary,'all','auto');
 IF report->>'baselineSource'<>'verified' OR (report#>>'{burstCollection,pre,total}')::int<>1 THEN RAISE EXCEPTION 'Auto mixed legacy with verified'; END IF;
 report:=public.get_weapon_meta_report(patch,boundary,'all','legacy');
 IF report->>'baselineSource'<>'legacy_reference' OR (report#>>'{burstCollection,pre,total}')::int<>1 THEN RAISE EXCEPTION 'Explicit legacy mixed verified samples'; END IF;
 report:=public.get_weapon_meta_report(patch,boundary,'competitive','auto');
 IF (report#>>'{burstCollection,post,total}')::int<>0 THEN RAISE EXCEPTION 'Match type leaked'; END IF;
 IF has_function_privilege('anon','public.get_weapon_meta_report(text,timestamptz,text,text)','EXECUTE') OR has_function_privilege('authenticated','public.get_weapon_meta_report(text,timestamptz,text,text)','EXECUTE') THEN RAISE EXCEPTION 'Public execution allowed'; END IF;
END $$;
ROLLBACK;
SELECT true AS aggregate_legacy_strict_isolation_and_permissions_passed;
