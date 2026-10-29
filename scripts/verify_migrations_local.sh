#!/usr/bin/env bash
#
# 운영과 분리된 일회용 PostgreSQL 17 컨테이너(또는 로컬 임시 클러스터)에
# 신규 migration 을 적용하고 RPC 동작 시나리오를 실행합니다. 운영 DB 를 절대 건드리지 않습니다.
#
# 사용법: npm run verify:migrations
#
# 전제: Docker + psql 또는 Homebrew PostgreSQL 17 설치됨.
# 저장소 전체 migration 재생은 baseline 결함(20260526022000 이 이력에 없는 public.profiles 를
# 참조)으로 불가하므로, 아래 prerequisites.sql 로 신규 migration 이 참조하는 객체만 만듭니다.

set -euo pipefail

CONTAINER_ID=""
PG_PORT="${BGMS_MIG_CHECK_PORT:-55433}"
PG_BIN="${BGMS_PG_BIN:-}"
FORCE_LOCAL_POSTGRES="${BGMS_USE_LOCAL_POSTGRES:-false}"
LOCAL_DATA_DIR=""
LOCAL_SOCKET_DIR=""
ACTUAL_MAP_PACKET_SQL_FILE=""
USE_LOCAL_POSTGRES=false
export PGPASSWORD=pw

MIGRATIONS=(
  "20260718122322_board_turnstile_write_boundary"
  "20260730200100_weapon_patch_proposals"
  "20260730203000_tighten_service_data_write_policies"
  "20260730204500_discord_room_rate_limit"
  "20260730210000_pubg_response_cache"
  "20260731100000_prevent_profile_role_escalation"
  "20260804000000_optimize_player_cache_compaction"
  "20260819115023_profile_linked_pubg_auto_sync"
  "20260901141209_pubg_analysis_population_provenance"
  "20260902171741_telemetry_cache_recovery_claim"
  "20260904005531_telemetry_cache_recovery_finalize"
  "20260904130000_telemetry_cache_recovery_safety"
  "20260907133015_analysis_calculation_version"
  "20260907173907_user_lifecycle_events"
  "20260907181120_analysis_calculation_canonical_only"
  "20260911100000_pubg_match_discovery"
  "20260911110000_pubg_ban_watch"
  "20260913090000_pubg_rankings_and_performance"
  "20260913100000_pubg_encounter_page"
  "20260915090000_pubg_release_hardening"
  "20260921100000_support_center"
  "20260921103000_support_privacy_settings_hardening"
  "20260921110000_support_privacy_ranking_identity"
  "20260926123052_fix_support_reply_notification_conflict"
  "20261003090309_player_match_account_history_index"
  "20261003144730_pubg_discovery_fair_claim"
  "20261003145149_pubg_discovery_claim_index_predicate"
  "20261003200626_mobile_scoped_match_collection"
  "20261003200721_unique_scoped_pubg_discovery_rpc"
  "20261004050604_pubg_scoped_collection_short_lease"
  "20261004050621_mobile_board_like_atomic"
  "20261005081214_pubg_collection_database_clock"
  "20261005081741_pubg_collection_network_acl"
  "20261005082711_pubg_collection_signed_requests"
  "20261005193048_pubg_long_term_match_performance"
  "20261006115638_pubg_archive_cleanup_cursor"
  "20261006130700_bounded_unretained_match_performance"
  "20261006193137_retention_legacy_account_binding"
  "20261006210245_retention_match_type_recovery"
  "20261006223434_legacy_team_retention_recovery"
  "20261007053338_legacy_map_retention_recovery"
  "20261007062957_legacy_team_retention_event_metadata"
  "20261008213709_legacy_team_retention_failure_reasons"
  "20261009022508_participant_match_retention_scope"
  "20261009182823_restore_player_cache_compaction_contract"
  "20261009213020_analysis_calculation_coexistence"
  "20261010000000_analysis_calculation_v3"
  "20261010001000_bound_tier_ranking_candidates"
  "20261010031908_defer_ranking_scores_and_metadata"
  "20261010041817_pubg_ranking_safe_cache"
  "20261010112340_protect_board_delete_credentials"
  "20261010112343_secure_pending_marker_writes"
  "20261010112345_repair_hotdrop_atomic_counts"
  "20261010113347_admin_profile_save"
  "20261010113427_activate_board_delete_credential_privacy"
  "20261013185213_telemetry_lease_errors_without_postgrest_retry"
  "20261014090000_restrict_public_board_writes"
  "20261014100000_pin_legacy_function_search_path"
  "20261014120000_protect_board_post_views"
  "20261014130000_suggest_similar_players_trgm_index_scan"
  "20261014140000_reports_revoke_public_truncate"
  "20261014150000_pubg_ranking_background_refresh"
  "20261014151000_pubg_ranking_refresh_queue"
  "20261014160000_pubg_player_matches_unknown_type_index"
  "20261014161000_pubg_player_cache_keep_recent_index"
  "20261014162000_pubg_player_cache_compaction_candidates_index"
  "20261014163000_pubg_player_cache_autovacuum"
  "20261014164000_drop_redundant_player_cache_retention_index"
  "20261014165000_player_cache_compaction_index_friendly"
  "20261014166000_pubg_match_performance_match_player_index"
  "20261014170000_bluezone_app_data_bucket"
  "20261014180000_pubg_team_benchmarks"
  "20261014190000_pubg_previous_week_rankings"
  "20261014220000_pubg_ranking_prebuild_all_filters"
  "20261014230000_pubg_ranking_seed_commit_first"
  "20261015010000_suggest_similar_players_two_stage"
  "20261015120000_player_match_row_extras"
  "20261016010000_performance_jobs_newest_first"
  "20261017010000_public_column_privacy_prepare"
  "20261017020000_public_column_privacy_revoke"
  "20261017030000_comments_count_hotfix"
  "20261017040000_comments_column_privacy_reapply"
  "20261017050000_close_player_data_tables"
  "20261017060000_revoke_unused_client_write_grants"
  "20261021010000_retention_candidates_telemetry_driven"
  "20261022114157_lol_persistence_foundation"
  "20261022150000_pubg_player_matches_autovacuum"
  "20261022200000_lol_remove_daily_budget"
  "20261023010000_lol_ranked_history"
  "20261023020000_lol_ranked_daily"
  "20261023030000_lol_ops_metrics"
  "20261023040000_lol_player_summaries"
  "20261023050000_lol_benchmark_aggregates"
  "20261023060000_lol_participant_identity"
  "20261024010000_lol_augment_catalog"
  "20261024020000_lol_review_hardening"
  "20261024030000_lol_summary_challenges"
  "20261024040000_lol_review_fixes"
  "20261025010000_lol_challenge_catalog"
  "20261025200000_lol_ladder_status"
  "20261026010000_lol_delete_search_lease_any_version"
  "20261026020000_lol_search_cache_payload_1mb"
  "20261026030000_lol_champion_bans"
  "20261027000000_analysis_calculation_v4"
  "20261028000000_analysis_calculation_v5"
  "20261028120000_benchmark_counter_latency_split"
  "20261028130000_lol_champion_stats"
  "20261028140000_first_reply_evidence"
  "20261029010000_lol_riot_window_guard"
  "20261029020000_lol_search_snapshot"
  "20261029030000_lol_guard_snapshot_fixes"
)

cleanup() {
  if [ -n "$ACTUAL_MAP_PACKET_SQL_FILE" ]; then
    rm -f "$ACTUAL_MAP_PACKET_SQL_FILE"
  fi
  if [ "$USE_LOCAL_POSTGRES" = true ] && [ -n "$LOCAL_DATA_DIR" ]; then
    "$PG_BIN/pg_ctl" -D "$LOCAL_DATA_DIR" -m immediate stop >/dev/null 2>&1 || true
    rm -rf "$LOCAL_DATA_DIR" "$LOCAL_SOCKET_DIR"
  elif [ -n "$CONTAINER_ID" ]; then
    docker rm -f "$CONTAINER_ID" >/dev/null 2>&1 || true
  fi
}
trap cleanup EXIT

if [ "$FORCE_LOCAL_POSTGRES" = true ] || ! command -v docker >/dev/null 2>&1 || ! docker info >/dev/null 2>&1; then
  if [ -z "$PG_BIN" ] && command -v brew >/dev/null 2>&1; then
    PG_BIN="$(brew --prefix postgresql@17 2>/dev/null)/bin"
  fi
  if [ -z "$PG_BIN" ] || [ ! -x "$PG_BIN/initdb" ] || [ ! -x "$PG_BIN/pg_ctl" ]; then
    echo "❌ Docker를 사용할 수 없고 PostgreSQL 17 실행 파일도 찾지 못했습니다"
    exit 1
  fi
  USE_LOCAL_POSTGRES=true
  LOCAL_DATA_DIR="$(mktemp -d "${TMPDIR:-/tmp}/bgms-mig-check-data.XXXXXX")"
  LOCAL_SOCKET_DIR="$(mktemp -d "${TMPDIR:-/tmp}/bgms-mig-check-socket.XXXXXX")"
  echo "▶ 일회용 PostgreSQL 17 로컬 클러스터 기동"
  "$PG_BIN/initdb" -D "$LOCAL_DATA_DIR" -A trust -U postgres --no-locale >/dev/null
  "$PG_BIN/pg_ctl" -D "$LOCAL_DATA_DIR" \
    -o "-p ${PG_PORT} -k ${LOCAL_SOCKET_DIR}" \
    -l "$LOCAL_DATA_DIR/postgres.log" start >/dev/null
  PSQL_ROOT=("$PG_BIN/psql" -h "$LOCAL_SOCKET_DIR" -p "$PG_PORT" -U postgres -v ON_ERROR_STOP=1 -q)
  PSQL=("$PG_BIN/psql" -h "$LOCAL_SOCKET_DIR" -p "$PG_PORT" -U postgres -d migcheck -v ON_ERROR_STOP=1 -q)
else
  echo "▶ 일회용 PostgreSQL 17 컨테이너 기동"
  CONTAINER_ID="$(docker run -d --name "bgms-mig-check-$$-$RANDOM" -e POSTGRES_PASSWORD=pw -p "${PG_PORT}:5432" postgres:17)"

  postgres_ready=false
  for _ in $(seq 1 60); do
    if psql -h 127.0.0.1 -p "$PG_PORT" -U postgres -c 'select 1' >/dev/null 2>&1; then
      postgres_ready=true
      break
    fi
    sleep 1
  done
  if [ "$postgres_ready" != true ]; then
    echo "❌ 일회용 PostgreSQL 17 컨테이너가 준비되지 않았습니다"
    exit 1
  fi

  PSQL_ROOT=(psql -h 127.0.0.1 -p "$PG_PORT" -U postgres -v ON_ERROR_STOP=1 -q)
  PSQL=(psql -h 127.0.0.1 -p "$PG_PORT" -U postgres -d migcheck -v ON_ERROR_STOP=1 -q)
fi

"${PSQL_ROOT[@]}" -c "drop database if exists migcheck;" -c "create database migcheck;"

echo "▶ prerequisite 스키마 구성"
"${PSQL[@]}" -f tests/fixtures/migration-check/prerequisites.sql

# Account repair must roll back both records if either live snapshot or account uniqueness changes.
"${PSQL[@]}" -f tests/fixtures/migration-check/legacy_account_binding_checks.sql
"${PSQL[@]}" -f tests/fixtures/migration-check/pubg-cron-extension-stubs.sql

echo "▶ 신규 migration 적용"
for migration in "${MIGRATIONS[@]}"; do
  if [ "$migration" = "20261024030000_lol_summary_challenges" ]; then
    "${PSQL[@]}" -f tests/fixtures/migration-check/lol-challenges-backfill-setup.sql
  fi
  if [[ "$migration" == "20261023060000_lol_participant_identity" ]]; then
    "${PSQL[@]}" -f tests/fixtures/migration-check/lol-identity-backfill-setup.sql
  fi
  if [ "$migration" = "20261023040000_lol_player_summaries" ]; then
    "${PSQL[@]}" -f tests/fixtures/migration-check/lol-summary-backfill-setup.sql
  fi
  if [ "$migration" = "20261010113427_activate_board_delete_credential_privacy" ]; then
    "${PSQL[@]}" -f tests/fixtures/migration-check/board-credential-preparation.sql
  fi
  if [ "$migration" = "20261005081214_pubg_collection_database_clock" ]; then
    # The hosted extensions are fixture interfaces here; all application SQL is
    # applied unchanged. Real extension install and delivery need live checks.
    sed '/^create extension if not exists pg_cron /d; /^create extension if not exists pg_net /d' \
      "supabase/migrations/${migration}.sql" | "${PSQL[@]}"
  elif [ "$migration" = "20261014130000_suggest_similar_players_trgm_index_scan" ] \
    || [ "$migration" = "20261015010000_suggest_similar_players_two_stage" ]; then
    # 각 psql 은 새 연결이다. 슈퍼유저 세션의 pg_trgm 로드 상태를 재사용하지 않는다.
    # 함수 설정의 임계값은 migration 마다 다르다(0.2 → 두 단계 검색의 0.3).
    expected_threshold=0.2
    if [ "$migration" = "20261015010000_suggest_similar_players_two_stage" ]; then
      expected_threshold=0.3
    fi
    for _ in 1 2; do
      "${PSQL[@]}" -v expected_threshold="$expected_threshold" \
        -c "set role bgms_migration_check;" \
        -f "supabase/migrations/${migration}.sql" \
        -f tests/fixtures/migration-check/suggest-similar-players-migration-role.sql
    done
  else
    if [ "$migration" = "20261024020000_lol_review_hardening" ]; then
      "${PSQL[@]}" -f tests/fixtures/migration-check/lol-review-fk-audit.sql
    fi
    "${PSQL[@]}" -f "supabase/migrations/${migration}.sql"
  fi
  echo "  ✅ ${migration}"
done

echo "▶ RPC 동작 시나리오 실행"
"${PSQL[@]}" -f tests/fixtures/migration-check/telemetry-retry-sqlstate-checks.sql
# 이미 적용된 DB 에 다시 실행해도 아무것도 바꾸지 않아야 한다.
"${PSQL[@]}" -f supabase/migrations/20261013185213_telemetry_lease_errors_without_postgrest_retry.sql
"${PSQL[@]}" -f tests/fixtures/migration-check/telemetry-retry-sqlstate-checks.sql
"${PSQL[@]}" -f tests/fixtures/migration-check/board-credential-privacy.sql
"${PSQL[@]}" -f tests/fixtures/migration-check/pending-marker-security.sql
"${PSQL[@]}" -f tests/fixtures/migration-check/pending-marker-concurrency-setup.sql
"${PSQL[@]}" -c "set role service_role; select public.vote_pending_marker('99200000-0000-4000-8000-000000000001','99200000-0000-4000-8000-000000000001','up');" &
pending_vote_first_pid=$!
pending_vote_started=false
for _ in $(seq 1 50); do
  if [ "$("${PSQL[@]}" -At -c "select exists(select 1 from pg_locks where locktype='advisory' and classid=(20261010112343::bigint>>32)::oid and objid=(20261010112343::bigint&4294967295)::oid and granted);")" = "t" ]; then
    pending_vote_started=true
    break
  fi
  sleep 0.02
done
if [ "$pending_vote_started" != true ]; then
  echo "❌ 동시 투표 검증의 첫 투표 잠금 확보를 확인하지 못했습니다"
  exit 1
fi
"${PSQL[@]}" -c "set role service_role; select public.vote_pending_marker('99200000-0000-4000-8000-000000000001','99200000-0000-4000-8000-000000000002','up');" &
pending_vote_second_pid=$!
wait "$pending_vote_first_pid"
wait "$pending_vote_second_pid"
"${PSQL[@]}" -c "set role authenticated;
  select set_config('request.jwt.claim.sub','99200000-0000-4000-8000-000000000001',false);
  select set_config('request.jwt.claim.role','authenticated',false);
  insert into public.pending_markers(map_name,marker_type,x,y,weight,contributor_ids,is_notified)
  values('Erangel','Garage',6500,6500,1,array['99200000-0000-4000-8000-000000000001']::uuid[],false);" &
pending_registration_first_pid=$!
pending_registration_started=false
for _ in $(seq 1 50); do
  if [ "$("${PSQL[@]}" -At -c "select exists(select 1 from pg_locks where locktype='advisory' and classid=(20261010112344::bigint>>32)::oid and objid=(20261010112344::bigint&4294967295)::oid and granted);")" = "t" ]; then
    pending_registration_started=true
    break
  fi
  sleep 0.02
done
if [ "$pending_registration_started" != true ]; then
  echo "❌ 동시 제보 검증의 레거시 등록 잠금 확보를 확인하지 못했습니다"
  exit 1
fi
"${PSQL[@]}" -c "set role service_role; select public.create_pending_marker('99200000-0000-4000-8000-000000000002','Erangel','Garage',6501,6500);" &
pending_registration_second_pid=$!
wait "$pending_registration_first_pid"
wait "$pending_registration_second_pid"
"${PSQL[@]}" -f tests/fixtures/migration-check/pending-marker-concurrency-checks.sql
"${PSQL[@]}" -f tests/fixtures/migration-check/hotdrop-count-atomic.sql
"${PSQL[@]}" -f tests/fixtures/migration-check/admin-profile-save.sql
"${PSQL[@]}" -f tests/fixtures/migration-check/participant_match_retention_scope_checks.sql
"${PSQL[@]}" -f tests/fixtures/migration-check/retention_candidates_telemetry_driven_checks.sql
"${PSQL[@]}" -f tests/fixtures/migration-check/pubg_player_matches_autovacuum_checks.sql
"${PSQL[@]}" -f tests/fixtures/migration-check/player-match-row-extras-checks.sql
"${PSQL[@]}" -f tests/fixtures/migration-check/retention_legacy_binding_checks.sql
"${PSQL[@]}" -f tests/fixtures/migration-check/retention_match_type_recovery_checks.sql
"${PSQL[@]}" -f tests/fixtures/migration-check/legacy_team_retention_recovery_checks.sql
"${PSQL[@]}" -f tests/sql/legacy-team-event-metadata-checks.sql
"${PSQL[@]}" -f tests/fixtures/migration-check/legacy_map_retention_recovery_checks.sql
if [ -n "${BGMS_RETENTION_PACKET_FILE:-}" ]; then
  BGMS_PSQL_BIN="${PSQL[0]}" BGMS_RETENTION_PGHOST="${PSQL[2]}" BGMS_RETENTION_PGPORT="${PSQL[4]}" \
    npx tsx scripts/verify_legacy_team_retention_rpc.mts
fi
if [ -n "${BGMS_LEGACY_MAP_PACKET_FILE:-}" ]; then
  ACTUAL_MAP_PACKET_SQL_FILE="$(mktemp "${TMPDIR:-/tmp}/bgms-legacy-map-packet.XXXXXX.sql")"
  chmod 600 "$ACTUAL_MAP_PACKET_SQL_FILE"
  python3 - "$BGMS_LEGACY_MAP_PACKET_FILE" "$ACTUAL_MAP_PACKET_SQL_FILE" <<'PY'
import json
import pathlib
import sys

source = pathlib.Path(sys.argv[1])
destination = pathlib.Path(sys.argv[2])
try:
    if source.stat().st_mode & 0o077:
        raise ValueError
    raw = source.read_bytes()
    packet = json.loads(raw)
    if len(raw) > 131072 or not isinstance(packet, dict) or set(packet) != {
        "before", "registry", "expectedBasic", "performance"
    }:
        raise ValueError
except Exception:
    print("Invalid or non-private legacy map packet; refusing local verification", file=sys.stderr)
    sys.exit(1)

for key in ("before", "expectedBasic"):
    if isinstance(packet.get(key), dict) and "retention_scope" not in packet[key]:
        packet[key]["retention_scope"] = "legacy"
packet_hex = json.dumps(packet, separators=(",", ":")).encode().hex()
sql = f"""begin;
set local timezone='UTC';
create temporary table actual_legacy_map_packet(packet jsonb not null) on commit drop;
insert into actual_legacy_map_packet values (pg_catalog.convert_from(pg_catalog.decode('{packet_hex}','hex'),'UTF8')::jsonb);
insert into public.pubg_player_matches
select (pg_catalog.jsonb_populate_record(null::public.pubg_player_matches,p.packet->'before')).*
from actual_legacy_map_packet p on conflict do nothing;
insert into public.telemetry_map_cache_entries
select (pg_catalog.jsonb_populate_record(null::public.telemetry_map_cache_entries,p.packet->'registry')).*
from actual_legacy_map_packet p on conflict do nothing;
grant select on actual_legacy_map_packet to service_role;
set local role service_role;
do $verify$
declare p jsonb; answer jsonb; basic_after jsonb; performance_after jsonb; saved_count integer;
begin
  select packet into p from actual_legacy_map_packet;
  answer := public.recover_retention_legacy_map(p);
  if answer->>'saved' is distinct from 'true' or answer->'basic' is distinct from p->'expectedBasic' then
    raise exception 'actual map packet basic readback mismatch';
  end if;
  select pg_catalog.to_jsonb(m) into basic_after from public.pubg_player_matches m
  where m.platform=p->'performance'->>'platform' and m.match_id=p->'performance'->>'match_id'
    and m.player_id=p->'performance'->>'player_id';
  select pg_catalog.to_jsonb(f),count(*)::integer into performance_after,saved_count
  from public.pubg_match_performance f
  where f.platform=p->'performance'->>'platform' and f.match_id=p->'performance'->>'match_id'
    and f.account_id=p->'performance'->>'account_id'
    and f.calculation_version=(p->'performance'->>'calculation_version')::integer
    and f.result_version=(p->'performance'->>'result_version')::integer
  group by f.platform,f.account_id,f.match_id,f.player_id,f.calculation_version,f.result_version,
    f.score,f.tier,f.benchmark,f.ranking_eligible,f.calculated_at,f.summary,f.played_at,f.summary_version,f.source_checksum;
  if basic_after is distinct from p->'expectedBasic' or saved_count is distinct from 1
     or (performance_after - array['calculated_at','played_at']::text[]) is distinct from ((p->'performance') - 'played_at')
     or (performance_after->>'played_at')::timestamptz is distinct from (p->'performance'->>'played_at')::timestamptz then
    raise exception 'actual map packet strict readback mismatch';
  end if;
end;
$verify$;
reset role;
rollback;
select 'actual legacy-map production packet passed isolated PostgreSQL verification' as result;
"""
destination.write_text(sql)
destination.chmod(0o600)
PY
  OUTPUT="$("${PSQL[@]}" -f "$ACTUAL_MAP_PACKET_SQL_FILE" 2>&1)" || {
    ACTUAL_MAP_ERROR_DIR="$(mktemp -d "${TMPDIR:-/tmp}/bgms-legacy-map-error.XXXXXX")"
    chmod 700 "$ACTUAL_MAP_ERROR_DIR"
    printf '%s\n' "$OUTPUT" > "$ACTUAL_MAP_ERROR_DIR/error.log"
    chmod 600 "$ACTUAL_MAP_ERROR_DIR/error.log"
    rm -f "$ACTUAL_MAP_PACKET_SQL_FILE"
    printf 'Actual map packet verification failed; private details: %s\n' "$ACTUAL_MAP_ERROR_DIR"
    exit 1
  }
  echo "$OUTPUT" | grep -q "actual legacy-map production packet passed isolated PostgreSQL verification" || {
    rm -f "$ACTUAL_MAP_PACKET_SQL_FILE"
    printf '%s\n' 'Actual map packet verification completion was not confirmed'
    exit 1
  }
  rm -f "$ACTUAL_MAP_PACKET_SQL_FILE"
  echo "  ✅ 비공개 실제 map packet 격리 검증"
fi
"${PSQL[@]}" -f tests/fixtures/migration-check/player-cache-compaction-scenarios.sql
"${PSQL[@]}" -f tests/fixtures/migration-check/suggest-similar-players-scenarios.sql
"${PSQL[@]}" -f tests/fixtures/migration-check/ranking-performance-scenarios.sql
"${PSQL[@]}" -f tests/fixtures/migration-check/ranking-cache-scenarios.sql
"${PSQL[@]}" -f tests/fixtures/migration-check/ranking-background-refresh-scenarios.sql
"${PSQL[@]}" -f tests/fixtures/migration-check/slow-query-index-scenarios.sql
"${PSQL[@]}" -f tests/fixtures/migration-check/bluezone-bucket-scenarios.sql
"${PSQL[@]}" -f tests/fixtures/migration-check/team-benchmark-scenarios.sql
"${PSQL[@]}" -f tests/fixtures/migration-check/calculation-coexistence-scenarios.sql
"${PSQL[@]}" -f tests/fixtures/migration-check/retained-performance-scenarios.sql
"${PSQL[@]}" -f tests/fixtures/migration-check/performance-jobs-newest-first-checks.sql
"${PSQL[@]}" -f tests/fixtures/migration-check/encounter-page-scenarios.sql
"${PSQL[@]}" -f tests/fixtures/migration-check/match-discovery-scenarios.sql
"${PSQL[@]}" -f tests/fixtures/migration-check/scoped-match-discovery-scenarios.sql
"${PSQL[@]}" -f tests/fixtures/migration-check/mobile-board-likes-scenarios.sql
"${PSQL[@]}" -f tests/fixtures/migration-check/board-public-write-boundaries.sql
# 이미 적용된 DB 에 다시 실행해도 권한 상태가 같아야 한다.
"${PSQL[@]}" -f supabase/migrations/20261014090000_restrict_public_board_writes.sql
"${PSQL[@]}" -f supabase/migrations/20261014140000_reports_revoke_public_truncate.sql
"${PSQL[@]}" -f tests/fixtures/migration-check/board-public-write-boundaries.sql
"${PSQL[@]}" -f tests/fixtures/migration-check/board-post-views-scenarios.sql
# 이미 적용된 DB 에 다시 실행해도 조회수 경로 권한과 동작이 같아야 한다.
"${PSQL[@]}" -f supabase/migrations/20261014120000_protect_board_post_views.sql
"${PSQL[@]}" -f tests/fixtures/migration-check/board-post-views-scenarios.sql
"${PSQL[@]}" -f tests/fixtures/migration-check/legacy-function-search-path.sql
# 이미 적용된 DB 에 다시 실행해도 설정과 권한이 같아야 한다.
"${PSQL[@]}" -f supabase/migrations/20261014100000_pin_legacy_function_search_path.sql
"${PSQL[@]}" -f tests/fixtures/migration-check/legacy-function-search-path.sql
"${PSQL[@]}" -f tests/fixtures/migration-check/pubg-collection-cron-scenarios.sql
"${PSQL[@]}" -f tests/fixtures/migration-check/ban-watch-scenarios.sql
"${PSQL[@]}" -f tests/fixtures/migration-check/ban-watch-boundaries.sql
"${PSQL[@]}" -f tests/fixtures/migration-check/membership-lifecycle-scenarios.sql
"${PSQL[@]}" -f tests/fixtures/migration-check/calculation-canonical-scenarios.sql
if ! OUTPUT="$("${PSQL[@]}" -f tests/fixtures/migration-check/scenarios.sql 2>&1)"; then
  printf '%s\n' "$OUTPUT"
  exit 1
fi
echo "$OUTPUT" | grep -E "NOTICE|ERROR|^---|^===" || true

if echo "$OUTPUT" | grep -q "FAIL"; then
  echo "❌ 시나리오 실패"
  exit 1
fi
if ! echo "$OUTPUT" | grep -q "전체 시나리오 통과"; then
  echo "❌ 시나리오가 끝까지 실행되지 않았습니다"
  exit 1
fi

"${PSQL[@]}" -f tests/fixtures/migration-check/calculation-scenarios.sql
"${PSQL[@]}" -f tests/fixtures/migration-check/calculation-v3-scenarios.sql
"${PSQL[@]}" -f tests/fixtures/migration-check/calculation-v4-scenarios.sql
"${PSQL[@]}" -f tests/fixtures/migration-check/calculation-v5-scenarios.sql
"${PSQL[@]}" -f tests/fixtures/migration-check/counter-latency-split-scenarios.sql
"${PSQL[@]}" -f tests/fixtures/migration-check/first-reply-evidence-scenarios.sql
"${PSQL[@]}" -f tests/fixtures/migration-check/support-center-scenarios.sql
"${PSQL[@]}" -f tests/fixtures/migration-check/public-column-privacy-checks.sql
"${PSQL[@]}" -f tests/fixtures/migration-check/client-grant-hardening-checks.sql
"${PSQL[@]}" -f tests/fixtures/migration-check/ranking-cache-concurrency-setup.sql
# 요청은 집계하지 않고 등록만 한다. 동시 요청 두 개가 등록 행 하나만 만든다.
"${PSQL[@]}" -c "set role service_role; select public.get_pubg_rankings_cached('damage',array['solo'],'all',3,8,1,73)->>'pending';" &
ranking_first_pid=$!
"${PSQL[@]}" -c "set role service_role; select public.get_pubg_rankings_cached('damage',array['solo'],'all',3,8,1,73)->>'pending';" &
ranking_second_pid=$!
wait "$ranking_first_pid"
wait "$ranking_second_pid"
"${PSQL[@]}" -c "do \$\$ begin if (select count(*) from public.pubg_response_cache where cache_key like 'rankings:v2:%')<>1 or exists(select 1 from public.ranking_cache_test_calls) then raise exception 'Request path queued twice or aggregated'; end if; end \$\$;"
# 예약 집계 두 개가 동시에 돌아도 한 번만 집계한다.
# 첫 실행은 108개 조합 등록만 하고 커밋한다.
"${PSQL[@]}" -c "select public.refresh_pubg_rankings_cache();"
"${PSQL[@]}" -c "select public.refresh_pubg_rankings_cache();" &
ranking_first_pid=$!
"${PSQL[@]}" -c "select public.refresh_pubg_rankings_cache();" &
ranking_second_pid=$!
wait "$ranking_first_pid"
wait "$ranking_second_pid"
"${PSQL[@]}" -c "do \$\$ begin
  if (select count(*) from public.ranking_cache_test_calls)<>1 then raise exception 'Concurrent refresh aggregated more than once'; end if;
  end \$\$;
  delete from public.pubg_response_cache where cache_key like 'rankings:v2:%';
  delete from public.ranking_cache_test_calls;"
"${PSQL[@]}" -c "set role service_role; select public.get_pubg_rankings_cached('damage',array['solo'],'all',3,8,1,73)->>'pending';"
"${PSQL[@]}" -c "select public.refresh_pubg_rankings_cache();"
"${PSQL[@]}" -c "select public.refresh_pubg_rankings_cache();" &
ranking_privacy_pid=$!
ranking_aggregate_started=false
for _ in $(seq 1 50); do
  if [ "$("${PSQL[@]}" -At -c "select exists(select 1 from pg_locks where locktype='advisory' and classid=(20261010041817::bigint>>32)::oid and objid=(20261010041817::bigint&4294967295)::oid and granted);")" = "t" ]; then
    ranking_aggregate_started=true
    break
  fi
  sleep 0.02
done
if [ "$ranking_aggregate_started" != true ]; then
  echo "❌ 동시 비공개 검증의 집계 시작을 확인하지 못했습니다"
  exit 1
fi
"${PSQL[@]}" -c "update public.system_settings set value='[{\"platform\":\"steam\",\"nickname\":\"concurrent-ranking\",\"account_id\":\"account.concurrentranking\"}]' where key='private_players_list';"
if wait "$ranking_privacy_pid"; then
  echo "❌ 집계 중 비공개 변경을 정상 결과로 저장했습니다"
  exit 1
fi
"${PSQL[@]}" -f tests/fixtures/migration-check/ranking-cache-concurrency-checks.sql
echo "▶ LoL persistence 시나리오 실행"
"${PSQL[@]}" -f tests/fixtures/migration-check/lol-persistence-scenarios.sql
"${PSQL[@]}" -f tests/fixtures/migration-check/lol-ranked-history-scenarios.sql
"${PSQL[@]}" -f tests/fixtures/migration-check/lol-ranked-daily-scenarios.sql
"${PSQL[@]}" -f tests/fixtures/migration-check/lol-ops-scenarios.sql
"${PSQL[@]}" -f tests/fixtures/migration-check/lol-player-summaries-scenarios.sql
"${PSQL[@]}" -f tests/fixtures/migration-check/lol-benchmark-scenarios.sql
"${PSQL[@]}" -f tests/fixtures/migration-check/lol-participant-identity-scenarios.sql
"${PSQL[@]}" -f tests/fixtures/migration-check/lol-augment-catalog-scenarios.sql
"${PSQL[@]}" -f tests/fixtures/migration-check/lol-review-hardening-scenarios.sql
"${PSQL[@]}" -f tests/fixtures/migration-check/lol-challenges-scenarios.sql
"${PSQL[@]}" -f tests/fixtures/migration-check/lol-challenge-catalog-scenarios.sql
"${PSQL[@]}" -f tests/fixtures/migration-check/lol-review-fixes-scenarios.sql
"${PSQL[@]}" -f tests/fixtures/migration-check/lol-search-cache-cap-scenarios.sql
"${PSQL[@]}" -f tests/fixtures/migration-check/lol-search-snapshot-scenarios.sql
"${PSQL[@]}" -f tests/fixtures/migration-check/lol-guard-snapshot-fixes-scenarios.sql
# 계정 삭제가 진행 중일 때 들어온 보관본 저장은 삭제 커밋을 기다린 뒤 거절되어야 한다.
"${PSQL[@]}" -q -c "insert into public.lol_accounts (puuid,game_name,tag_line,platform_id,regional_route) values ('race-puuid','Race','KR1','kr','asia');"
"${PSQL[@]}" -q -c "begin; set local role service_role; select public.delete_lol_account_data('race-puuid'); select pg_sleep(1.5); commit;" >/dev/null &
lol_delete_pid=$!
sleep 0.5
lol_race_saved="$("${PSQL[@]}" -qAt -c "set role service_role; select public.put_lol_search_snapshot('search-snapshot:v11:kr:asia:16.21.1:race:kr1','kr','asia','16.21.1','race-puuid','{\"lastUpdatedAt\":\"2026-10-29T00:00:00Z\"}'::jsonb);")"
wait "$lol_delete_pid"
lol_race_rows="$("${PSQL[@]}" -qAt -c "select count(*) from public.lol_api_cache where cache_key='search-snapshot:v11:kr:asia:16.21.1:race:kr1'")"
if [ "$lol_race_saved" != "f" ] || [ "$lol_race_rows" != "0" ]; then
  echo "❌ 계정 삭제 중 저장된 LoL 보관본이 남았습니다 (saved=$lol_race_saved rows=$lol_race_rows)"
  exit 1
fi
echo "  ✅ 계정 삭제와 동시에 들어온 LoL 보관본 저장을 거절"
"${PSQL[@]}" -f tests/fixtures/migration-check/lol-ladder-status-scenarios.sql
"${PSQL[@]}" -f tests/fixtures/migration-check/lol-champion-bans-scenarios.sql
"${PSQL[@]}" -f tests/fixtures/migration-check/lol-champion-stats-scenarios.sql
# 같은 버킷의 동시 호출은 정확히 한 번만 허용한다.
"${PSQL[@]}" -c "set role service_role; delete from public.lol_public_rate_limits where bucket_key = 'search:' || repeat('e', 64);"
lol_limit_pids=()
for _ in $(seq 1 8); do
  "${PSQL[@]}" -c "set role service_role; do \$\$ begin
    if (public.consume_lol_public_rate_limit('search:' || repeat('e',64),1,60)->>'allowed')::boolean then
      perform public.increment_lol_ops_metric('search_cache_miss',1);
    end if;
  end \$\$;" &
  lol_limit_pids+=("$!")
done
for lol_limit_pid in "${lol_limit_pids[@]}"; do wait "$lol_limit_pid"; done
"${PSQL[@]}" -c "do \$\$ begin
  if (select count from public.lol_public_rate_limits where bucket_key='search:' || repeat('e',64)) <> 2
    or (select value from public.lol_ops_daily where metric='search_cache_miss' and day=(now() at time zone 'Asia/Seoul')::date) <> 1 then
    raise exception '공개 제한 동시 호출이 원자적이지 않습니다';
  end if;
end \$\$;"
# 같은 패치의 실제 동시 실행도 활성 lease 하나만 얻어야 한다.
"${PSQL[@]}" -c "set role service_role; select public.acquire_lol_augment_ingestion_lease('16.24');" &
augment_first_pid=$!
"${PSQL[@]}" -c "set role service_role; select public.acquire_lol_augment_ingestion_lease('16.24');" &
augment_second_pid=$!
wait "$augment_first_pid"
wait "$augment_second_pid"
"${PSQL[@]}" -c "do \$\$ begin
  if (select count(*) from public.lol_augment_ingestion_runs where client_patch='16.24')<>1
    or (select count(*) from public.lol_augment_ingestion_runs where client_patch='16.24' and status='running')<>1 then
    raise exception 'Concurrent augment ingestion acquired multiple leases';
  end if;
  end \$\$;
  delete from public.lol_augment_ingestion_runs where client_patch='16.24';
  delete from public.lol_game_patches where client_patch='16.24';"
echo "  ✅ 증강 lease 동시 요청 2개 중 1개 획득"
echo "✅ 신규 migration 적용 및 RPC 동작 검증 완료"
