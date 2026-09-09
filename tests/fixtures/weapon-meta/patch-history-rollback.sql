BEGIN;
DO $$
DECLARE a text:='qa-a-'||substr(gen_random_uuid()::text,1,8); b text:='qa-b-'||substr(gen_random_uuid()::text,1,8); r jsonb;
BEGIN
 INSERT INTO public.weapon_meta_patches(version,maintenance_started_at,starts_at,timing_status) VALUES
 (a,'2001-01-15T00:00Z','2001-01-15T08:30Z','confirmed'),(b,'2001-01-29T00:00Z','2001-01-29T08:30Z','confirmed'),(b||'-end','2001-02-12T00:00Z','2001-02-12T08:30Z','confirmed');
 INSERT INTO public.weapon_meta_match_samples(match_id,platform,player_id,played_at,patch_version,weapon_category,weapon_name,active_pick,total_damage,match_type)
 SELECT a||'-'||n,'steam','qa',t::timestamptz,'stale-env','AR','AKM',true,100,'official'
 FROM (VALUES (1,'2001-01-14T23:59Z'),(2,'2001-01-15T00:00Z'),(3,'2001-01-15T08:30Z'),(4,'2001-01-28T23:59Z'),(5,'2001-01-29T00:00Z'),(6,'2001-01-29T08:30Z'),(7,'2001-01-30T00:00Z'),(8,'2000-12-31T23:59Z')) x(n,t);
 INSERT INTO public.weapon_meta_match_samples(match_id,platform,player_id,played_at,patch_version,weapon_category,weapon_name,match_type)
 VALUES (a||'-unknown','steam','qa','2001-01-20T00:00Z',a,'AR','AKM','unknown');
 INSERT INTO public.weapon_meta_match_samples(match_id,platform,player_id,played_at,patch_version,weapon_category,weapon_name,active_pick,total_damage,match_type)
 VALUES (a||'-gas','steam','qa','2001-01-20T00:00Z',a,'SMG','BP_Baltic_GasPump',true,100,'official');
 r:=public.get_weapon_meta_patch_report(a,'all');
 IF (r#>>'{burstCollection,pre,total}')::int<>1 OR (r#>>'{burstCollection,post,total}')::int<>2 THEN RAISE EXCEPTION 'Old patch window: %',r->'burstCollection'; END IF;
 IF (SELECT count(*) FROM jsonb_array_elements(r->'dailyWeaponTrend') d WHERE d->>'date'='2001-01-15' AND d->>'scope'='weapon' AND d->>'weapon_name'='AKM' AND d->>'period' IN ('pre','post') AND (d->>'player_match_count')::int=1)<>2 THEN RAISE EXCEPTION 'Patch-day pre/post trend mixed'; END IF;
 r:=public.get_weapon_meta_patch_report(b,'all');
 IF (r#>>'{burstCollection,pre,total}')::int<>2 OR (r#>>'{burstCollection,post,total}')::int<>2 THEN RAISE EXCEPTION 'Next patch reuse or maintenance: %',r->'burstCollection'; END IF;
 IF NOT EXISTS(SELECT 1 FROM public.weapon_meta_match_samples WHERE match_id=a||'-3' AND patch_version=a) OR NOT EXISTS(SELECT 1 FROM public.weapon_meta_match_samples WHERE match_id=a||'-6' AND patch_version=b) THEN RAISE EXCEPTION 'Static environment overrode match date'; END IF;
 r:=public.get_weapon_meta_patch_report(a,'competitive');
 IF (r#>>'{burstCollection,post,total}')::int<>0 THEN RAISE EXCEPTION 'Match type leaked'; END IF;
 UPDATE public.weapon_meta_match_samples SET patch_version='stale-again' WHERE match_id=a||'-3';
 IF NOT EXISTS(SELECT 1 FROM public.weapon_meta_match_samples WHERE match_id=a||'-3' AND patch_version=a) THEN RAISE EXCEPTION 'Reanalysis changed historical patch'; END IF;
 IF has_function_privilege('anon','public.get_weapon_meta_patch_report(text,text)','EXECUTE') OR has_function_privilege('authenticated','public.get_weapon_meta_patch_report(text,text)','EXECUTE') THEN RAISE EXCEPTION 'Public SQL execution allowed'; END IF;
END $$;
ROLLBACK;
SELECT true AS patch_boundaries_reuse_match_type_and_reanalysis_passed;
