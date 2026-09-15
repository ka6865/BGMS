begin;
do $$ declare t uuid;ok boolean;n integer;begin
 t=public.claim_pubg_encounter('steam','account.subject','test-encounter');
 if t is null then raise exception 'Encounter not claimed';end if;
 if public.claim_pubg_encounter('steam','account.subject','test-encounter') is not null then raise exception 'Duplicate claim';end if;
 if public.claim_pubg_encounter('kakao','account.other','other-match') is not null then raise exception 'Global concurrency bypass';end if;
 ok=public.finish_pubg_encounter(t,'{"encounters":[],"source":{"verifiedSubjectAccountId":"account.subject","platform":"steam","matchId":"test-encounter"}}');
 if not ok then raise exception 'Encounter not saved';end if;
 if public.finish_pubg_encounter(t,'{"encounters":[]}') then raise exception 'Old lease reused';end if;
 if public.claim_pubg_encounter('steam','account.subject','test-encounter') is not null then raise exception 'Empty result re-downloaded';end if;
 if not public.claim_pubg_encounter_profile_request() or not public.claim_pubg_encounter_profile_request() then raise exception 'Initial requests rejected';end if;
 if public.claim_pubg_encounter_profile_request() then raise exception 'Global budget bypass';end if;
 if has_table_privilege('authenticated','public.pubg_encounter_cache','SELECT') or has_function_privilege('anon','public.claim_pubg_encounter(text,text,text)','EXECUTE') then raise exception 'Public cache access';end if;
end $$;
do $$ declare failed uuid;other uuid;begin
 failed=public.claim_pubg_encounter('steam','account.failed','failed-match');
 if failed is null then raise exception 'Failed encounter claim missing';end if;
 if not public.fail_pubg_encounter(failed) then raise exception 'Failed encounter release rejected';end if;
 other=public.claim_pubg_encounter('steam','account.other','other-match');
 if other is null then raise exception 'Failed row retained global slot';end if;
 perform public.fail_pubg_encounter(other);
 if public.claim_pubg_encounter('steam','account.failed','failed-match') is not null then raise exception 'Failed row cooldown bypassed';end if;
 if has_function_privilege('authenticated','public.fail_pubg_encounter(uuid)','EXECUTE') then raise exception 'Public failure release access';end if;
end $$;
do $$ declare removed record;begin
 insert into public.pubg_player_match_discovery(platform,account_id,match_id,nickname_at_discovery,state,last_seen_at,saved_at)
 values('steam','account.cleanup','cleanup-discovery','Cleanup','saved',now()-interval '200 days',now()-interval '200 days');
 insert into auth.users(id) values('99999999-9999-4999-8999-999999999999') on conflict do nothing;
 insert into public.pubg_ban_watch_items(user_id,platform,subject_account_id,target_account_id,match_id,event_at,role,nickname_at_match,active_until)
 values('99999999-9999-4999-8999-999999999999','steam','account.cleanup-subject','account.cleanup-target','cleanup-watch',now()-interval '400 days','killer','Cleanup',now()-interval '200 days');
 insert into public.pubg_ban_status_events(platform,account_id,previous_status,observed_status,observed_at)
 values('steam','account.cleanup-target',null,'none',now()-interval '400 days');
 select * into removed from public.cleanup_pubg_tracking_retention();
 if removed.discovery_rows<>1 or removed.watch_rows<>1 or removed.event_rows<>1 then raise exception 'Tracking cleanup failed: %',removed;end if;
 if has_function_privilege('authenticated','public.cleanup_pubg_tracking_retention()','EXECUTE') then raise exception 'Public tracking cleanup access';end if;
end $$;
rollback;
