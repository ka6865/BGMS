-- 전적 목록 보조 값(team_id·이동 거리·최장 킬)의 저장 계약.
begin;
do $$
declare target jsonb; batch jsonb; invalid jsonb; n integer;
begin
  target := jsonb_build_object('player_id','extras_a','account_id','account.extras_a','platform','steam',
    'match_id','row-extras-check','played_at',to_char(now() at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS"Z"'),
    'game_mode','squad','map_name','Baltic_Main','match_type','official','kills',1,'damage',120,'win_place',3,
    'ranking_eligible',true,'retention_scope','basic_only','team_id',7,'travel_distance',2450,'longest_kill',183);
  batch := jsonb_build_array(target,
    target||'{"player_id":"extras_b","account_id":"account.extras_b","team_id":7}'::jsonb,
    (target-'team_id'-'travel_distance'-'longest_kill')||'{"player_id":"extras_c","account_id":"account.extras_c"}'::jsonb);
  perform set_config('role','service_role',true);
  n := public.upsert_pubg_participant_matches(batch);
  if n<>3 or not exists(select 1 from public.pubg_player_matches where player_id='extras_a'
      and match_id='row-extras-check' and team_id=7 and travel_distance=2450 and longest_kill=183)
    or not exists(select 1 from public.pubg_player_matches where player_id='extras_c'
      and match_id='row-extras-check' and team_id is null and travel_distance is null and longest_kill is null) then
    raise exception 'row extras not saved as observed';
  end if;
  -- 보조 값이 없는 재수집은 이미 관측한 값을 지우지 않는다.
  n := public.upsert_pubg_participant_matches(jsonb_build_array(target-'team_id'-'travel_distance'-'longest_kill'));
  if n<>1 or not exists(select 1 from public.pubg_player_matches where player_id='extras_a'
      and match_id='row-extras-check' and team_id=7 and travel_distance=2450 and longest_kill=183) then
    raise exception 'row extras cleared by unobserved upsert';
  end if;
  foreach invalid in array array[
    jsonb_build_array(target||'{"team_id":-1}'::jsonb),
    jsonb_build_array(target||'{"team_id":40000}'::jsonb),
    jsonb_build_array(target||'{"travel_distance":12.5}'::jsonb),
    jsonb_build_array(target||'{"longest_kill":"183"}'::jsonb),
    jsonb_build_array(target||'{"travel_distance":-3}'::jsonb)
  ] loop
    begin
      perform public.upsert_pubg_participant_matches(invalid);
      raise exception 'invalid row extras accepted';
    exception when sqlstate '22023' then null;
    end;
  end loop;
  perform set_config('role','postgres',true);
  begin
    insert into public.pubg_player_matches(player_id,platform,match_id,played_at,game_mode,map_name,kills,damage,win_place,match_type,team_id)
    values ('extras_direct','steam','row-extras-check',now(),'squad','Baltic_Main',0,0,1,'official',-5);
    raise exception 'row extras check constraint missing';
  exception when check_violation then null;
  end;
end;
$$;
rollback;
