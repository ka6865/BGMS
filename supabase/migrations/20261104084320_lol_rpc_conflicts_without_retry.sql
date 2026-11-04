begin;
set local lock_timeout='2s';

-- 40001은 PostgREST의 무한 재시도를 유발하므로 도메인 충돌은 HTTP 409로 반환한다.
-- https://supabase.com/kb/troubleshooting/high-cpu-and-infinite-transaction-retries-when-using-custom-error-codes-in-rpc-functions
do $$
declare signature text; definition text; expected_count integer; marker_count integer;
begin
  for signature,expected_count in select * from (values
    ('public.persist_lol_search_snapshot(text,uuid,text,jsonb,text,text,text,jsonb,jsonb,jsonb)',1),
    ('public.persist_lol_match_details(text,uuid,text,jsonb,text,text,text,jsonb,jsonb,jsonb)',1),
    ('public.put_lol_challenge_catalog_cache(jsonb,text,uuid)',1),
    ('public.commit_lol_season_progress(text,text,bigint,bigint,text[],jsonb,timestamptz)',1),
    ('public.renew_lol_mayhem_dataset_lease(uuid)',2),
    ('public.ingest_lol_mayhem_dataset(text,text,text,text,jsonb,jsonb,jsonb)',4),
    ('public.review_lol_mayhem_dataset(bigint,text,uuid,bigint,text)',1)
  ) functions(signature,expected_count) loop
    if to_regprocedure(signature) is null then raise exception 'missing LoL conflict function: %',signature; end if;
    definition:=pg_get_functiondef(to_regprocedure(signature));
    marker_count:=(length(definition)-length(replace(definition,'''40001''','')))/7;
    if marker_count<>expected_count then raise exception 'unexpected LoL conflict contract: %',signature; end if;
    execute replace(definition,'''40001''','''PT409''');
  end loop;
end $$;
commit;
