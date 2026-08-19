# Task 3 review-fix report

## Result

Hardened the linked-only PUBG sync runner on base `6f09192923290a851516941dda72c2377fe184dd`.

- Lease expiry and all success/failure/rate-limit eligibility timestamps use a fresh current clock for each candidate transition; a long sequential run no longer reuses the run-start timestamp.
- A quota row with `remaining <= safeRemaining` is considered stale when its valid `resetAt` is already past. An active exhausted row stops the run and settles the owned lease to `idle` with `nextEligibleAt` equal to the reset time.
- Production dependencies now persist complete player and match rate-limit snapshots to `pubg_api_status`. Tracking is awaited but fail-open, so tracker exceptions cannot hide a player/match `429`; tracking failures are counted in the machine-readable summary.
- Default API/DB boundaries now fail closed unless their credential or an explicit injected substitute is present. `main(options)` delegates every supplied option to the injectable runner.
- Lease-claim exceptions are surfaced as `linked-player-sync-claim-failed` control-plane errors. Completion `false` or throws are never treated as settled; success counters are incremented only after a `true` completion, with one best-effort idle cleanup attempt before surfacing the error.
- Removed redundant ingest aliases, runner/dependency aliases, and duplicate summary counters. Moved API/quota/rate-limit boundaries to `lib/pubg/syncRunnerBoundaries.ts`; the runner is 668 lines versus 714 at the review base.
- Preserved `fetchAndIngestBasicMatchSummary(...): Promise<PlayerMatchRecord | null>` and the structured outcome interface used by the scheduled workflow.

## TDD evidence

Added one red regression for each P1 finding in `tests/sync-user-matches.test.ts` (completion false/throw are parameterized under the completion P1; quota covers both expired and active reset rows). Before the implementation, the focused run failed as expected:

```text
$ npm run test:unit -- tests/sync-user-matches.test.ts
Test Files  1 failed (1)
Tests      7 failed | 15 passed (22)
```

The failures were the expected stale-clock, quota-reset, tracker-masking-429, incomplete-DI, swallowed-claim, and completion-settlement regressions. After the implementation, the same file passed 23/23.

## Verification

- `npm run test:unit -- tests/sync-user-matches.test.ts tests/player-matches.test.ts tests/pubg-response-cache.test.ts` — 3 files, 50 tests passed.
- `npm run test:unit` — 158 files passed, 2 skipped; 1,429 tests passed, 49 skipped.
- `npm test -- --runInBand` — 1 Jest suite, 2 tests passed.
- `npm run verify:core` — exit 0; 61 existing ESLint warnings, 0 errors.
- `npx eslint scripts/sync_user_matches.ts lib/pubg/syncRunnerBoundaries.ts lib/pubg/playerMatchesIngest.ts tests/sync-user-matches.test.ts` — passed.
- `npx tsc --noEmit --pretty false` — passed.
- `git diff --check` — passed.

No production or remote database was queried, migrated, or mutated. The persistence regression uses an injected Supabase-shaped test boundary only.
