begin;

do $fixture$
declare
  match_key constant text := '00000000-0000-0000-0000-000000000901';
  played_at_value timestamptz := pg_catalog.now() - interval '30 days';
  before_row jsonb;
  source_row jsonb;
  processed_row jsonb;
  full_b jsonb;
  compact_performance jsonb;
  recovery_evidence jsonb;
  recent_payload jsonb;
  payload jsonb;
  result jsonb;
  failure_reason text;
begin
  insert into public.pubg_player_matches
    (match_id,platform,player_id,account_id,played_at,game_mode,map_name,kills,damage,win_place,match_type)
  values
    (match_key,'steam','player_b',null,played_at_value,'unknown','unknown',0,0,99,'unknown'),
    (match_key,'steam','player_a','account.player-a',played_at_value,'squad-fpp','Baltic_Main',1,400,5,'official');

  insert into public.processed_match_telemetry(match_id,platform,player_id,data)
  values(match_key,'steam','player_a',jsonb_build_object('fullResult',jsonb_build_object(
    'matchId',match_key,'platform','steam','player_id','player_a','createdAt',played_at_value,
    'gameMode','squad-fpp','matchType','official','mapName','Baltic_Main',
    'matchInfo',jsonb_build_object('date',played_at_value,'mode','squad-fpp','matchType','official','mapId','erangel','duration',900),
    'stats',jsonb_build_object('name','player_a','playerId','account.player-a','kills',1,'damageDealt',400.5,'winPlace',5,'timeSurvived',800),
    'team',jsonb_build_array(
      jsonb_build_object('name','player_a','playerId','account.player-a','kills',1,'damageDealt',400.5,'winPlace',5),
      jsonb_build_object('name','player_b','playerId','account.player-b','kills',2,'damageDealt',300.5,'winPlace',4)
    )
  )));

  select pg_catalog.to_jsonb(m) into before_row from public.pubg_player_matches m
  where m.match_id=match_key and m.player_id='player_b';
  select pg_catalog.to_jsonb(m) into source_row from public.pubg_player_matches m
  where m.match_id=match_key and m.player_id='player_a';
  select pg_catalog.to_jsonb(p) into processed_row from public.processed_match_telemetry p
  where p.match_id=match_key and p.player_id='player_a';

  recovery_evidence := jsonb_build_object(
    'sourceScope',jsonb_build_object('matchId',match_key,'platform','steam','playerId','player_a'),
    'legacyKey',match_key || '_player_a_v4_analyze.json','verification','parent-exact-key',
    'rawArtifactSha256',repeat('a',64),'sourceFullResultSha256',repeat('b',64),
    'sourceMatchId',match_key,'sourcePlayerId','player_a',
    'observedPlayers',2,'officialPlayers',2,'observedTeams',1,'officialTeams',1,'observedTeamId',42,
    'telemetryFilter','current-allowlist-projection','cohortEvidence','LogPlayerCreate exact official lobby counts',
    'unavailableEvidence',jsonb_build_array('full-lobby-damage-rank','opponent-official-stats','LogPlayerAttack')
  );
  full_b := jsonb_build_object(
    'matchId',match_key,'platform','steam','player_id','player_b','createdAt',played_at_value,
    'gameMode','squad-fpp','matchType','official','mapName','Baltic_Main','mapId','Baltic_Main','v',4,'calculationVersion',12,
    'stats',jsonb_build_object('name','player_b','playerId','account.player-b','kills',2,'damageDealt',300.5,'winPlace',4,'timeSurvived',700),
    'totalPlayers',2,'totalTeams',1,'team',jsonb_build_array(),
    'retentionRecoveryEvidence',recovery_evidence
  );
  compact_performance := jsonb_build_object(
    'platform','steam','account_id','account.player-b','match_id',match_key,'player_id','player_b',
    'calculation_version',12,'result_version',4,'played_at',played_at_value,'summary_version',1,
    'source_checksum',repeat('c',64),'score',null,'tier',null,'benchmark',null,'ranking_eligible',false,
    'summary',jsonb_build_object(
      'matchId',match_key,'platform','steam','player_id','player_b','createdAt',played_at_value,
      'gameMode','squad-fpp','matchType','official','mapName','Baltic_Main','v',4,
      'stats',jsonb_build_object('name','player_b','playerId','account.player-b','kills',2,'damageDealt',300.5,'winPlace',4),
      'benchmark',null,'isValidBenchmark',false,'performanceHistorical',true,
      'retentionRecoveryContext','partial-legacy-team-events','team',jsonb_build_array(),
      'killDetails',jsonb_build_array(),'dbnoDetails',jsonb_build_array(),
      'retentionRecoveryEvidence',recovery_evidence
    )
  );
  payload := jsonb_build_object(
    'before',before_row,'sourceBasic',source_row,'processedSource',processed_row,
    'expectedBasic',before_row || jsonb_build_object('account_id','account.player-b','played_at',played_at_value,
      'game_mode','squad-fpp','map_name','Baltic_Main','kills',2,'damage',300,'win_place',4,'match_type','official'),
    'fullResult',full_b,'performance',compact_performance
  );

  if (select prosecdef from pg_catalog.pg_proc where oid='public.recover_retention_legacy_team(jsonb)'::regprocedure)
     or (select proconfig from pg_catalog.pg_proc where oid='public.recover_retention_legacy_team(jsonb)'::regprocedure)
       is distinct from array['search_path=""']::text[]
     or has_function_privilege('anon','public.recover_retention_legacy_team(jsonb)','EXECUTE')
     or has_function_privilege('authenticated','public.recover_retention_legacy_team(jsonb)','EXECUTE')
     or not has_function_privilege('service_role','public.recover_retention_legacy_team(jsonb)','EXECUTE') then
    raise exception 'RPC invoker/search_path/ACL mismatch';
  end if;

  perform pg_catalog.set_config('role','anon',true);
  begin
    perform public.recover_retention_legacy_team(payload);
    raise exception 'anon unexpectedly executed RPC';
  exception when insufficient_privilege then null;
  end;
  perform pg_catalog.set_config('role','postgres',true);

  begin
    perform public.recover_retention_legacy_team(null);
    raise exception 'malformed payload unexpectedly succeeded';
  exception when others then
    if sqlerrm <> 'legacy-team-retention-recovery-failed' then raise; end if;
    get stacked diagnostics failure_reason = pg_exception_detail;
    if failure_reason is distinct from 'validation-rejected' then raise exception 'unsafe validation failure reason'; end if;
  end;

  begin
    update public.pubg_player_matches set played_at=pg_catalog.now()-interval '1 hour'
    where match_id=match_key;
    update public.processed_match_telemetry set data=jsonb_set(jsonb_set(data,
      '{fullResult,createdAt}',to_jsonb(pg_catalog.now()-interval '1 hour')),
      '{fullResult,matchInfo,date}',to_jsonb(pg_catalog.now()-interval '1 hour')) where match_id=match_key;
    recent_payload := jsonb_set(jsonb_set(jsonb_set(payload,
      '{before}',(select to_jsonb(m) from public.pubg_player_matches m where m.match_id=match_key and m.player_id='player_b')),
      '{sourceBasic}',(select to_jsonb(m) from public.pubg_player_matches m where m.match_id=match_key and m.player_id='player_a')),
      '{processedSource}',(select to_jsonb(p) from public.processed_match_telemetry p where p.match_id=match_key and p.player_id='player_a'));
    recent_payload := jsonb_set(jsonb_set(jsonb_set(jsonb_set(recent_payload,
      '{expectedBasic,played_at}',to_jsonb(pg_catalog.now()-interval '1 hour')),
      '{fullResult,createdAt}',to_jsonb(pg_catalog.now()-interval '1 hour')),
      '{performance,played_at}',to_jsonb(pg_catalog.now()-interval '1 hour')),
      '{performance,summary,createdAt}',to_jsonb(pg_catalog.now()-interval '1 hour'));
    perform public.recover_retention_legacy_team(recent_payload);
    raise exception 'unexpired match unexpectedly recovered';
  exception when others then
    if sqlerrm <> 'legacy-team-retention-recovery-failed' then raise; end if;
  end;

  begin
    perform public.recover_retention_legacy_team(jsonb_set(payload,'{processedSource,updated_at}',to_jsonb((pg_catalog.now()+interval '1 second')::text)));
    raise exception 'stale source CAS unexpectedly succeeded';
  exception when others then
    if sqlerrm <> 'legacy-team-retention-recovery-failed' then raise; end if;
    get stacked diagnostics failure_reason = pg_exception_detail;
    if failure_reason is distinct from 'snapshot-changed' then raise exception 'snapshot failure reason mismatch'; end if;
  end;

  begin
    perform public.recover_retention_legacy_team(jsonb_set(payload,'{fullResult,stats,kills}','7'::jsonb));
    raise exception 'wrong target official stat unexpectedly succeeded';
  exception when others then
    if sqlerrm <> 'legacy-team-retention-recovery-failed' then raise; end if;
  end;

  begin
    perform public.recover_retention_legacy_team(jsonb_set(payload,'{before,damage}','12'::jsonb));
    raise exception 'incomplete placeholder unexpectedly succeeded';
  exception when others then
    if sqlerrm <> 'legacy-team-retention-recovery-failed' then raise; end if;
  end;

  insert into public.processed_match_telemetry(match_id,platform,player_id,data)
  values(match_key,'steam','player_b','{"fullResult":{}}'::jsonb);
  begin
    perform public.recover_retention_legacy_team(payload);
    raise exception 'existing target processed row unexpectedly succeeded';
  exception when others then
    if sqlerrm <> 'legacy-team-retention-recovery-failed' then raise; end if;
    get stacked diagnostics failure_reason = pg_exception_detail;
    if failure_reason is distinct from 'target-exists' then raise exception 'target collision failure reason mismatch'; end if;
  end;
  delete from public.processed_match_telemetry where match_id=match_key and platform='steam' and player_id='player_b';

  insert into public.pubg_player_matches
    (match_id,platform,player_id,account_id,played_at,game_mode,map_name,kills,damage,win_place,match_type)
  values(match_key,'steam','collision','account.player-b',played_at_value,'squad-fpp','Baltic_Main',2,300,4,'official');
  begin
    perform public.recover_retention_legacy_team(payload);
    raise exception 'account collision unexpectedly succeeded';
  exception when others then
    if sqlerrm <> 'legacy-team-retention-recovery-failed' then raise; end if;
  end;
  delete from public.pubg_player_matches where match_id=match_key and platform='steam' and player_id='collision';

  insert into public.telemetry_map_cache_entries(match_id,platform,player_id,mode,telemetry_version,storage_path,status,lease_expires_at)
  values(match_key,'steam','player_b','full',1,'fixture/legacy-team-pending.json','pending',pg_catalog.now()+interval '30 seconds');
  begin
    perform public.recover_retention_legacy_team(payload);
    raise exception 'active registry lease unexpectedly succeeded';
  exception when others then
    if sqlerrm <> 'legacy-team-retention-recovery-failed' then raise; end if;
    get stacked diagnostics failure_reason = pg_exception_detail;
    if failure_reason is distinct from 'active-lease' then raise exception 'active lease failure reason mismatch'; end if;
  end;
  delete from public.telemetry_map_cache_entries where storage_path='fixture/legacy-team-pending.json';

  insert into public.telemetry_map_cache_entries(match_id,platform,player_id,mode,telemetry_version,storage_path,status,lease_token,lease_expires_at)
  values(match_key,'steam','account.other-reference','full',1,'fixture/other-reference-lease.json','ready',gen_random_uuid(),pg_catalog.now()-interval '1 hour');
  begin
    perform public.recover_retention_legacy_team(payload);
    raise exception 'other account token unexpectedly ignored';
  exception when others then
    if sqlerrm <> 'legacy-team-retention-recovery-failed' then raise; end if;
  end;
  delete from public.telemetry_map_cache_entries where storage_path='fixture/other-reference-lease.json';

  insert into public.pubg_performance_jobs(platform,account_id,match_id,player_id,calculation_version,result_version,state)
  values('steam','account.other-reference',match_key,'other-reference',12,4,'retry');
  begin
    perform public.recover_retention_legacy_team(payload);
    raise exception 'other account retry work unexpectedly ignored';
  exception when others then
    if sqlerrm <> 'legacy-team-retention-recovery-failed' then raise; end if;
  end;
  delete from public.pubg_performance_jobs where match_id=match_key and account_id='account.other-reference';

  insert into public.pubg_performance_jobs(platform,account_id,match_id,player_id,calculation_version,result_version,state,lease_expires_at)
  values('steam','account.player-b',match_key,'player_b',12,4,'running',pg_catalog.now()+interval '30 seconds');
  begin
    perform public.recover_retention_legacy_team(payload);
    raise exception 'active performance lease unexpectedly succeeded';
  exception when others then
    if sqlerrm <> 'legacy-team-retention-recovery-failed' then raise; end if;
  end;
  delete from public.pubg_performance_jobs where match_id=match_key and account_id='account.player-b';

  result := public.recover_retention_legacy_team(payload);
  if result->>'saved' is distinct from 'true'
     or result->'basic'->>'account_id' is distinct from 'account.player-b'
     or result->'basic'->>'damage' is distinct from '300'
     or (select count(*) from public.processed_match_telemetry where match_id=match_key and player_id='player_b') <> 0
     or (select count(*) from public.pubg_match_performance where match_id=match_key and player_id='player_b') <> 1
     or (select summary->'retentionRecoveryEvidence'->>'rawArtifactSha256'
         from public.pubg_match_performance where match_id=match_key and player_id='player_b') <> repeat('a',64) then
    raise exception 'compact-only successful recovery result mismatch';
  end if;

  begin
    perform public.recover_retention_legacy_team(payload);
    raise exception 'repeat recovery unexpectedly succeeded';
  exception when others then
    if sqlerrm <> 'legacy-team-retention-recovery-failed' then raise; end if;
  end;
end;
$fixture$;

rollback;
select 'legacy team retention recovery scenarios passed' as result;
