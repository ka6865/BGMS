#!/usr/bin/env bash
#
# 운영과 분리된 일회용 PostgreSQL 17 컨테이너에 신규 migration 을 적용하고
# RPC 동작 시나리오를 실행합니다. 운영 DB 를 절대 건드리지 않습니다.
#
# 사용법: npm run verify:migrations
#
# 전제: Docker 실행 중, psql 설치됨.
# 저장소 전체 migration 재생은 baseline 결함(20260526022000 이 이력에 없는 public.profiles 를
# 참조)으로 불가하므로, 아래 prerequisites.sql 로 신규 migration 이 참조하는 객체만 만듭니다.

set -euo pipefail

CONTAINER_NAME="bgms-mig-check"
PG_PORT="${BGMS_MIG_CHECK_PORT:-55433}"
export PGPASSWORD=pw

MIGRATIONS=(
  "20260730200100_weapon_patch_proposals"
  "20260730203000_tighten_service_data_write_policies"
  "20260730204500_discord_room_rate_limit"
  "20260730210000_pubg_response_cache"
  "20260819115023_profile_linked_pubg_auto_sync"
)

cleanup() {
  docker rm -f "$CONTAINER_NAME" >/dev/null 2>&1 || true
}
trap cleanup EXIT

echo "▶ 일회용 PostgreSQL 17 컨테이너 기동"
cleanup
docker run -d --name "$CONTAINER_NAME" -e POSTGRES_PASSWORD=pw -p "${PG_PORT}:5432" postgres:17 >/dev/null

for _ in $(seq 1 60); do
  if psql -h 127.0.0.1 -p "$PG_PORT" -U postgres -c 'select 1' >/dev/null 2>&1; then break; fi
  sleep 1
done

PSQL_ROOT=(psql -h 127.0.0.1 -p "$PG_PORT" -U postgres -v ON_ERROR_STOP=1 -q)
"${PSQL_ROOT[@]}" -c "drop database if exists migcheck;" -c "create database migcheck;"

PSQL=(psql -h 127.0.0.1 -p "$PG_PORT" -U postgres -d migcheck -v ON_ERROR_STOP=1 -q)

echo "▶ prerequisite 스키마 구성"
"${PSQL[@]}" -f tests/fixtures/migration-check/prerequisites.sql

echo "▶ 신규 migration 적용"
for migration in "${MIGRATIONS[@]}"; do
  "${PSQL[@]}" -f "supabase/migrations/${migration}.sql"
  echo "  ✅ ${migration}"
done

echo "▶ RPC 동작 시나리오 실행"
OUTPUT="$(psql -h 127.0.0.1 -p "$PG_PORT" -U postgres -d migcheck -v ON_ERROR_STOP=1 \
  -f tests/fixtures/migration-check/scenarios.sql 2>&1)"
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
