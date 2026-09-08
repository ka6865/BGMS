# Task 8 report: integration, security, and operations handoff

## Implemented

- Replaced direct policy table updates with a service-role-only `configure_community_agent_policy(jsonb)` RPC. It applies only supplied fields under the policy lock. Enabling publication can clear `dry_run` only for the current Korean day’s ready run after fresh evidence, category, validation hash, and recomputed approved title+HTML hash checks. It never invokes the board writer.
- Kept direct dry-run publish denied, prior-day publish denied, pause respected, and published retry idempotent. Policy and run locks remain in that order.
- Added `dryRun` to persisted `RunSnapshot` payloads.
- Made YouTube initially deselected. Cleanup deletes raw YouTube evidence metadata after 30 days even when run JSON still references its ID, preserves posts, and clears channel/upload cache after 30 days without a `last_success_at` refresh.
- Replaced permanent YouTube API titles with `YouTube 공식 영상` / `YouTube 공개 댓글` citation labels.
- Made YouTube `fetchedCount` count API video/comment candidates and `retainedCount` count retained evidence; updated the admin qualification.
- Made the 40-second collector deadline settle even if a fetch implementation ignores abort.
- Added a provider-mocked lifecycle connecting the actual run route, service, collectors, editorial parser/renderer, and worker. External HTTP/Gemini and the DB repository are fixtures; real DB atomicity remains in the PostgreSQL verifier.
- Added tracked operations and consolidated verification documents, including rollout boundaries, YouTube conditions, retention behavior, live-smoke limits, and recorded token cost.
- Expanded `verify:community` to all nine community test files.

## Fresh verification

```text
npm run verify:community
PASS — 9 files, 81 tests

PATH=/opt/homebrew/bin:$PATH bash scripts/verify_community_agent_migration.sh
PASS — disposable PostgreSQL 17, sequential scenarios, concurrent publish, concurrent configure-stop/publish

npm run verify:admin
PASS — 19 files, 382 tests

npm run verify:core
PASS — TypeScript 0 errors; ESLint 0 errors and the existing 52 warnings

npx eslint <Task 8 TypeScript/TSX/test files>
PASS — 0 warnings, 0 errors

git diff --check
PASS
```

## SQL scenarios

- anon/authenticated cannot read private tables or execute configure/publish RPCs; service_role executes the invoker functions.
- Default policy leaves YouTube off. Partial configure patch preserves omitted fields.
- Direct dry-run publish returns `not_ready`; valid same-day ready dry-run promotion clears only `dry_run`; configure writes no post.
- Immediate pause returns `paused`; hash mismatch, missing evidence, and prior date stay dry-run.
- Existing writer rollback, concurrent one-post publish, deleted-post retry, and policy-lock stop serialization pass.
- Referenced 31-day-old YouTube metadata is deleted, a sentinel published post remains, and other-source metadata keeps the prior lifecycle.
- Stale channel IDs are cleared from `last_success_at`; a recent success remains even if `updated_at` is old.

## Concerns and boundaries

- No production DB, deployment, provider account, paid service, workflow dispatch, external publication, or external comment was used.
- Local Naver/YouTube keys were absent and production environment was not inspected. Those providers are fixture-only and key presence alone is not readiness.
- Existing live smoke established local DC access and bounded Gemini behavior, not a deployed API dry-run or a completed real-source article. The actual source pipeline safely deferred; only the synthetic writer-schema smoke parsed the complete writer contract.
- Cleanup-only continues during a normal publication pause only while Actions and the server are available. If either is disabled, an operator must run authenticated cleanup manually.
- The YouTube rollout condition is operational guidance based on the linked primary policies, not a general legal-compliance determination.

## Review fix round 1

- Corrected the lifecycle evidence to state that external HTTP/Gemini and the database repository use fixtures; the separate PostgreSQL verifier remains the basis for DB/service_role claims.
- Replaced the unsupported zero-cost statement with the observed boundary: no paid conversion or payment action occurred, and billing records were not inspected.
- Added a real service_role SQL scenario that starts from a paused policy, patches categories and source selection, and proves `enabled`, `publishing_enabled`, bot identity, and daily limit remain unchanged.

Verification for this docs/SQL-only fix:

```text
PATH=/opt/homebrew/bin:$PATH bash scripts/verify_community_agent_migration.sh
PASS — disposable PostgreSQL 17, including service_role paused partial-patch preservation

git diff --check
PASS
```
