#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$repo_root"
pg_bin=""
for candidate in "${PG17_BINDIR:-}" /opt/homebrew/opt/postgresql@17/bin /usr/local/opt/postgresql@17/bin; do
  if [[ -x "$candidate/postgres" ]] && "$candidate/postgres" --version | rg -q 'PostgreSQL\) 17\.'; then
    pg_bin="$candidate"
    break
  fi
done
if [[ -z "$pg_bin" ]]; then
  echo "PostgreSQL 17 binaries are required; set PG17_BINDIR." >&2
  exit 2
fi
if [[ -z "${POSTGREST_BIN:-}" || ! -x "$POSTGREST_BIN" ]]; then
  echo "Set POSTGREST_BIN to an executable official PostgREST binary; no package is installed by this script." >&2
  exit 2
fi
postgrest() {
  if [[ -n "${POSTGREST_LIBRARY_PATH:-}" ]]; then
    exec env DYLD_LIBRARY_PATH="$POSTGREST_LIBRARY_PATH" "$POSTGREST_BIN" "$@"
  else
    exec "$POSTGREST_BIN" "$@"
  fi
}
if ! postgrest --version | rg -q '^PostgREST 1[4-9]\.'; then
  echo "PostgREST 14 or newer is required." >&2
  exit 2
fi
postgrest_version="$(postgrest --version)"

tmp_dir="$(mktemp -d /tmp/lol-it.XXXXXX)"
ports="$(python3 - <<'PY'
import socket
sockets=[]
try:
    for _ in range(2):
        sock=socket.socket()
        sock.bind(("127.0.0.1", 0))
        sockets.append(sock)
    print(*(sock.getsockname()[1] for sock in sockets))
finally:
    for sock in sockets: sock.close()
PY
)"
read -r db_port rest_port <<< "$ports"
postgrest_pid=""
cleanup() {
  if [[ -n "$postgrest_pid" ]]; then
    kill "$postgrest_pid" >/dev/null 2>&1 || true
    wait "$postgrest_pid" 2>/dev/null || true
    postgrest_pid=""
  fi
  "$pg_bin/pg_ctl" -D "$tmp_dir/pgdata" -m fast stop >/dev/null 2>&1 || true
  python3 - "$tmp_dir" /tmp <<'PY'
from pathlib import Path
import shutil, sys
target, parent = Path(sys.argv[1]).resolve(), Path(sys.argv[2]).resolve()
if target.parent != parent or not target.name.startswith("lol-it."):
    raise SystemExit("Refusing to remove unexpected temporary path")
shutil.rmtree(target)
PY
}
trap cleanup EXIT INT TERM

openssl rand -hex 32 > "$tmp_dir/jwt-secret"
openssl rand -hex 24 > "$tmp_dir/pg-password"
chmod 600 "$tmp_dir/jwt-secret" "$tmp_dir/pg-password"
auth_password="$(cat "$tmp_dir/pg-password")"
jwt_secret="$(cat "$tmp_dir/jwt-secret")"

"$pg_bin/initdb" -D "$tmp_dir/pgdata" -U postgres -A trust >/dev/null
if ! "$pg_bin/pg_ctl" -D "$tmp_dir/pgdata" -o "-p $db_port -h 127.0.0.1" -l "$tmp_dir/postgres.log" start >/dev/null; then
  tail -n 20 "$tmp_dir/postgres.log" >&2 || true
  exit 1
fi
"$pg_bin/psql" -X -v ON_ERROR_STOP=1 -h 127.0.0.1 -p "$db_port" -U postgres -d postgres <<SQL
create role anon nologin;
create role authenticated nologin;
create role service_role nologin bypassrls;
create role authenticator login noinherit password '$auth_password';
grant anon, authenticated, service_role to authenticator;
create database lol_persistence_integration;
SQL
"$pg_bin/psql" -X -v ON_ERROR_STOP=1 -h 127.0.0.1 -p "$db_port" -U postgres -d lol_persistence_integration \
  -f "$repo_root/supabase/migrations/20261022114157_lol_persistence_foundation.sql" >/dev/null
"$pg_bin/psql" -X -v ON_ERROR_STOP=1 -h 127.0.0.1 -p "$db_port" -U postgres -d lol_persistence_integration \
  -f "$repo_root/supabase/migrations/20261022200000_lol_remove_daily_budget.sql" >/dev/null
"$pg_bin/psql" -X -v ON_ERROR_STOP=1 -h 127.0.0.1 -p "$db_port" -U postgres -d lol_persistence_integration \
  -f "$repo_root/supabase/migrations/20261023010000_lol_ranked_history.sql" >/dev/null
"$pg_bin/psql" -X -v ON_ERROR_STOP=1 -h 127.0.0.1 -p "$db_port" -U postgres -d lol_persistence_integration \
  -f "$repo_root/supabase/migrations/20261023020000_lol_ranked_daily.sql" >/dev/null
"$pg_bin/psql" -X -v ON_ERROR_STOP=1 -h 127.0.0.1 -p "$db_port" -U postgres -d lol_persistence_integration \
  -f "$repo_root/supabase/migrations/20261023030000_lol_ops_metrics.sql" >/dev/null
"$pg_bin/psql" -X -v ON_ERROR_STOP=1 -h 127.0.0.1 -p "$db_port" -U postgres -d lol_persistence_integration \
  -f "$repo_root/supabase/migrations/20261023040000_lol_player_summaries.sql" >/dev/null
"$pg_bin/psql" -X -v ON_ERROR_STOP=1 -h 127.0.0.1 -p "$db_port" -U postgres -d lol_persistence_integration \
  -f "$repo_root/supabase/migrations/20261023050000_lol_benchmark_aggregates.sql" >/dev/null
cat > "$tmp_dir/postgrest.conf" <<EOF
db-uri = "postgres://authenticator:$auth_password@127.0.0.1:$db_port/lol_persistence_integration"
db-schemas = "public"
db-extra-search-path = "public"
db-anon-role = "anon"
jwt-secret = "$jwt_secret"
server-host = "127.0.0.1"
server-port = $rest_port
EOF
chmod 600 "$tmp_dir/postgrest.conf"
postgrest "$tmp_dir/postgrest.conf" > "$tmp_dir/postgrest.log" 2>&1 &
postgrest_pid="$!"
ready=false
for _ in {1..30}; do
  if curl -fsS --max-time 1 "http://127.0.0.1:$rest_port/" -o /dev/null; then ready=true; break; fi
  sleep 1
done
if [[ "$ready" != true ]]; then
  echo "Temporary PostgREST did not become ready; inspect the isolated process log." >&2
  exit 1
fi

export NEXT_PUBLIC_SUPABASE_URL="http://127.0.0.1:$rest_port"
export LOL_PERSISTENCE_INTEGRATION_UNREACHABLE_URL="$NEXT_PUBLIC_SUPABASE_URL"
export LOL_PERSISTENCE_INTEGRATION_JWT_SECRET="$jwt_secret"
export SUPABASE_SERVICE_ROLE_KEY="$(python3 - "$jwt_secret" <<'PY'
import base64, hashlib, hmac, json, sys, time
secret=sys.argv[1].encode()
enc=lambda value: base64.urlsafe_b64encode(json.dumps(value,separators=(",",":")).encode()).rstrip(b"=").decode()
unsigned=enc({"alg":"HS256","typ":"JWT"})+"."+enc({"role":"service_role","exp":int(time.time())+900})
signature=base64.urlsafe_b64encode(hmac.new(secret,unsigned.encode(),hashlib.sha256).digest()).rstrip(b"=").decode()
print(unsigned+"."+signature)
PY
)"
export LOL_PERSISTENCE_ENABLED=true
export RIOT_API_KEY=fixture-only-no-live-request
export RUN_LOL_PERSISTENCE_INTEGRATION=true

for mode in populate cache-hit flag-off db-error; do
  if [[ "$mode" == "db-error" && -n "$postgrest_pid" ]]; then
    kill "$postgrest_pid"
    wait "$postgrest_pid" 2>/dev/null || true
    postgrest_pid=""
  fi
  export LOL_PERSISTENCE_INTEGRATION_MODE="$mode"
  npx vitest run tests/lol-persistence-integration.test.ts --testTimeout=30000
done

trap - EXIT INT TERM
cleanup
python3 - "$db_port" "$rest_port" <<'PY'
import socket, sys
for port in map(int, sys.argv[1:]):
    with socket.socket() as sock:
        sock.bind(("127.0.0.1", port))
PY
echo "PostgreSQL 17 + PostgREST real REST integration passed; $postgrest_version; isolated ports closed: $db_port $rest_port."
