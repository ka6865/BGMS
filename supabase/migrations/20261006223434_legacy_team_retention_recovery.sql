create or replace function public.recover_retention_legacy_team(p_packet jsonb)
returns jsonb
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_before jsonb;
  v_source_basic jsonb;
  v_source_processed jsonb;
  v_expected jsonb;
  v_full jsonb;
  v_performance jsonb;
  v_stats jsonb;
  v_source_stats jsonb;
  v_team_member jsonb;
  v_evidence jsonb;
  v_summary jsonb;
  v_basic_after jsonb;
  v_match_id text;
  v_platform text;
  v_player_id text;
  v_account_id text;
  v_source_player_id text;
  v_before_time timestamptz;
  v_source_time timestamptz;
  v_expected_time timestamptz;
  v_source_full_time timestamptz;
  v_full_time timestamptz;
  v_summary_time timestamptz;
  v_calculation_version integer;
  v_result_version integer;
  v_summary_version integer;
  v_metadata_repair boolean;
  v_stats_repair boolean;
  v_source_map text;
  v_full_map text;
  v_basic_map text;
  v_lock_deadline timestamptz;
begin
  if p_packet is null or pg_catalog.jsonb_typeof(p_packet) is distinct from 'object'
     or pg_catalog.octet_length(p_packet::text) > 8388608
     or pg_catalog.jsonb_typeof(p_packet->'before') is distinct from 'object'
     or pg_catalog.jsonb_typeof(p_packet->'sourceBasic') is distinct from 'object'
     or pg_catalog.jsonb_typeof(p_packet->'processedSource') is distinct from 'object'
     or pg_catalog.jsonb_typeof(p_packet->'expectedBasic') is distinct from 'object'
     or pg_catalog.jsonb_typeof(p_packet->'fullResult') is distinct from 'object'
     or pg_catalog.jsonb_typeof(p_packet->'performance') is distinct from 'object' then
    raise exception 'invalid packet';
  end if;

  v_before := p_packet->'before';
  v_source_basic := p_packet->'sourceBasic';
  v_source_processed := p_packet->'processedSource';
  v_expected := p_packet->'expectedBasic';
  v_full := p_packet->'fullResult';
  v_performance := p_packet->'performance';

  if coalesce(v_before->>'match_id','') !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
     or v_before->>'platform' not in ('steam','kakao')
     or coalesce(v_before->>'player_id','') !~ '^[a-z0-9._-]{1,64}$'
     or v_before->'account_id' is distinct from 'null'::jsonb
     or v_source_basic->>'match_id' is distinct from v_before->>'match_id'
     or v_source_basic->>'platform' is distinct from v_before->>'platform'
     or coalesce(v_source_basic->>'player_id','') !~ '^[a-z0-9._-]{1,64}$'
     or v_source_basic->>'player_id' is not distinct from v_before->>'player_id'
     or v_source_processed->>'match_id' is distinct from v_before->>'match_id'
     or v_source_processed->>'platform' is distinct from v_before->>'platform'
     or v_source_processed->>'player_id' is distinct from v_source_basic->>'player_id'
     or v_expected->>'match_id' is distinct from v_before->>'match_id'
     or v_expected->>'platform' is distinct from v_before->>'platform'
     or v_expected->>'player_id' is distinct from v_before->>'player_id'
     or coalesce(v_expected->>'account_id','') !~ '^account\.[A-Za-z0-9_-]+$'
     or v_full->>'matchId' is distinct from v_before->>'match_id'
     or v_full->>'platform' is distinct from v_before->>'platform'
     or lower(v_full->>'player_id') is distinct from lower(v_before->>'player_id')
     or v_full->>'createdAt' is null
     or v_full->>'gameMode' is null
     or v_full->>'matchType' not in ('official','competitive','custom','event','seasonal','airoyale','training')
     or pg_catalog.jsonb_typeof(v_full->'stats') is distinct from 'object'
     or pg_catalog.jsonb_typeof(v_full->'team') is distinct from 'array'
     or coalesce(v_full->'retentionRecoveryEvidence'->>'rawArtifactSha256','') !~* '^[a-f0-9]{64}$'
     or v_full->'retentionRecoveryEvidence'->>'sourceMatchId' is distinct from v_before->>'match_id'
     or lower(v_full->'retentionRecoveryEvidence'->>'sourcePlayerId') is distinct from lower(v_source_basic->>'player_id')
     or not (
       (left(v_full->'retentionRecoveryEvidence'->>'legacyKey',length(v_before->>'match_id')+1)=v_before->>'match_id' || '_'
        and substring(v_full->'retentionRecoveryEvidence'->>'legacyKey' from length(v_before->>'match_id')+2 for length(v_before->>'player_id'))=v_before->>'player_id'
        and substring(v_full->'retentionRecoveryEvidence'->>'legacyKey' from length(v_before->>'match_id')+2+length(v_before->>'player_id')) ~ '^_v[1-9][0-9]*_analyze[.]json$')
       or
       (left(v_full->'retentionRecoveryEvidence'->>'legacyKey',length(v_before->>'match_id')+1)=v_before->>'match_id' || '_'
        and substring(v_full->'retentionRecoveryEvidence'->>'legacyKey' from length(v_before->>'match_id')+2 for length(v_source_basic->>'player_id'))=v_source_basic->>'player_id'
        and substring(v_full->'retentionRecoveryEvidence'->>'legacyKey' from length(v_before->>'match_id')+2+length(v_source_basic->>'player_id')) ~ '^_v[1-9][0-9]*_analyze[.]json$')) then
    raise exception 'invalid identity or evidence';
  end if;

  v_match_id := v_before->>'match_id';
  v_platform := v_before->>'platform';
  v_player_id := v_before->>'player_id';
  v_account_id := v_expected->>'account_id';
  v_source_player_id := v_source_basic->>'player_id';
  v_stats := v_full->'stats';
  v_source_stats := v_source_processed->'data'->'fullResult'->'stats';
  v_evidence := v_full->'retentionRecoveryEvidence';
  v_summary := v_performance->'summary';
  v_source_map := case lower(btrim(v_source_processed->'data'->'fullResult'->>'mapName'))
    when 'baltic_main' then 'erangel' when '에란겔' then 'erangel' when 'erangel' then 'erangel'
    when 'desert_main' then 'miramar' when '미라마' then 'miramar' when 'miramar' then 'miramar'
    when 'savage_main' then 'sanhok' when '사녹' then 'sanhok' when 'sanhok' then 'sanhok'
    when 'tiger_main' then 'taego' when '태이고' then 'taego' when 'taego' then 'taego'
    when 'dihorotok_main' then 'vikendi' when '비켄디' then 'vikendi' when 'vikendi' then 'vikendi'
    when 'neon_main' then 'rondo' when '론도' then 'rondo' when 'rondo' then 'rondo'
    when 'kiki_main' then 'deston' when '데스턴' then 'deston' when 'deston' then 'deston'
    when 'summerland_main' then 'karakin' when '카라킨' then 'karakin' when 'karakin' then 'karakin'
    when 'chimera_main' then 'paramo' when '파라모' then 'paramo' when 'paramo' then 'paramo'
    else lower(btrim(v_source_processed->'data'->'fullResult'->>'mapName')) end;
  v_full_map := case lower(btrim(v_full->>'mapName'))
    when 'baltic_main' then 'erangel' when '에란겔' then 'erangel' when 'erangel' then 'erangel'
    when 'desert_main' then 'miramar' when '미라마' then 'miramar' when 'miramar' then 'miramar'
    when 'savage_main' then 'sanhok' when '사녹' then 'sanhok' when 'sanhok' then 'sanhok'
    when 'tiger_main' then 'taego' when '태이고' then 'taego' when 'taego' then 'taego'
    when 'dihorotok_main' then 'vikendi' when '비켄디' then 'vikendi' when 'vikendi' then 'vikendi'
    when 'neon_main' then 'rondo' when '론도' then 'rondo' when 'rondo' then 'rondo'
    when 'kiki_main' then 'deston' when '데스턴' then 'deston' when 'deston' then 'deston'
    when 'summerland_main' then 'karakin' when '카라킨' then 'karakin' when 'karakin' then 'karakin'
    when 'chimera_main' then 'paramo' when '파라모' then 'paramo' when 'paramo' then 'paramo'
    else lower(btrim(v_full->>'mapName')) end;
  v_basic_map := case lower(btrim(v_source_basic->>'map_name'))
    when 'baltic_main' then 'erangel' when '에란겔' then 'erangel' when 'erangel' then 'erangel'
    when 'desert_main' then 'miramar' when '미라마' then 'miramar' when 'miramar' then 'miramar'
    when 'savage_main' then 'sanhok' when '사녹' then 'sanhok' when 'sanhok' then 'sanhok'
    when 'tiger_main' then 'taego' when '태이고' then 'taego' when 'taego' then 'taego'
    when 'dihorotok_main' then 'vikendi' when '비켄디' then 'vikendi' when 'vikendi' then 'vikendi'
    when 'neon_main' then 'rondo' when '론도' then 'rondo' when 'rondo' then 'rondo'
    when 'kiki_main' then 'deston' when '데스턴' then 'deston' when 'deston' then 'deston'
    when 'summerland_main' then 'karakin' when '카라킨' then 'karakin' when 'karakin' then 'karakin'
    when 'chimera_main' then 'paramo' when '파라모' then 'paramo' when 'paramo' then 'paramo'
    else lower(btrim(v_source_basic->>'map_name')) end;

  if coalesce(v_stats->>'playerId','') !~ '^account\.[A-Za-z0-9_-]+$'
     or v_stats->>'playerId' is distinct from v_account_id
     or lower(v_stats->>'name') is distinct from lower(v_player_id)
     or v_full->>'calculationVersion' is null and v_full->>'v' is null
     or coalesce(v_full->>'v','') !~ '^[1-9][0-9]*$'
     or coalesce(v_full->>'calculationVersion','0') !~ '^[0-9]+$'
     or coalesce(v_evidence->>'rawArtifactSha256','') !~* '^[a-f0-9]{64}$'
     or coalesce(v_evidence->>'sourceFullResultSha256','') !~* '^[a-f0-9]{64}$'
     or coalesce(v_evidence->>'observedPlayers','') !~ '^[1-9][0-9]*$'
     or coalesce(v_evidence->>'officialPlayers','') is distinct from v_evidence->>'observedPlayers'
     or coalesce(v_evidence->>'observedTeams','') !~ '^[1-9][0-9]*$'
     or coalesce(v_evidence->>'officialTeams','') is distinct from v_evidence->>'observedTeams'
     or pg_catalog.jsonb_typeof(v_stats->'kills') is distinct from 'number'
     or pg_catalog.jsonb_typeof(v_stats->'damageDealt') is distinct from 'number'
     or pg_catalog.jsonb_typeof(v_stats->'winPlace') is distinct from 'number'
     or pg_catalog.jsonb_typeof(v_source_stats) is distinct from 'object'
     or coalesce(v_source_stats->>'playerId','') !~ '^account\.[A-Za-z0-9_-]+$'
     or coalesce(v_source_basic->>'account_id','') !~ '^account\.[A-Za-z0-9_-]+$'
     or v_source_basic->>'account_id' is distinct from v_source_stats->>'playerId'
     or lower(v_source_stats->>'name') is distinct from lower(v_source_player_id)
     or pg_catalog.jsonb_typeof(v_source_stats->'kills') is distinct from 'number'
     or pg_catalog.jsonb_typeof(v_source_stats->'damageDealt') is distinct from 'number'
     or pg_catalog.jsonb_typeof(v_source_stats->'winPlace') is distinct from 'number'
     or v_source_basic->>'kills' is distinct from v_source_stats->>'kills'
     or v_source_basic->>'damage' is distinct from pg_catalog.floor((v_source_stats->>'damageDealt')::numeric)::text
     or v_source_basic->>'win_place' is distinct from v_source_stats->>'winPlace'
     or v_source_processed->'data'->'fullResult'->>'matchId' is distinct from v_match_id
     or v_source_processed->'data'->'fullResult'->>'platform' is distinct from v_platform
     or lower(v_source_processed->'data'->'fullResult'->>'player_id') is distinct from lower(v_source_player_id)
     or v_source_processed->'data'->'fullResult'->>'matchType' is distinct from v_source_basic->>'match_type'
     or v_source_processed->'data'->'fullResult'->>'gameMode' is distinct from v_source_basic->>'game_mode'
     or pg_catalog.jsonb_typeof(v_source_processed->'data'->'fullResult'->'matchInfo') is distinct from 'object'
     or v_full->>'matchType' is distinct from v_expected->>'match_type'
     or v_full->>'gameMode' is distinct from v_expected->>'game_mode'
     or v_source_map is distinct from v_basic_map
     or v_full_map is distinct from v_basic_map
     or pg_catalog.floor((v_stats->>'damageDealt')::numeric) is distinct from (v_expected->>'damage')::numeric
     or (v_stats->>'kills')::numeric is distinct from (v_expected->>'kills')::numeric
     or (v_stats->>'winPlace')::numeric is distinct from (v_expected->>'win_place')::numeric
     or (v_source_stats->>'kills')::numeric < 0 or (v_stats->>'kills')::numeric < 0
     or (v_source_stats->>'damageDealt')::numeric < 0 or (v_stats->>'damageDealt')::numeric < 0
     or (v_source_stats->>'winPlace')::numeric < 1 or (v_stats->>'winPlace')::numeric < 1 then
    raise exception 'invalid official result';
  end if;
  select member.value into v_team_member
  from pg_catalog.jsonb_array_elements(v_source_processed->'data'->'fullResult'->'team') as member(value)
  where lower(member.value->>'name') = lower(v_player_id);
  if v_team_member is null
     or (select count(*) from pg_catalog.jsonb_array_elements(v_source_processed->'data'->'fullResult'->'team') as member(value)
         where lower(member.value->>'name') = lower(v_player_id)) <> 1
     or v_team_member->>'playerId' is distinct from v_account_id
     or v_team_member->>'kills' is distinct from v_stats->>'kills'
     or v_team_member->>'damageDealt' is distinct from v_stats->>'damageDealt'
     or v_team_member->>'winPlace' is distinct from v_stats->>'winPlace'
     or v_source_stats->>'kills' is distinct from (select member.value->>'kills' from pg_catalog.jsonb_array_elements(v_source_processed->'data'->'fullResult'->'team') as member(value)
       where member.value->>'playerId' = v_source_stats->>'playerId' limit 1)
     or v_source_stats->>'damageDealt' is distinct from (select member.value->>'damageDealt' from pg_catalog.jsonb_array_elements(v_source_processed->'data'->'fullResult'->'team') as member(value)
       where member.value->>'playerId' = v_source_stats->>'playerId' limit 1)
     or v_source_stats->>'winPlace' is distinct from (select member.value->>'winPlace' from pg_catalog.jsonb_array_elements(v_source_processed->'data'->'fullResult'->'team') as member(value)
       where member.value->>'playerId' = v_source_stats->>'playerId' limit 1) then
    raise exception 'team evidence mismatch';
  end if;

  if coalesce(v_before->>'played_at','') !~ '^\d{4}-\d{2}-\d{2}T'
     or not pg_catalog.pg_input_is_valid(v_before->>'played_at','timestamp with time zone')
     or coalesce(v_source_basic->>'played_at','') !~ '^\d{4}-\d{2}-\d{2}T'
     or not pg_catalog.pg_input_is_valid(v_source_basic->>'played_at','timestamp with time zone')
     or coalesce(v_expected->>'played_at','') !~ '^\d{4}-\d{2}-\d{2}T'
     or not pg_catalog.pg_input_is_valid(v_expected->>'played_at','timestamp with time zone')
     or coalesce(v_source_processed->'data'->'fullResult'->>'createdAt','') !~ '^\d{4}-\d{2}-\d{2}T'
     or not pg_catalog.pg_input_is_valid(v_source_processed->'data'->'fullResult'->>'createdAt','timestamp with time zone')
     or coalesce(v_full->>'createdAt','') !~ '^\d{4}-\d{2}-\d{2}T'
     or not pg_catalog.pg_input_is_valid(v_full->>'createdAt','timestamp with time zone')
     or coalesce(v_summary->>'createdAt','') !~ '^\d{4}-\d{2}-\d{2}T'
     or not pg_catalog.pg_input_is_valid(v_summary->>'createdAt','timestamp with time zone')
     or (v_before->>'played_at')::timestamptz >= pg_catalog.now() - interval '14 days'
     or (v_source_basic->>'played_at')::timestamptz >= pg_catalog.now() - interval '14 days'
     or (v_before->>'played_at')::timestamptz > pg_catalog.now()
     or (v_source_basic->>'played_at')::timestamptz > pg_catalog.now()
     or (v_expected->>'played_at')::timestamptz >= pg_catalog.now() - interval '14 days'
     or (v_expected->>'played_at')::timestamptz > pg_catalog.now() then
    raise exception 'outside recovery window';
  end if;
  v_before_time := (v_before->>'played_at')::timestamptz;
  v_source_time := (v_source_basic->>'played_at')::timestamptz;
  v_expected_time := (v_expected->>'played_at')::timestamptz;
  v_source_full_time := (v_source_processed->'data'->'fullResult'->>'createdAt')::timestamptz;
  v_full_time := (v_full->>'createdAt')::timestamptz;
  v_summary_time := (v_summary->>'createdAt')::timestamptz;
  if v_source_full_time is distinct from v_source_time
     or v_full_time is distinct from v_expected_time
     or v_summary_time is distinct from v_expected_time
     or v_full_time is distinct from v_source_time
     or v_source_processed->'data'->'fullResult'->'matchInfo'->>'mode' is distinct from v_source_basic->>'game_mode'
     or v_source_processed->'data'->'fullResult'->'matchInfo'->>'date' is not null and
       (not pg_catalog.pg_input_is_valid(v_source_processed->'data'->'fullResult'->'matchInfo'->>'date','timestamp with time zone')
        or (v_source_processed->'data'->'fullResult'->'matchInfo'->>'date')::timestamptz is distinct from v_source_time)
     or v_source_processed->'data'->'fullResult'->'matchInfo'->>'matchType' is not null and
       v_source_processed->'data'->'fullResult'->'matchInfo'->>'matchType' is distinct from v_source_basic->>'match_type' then
    raise exception 'metadata evidence mismatch';
  end if;

  v_stats_repair := v_before->>'account_id' is null
    and v_before->>'kills' = '0' and v_before->>'damage' = '0' and v_before->>'win_place' = '99';
  v_metadata_repair := v_stats_repair
    and lower(v_before->>'map_name') = 'unknown'
    and lower(v_before->>'game_mode') = 'unknown';
  if not v_stats_repair and (
       v_before->>'kills' is distinct from v_expected->>'kills'
       or v_before->>'damage' is distinct from v_expected->>'damage'
       or v_before->>'win_place' is distinct from v_expected->>'win_place') then
    raise exception 'observed stats cannot change';
  end if;
  if v_metadata_repair then
    if v_expected_time is distinct from v_source_time
       or v_expected->>'game_mode' is distinct from v_full->>'gameMode'
       or v_expected->>'map_name' is distinct from v_source_basic->>'map_name' then
      raise exception 'metadata repair mismatch';
    end if;
  elsif v_before_time is distinct from v_expected_time
     or v_before->>'game_mode' is distinct from v_expected->>'game_mode'
     or v_before->>'map_name' is distinct from v_expected->>'map_name' then
    raise exception 'observed metadata cannot change';
  end if;
  if v_before->>'match_type' in ('unknown','unavailable') then
    if v_expected->>'match_type' is distinct from v_full->>'matchType' then raise exception 'match type repair mismatch'; end if;
  elsif v_expected->>'match_type' is distinct from v_before->>'match_type' then
    raise exception 'observed match type cannot change';
  end if;

  if pg_catalog.jsonb_typeof(v_summary) is distinct from 'object'
     or v_performance->>'platform' is distinct from v_platform
     or v_performance->>'match_id' is distinct from v_match_id
     or v_performance->>'player_id' is distinct from v_player_id
     or v_performance->>'account_id' is distinct from v_account_id
     or coalesce(v_performance->>'played_at','') !~ '^\d{4}-\d{2}-\d{2}T'
     or not pg_catalog.pg_input_is_valid(v_performance->>'played_at','timestamp with time zone')
     or (v_performance->>'played_at')::timestamptz is distinct from v_expected_time
     or v_performance->>'summary_version' is distinct from '1'
     or v_performance->>'calculation_version' is distinct from coalesce(v_full->>'calculationVersion','0')
     or v_performance->>'result_version' is distinct from v_full->>'v'
     or coalesce(v_performance->>'source_checksum','') !~* '^[a-f0-9]{64}$'
     or v_performance->'benchmark' is distinct from 'null'::jsonb
     or v_performance->'score' is distinct from 'null'::jsonb
     or v_performance->'tier' is distinct from 'null'::jsonb
     or v_performance->>'ranking_eligible' is distinct from 'false'
     or v_summary->>'matchId' is distinct from v_match_id
     or v_summary->>'gameMode' is distinct from v_expected->>'game_mode'
     or v_summary->>'matchType' is distinct from v_expected->>'match_type'
     or v_summary->>'v' is distinct from v_full->>'v'
     or v_summary->'benchmark' is distinct from 'null'::jsonb
     or v_summary->>'isValidBenchmark' is distinct from 'false'
     or v_summary->'stats'->>'playerId' is distinct from v_account_id
     or lower(v_summary->'stats'->>'name') is distinct from lower(v_player_id)
     or v_summary->'stats'->>'kills' is distinct from v_stats->>'kills'
     or v_summary->'stats'->>'damageDealt' is distinct from v_stats->>'damageDealt'
     or v_summary->'stats'->>'winPlace' is distinct from v_stats->>'winPlace'
     or v_summary->>'performanceHistorical' is distinct from 'true'
     or v_summary->>'retentionRecoveryContext' is distinct from 'partial-legacy-team-events'
     or pg_catalog.octet_length(v_summary::text) > 32768
     or pg_catalog.jsonb_typeof(v_summary->'team') is distinct from 'array'
     or pg_catalog.jsonb_array_length(v_summary->'team') <> 0
     or pg_catalog.jsonb_typeof(v_summary->'killDetails') is distinct from 'array'
     or pg_catalog.jsonb_array_length(v_summary->'killDetails') <> 0
     or pg_catalog.jsonb_typeof(v_summary->'dbnoDetails') is distinct from 'array'
     or pg_catalog.jsonb_array_length(v_summary->'dbnoDetails') <> 0
     or v_summary->'retentionRecoveryEvidence' is distinct from v_evidence
     or pg_catalog.jsonb_typeof(v_evidence->'sourceScope') is distinct from 'object'
     or v_evidence->'sourceScope'->>'matchId' is distinct from v_match_id
     or v_evidence->'sourceScope'->>'platform' is distinct from v_platform
     or lower(v_evidence->'sourceScope'->>'playerId') is distinct from lower(v_source_player_id)
     or v_evidence->>'sourceMatchId' is distinct from v_match_id
     or lower(v_evidence->>'sourcePlayerId') is distinct from lower(v_source_player_id)
     or coalesce(v_evidence->>'legacyKey','') !~ '^[0-9a-f-]{36}_[a-z0-9._-]{1,64}_v[1-9][0-9]*_analyze[.]json$'
     or coalesce(v_evidence->>'rawArtifactSha256','') !~* '^[a-f0-9]{64}$'
     or coalesce(v_evidence->>'sourceFullResultSha256','') !~* '^[a-f0-9]{64}$'
     or v_evidence->>'officialPlayers' is distinct from v_evidence->>'observedPlayers'
     or v_evidence->>'officialTeams' is distinct from v_evidence->>'observedTeams'
     or coalesce(v_evidence->>'observedPlayers','') !~ '^[1-9][0-9]*$'
     or coalesce(v_evidence->>'observedTeams','') !~ '^[1-9][0-9]*$'
     or (select count(*) from pg_catalog.jsonb_object_keys(v_evidence)) > 16 then
    raise exception 'invalid compact row';
  end if;
  if pg_catalog.octet_length(v_summary::text) > 32768 then raise exception 'compact row too large'; end if;

  v_calculation_version := (v_performance->>'calculation_version')::integer;
  v_result_version := (v_performance->>'result_version')::integer;
  v_summary_version := (v_performance->>'summary_version')::integer;

  perform pg_catalog.set_config('lock_timeout','2s',true);
  lock table public.telemetry_map_cache_entries,
    public.pubg_player_match_discovery,
    public.pubg_performance_jobs,
    public.pubg_player_matches,
    public.processed_match_telemetry,
    public.pubg_match_performance in share row exclusive mode nowait;
  v_lock_deadline := pg_catalog.clock_timestamp() + interval '1 second';

  if exists (select 1 from public.telemetry_map_cache_entries c
    where c.match_id = v_match_id and c.platform = v_platform
      and (c.status is distinct from 'ready' or c.lease_token is not null or c.lease_expires_at > pg_catalog.now()))
    or exists (select 1 from public.pubg_player_match_discovery d
      where d.match_id = v_match_id and d.platform = v_platform
        and (d.state in ('pending','retry','running') or d.lease_token is not null or d.lease_expires_at > pg_catalog.now()))
    or exists (select 1 from public.pubg_performance_jobs j
      where j.match_id = v_match_id and j.platform = v_platform
        and (j.state in ('pending','retry','running') or j.lease_token is not null or j.lease_expires_at > pg_catalog.now())) then
    raise exception 'active lease';
  end if;

  if exists (select 1 from public.processed_match_telemetry p
       where p.match_id = v_match_id and p.platform = v_platform and p.player_id = v_player_id)
     or exists (select 1 from public.pubg_match_performance p
       where p.match_id = v_match_id and p.platform = v_platform and p.player_id = v_player_id)
     or exists (select 1 from public.pubg_player_matches m
       where m.match_id = v_match_id and m.platform = v_platform and m.account_id = v_account_id)
     then
    raise exception 'target or account already exists';
  end if;

  if not exists (select 1 from public.pubg_player_matches m
       where m.match_id = v_match_id and m.platform = v_platform and m.player_id = v_player_id
         and m.account_id is null
         and pg_catalog.to_jsonb(m) = pg_catalog.to_jsonb(
           pg_catalog.jsonb_populate_record(null::public.pubg_player_matches,v_before)))
     or not exists (select 1 from public.pubg_player_matches m
       where m.match_id = v_match_id and m.platform = v_platform and m.player_id = v_source_player_id
         and pg_catalog.to_jsonb(m) = pg_catalog.to_jsonb(
           pg_catalog.jsonb_populate_record(null::public.pubg_player_matches,v_source_basic)))
     or not exists (select 1 from public.processed_match_telemetry p
       where p.match_id = v_match_id and p.platform = v_platform and p.player_id = v_source_player_id
         and pg_catalog.to_jsonb(p) = pg_catalog.to_jsonb(
           pg_catalog.jsonb_populate_record(null::public.processed_match_telemetry,v_source_processed))) then
    raise exception 'source snapshot changed';
  end if;

  if (v_expected - array['account_id','played_at','game_mode','map_name','kills','damage','win_place','match_type']::text[])
        is distinct from (v_before - array['account_id','played_at','game_mode','map_name','kills','damage','win_place','match_type']::text[])
     or (not v_metadata_repair and (v_expected_time is distinct from v_before_time
       or v_expected->>'game_mode' is distinct from v_before->>'game_mode'
       or v_expected->>'map_name' is distinct from v_before->>'map_name'))
     or (not v_stats_repair and (v_expected->>'kills' is distinct from v_before->>'kills'
       or v_expected->>'damage' is distinct from v_before->>'damage'
       or v_expected->>'win_place' is distinct from v_before->>'win_place')) then
    raise exception 'expected row changes outside allowed fields';
  end if;

  if pg_catalog.clock_timestamp() > v_lock_deadline then
    raise exception 'recovery-lock-budget-exceeded';
  end if;
  update public.pubg_player_matches as m
  set account_id = v_account_id,
      played_at = v_expected_time,
      game_mode = v_expected->>'game_mode',
      map_name = v_expected->>'map_name',
      kills = (v_expected->>'kills')::integer,
      damage = (v_expected->>'damage')::integer,
      win_place = (v_expected->>'win_place')::integer,
      match_type = v_expected->>'match_type'
  where m.match_id = v_match_id and m.platform = v_platform and m.player_id = v_player_id
    and m.account_id is null and pg_catalog.to_jsonb(m) = pg_catalog.to_jsonb(
      pg_catalog.jsonb_populate_record(null::public.pubg_player_matches,v_before))
  returning pg_catalog.to_jsonb(m) into v_basic_after;
  if v_basic_after is null then raise exception 'target snapshot changed'; end if;

  insert into public.pubg_match_performance (
    platform, account_id, match_id, player_id, calculation_version, result_version,
    score, tier, benchmark, ranking_eligible, calculated_at,
    summary, played_at, summary_version, source_checksum
  ) values (
    v_platform, v_account_id, v_match_id, v_player_id, v_calculation_version, v_result_version,
    null, null, null, false, pg_catalog.now(),
    v_summary, v_expected_time, v_summary_version,
    lower(v_performance->>'source_checksum')
  );

  if pg_catalog.clock_timestamp() > v_lock_deadline then
    raise exception 'recovery-lock-budget-exceeded';
  end if;

  return pg_catalog.jsonb_build_object('basic',v_basic_after,'saved',true);
exception when others then
  raise exception 'legacy-team-retention-recovery-failed' using errcode = 'P0001';
end;
$$;

revoke all on function public.recover_retention_legacy_team(jsonb) from public, anon, authenticated;
grant execute on function public.recover_retention_legacy_team(jsonb) to service_role;
