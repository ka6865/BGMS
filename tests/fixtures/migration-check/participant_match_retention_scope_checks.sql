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
