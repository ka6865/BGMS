# Profile-linked PUBG auto-sync migration handoff

Date: 2026-08-19 KST
Project: `kolwueoejdasoqyopkao`
Base: `85e4c03fab651f4b57459e6278f2de2b2af97f35`
Production mutation: none. This handoff is for coordinator-owned application after review.

## Migration to apply

Apply this file exactly, in the normal migration order after the migrations already present in production:

`supabase/migrations/20260819115023_profile_linked_pubg_auto_sync.sql`

Local SHA-256: `fc10f4b8c2e77948d1314a7f425008586758670fd697fe70002e5eac777f95cc`

The migration creates `public.pubg_linked_player_sync_state`, keyed by `(platform, normalized_nickname)`, with the six-state lifecycle, lease/backoff timestamps, and service-role-only table access. It also adds the two supported-link functional partial indexes on `public.profiles`:

- `pubg_linked_profiles_active_idx` on `last_active_at desc`, excluding null activity and non-linked/non-supported profiles.
- `pubg_linked_profiles_identity_idx` on `lower(btrim(coalesce(pubg_platform, ''))), lower(btrim(pubg_nickname))`, with the same linked-supported predicate.

`normalized_nickname` is constrained to a non-empty canonical lowercase/trimmed value. The candidate, claim, and completion RPCs are `SECURITY INVOKER`; `public`, `anon`, and `authenticated` table/RPC privileges are revoked and `service_role` receives the required table and execute grants. The RPC candidate query deduplicates by canonical player identity and uses the latest linked activity.

## Production read-only evidence

The following checks were run against project `kolwueoejdasoqyopkao` using read-only Supabase operations. `to_regclass('public.pubg_linked_player_sync_state')` returned `NULL`, `state_table_exists` was `false`, and migration history did not contain version `20260819115023`. The production migration list ended at `20260817172423` (`add_survival_mastery_cache`).

| Aggregate | Result |
| --- | ---: |
| Profiles | 272 |
| Linked + supported profiles | 54 |
| Active linked-supported profiles (last 30 days) | 39 |
| Distinct active linked-supported identities | 39 |
| Inactive linked-supported profiles (`last_active_at` older than 30 days) | 14 |
| Linked-supported profiles with null `last_active_at` | 1 |
| Unlinked profiles | 218 |

The 54 linked-supported rows therefore split into 39 active, 14 older, and one with no activity timestamp. No sync-state rows can exist in production until the migration is applied.

## Advisor baseline (before migration)

Advisors were run read-only while the new migration was absent. These findings are pre-existing baseline findings; they are not evidence that the unapplied migration was applied or that this task remediated unrelated objects.

| Advisor | Total | ERROR | WARN | INFO | Breakdown |
| --- | ---: | ---: | ---: | ---: | --- |
| Security | 52 | 1 | 23 | 28 | 28 `rls_enabled_no_policy` INFO; 1 `security_definer_view` ERROR; 7 `function_search_path_mutable` WARN; 1 `extension_in_public` WARN; 7 anon and 7 authenticated security-definer RPC WARNs; 1 leaked-password WARN |
| Performance | 160 | 0 | 118 | 42 | 33 `auth_rls_initplan` WARN; 85 `multiple_permissive_policies` WARN; 28 `unindexed_foreign_keys` INFO; 13 `unused_index` INFO; 1 absolute Auth connection allocation INFO |

The one security ERROR is `public.benchmark_stats_by_tier` using a security-definer view. Official remediation references:

- Security: [0008 RLS enabled without policy](https://supabase.com/docs/guides/database/database-linter?lint=0008_rls_enabled_no_policy), [0010 security-definer view](https://supabase.com/docs/guides/database/database-linter?lint=0010_security_definer_view), [0011 mutable function search path](https://supabase.com/docs/guides/database/database-linter?lint=0011_function_search_path_mutable), [0014 extension in `public`](https://supabase.com/docs/guides/database/database-linter?lint=0014_extension_in_public), [0028 anon security-definer function executable](https://supabase.com/docs/guides/database/database-linter?lint=0028_anon_security_definer_function_executable), [0029 authenticated security-definer function executable](https://supabase.com/docs/guides/database/database-linter?lint=0029_authenticated_security_definer_function_executable), and [password strength/leaked-password protection](https://supabase.com/docs/guides/auth/password-security#password-strength-and-leaked-password-protection).
- Performance: [0001 unindexed foreign keys](https://supabase.com/docs/guides/database/database-linter?lint=0001_unindexed_foreign_keys), [0003 auth RLS init plan](https://supabase.com/docs/guides/database/database-linter?lint=0003_auth_rls_initplan), [0005 unused indexes](https://supabase.com/docs/guides/database/database-linter?lint=0005_unused_index), [0006 multiple permissive policies](https://supabase.com/docs/guides/database/database-linter?lint=0006_multiple_permissive_policies), and [going into production](https://supabase.com/docs/guides/deployment/going-into-prod).

Supabase's [2026-04-28 Data API exposure change](https://supabase.com/changelog/45329-breaking-change-tables-not-exposed-to-data-and-graphql-api-automatically) is also relevant: new public tables need explicit exposure/grants. This migration intentionally grants only `service_role`, so the internal state table is not a public Data API surface.

## Apply prerequisites and order

1. Confirm the coordinator is on the migration chain containing all production versions through `20260817172423` and has a backup/restore point appropriate for a DDL change.
2. Confirm `public.profiles` has `pubg_nickname`, `pubg_platform`, `last_active_at`, `updated_at`, and a primary key, and that the service-role execution context can read it.
3. Confirm the worker's `NEXT_PUBLIC_SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`, and `PUBG_API_KEY` secrets are present. The service wrapper rejects missing or non-service-role credentials.
4. Apply `20260819115023_profile_linked_pubg_auto_sync.sql` once through the coordinator's reviewed migration path. Do not apply it with a worker, `apply_migration` from this task, or an ad-hoc production SQL session.
5. Only after the migration and post-apply checks pass, enable the scheduled linked-player sync consumer. The existing Smart Scraper/Bluezone ordering and the `rate_limited` Hotdrop gate remain unchanged.

## Post-apply read-only checks

Run these checks from a read-only verification session. The local verifier at `scripts/verify_migrations_local.sh` is the executable reference and covers all of them on PostgreSQL 17.

```sql
select to_regclass('public.pubg_linked_player_sync_state') as state_table;
select exists (
  select 1 from supabase_migrations.schema_migrations
  where version = '20260819115023'
) as migration_applied;

select grantee, privilege_type
from information_schema.role_table_grants
where table_schema = 'public'
  and table_name = 'pubg_linked_player_sync_state'
order by grantee, privilege_type;

select p.proname, p.prosecdef,
       has_function_privilege('service_role', p.oid, 'EXECUTE') as service_can_execute,
       has_function_privilege('anon', p.oid, 'EXECUTE') as anon_can_execute,
       has_function_privilege('authenticated', p.oid, 'EXECUTE') as authenticated_can_execute
from pg_proc p
join pg_namespace n on n.oid = p.pronamespace
where n.nspname = 'public'
  and p.proname in (
    'list_pubg_linked_sync_candidates',
    'claim_pubg_linked_sync',
    'complete_pubg_linked_sync'
  );
```

In a disposable or coordinator-controlled role-test transaction, `SET LOCAL ROLE service_role` must successfully read the state table and invoke the list RPC. Equivalent `SET LOCAL ROLE anon` and `SET LOCAL ROLE authenticated` attempts to select the state table and invoke the list RPC must fail with `insufficient_privilege`. Verify the candidate result has one row per canonical identity, includes only linked active profiles, and does not include inactive or unlinked profiles. Do not write production rows as part of these checks.

After the role checks, rerun both advisors and record any new lints separately from the baseline above. A deliberate RLS-enabled/no-policy INFO for this internal service-only table is expected if the advisor reports it; do not add a public policy merely to silence that INFO.

## Verification evidence in this change

- Focused Task 5 suites: 8 files, 67 tests passed after the route assertion correction; the final full run below includes the same coverage.
- `npm run verify:migrations`: disposable PostgreSQL 17 applied the migration and passed candidate dedupe/activity filtering, lease and stale-completion checks, canonical CHECK/index checks, real `SET ROLE service_role` positive access, anon/authenticated table denial, anon/authenticated RPC denial, ACL checks, and `SECURITY INVOKER` checks.
- `npm run test:unit`: 160 files passed, 2 skipped; 1,440 tests passed, 49 skipped.
- `npm test -- --runInBand`: 1 Jest suite, 2 tests passed.
- `npm run verify:core`: exit 0; 0 errors and 61 repository-existing ESLint warnings.
- `npm run build`: production Next.js build completed successfully.
- YAML parse with `js-yaml`: passed. The embedded `Notify Discord On Failure` shell passed `bash -n`.
- `git diff --check`: passed.

The new runtime regression proves a cached existing player with stale optional survival mastery and a missing explicitly selected season returns an empty `{ ranked: null, normal: null }` bucket without calling PUBG. The runner regression proves a primary state-machine error remains the thrown error when its output writer also throws. Shared runner types now live in `lib/pubg/syncRunnerTypes.ts`, so `lib/pubg/syncRunnerBoundaries.ts` no longer has a type-only import from the script.

## Exact rollback SQL (coordinator approval required)

Do not run this as part of Task 5. If the coordinator approves rollback after assessing any rows created by the worker, execute this exact reverse-order SQL in a controlled maintenance window:

```sql
begin;

drop function if exists public.complete_pubg_linked_sync(
  text, text, uuid, text, timestamptz, timestamptz, integer, text
);
drop function if exists public.claim_pubg_linked_sync(
  text, text, text, uuid, timestamptz
);
drop function if exists public.list_pubg_linked_sync_candidates(
  integer, timestamptz
);

drop index if exists public.pubg_linked_profiles_identity_idx;
drop index if exists public.pubg_linked_profiles_active_idx;
drop table if exists public.pubg_linked_player_sync_state;

commit;
```

The rollback removes the sync state and its indexes/functions only; it does not alter profiles, player cache rows, match rows, or unrelated advisor findings.
