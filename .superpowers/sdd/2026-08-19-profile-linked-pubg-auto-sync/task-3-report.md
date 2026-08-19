# Task 3 implementation report

## Result

Implemented linked-only PUBG user match synchronization from the Task 2 RPC boundary through the scheduled state machine.

- `lib/pubg/userSyncHelper.ts` now delegates candidate selection to `fetchLinkedPlayerSyncCandidates`, deduplicates canonical identities defensively, and has no `pubg_player_cache`/`search_count` fallback.
- `lib/pubg/playerMatchesIngest.ts` adds structured `saved`, `not_found`, `rate_limited`, `upstream_error`, and `network_error` outcomes, quota-header snapshots, and compatibility aliases while preserving `fetchAndIngestBasicMatchSummary(...): Promise<PlayerMatchRecord | null>` for match-summary routes.
- `scripts/sync_user_matches.ts` exposes an injectable `runSyncUserMatches`/`runSync` runner and one JSON summary. It claims the linked lease, claims the season-independent Task 1 refresh lock, checks quota, fetches recent IDs, ingests missing matches sequentially, applies Task 1 success/404/rate-limit/backoff timestamps, clears lock-collision leases as `idle`, and stops after a 429 while keeping the stable `rate_limited` GitHub output.
- Player and match rate-limit headers are retained in the returned summary and can be forwarded to an injected tracker.

## TDD evidence

The new delegation, structured-outcome, lease/lock, 404, 429, zero-match, and backoff tests were written before the implementation. The initial red run was:

```text
$ npm run test:unit -- tests/sync-user-matches.test.ts
Test Files  1 failed (1)
Tests      11 failed | 4 passed (15)
```

The failures were the expected missing linked-only delegation, structured ingest function, and runner behavior. After implementation the same tests passed.

## Verification

- `npm run test:unit -- tests/sync-user-matches.test.ts tests/player-matches.test.ts tests/pubg-response-cache.test.ts` — 3 files, 42 tests passed.
- `npm run test:unit` — 158 files passed, 2 skipped; 1,421 tests passed, 49 skipped.
- `npm test -- --runInBand` — 1 Jest suite, 2 tests passed.
- `npx eslint lib/pubg/userSyncHelper.ts lib/pubg/playerMatchesIngest.ts scripts/sync_user_matches.ts tests/sync-user-matches.test.ts` — passed.
- `npm run verify:core` — passed with the repository's existing ESLint warnings and no errors.
- `git diff --check` — passed.

No production or remote database was queried, migrated, or mutated. The scheduled runner was exercised only with injected test dependencies. Commit message: `feat: sync active linked PUBG players`.
