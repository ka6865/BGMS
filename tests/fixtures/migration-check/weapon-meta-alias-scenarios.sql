insert into public.weapon_meta_patches values ('alias-test',now()-interval '3 days',now()-interval '2 days','confirmed');
insert into public.weapon_meta_match_samples (match_id,platform,player_id,played_at,match_type,weapon_name,weapon_category,active_pick,total_damage,total_kills,total_dbnos,first_sec_hits,sustained_hits,sustained_burst_count,patch_version) values
 ('m1','steam','player',now()-interval '1 day','official','FamasG2','AR',true,100,1,0,1,2,1,'alias-test'),
 ('m1','steam','player',now()-interval '1 day','official','파마스','AR',true,50,0,1,1,3,1,'alias-test'),
 ('m2','steam','player',now()-interval '1 day','official','DuncansHK416','AR',true,150,1,0,1,2,1,'alias-test'),
 ('m3','steam','player',now()-interval '1 day','official','LunchmeatsAK47','AR',true,200,0,1,1,2,1,'alias-test');
do $$
declare report jsonb; famas jsonb;
begin
 report := public.get_weapon_meta_patch_report('alias-test','all');
 select x into famas from jsonb_array_elements(report->'comparison') x where x->>'weapon_name'='파마스';
 if (famas->>'active_pick_count')::int <> 1 or (famas->>'total_damage')::numeric <> 150 then raise exception 'alias match dedup failed: %',famas; end if;
 if exists(select 1 from jsonb_array_elements(report->'comparison') x where x->>'weapon_name' in ('FamasG2','DuncansHK416','LunchmeatsAK47')) then raise exception 'alias remains'; end if;
 if not exists(select 1 from jsonb_array_elements(report->'comparison') x where x->>'weapon_name'='M416') or not exists(select 1 from jsonb_array_elements(report->'comparison') x where x->>'weapon_name'='AKM') then raise exception 'canonical names missing'; end if;
 if not exists(select 1 from jsonb_array_elements(report->'dailyWeaponTrend') x where x->>'weapon_name'='파마스' and (x->>'weapon_pick_count')::int=1) then raise exception 'daily trend mismatch'; end if;
end $$;
