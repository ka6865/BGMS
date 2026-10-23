begin;
set local role service_role;
do $$
declare v_row public.lol_player_match_summaries; v_bad jsonb;
begin
  select * into strict v_row from public.get_lol_player_match_summaries('challenge-seed',100,null) where match_id='KR_887997';
  if v_row.challenges <> '{"soloKills":2,"visionScorePerMinute":1.25,"teamDamagePercentage":0.3}'::jsonb
    or v_row.kills <> 2 then raise exception 'challenges backfill/filter changed the summary'; end if;
  if not exists (select 1 from public.lol_player_match_summaries
    where puuid='challenge-seed' and match_id='KR_887996' and kills=123 and challenges='{}') then
    raise exception 'rawless summary was changed'; end if;
  perform public.upsert_lol_player_match_summaries('KR_887997',null);
  if (select challenges from public.lol_player_match_summaries where puuid='challenge-seed' and match_id='KR_887997') <> v_row.challenges then
    raise exception 'challenges upsert was not idempotent'; end if;

  -- 배열·null·문자열 또는 키 누락은 빈 객체로 추출한다.
  foreach v_bad in array array['[]'::jsonb,'null'::jsonb,'"changed"'::jsonb,'{}'::jsonb] loop
    update public.lol_matches set request_json=jsonb_set(request_json,'{info,participants,0,challenges}',v_bad) where match_id='KR_887997';
    perform public.upsert_lol_player_match_summaries('KR_887997',null);
    if (select challenges from public.lol_player_match_summaries where puuid='challenge-seed' and match_id='KR_887997') <> '{}' then
      raise exception 'malformed challenges were not skipped'; end if;
  end loop;
  begin
    update public.lol_player_match_summaries set challenges=(select jsonb_object_agg('key'||i,i) from generate_series(1,32) i)
      where puuid='challenge-seed' and match_id='KR_887997';
    raise exception 'key limit missing';
  exception when check_violation then null; end;
  begin
    update public.lol_player_match_summaries set challenges=jsonb_build_object('soloKills',repeat('x',4096))
      where puuid='challenge-seed' and match_id='KR_887997';
    raise exception 'byte limit missing';
  exception when check_violation then null; end;
  begin
    update public.lol_player_match_summaries set challenges='[]' where puuid='challenge-seed' and match_id='KR_887997';
    raise exception 'object constraint missing';
  exception when check_violation then null; end;
end $$;
reset role;
do $$
declare v_role text;
begin
  foreach v_role in array array['anon','authenticated'] loop
    if has_function_privilege(v_role,'public.upsert_lol_player_match_summaries(text,text)','execute')
      or has_function_privilege(v_role,'public.get_lol_player_match_summaries(text,integer,timestamptz)','execute')
      or has_table_privilege(v_role,'public.lol_player_match_summaries','select,insert,update,delete') then
      raise exception 'public summary access granted'; end if;
  end loop;
  if not (select relrowsecurity from pg_class where oid='public.lol_player_match_summaries'::regclass)
    or (select prosecdef from pg_proc where oid='public.upsert_lol_player_match_summaries(text,text)'::regprocedure)
    or not has_function_privilege('service_role','public.upsert_lol_player_match_summaries(text,text)','execute') then
    raise exception 'RLS or invoker/service permission changed'; end if;
end $$;
rollback;
\echo '✅ LoL challenges 백필·화이트리스트·상한·권한 10개 시나리오 통과'
