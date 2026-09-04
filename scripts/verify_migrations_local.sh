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
)

cleanup() {
  if [ "$USE_LOCAL_POSTGRES" = true ] && [ -n "$LOCAL_DATA_DIR" ]; then
    "$PG_BIN/pg_ctl" -D "$LOCAL_DATA_DIR" -m immediate stop >/dev/null 2>&1 || true
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

echo "▶ 신규 migration 적용"
for migration in "${MIGRATIONS[@]}"; do
  "${PSQL[@]}" -f "supabase/migrations/${migration}.sql"
  echo "  ✅ ${migration}"
done

echo "▶ RPC 동작 시나리오 실행"
OUTPUT="$("${PSQL[@]}" -f tests/fixtures/migration-check/scenarios.sql 2>&1)"
echo "$OUTPUT" | grep -E "NOTICE|ERROR|^---|^===" || true

if echo "$OUTPUT" | grep -q "FAIL"; then
  echo "❌ 시나리오 실패"
  exit 1
fi
if ! echo "$OUTPUT" | grep -q "전체 시나리오 통과"; then
  echo "❌ 시나리오가 끝까지 실행되지 않았습니다"
  exit 1
fi

echo "✅ 신규 migration 적용 및 RPC 동작 검증 완료"
