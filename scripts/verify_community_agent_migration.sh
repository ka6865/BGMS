#!/usr/bin/env bash
# Verify the community-agent migration against a disposable local PostgreSQL 17.
# This script never reads a production connection string.
set -euo pipefail

readonly CONTAINER_NAME="bgms-community-agent-mig-check-$$"
readonly PG_PORT="${BGMS_COMMUNITY_AGENT_MIG_PORT:-$((56000 + ($$ % 500)))}"
readonly DATABASE="communityagentcheck"
readonly BOARD_MIGRATION="supabase/migrations/20260718203104_board_image_storage_ownership.sql"
readonly MIGRATION="supabase/migrations/20260908000000_community_agent_persistence.sql"
readonly FIXTURE="tests/fixtures/community-agent/prerequisites.sql"
readonly SCENARIOS="tests/fixtures/community-agent/scenarios.sql"
export PGPASSWORD=pw

cleanup() {
  docker rm -f "$CONTAINER_NAME" >/dev/null 2>&1 || true
}
trap cleanup EXIT

if ! command -v psql >/dev/null 2>&1; then
  echo "community-agent migration verification unavailable: psql is required; production DB is not used" >&2
  exit 2
fi
if ! docker info >/dev/null 2>&1; then
  echo "community-agent migration verification unavailable: Docker daemon is required; production DB is not used" >&2
  exit 2
fi
if [[ ! -f "$MIGRATION" ]]; then
  echo "community-agent migration is missing: $MIGRATION" >&2
  exit 1
fi

echo "▶ disposable PostgreSQL 17: 127.0.0.1:${PG_PORT}"
docker run -d --name "$CONTAINER_NAME" -e POSTGRES_PASSWORD=pw \
  -p "127.0.0.1:${PG_PORT}:5432" postgres:17 >/dev/null

for _ in $(seq 1 60); do
  if psql -h 127.0.0.1 -p "$PG_PORT" -U postgres -d postgres -c 'select 1' >/dev/null 2>&1; then
    break
  fi
  sleep 1
done
psql -h 127.0.0.1 -p "$PG_PORT" -U postgres -d postgres -v ON_ERROR_STOP=1 -q \
  -c "create database ${DATABASE};"

PSQL=(psql -h 127.0.0.1 -p "$PG_PORT" -U postgres -d "$DATABASE" -v ON_ERROR_STOP=1 -q)
echo "▶ prerequisite schema and real board writer"
"${PSQL[@]}" -f "$FIXTURE"
"${PSQL[@]}" -f "$BOARD_MIGRATION"
echo "▶ community-agent migration"
"${PSQL[@]}" -f "$MIGRATION"
echo "▶ sequential SQL scenarios"
"${PSQL[@]}" -f "$SCENARIOS"

wait_for_policy_lock() {
  local output
  for _ in $(seq 1 100); do
    if output="$("${PSQL[@]}" -c "begin; select 1 from public.community_agent_policy where singleton for update nowait; rollback;" 2>&1)"; then
      sleep 0.05
      continue
    fi
    if [[ "$output" == *"could not obtain lock"* ]]; then
      return 0
    fi
    echo "unexpected policy lock probe failure: $output" >&2
    return 1
  done
  echo "publisher did not acquire the policy lock" >&2
  return 1
}

wait_for_blocked_query() {
  local marker="$1"
  local blocked
  for _ in $(seq 1 100); do
    blocked="$("${PSQL[@]}" -Atc "select exists (select 1 from pg_stat_activity where datname = current_database() and query like '%${marker}%' and wait_event_type = 'Lock')")"
    if [[ "$blocked" == "t" ]]; then
      return 0
    fi
    sleep 0.05
  done
  echo "second session never blocked behind the confirmed policy lock: $marker" >&2
  return 1
}

RUN_ID="$("${PSQL[@]}" -Atc "select run_id from public.community_agent_runs where day = (clock_timestamp() at time zone 'Asia/Seoul')::date and approved_title = 'concurrency publish' limit 1")"
if [[ -z "$RUN_ID" ]]; then
  echo "concurrency test setup was not created" >&2
  exit 1
fi

echo "▶ concurrent publish serializes to one board post"
"${PSQL[@]}" -c "begin; select public.publish_community_post('${RUN_ID}'::uuid); select pg_sleep(5); commit;" >/tmp/community-agent-publish-a-$$.out &
PUBLISH_A=$!
wait_for_policy_lock
"${PSQL[@]}" -c "/* community-concurrent-publish */ select public.publish_community_post('${RUN_ID}'::uuid);" >/tmp/community-agent-publish-b-$$.out &
PUBLISH_B=$!
wait_for_blocked_query "community-concurrent-publish"
wait "$PUBLISH_A"
wait "$PUBLISH_B"
"${PSQL[@]}" -c "do \$\$ begin if (select count(*) from public.posts where title = 'concurrency publish') <> 1 then raise exception 'concurrent publish created duplicates'; end if; end \$\$;"
if ! grep -q 'already_published' /tmp/community-agent-publish-a-$$.out /tmp/community-agent-publish-b-$$.out; then
  echo "same-run retry did not return already_published" >&2
  exit 1
fi
"${PSQL[@]}" -c "delete from public.posts where title = 'concurrency publish';"
if [[ "$("${PSQL[@]}" -Atc "select public.publish_community_post('${RUN_ID}'::uuid) ->> 'code'")" != "already_published" ]]; then
  echo "deleted post allowed the published run to create a duplicate" >&2
  exit 1
fi

"${PSQL[@]}" -c "update public.community_agent_runs set day = (clock_timestamp() at time zone 'Asia/Seoul')::date - 3 where run_id = '${RUN_ID}'::uuid;"
STOP_RUN_ID="$("${PSQL[@]}" -Atc "select public.start_community_run(null, false) ->> 'id'")"
"${PSQL[@]}" -c "update public.community_agent_runs set status = 'ready', approved_title = 'stop publish serial', approved_html = '<p>validated</p>', approved_category = '자유', approved_hash = repeat('d', 64), validation = jsonb_build_object('passed', true, 'contentHash', repeat('d', 64)) where run_id = '${STOP_RUN_ID}'::uuid;"

echo "▶ concurrent stop/publish is serialized by the policy row"
"${PSQL[@]}" -c "begin; select public.publish_community_post('${STOP_RUN_ID}'::uuid); select pg_sleep(5); commit;" >/tmp/community-agent-stop-publish-a-$$.out &
STOP_PUBLISH_A=$!
wait_for_policy_lock
"${PSQL[@]}" -c "begin; /* community-concurrent-stop */ update public.community_agent_policy set enabled = false, publishing_enabled = false where singleton; commit;" >/tmp/community-agent-stop-publish-b-$$.out &
STOP_PUBLISH_B=$!
wait_for_blocked_query "community-concurrent-stop"
wait "$STOP_PUBLISH_A"
wait "$STOP_PUBLISH_B"
"${PSQL[@]}" -c "do \$\$ begin if (select count(*) from public.posts where title = 'stop publish serial') <> 1 then raise exception 'stop/publish was not serial'; end if; if (select enabled from public.community_agent_policy where singleton) then raise exception 'stop did not persist'; end if; end \$\$;"

rm -f /tmp/community-agent-publish-a-$$.out /tmp/community-agent-publish-b-$$.out \
  /tmp/community-agent-stop-publish-a-$$.out /tmp/community-agent-stop-publish-b-$$.out
echo "✅ community-agent migration and atomic publishing checks passed"
