# PUBG AI Release Safety Design

## Context

The current `develop` branch contains a partially implemented telemetry-cache recovery path. The production branch (`origin/main`) and the deployed `bgms.kr` application must remain unchanged while this work is completed and verified.

The user-facing product intent is unchanged:

- single-match analysis uses real PUBG telemetry from the selected match;
- ten-match analysis keeps the recent-match list and compares the player's best five eligible matches with an upper-tier benchmark;
- unavailable observations are shown as unavailable, never replaced with invented elite values;
- one Gemini model timing out does not prevent a later configured model from succeeding;
- benchmark recovery must not leave a match upgraded while its benchmark row remains stale, or vice versa.

## Safety Boundary

All implementation and local verification happen on `develop`. This work does not merge, promote, or deploy `main`, and it does not mutate the production database or R2 during implementation. Any later remote migration, benchmark recovery, branch push, or promotion is a separately visible release action.

## Design

### 1. Preserve and reproduce the benchmark corpus

The repository must contain the exact recovery-claim migration version already recorded remotely (`20260902171741`). The later duplicate timestamp is removed so local migration history matches the database.

`global_benchmarks` is a protected recovery asset:

- routine telemetry cleanup does not delete or cap benchmark rows;
- core-table backup includes `global_benchmarks`;
- the stale-manifest test passes a fixed clock to confirmation-token validation rather than weakening the 24-hour production expiry;
- the unused recovery-health Next.js route is removed because its broad filesystem tracing bloats the server bundle and risks copying unrelated workspace files.

### 2. Commit recovery as one database decision

R2 and Postgres cannot share a transaction, so recovery uses the standard order “upload object, then commit database state.” A service-role-only, `SECURITY INVOKER`, empty-`search_path` RPC performs the database portion atomically:

1. lock and validate the pending recovery lease;
2. lock and revalidate the exact version-72 processed row and PUBG account identity;
3. lock and revalidate the exact legacy benchmark guard (row id, bucket, filter version, and evidence version);
4. upsert match master data and version-73 processed analysis;
5. promote only that guarded benchmark row to the current evidence contract;
6. mark the telemetry-cache registry row ready and release the lease;
7. return success from the same database transaction.

Recovery does not run the generic post-finalization persistence fan-out. The normal ingestion path remains unchanged.

If an R2 upload was attempted, the request never deletes that deterministic key or releases its lease. Cloudflare R2 does not document `DeleteObject If-Match` as an atomic ownership check, so an in-request read-then-delete could remove a concurrent replacement. The object and lease remain for an explicit reconciler to inspect. Only a failure proven to occur before any upload may release the exact recovery lease, and that recovery-only RPC must return `true` only when its pending row and lease token were actually deleted. A competing worker that changed either guarded row wins; the stale worker must not overwrite or delete its state.

### 3. Store only observed analysis evidence

`coverRate` has one canonical stored unit: percent in the inclusive range 0–100. It is considered observed only when `coverRateSampleCount > 0`. Squad aggregation converts observed percentages to a weighted fraction for its existing scoring/prompt contract. A zero sample count produces “측정 불가,” not 0%.

Single-match benchmark comparison uses `adaptObservedBenchmark`. A benchmark or individual metric is available only when its total and per-metric sample thresholds are met. Hard-coded elite fallback values are not passed to the analysis engine or prompt. Existing version-73 cache rows without evidence counts are treated as unobserved without requiring a result-version bump.

The summary route accepts exactly the current result version, not future unknown versions. Nullable impact values stay unavailable through aggregation rather than becoming false zeros.

### 4. Continue after a model-local Gemini timeout

Each AI route distinguishes:

- a per-model timeout: record the failure and try the next configured model while the route budget remains;
- a caller abort or overall generation deadline: stop and return the route's timeout/abort response;
- a provider error: retain existing fallback/error reporting and continue where currently allowed.

Attempt timers are cleared when an attempt completes. Streaming responses remain governed by the overall route deadline after a model has successfully returned a stream.

## Compatibility

- Existing production code does not call the new RPC, so adding it later is backward compatible.
- The RPC is not executable by `public`, `anon`, or `authenticated`; only `service_role` receives execute permission.
- Normal PUBG ingestion and the intended ten-match/best-five selection do not change.
- Old cached analyses remain readable, but fabricated comparison fields are ignored when evidence counts are absent.

## Verification Gates

Before recommending a merge:

- focused tests cover stale-clock injection, cleanup/backup protection, claim/finalize races, rollback/compensation, cover-rate units, missing benchmarks, exact result versions, and first-model-timeout fallback;
- migration verification and a local Postgres scenario validate permissions and transaction behavior;
- `verify:analysis`, `verify:core`, `verify:admin`, `verify:security`, the full unit suite, dependency audit, and a clean production build pass;
- the built recovery route trace is absent and no environment-like workspace file appears in `.next` traces;
- a real authenticated preview flow and Gemini call are checked only after local gates are green and without promoting production.
