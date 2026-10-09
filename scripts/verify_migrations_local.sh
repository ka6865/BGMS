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

CONTAINER_NAME="bgms-mig-check"
PG_PORT="${BGMS_MIG_CHECK_PORT:-55433}"
PG_BIN="${BGMS_PG_BIN:-}"
FORCE_LOCAL_POSTGRES="${BGMS_USE_LOCAL_POSTGRES:-false}"
LOCAL_DATA_DIR=""
LOCAL_SOCKET_DIR=""
ACTUAL_MAP_PACKET_SQL_FILE=""
USE_LOCAL_POSTGRES=false
export PGPASSWORD=pw

MIGRATIONS=(
  "20260730200100_weapon_patch_proposals"
  "20260730203000_tighten_service_data_write_policies"
  "20260730204500_discord_room_rate_limit"
  "20260730210000_pubg_response_cache"
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
)

cleanup() {
  if [ -n "$ACTUAL_MAP_PACKET_SQL_FILE" ]; then
    rm -f "$ACTUAL_MAP_PACKET_SQL_FILE"
  fi
  if [ "$USE_LOCAL_POSTGRES" = true ] && [ -n "$LOCAL_DATA_DIR" ]; then
    "$PG_BIN/pg_ctl" -D "$LOCAL_DATA_DIR" -m immediate stop >/dev/null 2>&1 || true
    rm -rf "$LOCAL_DATA_DIR" "$LOCAL_SOCKET_DIR"
  else
    docker rm -f "$CONTAINER_NAME" >/dev/null 2>&1 || true
  fi
}
trap cleanup EXIT

if [ "$FORCE_LOCAL_POSTGRES" = true ] || ! docker info >/dev/null 2>&1; then
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
  cleanup
  docker run -d --name "$CONTAINER_NAME" -e POSTGRES_PASSWORD=pw -p "${PG_PORT}:5432" postgres:17 >/dev/null

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
  if [ "$migration" = "20261005081214_pubg_collection_database_clock" ]; then
    # The hosted extensions are fixture interfaces here; all application SQL is
    # applied unchanged. Real extension install and delivery need live checks.
    sed '/^create extension if not exists pg_cron /d; /^create extension if not exists pg_net /d' \
      "supabase/migrations/${migration}.sql" | "${PSQL[@]}"
  else
    "${PSQL[@]}" -f "supabase/migrations/${migration}.sql"
  fi
  echo "  ✅ ${migration}"
done

echo "▶ RPC 동작 시나리오 실행"
"${PSQL[@]}" -f tests/fixtures/migration-check/participant_match_retention_scope_checks.sql
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
"${PSQL[@]}" -f tests/fixtures/migration-check/ranking-performance-scenarios.sql
"${PSQL[@]}" -f tests/fixtures/migration-check/retained-performance-scenarios.sql
"${PSQL[@]}" -f tests/fixtures/migration-check/encounter-page-scenarios.sql
"${PSQL[@]}" -f tests/fixtures/migration-check/match-discovery-scenarios.sql
"${PSQL[@]}" -f tests/fixtures/migration-check/scoped-match-discovery-scenarios.sql
"${PSQL[@]}" -f tests/fixtures/migration-check/mobile-board-likes-scenarios.sql
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
"${PSQL[@]}" -f tests/fixtures/migration-check/support-center-scenarios.sql
echo "✅ 신규 migration 적용 및 RPC 동작 검증 완료"
