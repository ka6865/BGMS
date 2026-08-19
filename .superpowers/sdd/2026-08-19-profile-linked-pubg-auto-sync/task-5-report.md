# Task 5 report — schema and end-to-end verification

- Date: 2026-08-19 KST
- Base: `85e4c03fab651f4b57459e6278f2de2b2af97f35`
- Commit: `test: verify linked PUBG auto sync rollout`
- Production project: `kolwueoejdasoqyopkao`
- Production mutation: none; no migration apply, push, reset, or production write was performed.

## Result

Closed the tracked Task 5 P2s while preserving the Task 1–4 behavior:

- Hardened the unapplied `20260819115023_profile_linked_pubg_auto_sync.sql` with a canonical lowercase/trimmed `normalized_nickname` CHECK and supported-link partial indexes for active selection and identity grouping.
- Extended the disposable PostgreSQL verifier with real `SET ROLE service_role` positive access, anon/authenticated table and RPC denial, ACL checks, and `SECURITY INVOKER` assertions.
- Moved shared runner contracts to `lib/pubg/syncRunnerTypes.ts`; `lib/pubg/syncRunnerBoundaries.ts` no longer imports types from `scripts/sync_user_matches.ts`. The script re-exports the types for existing consumers.
- Made Task 2 server wrappers consume Task 1's shared status/platform/nickname canonical helpers.
- Added a mocked runtime player-route regression proving stale optional mastery plus a missing explicit season does not call PUBG and returns an empty selected-season bucket.
- Kept a primary runner/state-machine error when the output writer also fails; writer-only failures still surface when there is no primary error.
- Added the coordinator handoff at `docs/superpowers/handoffs/2026-08-19-profile-linked-pubg-auto-sync-migration.md`.

## Read-only production evidence

The state table and migration version were absent from production. The read-only aggregate query returned 272 profiles, 54 linked-supported profiles, 39 active linked-supported profiles and 39 distinct active identities, 14 older linked-supported profiles, one linked-supported profile with null `last_active_at`, and 218 unlinked profiles. The production migration list ended at `20260817172423`.

Read-only advisors returned security 52 (1 ERROR, 23 WARN, 28 INFO) and performance 160 (118 WARN, 42 INFO). The security ERROR is the pre-existing `security_definer_view` lint for `public.benchmark_stats_by_tier`; the new migration is absent, so these counts are recorded as baseline rather than as migration results.

## Verification

```text
npm run test:unit       → 160 files passed, 2 skipped; 1,440 passed, 49 skipped
npm test -- --runInBand → 1 suite passed; 2 tests passed
npm run verify:migrations → disposable PostgreSQL 17 migration + role/ACL/RPC scenarios passed
npm run verify:core     → exit 0; 0 errors, 61 existing warnings
npm run build           → Next.js production build passed
YAML parse              → passed
embedded workflow bash -n → passed
git diff --check        → passed
```

No worker completion message was sent. The coordinator can apply the migration after reviewing the handoff and its rollback SQL.
