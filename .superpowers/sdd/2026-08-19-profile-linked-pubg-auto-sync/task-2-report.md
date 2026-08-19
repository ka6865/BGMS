# Task 2 implementation report

## Result

Implemented the service-role-only linked PUBG player sync state boundary.

- Migration: `supabase/migrations/20260819115023_profile_linked_pubg_auto_sync.sql`
- Server wrappers: `lib/pubg/linkedPlayerSync.server.ts`
- Boundary tests: `tests/linked-player-sync-migration.test.ts`, `tests/linked-player-sync-server.test.ts`
- Local verifier coverage: `scripts/verify_migrations_local.sh` and the disposable migration fixtures

The migration creates `public.pubg_linked_player_sync_state` with one row per canonical `(platform, normalized_nickname)` identity, RLS, the allowed sync statuses, lease/backoff timestamps, and explicit service-role-only table and RPC privileges. The candidate RPC deduplicates linked profiles, uses `max(last_active_at)`, excludes blank/unsupported/inactive links, enforces eligibility and lease conditions, and orders never-succeeded identities first. Claim is atomic and refuses an active lease, a future `next_eligible_at`, or an identity with no linked profile. Completion updates only when the lease token matches, preventing stale workers from settling another worker's attempt. All three functions are `SECURITY INVOKER`.

The wrappers require an injected RPC client or non-empty `NEXT_PUBLIC_SUPABASE_URL` plus `SUPABASE_SERVICE_ROLE_KEY`; JWT keys carrying a non-`service_role` role are rejected. RPC payloads, timestamps, platforms, canonical nicknames, UUID lease tokens, status values, failure counts, and boolean results are validated before use.

## Supabase changelog implementation note

The current Supabase changelog entry dated 2026-04-28, “Tables not exposed to Data and GraphQL API automatically,” makes public-schema Data API exposure opt-in and requires explicit grants. This migration therefore revokes `public`, `anon`, and `authenticated` access and explicitly grants the table and RPC execution to `service_role`. The server wrapper performs the runtime service-role credential/role check before creating its client. No removed Supabase API is used.

Reference: <https://supabase.com/changelog/45329-breaking-change-tables-not-exposed-to-data-and-graphql-api-automatically>

## Verification

- `npm run test:unit -- tests/linked-player-sync-migration.test.ts tests/linked-player-sync-server.test.ts` — 2 files, 8 tests passed.
- `npm run verify:migrations` — disposable PostgreSQL 17 container applied the migration and all scenarios passed, including dedupe, active filtering, lease collision/stale completion, and anon RPC denial.
- `npm test -- --runInBand` — 1 Jest suite, 2 tests passed.
- `npm run verify:core` — passed with the repository's existing ESLint warnings and no errors.
- `git diff --cached --check` — passed.

No production or remote database was applied or mutated. Commit message: `feat: add linked player sync state`.
