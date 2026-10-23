#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
pg_bin=""
for candidate in "${PG17_BINDIR:-}" /opt/homebrew/opt/postgresql@17/bin /usr/local/opt/postgresql@17/bin; do
  if [[ -x "$candidate/postgres" ]] && "$candidate/postgres" --version | rg -q 'PostgreSQL\) 17\.'; then
    pg_bin="$candidate"
    break
  fi
done
if [[ -z "$pg_bin" ]]; then
  echo "PostgreSQL 17 binaries are required; set PG17_BINDIR or install no tools and retry on a host with PG17." >&2
  exit 2
fi

tmp_dir="$(mktemp -d "${TMPDIR:-/tmp}/lol-pg17.XXXXXX")"
mkdir -p "$tmp_dir/socket"
cleanup() {
  "$pg_bin/pg_ctl" -D "$tmp_dir/data" -m immediate stop >/dev/null 2>&1 || true
  case "$tmp_dir" in
    "${TMPDIR:-/tmp}"/lol-pg17.*) rm -rf -- "$tmp_dir" ;;
    *) echo "Refusing to remove unexpected path: $tmp_dir" >&2; exit 3 ;;
  esac
}
trap cleanup EXIT INT TERM

"$pg_bin/initdb" -D "$tmp_dir/data" -U postgres -A trust >/dev/null
"$pg_bin/pg_ctl" -D "$tmp_dir/data" -o "-k $tmp_dir/socket -p 54321 -h ''" -l "$tmp_dir/postgres.log" start >/dev/null
psql_local=("$pg_bin/psql" -X -v ON_ERROR_STOP=1 -h "$tmp_dir/socket" -p 54321 -U postgres -d postgres)
"${psql_local[@]}" -q -c "create role anon nologin; create role authenticated nologin; create role service_role nologin bypassrls;"
"$pg_bin/createdb" -h "$tmp_dir/socket" -p 54321 -U postgres lol_verification
psql_db=("$pg_bin/psql" -X -v ON_ERROR_STOP=1 -h "$tmp_dir/socket" -p 54321 -U postgres -d lol_verification)
"${psql_db[@]}" -q -f "$repo_root/supabase/migrations/20261022114157_lol_persistence_foundation.sql"
"${psql_db[@]}" -q -f "$repo_root/supabase/migrations/20261022200000_lol_remove_daily_budget.sql"
"${psql_db[@]}" -q -f "$repo_root/supabase/migrations/20261023010000_lol_ranked_history.sql"
"${psql_db[@]}" -q -f "$repo_root/supabase/migrations/20261023020000_lol_ranked_daily.sql"
"${psql_db[@]}" -q -f "$repo_root/supabase/migrations/20261023030000_lol_ops_metrics.sql"
"${psql_db[@]}" -q -f "$repo_root/tests/fixtures/migration-check/lol-summary-backfill-setup.sql"
"${psql_db[@]}" -q -f "$repo_root/supabase/migrations/20261023040000_lol_player_summaries.sql"
"${psql_db[@]}" -q -f "$repo_root/supabase/migrations/20261023050000_lol_benchmark_aggregates.sql"
"${psql_db[@]}" -q -f "$repo_root/tests/fixtures/migration-check/lol-identity-backfill-setup.sql"
"${psql_db[@]}" -q -f "$repo_root/supabase/migrations/20261023060000_lol_participant_identity.sql"
"${psql_db[@]}" -q -f "$repo_root/tests/fixtures/migration-check/lol-participant-identity-scenarios.sql"
"${psql_db[@]}" -q -f "$repo_root/tests/fixtures/migration-check/lol-benchmark-scenarios.sql"
"${psql_db[@]}" -q -f "$repo_root/tests/fixtures/lol-persistence-verification.sql"
"${psql_db[@]}" -q -f "$repo_root/tests/fixtures/migration-check/lol-ranked-history-scenarios.sql"
"${psql_db[@]}" -q -f "$repo_root/tests/fixtures/migration-check/lol-ranked-daily-scenarios.sql"
"${psql_db[@]}" -q -f "$repo_root/tests/fixtures/migration-check/lol-ops-scenarios.sql"
"${psql_db[@]}" -q -f "$repo_root/tests/fixtures/migration-check/lol-player-summaries-scenarios.sql"

for role in anon authenticated; do
  if "${psql_db[@]}" -c "set role $role; select * from public.lol_accounts" >"$tmp_dir/$role-table-denied" 2>&1; then
    echo "$role unexpectedly read LoL account rows." >&2; exit 1
  fi
  if "${psql_db[@]}" -c "set role $role; select * from public.acquire_lol_collection_lease('denied',10)" >"$tmp_dir/$role-rpc-denied" 2>&1; then
    echo "$role unexpectedly executed LoL repository RPC." >&2; exit 1
  fi
  for table in lol_benchmark_processed_matches lol_benchmark_aggregates; do
    if "${psql_db[@]}" -c "set role $role; select * from public.$table" >"$tmp_dir/$role-$table-denied" 2>&1; then
      echo "$role unexpectedly read benchmark rows." >&2; exit 1
    fi
  done
  if "${psql_db[@]}" -c "set role $role; select public.aggregate_lol_match_benchmarks('KR_7000')" >"$tmp_dir/$role-benchmark-rpc-denied" 2>&1; then
    echo "$role unexpectedly aggregated benchmark rows." >&2; exit 1
  fi

done

# Verify the storage RPC samples database time after waiting on the lease row lock.
"${psql_db[@]}" -q -c "insert into public.lol_collection_leases(lease_key,lease_type,lease_token,lease_until) values('match:lock-test','collection','00000000-0000-0000-0000-000000000777',clock_timestamp()+interval '250 milliseconds')"
"$pg_bin/psql" -X -v ON_ERROR_STOP=1 -h "$tmp_dir/socket" -p 54321 -U postgres -d lol_verification \
  -c "begin; select 1 from public.lol_collection_leases where lease_key='match:lock-test' for update; select pg_sleep(1.2); commit" >"$tmp_dir/lease-lock-holder" 2>&1 &
lock_holder_pid=$!
sleep 0.05
if "${psql_db[@]}" -c "select public.persist_lol_match_details(
  'match:lock-test','00000000-0000-0000-0000-000000000777','lock-test','{}','kr','asia','16.21.1',
  '{\"metadata\":{\"matchId\":\"KR_7003\",\"dataVersion\":2},\"info\":{\"participants\":[],\"gameStartTimestamp\":1700000000000}}','[]','[]')" >"$tmp_dir/expired-lock-write" 2>&1; then
  echo "Storage RPC accepted a lease that expired while waiting for its row lock." >&2; exit 1
fi
wait "$lock_holder_pid"
"${psql_db[@]}" -qAt -c "select count(*) from public.lol_matches where match_id='KR_7003'" >"$tmp_dir/expired-lock-match-count"
[[ "$(cat "$tmp_dir/expired-lock-match-count")" == "0" ]] || { echo "Expired lease wrote a match." >&2; exit 1; }

"${psql_db[@]}" -q -c "update public.lol_rate_limit_state set next_permit_at=now(),min_interval_ms=1500,last_started_at=null,blocked_until='-infinity',budget_day=(timezone('UTC',now()))::date,used_count=0 where host in ('global','asia','kr')"
pids=()
for attempt in 1 2 3 4 5 6 7 8; do
  "$pg_bin/psql" -X -At -h "$tmp_dir/socket" -p 54321 -U postgres -d lol_verification \
    -c "select granted from public.reserve_lol_riot_request('asia')" >"$tmp_dir/reserve.$attempt" &
  pids+=("$!")
done
concurrency_status=0
for pid in "${pids[@]}"; do wait "$pid" || concurrency_status=1; done
[[ "$concurrency_status" -eq 0 ]] || { echo "Concurrent permit request failed." >&2; exit 1; }
grant_count="$(rg -c '^t$' "$tmp_dir"/reserve.* | awk -F: '{sum += $NF} END {print sum+0}')"
[[ "$grant_count" -eq 2 ]] || { echo "Expected two atomic concurrent permits; received $grant_count." >&2; exit 1; }

# Restart only this disposable PostgreSQL 17 instance before a new client reads the cache.
"$pg_bin/pg_ctl" -D "$tmp_dir/data" -m fast stop >/dev/null
"$pg_bin/pg_ctl" -D "$tmp_dir/data" -o "-k $tmp_dir/socket -p 54321 -h ''" -l "$tmp_dir/postgres.log" start >/dev/null
"${psql_db[@]}" -qAt -c "select public.get_lol_api_cache('search:v1:kr:asia:16.21.1:fixture:kr1','search','kr','asia','16.21.1')->>'matchStatus'" >"$tmp_dir/persistent-hit"
[[ "$(cat "$tmp_dir/persistent-hit")" == "ready" ]] || { echo "Search cache did not survive PostgreSQL restart." >&2; exit 1; }
"${psql_db[@]}" -qAt -c "select public.get_lol_api_cache('match:v1:kr:asia:16.21.1:v3:KR_7000','match_details','kr','asia','16.21.1')->>'matchId'" >"$tmp_dir/persistent-detail-hit"
[[ "$(cat "$tmp_dir/persistent-detail-hit")" == "KR_7000" ]] || { echo "Detail cache did not survive PostgreSQL restart." >&2; exit 1; }

echo "LoL PostgreSQL 17 isolated verification passed (service_role vs anon/authenticated, RLS/RPC, atomic save+rollback, 1500 LP, cache scope/TTL and post-restart search/detail hits, 1.5s+header windows, lease fencing including lock-wait expiry, 8-way permit race: 2 grants)."
