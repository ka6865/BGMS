begin;

create or replace function pg_temp.make_legacy_map_packet(
  p_match_id text,
  p_played_at timestamptz default (pg_catalog.now() - interval '30 days'),
  p_player_id text default 'map_player',
  p_account_id text default 'account.map-test',
  p_kills integer default 1,
  p_damage integer default 12,
  p_win_place integer default 5,
  p_map_name text default 'Baltic_Main',
  p_game_mode text default 'squad-fpp',
  p_match_type text default 'unavailable',
  p_knocks integer default 2,
  p_survival_time integer default 777
)
returns jsonb
language plpgsql
as $$
declare
  v_before jsonb;
  v_registry jsonb;
  v_expected jsonb;
  v_performance jsonb;
  v_summary jsonb;
  v_evidence jsonb;
  v_stats jsonb;
  v_storage_path text;
  v_registry_id bigint;
begin
  insert into public.pubg_player_matches (
    player_id,platform,match_id,played_at,game_mode,map_name,kills,damage,win_place,
    match_type,knocks,survival_time,created_at,ranking_eligible,account_id
  ) values (
    p_player_id,'steam',p_match_id,p_played_at,p_game_mode,p_map_name,p_kills,p_damage,p_win_place,
    p_match_type,p_knocks,p_survival_time,pg_catalog.now() - interval '30 days',null,null
  );
  v_storage_path := 'telemetry-map/v61/steam/' || p_match_id || '/' ||
    pg_catalog.substr(pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to(p_account_id,'UTF8')),'hex'),1,32) || '/full.json';
  insert into public.telemetry_map_cache_entries (
    match_id,platform,player_id,mode,telemetry_version,storage_path,status,lease_expires_at,lease_token,updated_at
  ) values (
    p_match_id,'steam',p_account_id,'full',61,v_storage_path,'ready',pg_catalog.now() - interval '1 second',null,
    pg_catalog.now() - interval '1 day'
  ) returning id into v_registry_id;

  select pg_catalog.to_jsonb(m) into v_before from public.pubg_player_matches m
  where m.match_id=p_match_id and m.platform='steam' and m.player_id=p_player_id;
  select pg_catalog.to_jsonb(c) into v_registry from public.telemetry_map_cache_entries c where c.id=v_registry_id;
  v_expected := v_before || pg_catalog.jsonb_build_object('account_id',p_account_id);
  v_evidence := pg_catalog.jsonb_build_object(
    'kind','legacy-map-retention-v1','key',v_storage_path,'sha256',pg_catalog.repeat('a',64),
    'etag','fixture-etag','sizeBytes',1024,
    'basicSnapshot',pg_catalog.jsonb_build_object(
      'account_id',p_account_id,'player_id',p_player_id,'platform','steam','match_id',p_match_id,
      'played_at',v_before->'played_at','game_mode',p_game_mode,'map_name',p_map_name,
      'kills',p_kills,'damage',p_damage,'win_place',p_win_place,'match_type',p_match_type
      ,'knocks',p_knocks,'survival_time',p_survival_time
    ),
    'registryId',v_registry_id,'registryUpdatedAt',v_registry->'updated_at'
  );
  v_stats := pg_catalog.jsonb_build_object(
    'name',p_player_id,'playerId',p_account_id,'kills',p_kills,'damageDealt',12.062774658,
    'winPlace',p_win_place,'rank',p_win_place
  );
  if p_knocks is not null then v_stats := v_stats || pg_catalog.jsonb_build_object('DBNOs',p_knocks); end if;
  if p_survival_time is not null then v_stats := v_stats || pg_catalog.jsonb_build_object('timeSurvived',p_survival_time); end if;
  v_summary := pg_catalog.jsonb_build_object(
    'matchId',p_match_id,'createdAt',v_before->'played_at','mapName',p_map_name,'gameMode',p_game_mode,
    'matchType',p_match_type,'v',0,'isSummary',true,'summarySource','pubg_match_performance',
    'performanceOnly',true,'performanceHistorical',true,'retentionRecoveryContext','partial-legacy-map-events',
    'stats',v_stats,
    'replayObservedMetrics',pg_catalog.jsonb_build_object('knocks',2,'shotEvents',21,'reviveEvents',1),
    'retentionRecoveryEvidence',v_evidence
  );
  v_performance := pg_catalog.jsonb_build_object(
    'platform','steam','account_id',p_account_id,'match_id',p_match_id,'player_id',p_player_id,
    'calculation_version',0,'result_version',0,'played_at',v_before->'played_at','summary_version',1,
    'source_checksum',pg_catalog.repeat('c',64),'summary',v_summary,
    'score',null,'tier',null,'benchmark',null,'ranking_eligible',false
  );
  return pg_catalog.jsonb_build_object(
    'before',v_before,'registry',v_registry,'expectedBasic',v_expected,'performance',v_performance
  );
end;
$$;

create or replace function pg_temp.assert_legacy_map_rejected(p_packet jsonb, p_label text)
returns void
language plpgsql
as $$
begin
  begin
    perform public.recover_retention_legacy_map(p_packet);
  exception when others then
    if sqlerrm = 'legacy-map-retention-recovery-failed' then return; end if;
    raise exception 'unexpected error for %: %',p_label,sqlerrm;
  end;
  raise exception 'RPC unexpectedly accepted %',p_label;
end;
$$;

do $fixture$
declare
  packet jsonb;
  result jsonb;
  basic_after jsonb;
  match_key text;
  account_value text;
  storage_key text;
begin
  if (select p.prosecdef from pg_catalog.pg_proc p where p.oid='public.recover_retention_legacy_map(jsonb)'::pg_catalog.regprocedure)
     or (select p.proconfig from pg_catalog.pg_proc p where p.oid='public.recover_retention_legacy_map(jsonb)'::pg_catalog.regprocedure)
       is distinct from array['search_path=""']::text[]
     or pg_catalog.has_function_privilege('anon','public.recover_retention_legacy_map(jsonb)','EXECUTE')
     or pg_catalog.has_function_privilege('authenticated','public.recover_retention_legacy_map(jsonb)','EXECUTE')
     or not pg_catalog.has_function_privilege('service_role','public.recover_retention_legacy_map(jsonb)','EXECUTE') then
    raise exception 'RPC invoker/search_path/ACL mismatch';
  end if;

  packet := pg_temp.make_legacy_map_packet('00000000-0000-0000-0000-000000009101');
  perform pg_catalog.set_config('role','anon',true);
  begin
    perform public.recover_retention_legacy_map(packet);
    raise exception 'anon unexpectedly executed RPC';
  exception when insufficient_privilege then null;
  end;
  perform pg_catalog.set_config('role','postgres',true);
  perform pg_temp.assert_legacy_map_rejected(null,'null packet');
  perform pg_temp.assert_legacy_map_rejected(packet || pg_catalog.jsonb_build_object('padding',pg_catalog.repeat('x',131100)),'oversized packet');
  perform pg_temp.assert_legacy_map_rejected(pg_catalog.jsonb_set(packet,'{before,retention_scope}','null'::jsonb),'explicit null scope');
  perform pg_temp.assert_legacy_map_rejected(pg_catalog.jsonb_set(packet,'{before,retention_scope}','"detail"'::jsonb),'changed scope');

  -- The successful packet keeps every observed field byte-for-byte and only
  -- links account_id; unavailable match_type remains unavailable.
  result := public.recover_retention_legacy_map(pg_catalog.jsonb_set(pg_catalog.jsonb_set(packet,
    '{before}',(packet->'before')-'retention_scope'),'{expectedBasic}',(packet->'expectedBasic')-'retention_scope'));
  if result->>'saved' is distinct from 'true'
     or result->'basic' is distinct from packet->'expectedBasic'
     or result->'basic'->>'match_type' is distinct from 'unavailable'
     or ((result->'basic') - array['account_id']::text[]) is distinct from ((packet->'before') - array['account_id']::text[])
     or (select pg_catalog.count(*) from public.pubg_match_performance p
       where p.platform='steam' and p.match_id='00000000-0000-0000-0000-000000009101'
         and p.account_id='account.map-test' and p.calculation_version=0 and p.result_version=0
         and p.score is null and p.tier is null and p.benchmark is null and p.ranking_eligible is false
         and p.summary->>'matchType'='unavailable' and p.summary->'stats'->>'DBNOs'='2'
         and p.summary->'stats'->>'timeSurvived'='777') <> 1 then
    raise exception 'valid legacy map recovery did not preserve exact row and compact performance';
  end if;

  packet := pg_temp.make_legacy_map_packet('00000000-0000-0000-0000-000000009120',
    pg_catalog.now()-interval '30 days','map_player','account.map-test',1,12,5,'Baltic_Main','squad-fpp','unknown',null,null);
  result := public.recover_retention_legacy_map(packet);
  if result->>'saved' is distinct from 'true'
     or (select p.summary->>'matchType' from public.pubg_match_performance p
       where p.match_id='00000000-0000-0000-0000-000000009120' and p.account_id='account.map-test') is distinct from 'unknown'
     or (select p.summary->'stats' ? 'DBNOs' or p.summary->'stats' ? 'timeSurvived'
       from public.pubg_match_performance p where p.match_id='00000000-0000-0000-0000-000000009120'
         and p.account_id='account.map-test') then
    raise exception 'null basic optional stats were not omitted';
  end if;

  packet := pg_temp.make_legacy_map_packet('00000000-0000-0000-0000-000000009121',
    pg_catalog.now()-interval '30 days','map_player','account.map-test',1,12,5,'Baltic_Main','squad-fpp','unknown',2,null);
  result := public.recover_retention_legacy_map(packet);
  if result->>'saved' is distinct from 'true'
     or (select p.summary->'stats'->>'DBNOs' from public.pubg_match_performance p
       where p.match_id='00000000-0000-0000-0000-000000009121' and p.account_id='account.map-test') is distinct from '2'
     or (select p.summary->'stats' ? 'timeSurvived' from public.pubg_match_performance p
       where p.match_id='00000000-0000-0000-0000-000000009121' and p.account_id='account.map-test') then
    raise exception 'non-null knocks were not preserved independently';
  end if;
  packet := pg_temp.make_legacy_map_packet('00000000-0000-0000-0000-000000009122',
    pg_catalog.now()-interval '30 days','map_player','account.map-test',1,12,5,'Baltic_Main','squad-fpp','unknown',null,777);
  result := public.recover_retention_legacy_map(packet);
  if result->>'saved' is distinct from 'true'
     or (select p.summary->'stats'->>'timeSurvived' from public.pubg_match_performance p
       where p.match_id='00000000-0000-0000-0000-000000009122' and p.account_id='account.map-test') is distinct from '777'
     or (select p.summary->'stats' ? 'DBNOs' from public.pubg_match_performance p
       where p.match_id='00000000-0000-0000-0000-000000009122' and p.account_id='account.map-test') then
    raise exception 'non-null survival time was not preserved independently';
  end if;

  packet := pg_temp.make_legacy_map_packet('00000000-0000-0000-0000-000000009102');
  update public.telemetry_map_cache_entries set updated_at=pg_catalog.now()
    where match_id='00000000-0000-0000-0000-000000009102' and player_id='account.map-test';
  perform pg_temp.assert_legacy_map_rejected(packet,'stale registry CAS snapshot');
  if (select account_id is not null from public.pubg_player_matches where match_id='00000000-0000-0000-0000-000000009102')
     or exists(select 1 from public.pubg_match_performance where match_id='00000000-0000-0000-0000-000000009102') then
    raise exception 'registry CAS rejection was not atomic';
  end if;

  packet := pg_temp.make_legacy_map_packet('00000000-0000-0000-0000-000000009103');
  update public.pubg_player_matches set survival_time=776
    where match_id='00000000-0000-0000-0000-000000009103' and player_id='map_player';
  perform pg_temp.assert_legacy_map_rejected(packet,'stale full basic snapshot');
  if (select account_id is not null from public.pubg_player_matches where match_id='00000000-0000-0000-0000-000000009103')
     or exists(select 1 from public.pubg_match_performance where match_id='00000000-0000-0000-0000-000000009103') then
    raise exception 'basic snapshot rejection was not atomic';
  end if;

  packet := pg_temp.make_legacy_map_packet('00000000-0000-0000-0000-000000009104');
  perform pg_temp.assert_legacy_map_rejected(jsonb_set(packet,'{expectedBasic,damage}','13'::jsonb),'expectedBasic changing observed stats');

  -- A different account's pending registry, discovery, or worker lease blocks
  -- recovery for the entire match.
  packet := pg_temp.make_legacy_map_packet('00000000-0000-0000-0000-000000009105');
  account_value := 'account.other-registry';
  storage_key := 'telemetry-map/v61/steam/00000000-0000-0000-0000-000000009105/' ||
    pg_catalog.substr(pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to(account_value,'UTF8')),'hex'),1,32) || '/full.json';
  insert into public.telemetry_map_cache_entries(match_id,platform,player_id,mode,telemetry_version,storage_path,status,
    lease_expires_at,lease_token)
  values('00000000-0000-0000-0000-000000009105','steam',account_value,'full',61,storage_key,'pending',
    pg_catalog.now()+interval '5 minutes',pg_catalog.gen_random_uuid());
  perform pg_temp.assert_legacy_map_rejected(packet,'other account active registry lease');

  packet := pg_temp.make_legacy_map_packet('00000000-0000-0000-0000-000000009106');
  insert into public.pubg_player_match_discovery(platform,account_id,match_id,nickname_at_discovery,state)
  values('steam','account.other-discovery','00000000-0000-0000-0000-000000009106','another_player','pending');
  perform pg_temp.assert_legacy_map_rejected(packet,'other account pending discovery');

  packet := pg_temp.make_legacy_map_packet('00000000-0000-0000-0000-000000009107');
  insert into public.pubg_performance_jobs(platform,account_id,match_id,player_id,calculation_version,result_version,
    state,lease_token,lease_expires_at)
  values('steam','account.other-job','00000000-0000-0000-0000-000000009107','another_player',0,0,
    'running',pg_catalog.gen_random_uuid(),pg_catalog.now()+interval '5 minutes');
  perform pg_temp.assert_legacy_map_rejected(packet,'other account active job');

  packet := pg_temp.make_legacy_map_packet('00000000-0000-0000-0000-000000009108');
  insert into public.processed_match_telemetry(match_id,platform,player_id,data)
  values('00000000-0000-0000-0000-000000009108','steam','map_player','{"fullResult":{}}'::jsonb);
  perform pg_temp.assert_legacy_map_rejected(packet,'existing processed analysis');

  packet := pg_temp.make_legacy_map_packet('00000000-0000-0000-0000-000000009109');
  insert into public.pubg_match_performance(platform,account_id,match_id,player_id,calculation_version,result_version,
    score,tier,benchmark,ranking_eligible)
  values('steam','account.map-test','00000000-0000-0000-0000-000000009109','map_player',7,7,50,'B','{}'::jsonb,true);
  perform pg_temp.assert_legacy_map_rejected(packet,'existing performance at another version');

  packet := pg_temp.make_legacy_map_packet('00000000-0000-0000-0000-000000009110',pg_catalog.now()-interval '1 day');
  perform pg_temp.assert_legacy_map_rejected(packet,'match inside 14 day window');

  packet := pg_temp.make_legacy_map_packet('00000000-0000-0000-0000-000000009111');
  perform pg_temp.assert_legacy_map_rejected(jsonb_set(packet,'{performance,summary,stats,kills}','2'::jsonb),'kill mismatch');
  packet := pg_temp.make_legacy_map_packet('00000000-0000-0000-0000-000000009112');
  perform pg_temp.assert_legacy_map_rejected(jsonb_set(packet,'{performance,summary,stats,damageDealt}','13.2'::jsonb),'event damage floor mismatch');
  packet := pg_temp.make_legacy_map_packet('00000000-0000-0000-0000-000000009113');
  perform pg_temp.assert_legacy_map_rejected(jsonb_set(packet,'{performance,summary,stats,winPlace}','4'::jsonb),'placement mismatch');

  packet := pg_temp.make_legacy_map_packet('00000000-0000-0000-0000-000000009114');
  perform pg_temp.assert_legacy_map_rejected(jsonb_set(packet,'{performance,score}','87'::jsonb),'fabricated score');
  packet := pg_temp.make_legacy_map_packet('00000000-0000-0000-0000-000000009115');
  perform pg_temp.assert_legacy_map_rejected(jsonb_set(packet,'{performance,ranking_eligible}','true'::jsonb),'ranking eligibility');

  packet := pg_temp.make_legacy_map_packet('00000000-0000-0000-0000-000000009116',
    pg_catalog.now()-interval '30 days','map_player','account.map-test',0,0,99);
  perform pg_temp.assert_legacy_map_rejected(packet,'placeholder 0/0/99');
  packet := pg_temp.make_legacy_map_packet('00000000-0000-0000-0000-000000009117',
    pg_catalog.now()-interval '30 days','map_player','account.map-test',1,12,5,'unknown','squad-fpp');
  perform pg_temp.assert_legacy_map_rejected(packet,'unknown map');

  packet := pg_temp.make_legacy_map_packet('00000000-0000-0000-0000-000000009118');
  account_value := 'account.map-test';
  storage_key := packet->'registry'->>'storage_path';
  update public.telemetry_map_cache_entries set storage_path=storage_key || '.tampered'
    where match_id='00000000-0000-0000-0000-000000009118' and player_id=account_value;
  perform pg_temp.assert_legacy_map_rejected(packet,'registry key and snapshot tampering');

  packet := pg_temp.make_legacy_map_packet('00000000-0000-0000-0000-000000009119');
  insert into public.pubg_player_matches (
    player_id,platform,match_id,played_at,game_mode,map_name,kills,damage,win_place,match_type,account_id
  ) values ('other_alias','steam','00000000-0000-0000-0000-000000009119',pg_catalog.now()-interval '30 days',
    'squad-fpp','Baltic_Main',1,12,5,'unavailable','account.map-test');
  perform pg_temp.assert_legacy_map_rejected(packet,'account collision');
end;
$fixture$;

rollback;
