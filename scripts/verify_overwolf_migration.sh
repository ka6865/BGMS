#!/usr/bin/env bash
#
# Overwolf GEP 세션 요약 migration 을 일회용 PostgreSQL 에 적용하고
# RPC 동작 시나리오를 실행합니다. 운영 DB 를 절대 건드리지 않습니다.
#
# 사용법: npm run verify:overwolf-db
#
# 전제: psql 설치됨. Docker 가 있으면 컨테이너를, 없으면 임시 initdb 인스턴스를 사용합니다.

set -euo pipefail

CONTAINER_NAME="bgms-overwolf-mig-check"
PG_PORT="${BGMS_OVERWOLF_MIG_PORT:-55433}"
MIGRATION="20260731070000_overwolf_gep_session_events"
USE_DOCKER=0
TEMP_PGDATA=""

cleanup() {
  if [ "$USE_DOCKER" = "1" ]; then
    docker rm -f "$CONTAINER_NAME" >/dev/null 2>&1 || true
    return
  fi
  if [ -n "$TEMP_PGDATA" ]; then
    pg_ctl -D "$TEMP_PGDATA/data" stop >/dev/null 2>&1 || true
  fi
}
trap cleanup EXIT

if docker info >/dev/null 2>&1; then
  USE_DOCKER=1
  export PGPASSWORD=pw
  echo "▶ 일회용 PostgreSQL 17 컨테이너 기동"
  docker rm -f "$CONTAINER_NAME" >/dev/null 2>&1 || true
  docker run -d --name "$CONTAINER_NAME" -e POSTGRES_PASSWORD=pw \
    -p "${PG_PORT}:5432" postgres:17 >/dev/null
else
  echo "▶ Docker 없음. 임시 initdb 인스턴스 기동"
  TEMP_PGDATA="$(mktemp -d)"
  initdb -D "$TEMP_PGDATA/data" -U postgres --auth=trust >/dev/null
  pg_ctl -D "$TEMP_PGDATA/data" \
    -o "-p ${PG_PORT} -k $TEMP_PGDATA" \
    -l "$TEMP_PGDATA/log.txt" start >/dev/null
fi

for _ in $(seq 1 60); do
  if psql -h 127.0.0.1 -p "$PG_PORT" -U postgres -c 'select 1' >/dev/null 2>&1; then break; fi
  sleep 1
done

PSQL_ROOT=(psql -h 127.0.0.1 -p "$PG_PORT" -U postgres -v ON_ERROR_STOP=1 -q)
"${PSQL_ROOT[@]}" -c "drop database if exists overwolfmigcheck;" \
  -c "create database overwolfmigcheck;"

PSQL=(psql -h 127.0.0.1 -p "$PG_PORT" -U postgres -d overwolfmigcheck -v ON_ERROR_STOP=1 -q)

# Supabase 와 동일한 역할 속성을 만든다. service_role 은 실제로 bypassrls 다.
echo "▶ Supabase 역할 구성"
"${PSQL[@]}" -c "
do \$\$
begin
  if not exists (select 1 from pg_roles where rolname = 'anon') then
    create role anon nologin;
  end if;
  if not exists (select 1 from pg_roles where rolname = 'authenticated') then
    create role authenticated nologin;
  end if;
  if not exists (select 1 from pg_roles where rolname = 'service_role') then
    create role service_role nologin bypassrls;
  end if;
end \$\$;
"

echo "▶ migration 적용"
"${PSQL[@]}" -f "supabase/migrations/${MIGRATION}.sql"
echo "  ✅ ${MIGRATION}"

echo "▶ RPC 동작 시나리오 실행"
OUTPUT="$(psql -h 127.0.0.1 -p "$PG_PORT" -U postgres -d overwolfmigcheck \
  -f tests/fixtures/migration-check/overwolf-session-scenarios.sql 2>&1)"
echo "$OUTPUT" | grep -E "NOTICE|ERROR|^---|^===" || true

if echo "$OUTPUT" | grep -q "FAIL"; then
  echo "❌ 시나리오 실패"
  exit 1
fi
if ! echo "$OUTPUT" | grep -q "전체 시나리오 통과"; then
  echo "❌ 시나리오가 끝까지 실행되지 않았습니다"
  exit 1
fi

echo "✅ Overwolf 세션 migration 적용 및 RPC 동작 검증 완료"
