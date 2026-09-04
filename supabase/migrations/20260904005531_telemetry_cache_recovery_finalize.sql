-- Strict PUBG benchmark recovery finalization.
--
-- R2 upload is intentionally performed by the route before this RPC. This
-- function is the single database commit boundary for recovery: it locks and
-- revalidates the owned pending cache lease, the exact v72 processed row (with
-- PUBG account evidence), and the exact legacy benchmark row before changing
-- any of the four canonical rows. Guard failures return a structured result
-- without mutating any row; constraint or storage errors abort the transaction
-- so callers can compensate the one object they uploaded.

create or replace function public.finalize_telemetry_cache_recovery(
  p_match_id text,
  p_platform text,
  p_player_id text,
  p_mode text,
  p_telemetry_version numeric,
  p_storage_path text,
  p_lease_token uuid,
  p_processed_guard jsonb,
  p_benchmark_guard jsonb,
  p_rows jsonb
)
returns jsonb
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_lease public.telemetry_map_cache_entries%rowtype;
  v_previous_processed public.processed_match_telemetry%rowtype;
  v_previous_benchmark public.global_benchmarks%rowtype;
  v_existing_master public.match_master_telemetry%rowtype;
  v_master record;
  v_processed record;
  v_benchmark record;
  v_guard_match_id text;
  v_guard_player_id text;
  v_guard_platform text;
  v_guard_account_id text;
  v_guard_result_version integer;
  v_benchmark_id bigint;
  v_benchmark_match_id text;
  v_benchmark_player_id text;
  v_benchmark_platform text;
  v_benchmark_game_mode text;
  v_benchmark_match_type text;
  v_benchmark_tier text;
  v_benchmark_filter_version integer;
  v_benchmark_population_evidence_version integer;
  v_rows_count integer;
begin
  -- Scalar lease identity is deliberately fixed in the SQL signature. JSON is
  -- only used for the two compare guards and the three final row payloads.
  if p_match_id is null
    or p_match_id !~ '^[A-Za-z0-9._-]{1,160}$'
    or p_platform is null
    or p_platform not in ('steam', 'kakao')
    or p_player_id is null
    or p_player_id = ''
    or p_mode is distinct from 'lite'
    or p_telemetry_version is null
    or p_telemetry_version is distinct from 61
    or p_storage_path is null
    or p_storage_path = ''
    or p_lease_token is null
    or jsonb_typeof(p_processed_guard) is distinct from 'object'
    or jsonb_typeof(p_benchmark_guard) is distinct from 'object'
    or jsonb_typeof(p_rows) is distinct from 'object'
  then
    raise exception 'telemetry-recovery-finalize-invalid-input' using errcode = '22023';
  end if;

  -- Reject unknown top-level payloads. Every consumed field below is an
  -- explicit fixed allow-list; no table or column name is accepted from JSON.
  if exists (
    select 1
    from jsonb_object_keys(p_rows) as payload(key)
    where payload.key not in ('master', 'processed', 'benchmark')
  )
  or not (p_rows ?& array['master', 'processed', 'benchmark'])
  or jsonb_typeof(p_rows->'master') is distinct from 'object'
  or jsonb_typeof(p_rows->'processed') is distinct from 'object'
  or jsonb_typeof(p_rows->'benchmark') is distinct from 'object'
  or not (p_rows->'master' ?& array['match_id', 'map_name', 'game_mode', 'telemetry_version', 'storage_path'])
  or not (p_rows->'processed' ?& array['match_id', 'platform', 'player_id', 'data', 'updated_at'])
  or not (p_rows->'benchmark' ?& array[
    'match_id', 'platform', 'player_id', 'game_mode', 'map_name', 'match_type',
    'tier', 'filter_version', 'population_evidence_version', 'source'
  ])
  then
    raise exception 'telemetry-recovery-finalize-payload-not-allowlisted' using errcode = '22023';
  end if;

  -- Reject unknown keys in each nested object before extracting the exact
  -- fixed row shapes. jsonb_to_record is intentionally
  -- given a literal column list; it is not dynamic SQL and ignores no hidden
  -- table/column identifier supplied by the caller.
  if exists (
    select 1 from jsonb_object_keys(p_rows->'master') as payload(key)
    where payload.key not in ('match_id', 'map_name', 'game_mode', 'telemetry_version', 'storage_path')
  )
  or exists (
    select 1 from jsonb_object_keys(p_rows->'processed') as payload(key)
    where payload.key not in ('match_id', 'platform', 'player_id', 'data', 'updated_at')
  )
  or exists (
    select 1 from jsonb_object_keys(p_rows->'benchmark') as payload(key)
    where payload.key not in (
      'match_id', 'platform', 'player_id', 'damage', 'kills', 'win_place',
      'game_mode', 'map_name', 'counter_latency_ms', 'initiative_rate',
      'revive_rate', 'is_crossfire', 'utility_count', 'smoke_count',
      'frag_count', 'pressure_index', 'enemy_death_distance', 'survival_time',
      'isolation_index', 'min_dist', 'height_diff', 'smoke_rate', 'trade_rate',
      'solo_kill_rate', 'reversal_rate', 'duel_win_rate', 'trade_latency_ms',
      'lethal_throw_count', 'tier', 'score', 'combat_score', 'tactical_score',
      'survival_score', 'supp_count', 'team_wipes', 'match_type', 'death_phase',
      'filter_version', 'population_evidence_version', 'source'
    )
  )
  then
    raise exception 'telemetry-recovery-finalize-payload-not-allowlisted' using errcode = '22023';
  end if;

  select * into v_master
  from jsonb_to_record(p_rows->'master') as master(
    match_id text,
    map_name text,
    game_mode text,
    telemetry_version numeric,
    storage_path text
  );

  select * into v_processed
  from jsonb_to_record(p_rows->'processed') as processed(
    match_id text,
    platform text,
    player_id text,
    data jsonb,
    updated_at timestamptz
  );

  select * into v_benchmark
  from jsonb_to_record(p_rows->'benchmark') as benchmark(
    match_id text,
    platform text,
    player_id text,
    damage double precision,
    kills integer,
    win_place integer,
    game_mode text,
    map_name text,
    counter_latency_ms double precision,
    initiative_rate double precision,
    revive_rate double precision,
    is_crossfire boolean,
    utility_count integer,
    smoke_count integer,
    frag_count integer,
    pressure_index double precision,
    enemy_death_distance double precision,
    survival_time integer,
    isolation_index double precision,
    min_dist double precision,
    height_diff double precision,
    smoke_rate double precision,
    trade_rate double precision,
    solo_kill_rate integer,
    reversal_rate double precision,
    duel_win_rate double precision,
    trade_latency_ms double precision,
    lethal_throw_count integer,
    tier text,
    score double precision,
    combat_score double precision,
    tactical_score double precision,
    survival_score double precision,
    supp_count double precision,
    team_wipes integer,
    match_type text,
    death_phase integer,
    filter_version integer,
    population_evidence_version integer,
    source text
  );

  -- Explicit processed-identity guard allow-list. The row itself is re-read
  -- and locked below; these values are never trusted merely because they are
  -- present in the request.
  if not (p_processed_guard ?& array['matchId', 'playerId', 'platform', 'resultVersion', 'accountId'])
    or exists (
      select 1
      from jsonb_object_keys(p_processed_guard) as guard(key)
      where guard.key not in ('matchId', 'playerId', 'platform', 'resultVersion', 'accountId')
    )
  then
    raise exception 'telemetry-recovery-finalize-processed-guard-invalid' using errcode = '22023';
  end if;

  v_guard_match_id := p_processed_guard->>'matchId';
  v_guard_player_id := p_processed_guard->>'playerId';
  v_guard_platform := p_processed_guard->>'platform';
  v_guard_account_id := p_processed_guard->>'accountId';
  if v_guard_match_id is null
    or v_guard_player_id is null
    or v_guard_player_id = ''
    or v_guard_platform is null
    or v_guard_platform not in ('steam', 'kakao')
    or v_guard_account_id is null
    or v_guard_account_id = ''
    or jsonb_typeof(p_processed_guard->'resultVersion') is distinct from 'number'
    or p_processed_guard->>'resultVersion' is null
    or p_processed_guard->>'resultVersion' !~ '^[0-9]+$'
  then
    raise exception 'telemetry-recovery-finalize-processed-guard-invalid' using errcode = '22023';
  end if;
  v_guard_result_version := (p_processed_guard->>'resultVersion')::integer;
  if v_guard_result_version is distinct from 72
    or v_guard_match_id is distinct from p_match_id
    or v_guard_platform is distinct from p_platform
  then
    raise exception 'telemetry-recovery-finalize-processed-guard-invalid' using errcode = '22023';
  end if;

  -- Benchmark guard also has an explicit fixed allow-list. A null marker is a
  -- meaningful legacy value, hence comparisons below use IS NOT DISTINCT FROM.
  if not (p_benchmark_guard ?& array[
    'id', 'matchId', 'playerId', 'platform', 'gameMode', 'matchType', 'tier',
    'filterVersion', 'populationEvidenceVersion'
  ])
    or exists (
      select 1
      from jsonb_object_keys(p_benchmark_guard) as guard(key)
      where guard.key not in (
        'id', 'matchId', 'playerId', 'platform', 'gameMode', 'matchType', 'tier',
        'filterVersion', 'populationEvidenceVersion'
      )
    )
    or p_benchmark_guard->>'id' is null
    or p_benchmark_guard->>'id' !~ '^[0-9]+$'
  then
    raise exception 'telemetry-recovery-finalize-benchmark-guard-invalid' using errcode = '22023';
  end if;

  v_benchmark_id := (p_benchmark_guard->>'id')::bigint;
  v_benchmark_match_id := p_benchmark_guard->>'matchId';
  v_benchmark_player_id := p_benchmark_guard->>'playerId';
  v_benchmark_platform := p_benchmark_guard->>'platform';
  v_benchmark_game_mode := p_benchmark_guard->>'gameMode';
  v_benchmark_match_type := p_benchmark_guard->>'matchType';
  v_benchmark_tier := p_benchmark_guard->>'tier';
  if v_benchmark_match_id is null
    or v_benchmark_match_id is distinct from p_match_id
    or v_benchmark_player_id is null
    or v_benchmark_player_id = ''
    or v_benchmark_platform is null
    or v_benchmark_platform is distinct from p_platform
    or v_benchmark_game_mode is null
    or v_benchmark_match_type is null
    or v_benchmark_match_type not in ('official', 'competitive')
    or v_benchmark_tier is null
    or v_benchmark_tier not in (
      'S+', 'S', 'A+', 'A', 'A-', 'B+', 'B', 'B-',
      'C+', 'C', 'C-', 'D+', 'D', 'D-'
    )
    or jsonb_typeof(p_benchmark_guard->'filterVersion') is distinct from 'number'
      and jsonb_typeof(p_benchmark_guard->'filterVersion') is distinct from 'null'
    or jsonb_typeof(p_benchmark_guard->'populationEvidenceVersion') is distinct from 'number'
      and jsonb_typeof(p_benchmark_guard->'populationEvidenceVersion') is distinct from 'null'
  then
    raise exception 'telemetry-recovery-finalize-benchmark-guard-invalid' using errcode = '22023';
  end if;
  v_benchmark_filter_version := case
    when p_benchmark_guard->'filterVersion' = 'null'::jsonb then null
    else (p_benchmark_guard->>'filterVersion')::integer
  end;
  v_benchmark_population_evidence_version := case
    when p_benchmark_guard->'populationEvidenceVersion' = 'null'::jsonb then null
    else (p_benchmark_guard->>'populationEvidenceVersion')::integer
  end;
  if v_benchmark_population_evidence_version is not null
    or (v_benchmark_filter_version is not null and v_benchmark_filter_version > 8)
  then
    raise exception 'telemetry-recovery-finalize-benchmark-guard-invalid' using errcode = '22023';
  end if;

  -- Validate final rows before taking any mutation path. The processed payload
  -- is required to be the canonical v73 shape and retain account evidence.
  if v_master.match_id is null
    or v_master.match_id is distinct from p_match_id
    or v_master.map_name is null
    or v_master.game_mode is null
    or v_master.telemetry_version is null
    or v_master.telemetry_version is distinct from p_telemetry_version
    or v_master.storage_path is null
    or v_master.storage_path is distinct from p_storage_path
    or v_processed.match_id is null
    or v_processed.match_id is distinct from p_match_id
    or v_processed.platform is null
    or v_processed.platform is distinct from p_platform
    or v_processed.player_id is null
    or v_processed.player_id is distinct from v_guard_player_id
    or v_processed.data is null
    or v_processed.updated_at is null
    or jsonb_typeof(v_processed.data) is distinct from 'object'
    or jsonb_typeof(v_processed.data->'fullResult') is distinct from 'object'
    or v_processed.data #>> '{fullResult,v}' is distinct from '73'
    or v_processed.data #>> '{fullResult,matchId}' is distinct from p_match_id
    or v_processed.data #>> '{fullResult,player_id}' is distinct from v_guard_player_id
    or v_processed.data #>> '{fullResult,platform}' is distinct from p_platform
    or v_processed.data #>> '{fullResult,populationEvidenceVersion}' is distinct from '1'
    or (
      (v_processed.data #>> '{fullResult,stats,playerId}' is not null
        and v_processed.data #>> '{fullResult,stats,playerId}' is distinct from v_guard_account_id)
      or (v_processed.data #>> '{fullResult,stats,accountId}' is not null
        and v_processed.data #>> '{fullResult,stats,accountId}' is distinct from v_guard_account_id)
      or (
        v_processed.data #>> '{fullResult,stats,playerId}' is null
        and v_processed.data #>> '{fullResult,stats,accountId}' is null
      )
    )
  then
    raise exception 'telemetry-recovery-finalize-final-row-invalid' using errcode = '22023';
  end if;

  if v_benchmark.match_id is null
    or v_benchmark.match_id is distinct from v_benchmark_match_id
    or v_benchmark.player_id is null
    or v_benchmark.player_id is distinct from v_benchmark_player_id
    or v_benchmark.platform is null
    or v_benchmark.platform is distinct from p_platform
    or v_benchmark.game_mode is null
    or v_benchmark.game_mode is distinct from v_benchmark_game_mode
    or v_benchmark.match_type is null
    or v_benchmark.match_type is distinct from v_benchmark_match_type
    or v_benchmark.tier is null
    or v_benchmark.tier not in (
      'S+', 'S', 'A+', 'A', 'A-', 'B+', 'B', 'B-',
      'C+', 'C', 'C-', 'D+', 'D', 'D-'
    )
    or v_benchmark.filter_version is distinct from 8
    or v_benchmark.population_evidence_version is distinct from 1
    or v_benchmark.source is null
    or v_benchmark.source not in ('user', 'scraper')
  then
    raise exception 'telemetry-recovery-finalize-final-row-invalid' using errcode = '22023';
  end if;

  -- Serialize all finalizers for the match before checking the guards. This
  -- complements row locks and prevents cross-row interleavings.
  perform pg_advisory_xact_lock(hashtextextended(p_match_id, 1952805741));

  select * into v_lease
  from public.telemetry_map_cache_entries as cache
  where cache.match_id = p_match_id
    and cache.platform = p_platform
    and cache.player_id = p_player_id
    and cache.mode = p_mode
    and cache.telemetry_version = p_telemetry_version
    and cache.storage_path = p_storage_path
    and cache.status = 'pending'
    and cache.lease_token = p_lease_token
  for update;
  if not found then
    -- A lost response after COMMIT is safe to retry: recognize the exact
    -- already-finalized state and never ask the caller to compensate R2.
    if exists (
      select 1 from public.telemetry_map_cache_entries as cache
      where cache.match_id = p_match_id
        and cache.platform = p_platform
        and cache.player_id = p_player_id
        and cache.mode = p_mode
        and cache.telemetry_version = p_telemetry_version
        and cache.storage_path = p_storage_path
        and cache.status = 'ready'
        and cache.lease_expires_at is null
        and cache.lease_token is null
        and cache.updated_at is not distinct from v_processed.updated_at
    )
    and exists (
      select 1 from public.processed_match_telemetry as processed
      where processed.match_id = p_match_id
        and processed.platform = p_platform
        and processed.player_id = v_guard_player_id
        and processed.data is not distinct from v_processed.data
        and processed.updated_at is not distinct from v_processed.updated_at
        and jsonb_typeof(processed.data) is not distinct from 'object'
        and jsonb_typeof(processed.data->'fullResult') is not distinct from 'object'
        and processed.data #>> '{fullResult,v}' is not distinct from '73'
        and processed.data #>> '{fullResult,matchId}' is not distinct from p_match_id
        and processed.data #>> '{fullResult,player_id}' is not distinct from v_guard_player_id
        and processed.data #>> '{fullResult,platform}' is not distinct from p_platform
        and processed.data #>> '{fullResult,populationEvidenceVersion}' is not distinct from '1'
        and not (
          (processed.data #>> '{fullResult,stats,playerId}' is null
            and processed.data #>> '{fullResult,stats,accountId}' is null)
          or (processed.data #>> '{fullResult,stats,playerId}' is not null
            and processed.data #>> '{fullResult,stats,playerId}' is distinct from v_guard_account_id)
          or (processed.data #>> '{fullResult,stats,accountId}' is not null
            and processed.data #>> '{fullResult,stats,accountId}' is distinct from v_guard_account_id)
        )
    )
    and exists (
      select 1 from public.match_master_telemetry as master
      where master.match_id = p_match_id
        and master.map_name is not null
        and master.game_mode is not null
        and row(master.map_name, master.game_mode, master.telemetry_version, master.storage_path)
          is not distinct from row(v_master.map_name, v_master.game_mode, v_master.telemetry_version, v_master.storage_path)
    )
    and exists (
      select 1 from public.global_benchmarks as benchmark
      where benchmark.id = v_benchmark_id
        and benchmark.match_id is not distinct from v_benchmark_match_id
        and benchmark.platform is not distinct from v_benchmark_platform
        and benchmark.player_id is not distinct from v_benchmark_player_id
        and benchmark.game_mode is not null
        and benchmark.match_type is not null
        and benchmark.tier is not null
        and row(
          benchmark.damage, benchmark.kills, benchmark.win_place,
          benchmark.game_mode, benchmark.map_name, benchmark.counter_latency_ms,
          benchmark.initiative_rate, benchmark.revive_rate, benchmark.is_crossfire,
          benchmark.utility_count, benchmark.smoke_count, benchmark.frag_count,
          benchmark.pressure_index, benchmark.enemy_death_distance,
          benchmark.survival_time, benchmark.isolation_index, benchmark.min_dist,
          benchmark.height_diff, benchmark.smoke_rate, benchmark.trade_rate,
          benchmark.solo_kill_rate, benchmark.reversal_rate, benchmark.duel_win_rate,
          benchmark.trade_latency_ms, benchmark.lethal_throw_count, benchmark.tier,
          benchmark.score, benchmark.combat_score, benchmark.tactical_score,
          benchmark.survival_score, benchmark.supp_count, benchmark.team_wipes,
          benchmark.match_type, benchmark.death_phase, benchmark.filter_version,
          benchmark.population_evidence_version, benchmark.source
        ) is not distinct from row(
          v_benchmark.damage, v_benchmark.kills, v_benchmark.win_place,
          v_benchmark.game_mode, v_benchmark.map_name, v_benchmark.counter_latency_ms,
          v_benchmark.initiative_rate, v_benchmark.revive_rate, v_benchmark.is_crossfire,
          v_benchmark.utility_count, v_benchmark.smoke_count, v_benchmark.frag_count,
          v_benchmark.pressure_index, v_benchmark.enemy_death_distance,
          v_benchmark.survival_time, v_benchmark.isolation_index, v_benchmark.min_dist,
          v_benchmark.height_diff, v_benchmark.smoke_rate, v_benchmark.trade_rate,
          v_benchmark.solo_kill_rate, v_benchmark.reversal_rate, v_benchmark.duel_win_rate,
          v_benchmark.trade_latency_ms, v_benchmark.lethal_throw_count, v_benchmark.tier,
          v_benchmark.score, v_benchmark.combat_score, v_benchmark.tactical_score,
          v_benchmark.survival_score, v_benchmark.supp_count, v_benchmark.team_wipes,
          v_benchmark.match_type, v_benchmark.death_phase, v_benchmark.filter_version,
          v_benchmark.population_evidence_version, v_benchmark.source
        )
        and benchmark.source is not null
    ) then
      return jsonb_build_object('ok', true, 'code', 'already_finalized');
    end if;
    return jsonb_build_object('ok', false, 'code', 'lease_lost');
  end if;

  select * into v_previous_processed
  from public.processed_match_telemetry as processed
  where processed.match_id = p_match_id
    and processed.platform = p_platform
    and processed.player_id = v_guard_player_id
  for update;
  if not found
    or v_previous_processed.data is null
    or jsonb_typeof(v_previous_processed.data) is distinct from 'object'
    or jsonb_typeof(v_previous_processed.data->'fullResult') is distinct from 'object'
    or v_previous_processed.data #>> '{fullResult,v}' is distinct from '72'
    or v_previous_processed.data #>> '{fullResult,matchId}' is distinct from v_guard_match_id
    or v_previous_processed.data #>> '{fullResult,player_id}' is distinct from v_guard_player_id
    or v_previous_processed.data #>> '{fullResult,platform}' is distinct from v_guard_platform
    or (
      (v_previous_processed.data #>> '{fullResult,stats,playerId}' is not null
        and v_previous_processed.data #>> '{fullResult,stats,playerId}' is distinct from v_guard_account_id)
      or (v_previous_processed.data #>> '{fullResult,stats,accountId}' is not null
        and v_previous_processed.data #>> '{fullResult,stats,accountId}' is distinct from v_guard_account_id)
      or (
        v_previous_processed.data #>> '{fullResult,stats,playerId}' is null
        and v_previous_processed.data #>> '{fullResult,stats,accountId}' is null
      )
    )
  then
    return jsonb_build_object('ok', false, 'code', 'processed_guard_mismatch');
  end if;

  select * into v_previous_benchmark
  from public.global_benchmarks as benchmark
  where benchmark.id = v_benchmark_id
  for update;
  if not found
    or v_previous_benchmark.match_id is null
    or v_previous_benchmark.match_id is distinct from v_benchmark_match_id
    or v_previous_benchmark.player_id is null
    or v_previous_benchmark.player_id is distinct from v_benchmark_player_id
    or v_previous_benchmark.platform is null
    or v_previous_benchmark.platform is distinct from v_benchmark_platform
    or v_previous_benchmark.game_mode is null
    or v_previous_benchmark.game_mode is distinct from v_benchmark_game_mode
    or v_previous_benchmark.match_type is null
    or v_previous_benchmark.match_type is distinct from v_benchmark_match_type
    or v_previous_benchmark.tier is null
    or v_previous_benchmark.tier is distinct from v_benchmark_tier
    or v_previous_benchmark.filter_version is distinct from v_benchmark_filter_version
    or v_previous_benchmark.population_evidence_version is distinct from v_benchmark_population_evidence_version
  then
    return jsonb_build_object('ok', false, 'code', 'benchmark_guard_mismatch');
  end if;

  -- Lock an existing master row, if any, before the all-or-nothing writes.
  select * into v_existing_master
  from public.match_master_telemetry as master
  where master.match_id = p_match_id
  for update;

  insert into public.match_master_telemetry (
    match_id, map_name, game_mode, telemetry_version, storage_path
  ) values (
    v_master.match_id, v_master.map_name, v_master.game_mode,
    v_master.telemetry_version, v_master.storage_path
  )
  on conflict (match_id) do update set
    map_name = excluded.map_name,
    game_mode = excluded.game_mode,
    telemetry_version = excluded.telemetry_version,
    storage_path = excluded.storage_path;

  update public.processed_match_telemetry as processed
  set data = v_processed.data,
      updated_at = v_processed.updated_at
  where processed.match_id = p_match_id
    and processed.platform = p_platform
    and processed.player_id = v_guard_player_id;
  get diagnostics v_rows_count = row_count;
  if v_rows_count <> 1 then
    raise exception 'telemetry-recovery-finalize-processed-update-failed' using errcode = '40001';
  end if;

  update public.global_benchmarks as benchmark
  set damage = v_benchmark.damage,
      kills = v_benchmark.kills,
      win_place = v_benchmark.win_place,
      game_mode = v_benchmark.game_mode,
      map_name = v_benchmark.map_name,
      counter_latency_ms = v_benchmark.counter_latency_ms,
      initiative_rate = v_benchmark.initiative_rate,
      revive_rate = v_benchmark.revive_rate,
      is_crossfire = v_benchmark.is_crossfire,
      utility_count = v_benchmark.utility_count,
      smoke_count = v_benchmark.smoke_count,
      frag_count = v_benchmark.frag_count,
      pressure_index = v_benchmark.pressure_index,
      enemy_death_distance = v_benchmark.enemy_death_distance,
      survival_time = v_benchmark.survival_time,
      isolation_index = v_benchmark.isolation_index,
      min_dist = v_benchmark.min_dist,
      height_diff = v_benchmark.height_diff,
      smoke_rate = v_benchmark.smoke_rate,
      trade_rate = v_benchmark.trade_rate,
      solo_kill_rate = v_benchmark.solo_kill_rate,
      reversal_rate = v_benchmark.reversal_rate,
      duel_win_rate = v_benchmark.duel_win_rate,
      trade_latency_ms = v_benchmark.trade_latency_ms,
      lethal_throw_count = v_benchmark.lethal_throw_count,
      tier = v_benchmark.tier,
      score = v_benchmark.score,
      combat_score = v_benchmark.combat_score,
      tactical_score = v_benchmark.tactical_score,
      survival_score = v_benchmark.survival_score,
      supp_count = v_benchmark.supp_count,
      team_wipes = v_benchmark.team_wipes,
      match_type = v_benchmark.match_type,
      death_phase = v_benchmark.death_phase,
      filter_version = v_benchmark.filter_version,
      population_evidence_version = v_benchmark.population_evidence_version,
      source = v_benchmark.source
  where benchmark.id = v_previous_benchmark.id;
  get diagnostics v_rows_count = row_count;
  if v_rows_count <> 1 then
    raise exception 'telemetry-recovery-finalize-benchmark-update-failed' using errcode = '40001';
  end if;

  update public.telemetry_map_cache_entries as cache
  set status = 'ready',
      lease_expires_at = null,
      lease_token = null,
      storage_path = p_storage_path,
      updated_at = v_processed.updated_at
  where cache.match_id = p_match_id
    and cache.platform = p_platform
    and cache.player_id = p_player_id
    and cache.mode = p_mode
    and cache.telemetry_version = p_telemetry_version
    and cache.storage_path = p_storage_path
    and cache.status = 'pending'
    and cache.lease_token = p_lease_token;
  get diagnostics v_rows_count = row_count;
  if v_rows_count <> 1 then
    raise exception 'telemetry-recovery-finalize-lease-lost' using errcode = '40001';
  end if;

  return jsonb_build_object(
    'ok', true,
    'code', 'finalized',
    'matchId', p_match_id,
    'storagePath', p_storage_path
  );
end;
$$;

revoke all on function public.finalize_telemetry_cache_recovery(
  text, text, text, text, numeric, text, uuid, jsonb, jsonb, jsonb
) from public, anon, authenticated;

grant execute on function public.finalize_telemetry_cache_recovery(
  text, text, text, text, numeric, text, uuid, jsonb, jsonb, jsonb
) to service_role;
