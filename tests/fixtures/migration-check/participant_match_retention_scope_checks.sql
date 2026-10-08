begin;
do $$
declare scope text;
begin
  if exists (select 1 from public.pubg_player_matches where retention_scope <> 'legacy') then
    raise exception 'existing rows must remain legacy';
  end if;
  insert into public.pubg_player_matches(player_id,platform,match_id,played_at,game_mode,map_name,kills,damage,win_place,match_type,account_id)
  values ('scope_target','steam','scope-check',now(),'squad','Baltic_Main',0,0,1,'official','account.scope');
  update public.pubg_player_matches set retention_scope='basic_only',damage=10 where match_id='scope-check';
  select retention_scope into scope from public.pubg_player_matches where match_id='scope-check';
  if scope <> 'legacy' then raise exception 'legacy downgraded'; end if;
  update public.pubg_player_matches set retention_scope='detail' where match_id='scope-check';
  -- Conflict upserts and old writers must preserve detail, while measured stats can update.
  insert into public.pubg_player_matches(player_id,platform,match_id,played_at,game_mode,map_name,kills,damage,win_place,match_type,account_id,retention_scope)
  values ('scope_target','steam','scope-check',now(),'squad','Baltic_Main',0,20,1,'official','account.scope','basic_only')
  on conflict(player_id,platform,match_id) do update set retention_scope=excluded.retention_scope,damage=excluded.damage;
  update public.pubg_player_matches set retention_scope='legacy' where match_id='scope-check';
  if not exists(select 1 from public.pubg_player_matches where match_id='scope-check' and retention_scope='detail' and damage=20) then
    raise exception 'detail downgraded or valid observation lost';
  end if;
  insert into public.pubg_player_matches(player_id,platform,match_id,played_at,game_mode,map_name,kills,damage,win_place,match_type,account_id,retention_scope)
  values ('scope_peer','steam','scope-check',now(),'squad','Baltic_Main',0,0,1,'official','account.peer','basic_only');
  update public.pubg_player_matches set retention_scope='detail' where player_id='scope_peer';
  if not exists(select 1 from public.pubg_player_matches where player_id='scope_peer' and retention_scope='detail') then
    raise exception 'basic promotion failed';
  end if;
  begin
    update public.pubg_player_matches set retention_scope='invented' where match_id='scope-check';
    raise exception 'invalid scope accepted';
  exception when check_violation then null;
  end;
  if has_function_privilege('anon','public.preserve_player_match_retention_scope()','EXECUTE')
    or has_function_privilege('authenticated','public.preserve_player_match_retention_scope()','EXECUTE')
    or not has_function_privilege('service_role','public.preserve_player_match_retention_scope()','EXECUTE') then
    raise exception 'retention scope function ACL invalid';
  end if;
end;
$$;
rollback;

begin;
do $$
declare batch jsonb; target jsonb; n integer; invalid jsonb;
begin
  if (select prosecdef from pg_proc where oid='public.upsert_pubg_participant_matches(jsonb)'::regprocedure)
    or has_function_privilege('anon','public.upsert_pubg_participant_matches(jsonb)','EXECUTE')
    or has_function_privilege('authenticated','public.upsert_pubg_participant_matches(jsonb)','EXECUTE')
    or not has_function_privilege('service_role','public.upsert_pubg_participant_matches(jsonb)','EXECUTE') then
    raise exception 'atomic participant writer ACL invalid';
  end if;
  target := jsonb_build_object('player_id','atomic_a','account_id','account.atomic_a','platform','steam',
    'match_id','atomic-scope-check','played_at',to_char(now() at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS"Z"'),
    'game_mode','squad','map_name','Baltic_Main','match_type','official','kills',0,'damage',0,'win_place',1,
    'ranking_eligible',true,'retention_scope','detail','knocks',2,'survival_time',900);
  batch := jsonb_build_array(target,
    (target-'knocks'-'survival_time')||'{"player_id":"atomic_b","account_id":"account.atomic_b","retention_scope":"basic_only"}'::jsonb);
  perform set_config('role','service_role',true);
  n := public.upsert_pubg_participant_matches(batch);
  if n<>2 then raise exception 'atomic participant batch not saved'; end if;
  batch := jsonb_set(batch,'{0}',(target-'knocks'-'survival_time')||'{"retention_scope":"basic_only"}'::jsonb);
  n := public.upsert_pubg_participant_matches(batch);
  if n<>2 or not exists(select 1 from public.pubg_player_matches where player_id='atomic_a'
    and match_id='atomic-scope-check' and retention_scope='detail' and knocks=2 and survival_time=900)
    or not exists(select 1 from public.pubg_player_matches where player_id='atomic_b'
      and match_id='atomic-scope-check' and retention_scope='basic_only' and knocks is null and survival_time is null) then
    raise exception 'atomic repeated upsert lost scope or observations';
  end if;
  -- 마지막 참가자의 계정 충돌로 앞선 신규 삽입과 기존 stats 갱신도 전부 취소된다.
  insert into public.pubg_player_matches(player_id,platform,match_id,played_at,game_mode,map_name,kills,damage,win_place,match_type,account_id)
  values ('atomic_z','steam','atomic-scope-check',now(),'squad','Baltic_Main',0,0,1,'official','account.other');
  invalid := jsonb_build_array(target||'{"kills":8}'::jsonb,
    target||'{"player_id":"atomic_c","account_id":"account.atomic_c"}'::jsonb,
    target||'{"player_id":"atomic_z","account_id":"account.atomic_z"}'::jsonb);
  begin
    perform public.upsert_pubg_participant_matches(invalid);
    raise exception 'account conflict accepted';
  exception when sqlstate '22023' then null;
  end;
  if exists(select 1 from public.pubg_player_matches where match_id='atomic-scope-check' and player_id='atomic_c')
    or exists(select 1 from public.pubg_player_matches where match_id='atomic-scope-check' and player_id='atomic_a' and kills<>0) then
    raise exception 'partial participant batch committed';
  end if;
  foreach invalid in array array[
    jsonb_build_array(target,target),
    jsonb_build_array(target,target||'{"platform":"kakao","player_id":"atomic_other","account_id":"account.atomic_other"}'::jsonb),
    jsonb_build_array(target||'{"kills":null}'::jsonb),
    jsonb_build_array(target||'{"played_at":"infinity"}'::jsonb),
    jsonb_build_array(target||'{"win_place":0}'::jsonb)
  ] loop
    begin
      perform public.upsert_pubg_participant_matches(invalid);
      raise exception 'invalid participant input accepted';
    exception when sqlstate '22023' then null;
    end;
  end loop;
  perform set_config('role','postgres',true);
end;
$$;
rollback;

begin;
do $$
declare cutoff timestamptz := now()-interval '15 days'; n integer;
begin
  insert into public.pubg_player_matches(player_id,platform,match_id,played_at,game_mode,map_name,kills,damage,win_place,match_type,account_id,retention_scope)
  select 'scope_fanout_'||i,'steam','scope-fanout-1',now()-interval '40 days','squad','Baltic_Main',0,0,1,'official','account.fanout_'||i,'basic_only'
  from generate_series(1,100) i;
  insert into public.pubg_player_matches(player_id,platform,match_id,played_at,game_mode,map_name,kills,damage,win_place,match_type)
  values ('scope_next','steam','scope-fanout-2',now()-interval '39 days','squad','Baltic_Main',0,0,1,'official');
  insert into public.processed_match_telemetry(match_id,platform,player_id,data)
  values ('scope-fanout-1','steam','scope_fanout_1','{}'),('scope-fanout-2','steam','scope_next','{}');
  select count(distinct match_id) into n from public.list_retention_archive_candidates(2,cutoff);
  if n<>2 then raise exception 'fanout consumed match candidate limit'; end if;
  if not exists(select 1 from public.list_retention_archive_candidates(1,cutoff,now()-interval '40 days','steam','scope-fanout-1')
    where match_id='scope-fanout-2') then raise exception 'match cursor skipped next match'; end if;
  update public.processed_match_telemetry set data=jsonb_build_object('fullResult',jsonb_build_object(
    'stats',jsonb_build_object('name',player_id,'playerId','account.fanout_1'),
    'v',72,'calculationVersion',1)) where match_id in ('scope-fanout-1','scope-fanout-2');
  select count(distinct match_id) into n from public.list_unretained_match_performance(100,null)
    where match_id in ('scope-fanout-1','scope-fanout-2');
  if n<>2 then raise exception 'fanout consumed performance preservation match limit'; end if;
end;
$$;
rollback;
