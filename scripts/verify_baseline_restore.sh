#!/usr/bin/env bash
#
# 운영 스키마 baseline 으로 빈 DB 를 복구할 수 있는지 검증합니다.
# 운영 DB 를 읽지도 쓰지도 않습니다. 일회용 컨테이너 또는 로컬 클러스터만 사용합니다.
#
# 사용법: npm run verify:baseline
#
# 전제: Docker와 psql 또는 PostgreSQL 17 로컬 실행 파일.
#
# 배경:
#   저장소의 migration 만으로는 빈 DB 를 재현할 수 없습니다. 2026-08-01 실측에서
#   58개 중 26개가 실패하고 테이블이 32개만 생겼습니다(운영은 60개). posts,
#   comments, profiles, map_markers, pubg_player_cache 등 핵심 테이블이 Supabase
#   콘솔에서 직접 생성되어 CREATE TABLE 이력이 없기 때문입니다.
#
#   따라서 재해 복구 경로는 migration 재생이 아니라 baseline 스키마입니다.
#   이 스크립트가 그 경로를 검증합니다.
#
# 검증 항목:
#   1. baseline 이 빈 DB 에서 오류 없이 적용되는지
#   2. 객체 수가 운영과 일치하는지
#   3. baseline 위에 최신 migration 을 적용해도 깨지지 않는지
#   4. 핵심 RPC 가 실제로 동작하는지

set -euo pipefail

PG_PORT="${BGMS_BASELINE_CHECK_PORT:-55434}"
PG_BIN="${BGMS_PG_BIN:-}"
PSQL_BIN="psql"
FORCE_LOCAL_POSTGRES="${BGMS_USE_LOCAL_POSTGRES:-false}"
LOCAL_DATA_DIR=""
LOCAL_SOCKET_DIR=""
CONTAINER_ID=""
USE_LOCAL_POSTGRES=false
BASELINE_FILE="tests/fixtures/migration-check/baseline-schema.sql"
BASELINE_MIGRATION_CUTOFF="20260801000000"
export PGPASSWORD=pw

# 운영 실측값. baseline 이 이 수치를 재현해야 한다.
EXPECTED_TABLES=60
EXPECTED_POLICIES=68

cleanup() {
  if [ "$USE_LOCAL_POSTGRES" = true ] && [ -n "$LOCAL_DATA_DIR" ]; then
    "$PG_BIN/pg_ctl" -D "$LOCAL_DATA_DIR" -m immediate stop >/dev/null 2>&1 || true
    rm -rf "$LOCAL_DATA_DIR" "$LOCAL_SOCKET_DIR"
  elif [ -n "$CONTAINER_ID" ]; then
    docker rm -f "$CONTAINER_ID" >/dev/null 2>&1 || true
  fi
}
trap cleanup EXIT

if [ ! -f "$BASELINE_FILE" ]; then
  echo "❌ baseline 파일이 없습니다: $BASELINE_FILE"
  echo "   supabase db dump --linked -f tmp/prod_schema.sql 후 npm run db:baseline:refresh 를 실행하세요."
  exit 1
fi

if [ "$FORCE_LOCAL_POSTGRES" = true ] || ! command -v docker >/dev/null 2>&1 || ! docker info >/dev/null 2>&1; then
  if [ -z "$PG_BIN" ] && command -v brew >/dev/null 2>&1; then PG_BIN="$(brew --prefix postgresql@17 2>/dev/null)/bin"; fi
  if [ -z "$PG_BIN" ] || [ ! -x "$PG_BIN/initdb" ] || [ ! -x "$PG_BIN/pg_ctl" ]; then
    echo "❌ Docker를 사용할 수 없고 PostgreSQL 17 실행 파일도 찾지 못했습니다"
    exit 1
  fi
  USE_LOCAL_POSTGRES=true
  PSQL_BIN="$PG_BIN/psql"
  LOCAL_DATA_DIR="$(mktemp -d "${TMPDIR:-/tmp}/bgms-baseline-data.XXXXXX")"
  LOCAL_SOCKET_DIR="$(mktemp -d "${TMPDIR:-/tmp}/bgms-baseline-socket.XXXXXX")"
  echo "▶ 일회용 PostgreSQL 17 로컬 클러스터 기동"
  "$PG_BIN/initdb" -D "$LOCAL_DATA_DIR" -A trust -U postgres --no-locale >/dev/null
  "$PG_BIN/pg_ctl" -D "$LOCAL_DATA_DIR" -o "-p ${PG_PORT} -k ${LOCAL_SOCKET_DIR}" -l "$LOCAL_DATA_DIR/postgres.log" start >/dev/null
  PSQL_ROOT=("$PG_BIN/psql" -h "$LOCAL_SOCKET_DIR" -p "$PG_PORT" -U postgres -v ON_ERROR_STOP=1 -q)
  PSQL=("$PG_BIN/psql" -h "$LOCAL_SOCKET_DIR" -p "$PG_PORT" -U postgres -d baseline_check -v ON_ERROR_STOP=1 -q)
  PSQL_ARGS=(-h "$LOCAL_SOCKET_DIR" -p "$PG_PORT" -U postgres)
else
  echo "▶ 일회용 PostgreSQL 17 컨테이너 기동"
  CONTAINER_ID="$(docker run -d --name "bgms-baseline-check-$$" -e POSTGRES_PASSWORD=pw -p "${PG_PORT}:5432" postgres:17)"
  PSQL_ROOT=(psql -h 127.0.0.1 -p "$PG_PORT" -U postgres -v ON_ERROR_STOP=1 -q)
  PSQL=(psql -h 127.0.0.1 -p "$PG_PORT" -U postgres -d baseline_check -v ON_ERROR_STOP=1 -q)
  PSQL_ARGS=(-h 127.0.0.1 -p "$PG_PORT" -U postgres)
fi

postgres_ready=false
for _ in $(seq 1 60); do
  if "${PSQL_ROOT[@]}" -c 'select 1' >/dev/null 2>&1; then postgres_ready=true; break; fi
  sleep 1
done
if [ "$postgres_ready" != true ]; then echo "❌ 일회용 PostgreSQL이 준비되지 않았습니다"; exit 1; fi
"${PSQL_ROOT[@]}" -c "drop database if exists baseline_check;" -c "create database baseline_check;"

echo "▶ Supabase 플랫폼 전제 구성 (역할, auth, storage)"
"${PSQL[@]}" <<'SQL'
create extension if not exists pgcrypto;
do $$
begin
  if not exists (select 1 from pg_roles where rolname = 'anon') then create role anon nologin; end if;
  if not exists (select 1 from pg_roles where rolname = 'authenticated') then create role authenticated nologin; end if;
  if not exists (select 1 from pg_roles where rolname = 'service_role') then create role service_role nologin bypassrls; end if;
  if not exists (select 1 from pg_roles where rolname = 'supabase_admin') then create role supabase_admin nologin; end if;
  if not exists (select 1 from pg_roles where rolname = 'authenticator') then create role authenticator nologin; end if;
end $$;

-- Supabase 가 관리하는 스키마. baseline 이 이 객체를 참조한다.
create schema if not exists auth;
create table if not exists auth.users (
  id uuid primary key default gen_random_uuid(),
  email text,
  raw_user_meta_data jsonb
);
create or replace function auth.uid() returns uuid language sql stable as $$ select null::uuid $$;
create or replace function auth.role() returns text language sql stable as $$ select 'anon'::text $$;

create schema if not exists storage;
create table if not exists storage.buckets (
  id text primary key,
  name text,
  public boolean default false
);
create table if not exists storage.objects (
  id uuid primary key default gen_random_uuid(),
  bucket_id text,
  name text,
  owner uuid,
  metadata jsonb
);
SQL

echo "▶ baseline 적용"
# 덤프에 포함된 set_config 결과 행은 노이즈이므로 숨긴다.
"${PSQL[@]}" -t -o /dev/null -f "$BASELINE_FILE"
echo "  ✅ 오류 없이 적용됨"

echo "▶ 객체 수 검증"
ACTUAL_TABLES=$("$PSQL_BIN" "${PSQL_ARGS[@]}" -d baseline_check -t -A -c \
  "select count(*) from pg_class c join pg_namespace n on n.oid = c.relnamespace where n.nspname = 'public' and c.relkind = 'r';")
ACTUAL_POLICIES=$("$PSQL_BIN" "${PSQL_ARGS[@]}" -d baseline_check -t -A -c \
  "select count(*) from pg_policies where schemaname = 'public';")
ACTUAL_RLS=$("$PSQL_BIN" "${PSQL_ARGS[@]}" -d baseline_check -t -A -c \
  "select count(*) from pg_class c join pg_namespace n on n.oid = c.relnamespace where n.nspname = 'public' and c.relkind = 'r' and c.relrowsecurity;")

echo "  테이블 ${ACTUAL_TABLES} / 정책 ${ACTUAL_POLICIES} / RLS ${ACTUAL_RLS}"

if [ "$ACTUAL_TABLES" -lt "$EXPECTED_TABLES" ]; then
  echo "❌ 테이블 수가 기대(${EXPECTED_TABLES})보다 적습니다. baseline 이 오래됐을 수 있습니다."
  exit 1
fi
if [ "$ACTUAL_POLICIES" -lt "$EXPECTED_POLICIES" ]; then
  echo "❌ 정책 수가 기대(${EXPECTED_POLICIES})보다 적습니다."
  exit 1
fi
# RLS 가 빠진 테이블이 있으면 권한 경계가 뚫린다.
if [ "$ACTUAL_RLS" -ne "$ACTUAL_TABLES" ]; then
  echo "❌ RLS 가 비활성인 테이블이 있습니다 (${ACTUAL_RLS}/${ACTUAL_TABLES})."
  exit 1
fi
echo "  ✅ 운영 수치와 일치"

echo "▶ 핵심 RPC 동작 확인"
OUTPUT="$("$PSQL_BIN" "${PSQL_ARGS[@]}" -d baseline_check -t -A -c "
select
  (select count(*) from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public'
     and p.proname in (
       'compact_match_stats_raw',
       'compact_pubg_player_cache',
       'count_pubg_api_errors_in_window',
       'get_table_sizes',
       'get_index_usage',
       'get_db_size',
       'record_overwolf_session_event',
       'reserve_pubg_api_alert_delivery'
     ));" 2>&1)"
echo "  운영 RPC ${OUTPUT}/8 존재"
if [ "$OUTPUT" -lt 8 ]; then
  echo "❌ baseline 에 없는 RPC 가 있습니다. 덤프를 갱신하세요."
  exit 1
fi

# dry-run 은 아무것도 지우지 않으므로 빈 DB 에서도 안전하다.
echo "▶ 정리 RPC dry-run 실행"
"${PSQL[@]}" <<'SQL'
do $$
declare
  result jsonb;
begin
  result := public.compact_match_stats_raw(false, 1000);
  if (result->>'candidate_count') is null then
    raise exception 'compact_match_stats_raw 응답에 candidate_count 가 없습니다';
  end if;
  if (result->>'total_count') is null then
    raise exception 'compact_match_stats_raw 응답에 total_count 가 없습니다';
  end if;

  result := public.compact_pubg_player_cache(90, false, 1000, 150000);
  if (result->>'candidate_count') is null then
    raise exception 'compact_pubg_player_cache 응답에 candidate_count 가 없습니다';
  end if;

  raise notice '정리 RPC dry-run 통과';
end $$;
SQL
echo "  ✅ 응답 계약 확인"

echo "▶ 최신 migration 재적용 (baseline 위)"
RECENT_FAILED=0
while IFS= read -r migration; do
  version="$(basename "$migration" .sql)"
  [[ "$version" < "$BASELINE_MIGRATION_CUTOFF" ]] && continue
  if ! OUT=$("${PSQL[@]}" -f "$migration" 2>&1); then
    echo "  ❌ $(basename "$migration")"
    echo "$OUT" | grep -E "ERROR:" | head -2
    RECENT_FAILED=1
  fi
  # NOTICE 는 IF NOT EXISTS 가 정상 동작한 결과이므로 실패로 보지 않는다.
  # psql 이 ON_ERROR_STOP 으로 멈추면 위 조건에서 이미 잡힌다.
done < <(find supabase/migrations -maxdepth 1 -type f -name '*.sql' -print | sort)

if [ "$RECENT_FAILED" -ne 0 ]; then
  echo "❌ 최신 migration 이 baseline 위에서 재적용되지 않습니다."
  echo "   운영에 이미 적용된 객체를 IF NOT EXISTS 또는 DROP ... IF EXISTS 로 감싸세요."
  exit 1
fi
echo "  ✅ 재적용 가능 (멱등)"

echo ""
echo "✅ baseline 복구 경로 검증 완료"
echo "   빈 DB 에서 운영과 같은 스키마를 만들 수 있습니다."
