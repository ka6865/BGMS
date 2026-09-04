# Task 1 report — Make recovery assets safe and reproducible

## Implementation

- Renamed the recovery-claim migration to `20260902171741_telemetry_cache_recovery_claim.sql`; the SQL body was preserved byte-for-byte.
- Added the remote migration version to `scripts/verify_migrations_local.sh`, and added the registry prerequisite plus a duplicate-claim preservation scenario to the local migration fixtures.
- Made `benchmarkRecoveryConfirmationToken` accept an injected `Date`, kept the production 24-hour manifest expiry, passed the canary `runNow` into token validation, and prefixed deterministic tokens with `RECOVER-`.
- Removed routine benchmark deletion/capping from telemetry cleanup.
- Added `global_benchmarks` to core-table backups.
- Deleted the unused recovery-health route and route-only test.
- Added focused tests for the fixed clock/token, benchmark cleanup boundary, backup coverage, migration timestamp/path, and route absence. Updated the existing telemetry identity migration-path assertion.

## Files

Task 1 files changed:

- `.superpowers/sdd/2026-09-04-pubg-ai-release-safety/task-1-report.md`
- `scripts/run_benchmark_recovery_canary.ts`
- `scripts/cleanup_telemetry.ts`
- `scripts/backup_core_tables.ts`
- `scripts/verify_migrations_local.sh`
- `supabase/migrations/20260902171741_telemetry_cache_recovery_claim.sql` (renamed)
- `tests/benchmark-recovery-canary.test.ts`
- `tests/telemetry-cleanup.test.ts`
- `tests/backup-core-tables.test.ts`
- `tests/telemetry-identity.test.ts`
- `tests/migration-prerequisites.test.ts`
- `tests/fixtures/migration-check/prerequisites.sql`
- `tests/fixtures/migration-check/scenarios.sql`
- deleted `app/api/pubg/recovery-health/route.ts`
- deleted `tests/pubg-recovery-health.test.ts`

Unrelated pre-existing dirty files were preserved and are not part of the Task 1 commit.

## Verification commands and output summary

RED capture (before implementation):

```text
npx vitest run tests/benchmark-recovery-canary.test.ts tests/telemetry-cleanup.test.ts tests/backup-core-tables.test.ts tests/migration-prerequisites.test.ts
```

The repository had no `tests/migration-prerequisites.test.ts`; Vitest therefore ran only 3 files. The existing canary suite had 19 failures from real-clock `manifest_stale` errors. After adding the required assertions but before implementation, the new prerequisite test failed (missing migration version/route removal), backup test failed (missing `global_benchmarks`), cleanup test found the benchmark delete/cap code, and token test rejected the missing `RECOVER-` prefix.

GREEN capture:

```text
npx vitest run tests/benchmark-recovery-canary.test.ts tests/telemetry-cleanup.test.ts tests/backup-core-tables.test.ts tests/migration-prerequisites.test.ts
```

`Test Files 4 passed (4)`; `Tests 44 passed (44)`.

Additional focused migration-path check:

```text
npx vitest run tests/telemetry-identity.test.ts
```

`Test Files 1 passed (1)`; `Tests 6 passed (6)`.

Migration verifier command:

```text
bash scripts/verify_migrations_local.sh
```

It could not complete in this environment because Docker CLI/daemon operations hung while starting/removing the isolated container; no remote database command was used. The stuck local verifier processes were terminated. No production Supabase, R2, Vercel, or git remote was contacted.

Diff hygiene:

```text
git diff --check
```

Passed with no output.

## Self-review

- The migration rename is filename-only; the renamed file hash is `bd952c0c56f5343b6be3c56c3ea93086269e7a51cc61b2297a4c5175e7296b05`.
- `BENCHMARK_RECOVERY_MANIFEST_MAX_AGE_MS` remains 24 hours; tests inject/freeze the clock rather than weakening expiry.
- Cleanup has no `global_benchmarks` delete/upsert path, while orphan cleanup remains limited to its existing raw/processed tables.
- Backup includes the benchmark corpus and still excludes regenerable telemetry caches.
- The canary remains read-only with no direct database/R2 mutator path.
- Only Task 1 paths will be selected for commit; unrelated dirty changes remain untouched.

## Concerns

- The isolated Docker/Postgres migration verifier is blocked by the local Docker daemon hanging; rerun `bash scripts/verify_migrations_local.sh` when Docker is responsive.
- The migration fixtures now include the minimal claim-registry schema and scenario, but the full SQL execution still needs the blocked verifier.
