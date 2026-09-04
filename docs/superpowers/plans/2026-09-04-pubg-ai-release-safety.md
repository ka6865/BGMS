# PUBG AI Release Safety Implementation Plan

> **For agentic workers:** REQUIRED: execute one task at a time, write the specified tests first, commit only files in the task, and leave unrelated pre-existing changes untouched. A fresh reviewer gates every task.

**Goal:** Finish the PUBG telemetry-analysis and benchmark-recovery hardening on `develop` without changing the currently deployed production application.

**Architecture:** Keep normal ingestion behavior intact, add an atomic database finalizer only for guarded recovery, require observation evidence for analysis comparisons, and distinguish model-local Gemini timeouts from the overall request deadline.

**Tech Stack:** Next.js 16 route handlers, TypeScript, Vitest, Supabase/Postgres RPCs, Cloudflare R2-compatible object storage, Gemini REST streaming APIs.

**Spec:** `docs/superpowers/specs/2026-09-04-pubg-ai-release-safety-design.md`

## Global Constraints

- Do not merge, push, promote, or deploy `main`; do not mutate the production database or R2 while implementing.
- Preserve the product contract: recent ten-match analysis and best-five benchmark comparison remain intact.
- Missing telemetry or benchmark evidence must remain unavailable; never invent a zero, success count, or elite benchmark.
- Recovery may modify only the exact processed row, benchmark row, registry lease, and R2 key named by its authorization/claim.
- Database RPCs use `SECURITY INVOKER`, `SET search_path = ''`, schema-qualified objects, and execute permission only for `service_role`.
- Tests must freeze or inject time; production's 24-hour recovery-manifest expiry remains enforced.
- Do not read, print, copy, or commit any temporary environment or credential file.

---

## Task 1: Make recovery assets safe and reproducible

**Files:**

- Rename `supabase/migrations/20260903000000_telemetry_cache_recovery_claim.sql` to `supabase/migrations/20260902171741_telemetry_cache_recovery_claim.sql` without changing its SQL body.
- Modify `scripts/run_benchmark_recovery_canary.ts`.
- Modify `scripts/cleanup_telemetry.ts`.
- Modify `scripts/backup_core_tables.ts`.
- Modify `scripts/verify_migrations_local.sh` and the migration scenario/prerequisite tests it already invokes.
- Modify `tests/benchmark-recovery-canary.test.ts`, `tests/telemetry-cleanup.test.ts`, and `tests/backup-core-tables.test.ts`.
- Delete `app/api/pubg/recovery-health/route.ts` and `tests/pubg-recovery-health.test.ts`.

**Step 1: Add failing tests**

Assert all of the following:

```ts
expect(BACKUP_TABLES).toContain("global_benchmarks");
expect(cleanupSource).not.toMatch(/\.from\(["']global_benchmarks["']\).*\.(delete|upsert)\(/s);
expect(benchmarkRecoveryConfirmationToken(manifest, { now: FIXED_NOW })).toMatch(/^RECOVER-/);
```

Also assert that migration verification requires version `20260902171741`, that the duplicate timestamp does not exist, and that the recovery-health route is absent.

Run:

```bash
npx vitest run tests/benchmark-recovery-canary.test.ts tests/telemetry-cleanup.test.ts tests/backup-core-tables.test.ts tests/migration-prerequisites.test.ts
```

**Step 2: Implement the narrow changes**

Change the confirmation-token signature to accept an optional injected clock and pass `runNow` through the canary path:

```ts
export function benchmarkRecoveryConfirmationToken(
  manifest: BenchmarkRecoveryManifest,
  options: { now?: Date } = {},
): string {
  const validated = validateBenchmarkRecoveryManifest(manifest, options);
  // existing canonical hash generation
}
```

Remove the benchmark-delete/cap call from routine cleanup rather than changing its thresholds. Add `global_benchmarks` to `BACKUP_TABLES`. Keep the recovery-claim SQL byte-for-byte equivalent under the remote migration timestamp. Delete the unused route and its route-only test.

**Step 3: Verify and commit**

Run the focused tests above, `bash scripts/verify_migrations_local.sh`, `git diff --check`, then commit only Task 1 files.

---

## Task 2: Make recovery database finalization atomic

**Files:**

- Create one migration with `supabase migration new telemetry_cache_recovery_finalize`, then edit the generated SQL.
- Modify `app/api/pubg/match/route.ts`.
- Modify `lib/pubg-analysis/persistMatchAnalysis.ts` only if a pure benchmark-row builder must be exported/reused.
- Modify `lib/pubg-analysis/telemetryRegistry.server.ts`.
- Modify the R2 service module that owns upload/delete operations only if an exact-key compensation helper is not already exported.
- Modify `tests/persist-match-analysis.test.ts`, `tests/pubg-ingest-boundary.test.ts`, `tests/telemetry-identity.test.ts`, migration scenario tests, and add one focused recovery-finalization test if needed.

**Step 1: Add failing race and rollback tests**

Cover these transitions:

```text
valid v72 + guarded legacy benchmark + owned lease -> one success, v73 + benchmark evidence + ready
benchmark changed after claim -> no processed/master/benchmark/registry DB mutation by stale worker
processed identity changed after claim -> no DB mutation by stale worker
DB finalization fails after R2 upload -> leave the object and lease for reconciliation; issue no request-time R2 delete
failure proven before any upload -> release succeeds only when the recovery-only RPC deletes the exact pending lease token
same finalization retried -> no duplicate or cross-match mutation
normal non-recovery ingestion -> existing persistence fan-out unchanged
```

**Step 2: Add the restricted RPC**

The RPC accepts the existing lease/identity/benchmark guard plus explicit allow-listed final row payloads. Within one transaction it locks and validates every guard, promotes only the exact benchmark row, performs the existing master/processed/registry finalization, and returns a structured success/failure result. It must not accept arbitrary table names or dynamic SQL.

After the function is created, revoke `EXECUTE` on its exact generated
signature from `public`, `anon`, and `authenticated`, then grant `EXECUTE`
only to `service_role`. Verify those four ACL outcomes in the migration
scenario test; do not use an abbreviated or overloaded signature in the SQL.

**Step 3: Wire recovery only**

For `strictRecovery`:

```ts
await uploadTelemetryObject(exactKey, body);
try {
  await finalizeRecoveryAtomically({ lease, processedGuard, benchmarkGuard, rows });
} catch (error) {
  // R2 does not document conditional DeleteObject ownership semantics.
  // Preserve both object and lease for an explicit reconciliation pass.
  throw recoveryCompensationError(error, false);
}
```

Skip the generic `persistMatchAnalysis` call after successful atomic recovery. Keep its use on the normal path. Never delete a recovery R2 object from the request path. Add a service-role-only recovery release RPC that returns an affected-row boolean, and use it only before any upload was attempted; keep the ordinary release RPC and ingestion behavior unchanged.

**Step 4: Verify and commit**

Run focused Vitest tests, migration verification, local Postgres migration scenarios when available, `npx tsc --noEmit --pretty false`, and `git diff --check`; commit only Task 2 files.

---

## Task 3: Enforce observed-evidence units in single and ten-match analysis

**Files:**

- Modify `app/api/pubg/match/route.ts`.
- Modify `lib/pubg-analysis/AnalysisEngine.ts`, `benchmarkAdapter.ts`, `matchAiCoachingPrompt.ts`, `squadAnalysis.ts`, `squadAiCoachingPrompt.ts`, and affected types.
- Modify `app/api/pubg/ai-summary/route.ts`.
- Modify focused tests including `tests/analysis-engine.test.ts`, `tests/pubg-analysis-stability.test.ts`, `tests/final-release-blockers-squad.test.ts`, and `tests/ai-cache-routes.test.ts`.

**Step 1: Add failing evidence-contract tests**

Assert:

```text
coverRate=50, coverRateSampleCount=2 -> squad aggregate 0.5 and prompt 50%
coverRate=0, coverRateSampleCount=0 -> unavailable, not 0%
no/undersampled benchmark -> no elite default, no relative badge, prompt says 측정 불가
partially observed benchmark -> compare only metrics whose metric sample count >= 5
resultVersion=current+1 -> rejected as a cache hit
```

**Step 2: Implement the contract**

Keep stored `coverRate` as 0–100 percent. Compute weighted squad cover as:

```ts
if (sampleCount > 0 && rate >= 0 && rate <= 100) {
  coverAttempts += sampleCount;
  coverSuccesses += (rate / 100) * sampleCount;
}
const avgCoverRate = coverAttempts > 0 ? coverSuccesses / coverAttempts : null;
```

Use `adaptObservedBenchmark` for match analysis. Allow comparison/badges only when the benchmark and the specific metric carry sufficient evidence. Preserve null/unavailable values through summary aggregation. Change current-version checking to strict equality.

**Step 3: Verify and commit**

Run the focused tests, `npm run verify:analysis`, `npx tsc --noEmit --pretty false`, and `git diff --check`; commit only Task 3 files.

---

## Task 4: Fall through after a Gemini model-local timeout

**Files:**

- Modify `app/api/pubg/ai-analyze/route.ts`.
- Modify `app/api/pubg/ai-squad/route.ts`.
- Modify `app/api/pubg/ai-summary/route.ts`.
- Modify `tests/ai-cache-routes.test.ts` and any existing final-release route tests.

**Step 1: Add failing route tests**

For all three routes, mock model A to reject with its attempt-local `AbortError`, model B to succeed, and assert two calls plus a successful response. Separately assert caller abort/overall deadline stops attempts and retains the existing timeout status.

**Step 2: Separate attempt and overall abort state**

Use an attempt-local controller/timer combined with the caller/overall signal. In the catch path:

```ts
if (overallSignal.aborted || request.signal.aborted) break;
if (attemptTimedOut) {
  recordModelTimeout(model);
  continue;
}
// preserve existing provider-error fallback rules
```

Never leave an attempt timer active. Do not extend the route's existing total deadline.

**Step 3: Verify and commit**

Run the focused AI-route tests, `npm run verify:analysis`, `npx tsc --noEmit --pretty false`, and `git diff --check`; commit only Task 4 files.

---

## Task 5: Release verification without production promotion

No implementation is complete until all commands are run on the final committed tree:

```bash
npm run verify:core
npm run verify:analysis
npm run verify:admin
npm run verify:security
npm run test:unit
npm audit --omit=dev
npm audit
rm -rf .next && npm run build
bash scripts/verify_migrations_local.sh
```

Inspect `.next/server/app/api/pubg` traces and assert the removed recovery-health route and environment-like workspace paths are absent. Inspect `git status`, the commit range from `origin/develop`, and the diff from `origin/main`. Confirm no production ref changed.

After a fresh whole-branch Luna review passes, the controller reports exactly:

- what changed for users;
- what changed for developers/operators;
- remaining external steps (remote migration, guarded recovery, develop preview push) and why they are not production promotion;
- a clear `main` merge verdict backed by the command outputs.
