begin;
set local role service_role;
do $$
declare v_rows integer; v_removed jsonb;
begin
  if not exists (select 1 from public.lol_player_match_summaries where match_id='KR_889998'
    and teammates->0->>'puuid'='identity-backfill-peer') then raise exception 'identity backfill missing'; end if;
  if not exists (select 1 from public.lol_player_match_summaries where match_id='KR_889997'
    and teammates='[{"riotId":"No Raw#TEST","win":true}]'::jsonb) then raise exception 'expired raw summary modified'; end if;
  select count(*) into v_rows from public.get_lol_account_names_by_puuids(array['identity-backfill-own','unknown']);
  if v_rows<>1 then raise exception 'lookup returned unknown account'; end if;
  perform * from public.get_lol_account_names_by_puuids(array_fill('identity-backfill-own'::text,array[100]));
  begin
    perform * from public.get_lol_account_names_by_puuids(array_fill('x'::text,array[101]));
    raise exception 'lookup limit not enforced';
  exception when invalid_parameter_value then null; end;
  begin
    perform * from public.get_lol_account_names_by_puuids(array[null]::text[]);
    raise exception 'lookup accepted null identifier';
  exception when invalid_parameter_value then null; end;
  update public.lol_player_match_summaries set teammates='[]' where match_id='KR_889998';
  perform public.upsert_lol_player_match_summaries('KR_889998',null);
  if not exists (select 1 from public.lol_player_match_summaries where match_id='KR_889998'
    and teammates->0->>'puuid'='identity-backfill-peer') then raise exception 'extractor lost identity'; end if;
  -- 원문과 계정 이름을 잃은 동료도 PUUID로 삭제한다.
  update public.lol_player_match_summaries set teammates='[{"riotId":"Different#TEST","puuid":"identity-deleted-peer","win":true}]'
    where match_id='KR_889997';
  v_removed := public.delete_lol_account_data('identity-deleted-peer');
  if (v_removed->>'teammate_rows')::integer<>1 then raise exception 'deletion retained teammate identity'; end if;
end;
$$;
reset role;
do $$
declare v_role text;
begin
  foreach v_role in array array['anon','authenticated'] loop
    execute format('set local role %I',v_role);
    begin
      perform * from public.get_lol_account_names_by_puuids(array['identity-backfill-own']);
      raise exception '% unexpectedly executed participant lookup',v_role;
    exception when insufficient_privilege then null; end;
    reset role;
  end loop;
  if exists (select 1 from pg_proc where oid='public.get_lol_account_names_by_puuids(text[])'::regprocedure
    and (prosecdef or not ('search_path=""'=any(proconfig)))) then raise exception 'unsafe participant lookup settings'; end if;
end;
$$;
rollback;
