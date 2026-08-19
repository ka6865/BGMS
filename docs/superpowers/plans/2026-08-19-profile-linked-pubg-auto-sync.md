# Profile-Linked PUBG Auto Sync Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Restrict scheduled PUBG match refreshes to recently active members with linked PUBG identities, persist sync outcomes and backoff, and prevent automatic and manual refreshes from consuming quota concurrently.

**Architecture:** A service-role-only `pubg_linked_player_sync_state` table stores one state row per canonical PUBG player identity, not per member. SQL RPCs list eligible linked identities, atomically claim a lease, and settle success/failure outcomes; both scheduled and manual refreshes use one season-independent player refresh lock. Ordinary searches remain DB-only and never become automatic-sync candidates.

**Tech Stack:** Next.js 16, TypeScript, Node.js 22, Supabase Postgres/PostgREST RPC, GitHub Actions, Vitest.

**Spec:** `docs/superpowers/specs/2026-08-19-profile-linked-pubg-auto-sync-design.md`

## Global Constraints

- Automatic sync candidates must have a linked PUBG nickname and platform plus `last_active_at` within 30 days.
- Remove the `search_count >= 3` cache-user fallback completely.
- A non-force search for an existing `pubg_player_cache` row must return DB data without calling PUBG, even when optional mastery data is stale or a requested season is absent.
- Use one state row per `(platform, normalized_nickname)` so duplicate profile links do not duplicate API calls.
- Automatic success, including zero new matches, becomes eligible again after 24 hours.
- 404 backs off for 7 days; transient failures back off for 1 hour, 6 hours, then 24 hours; 429 stops the whole run.
- Manual refresh remains available to unlinked searches but shares the canonical player lock with automatic sync.
- New internal tables and RPCs are service-role only, RLS-enabled, and unavailable to `anon` and `authenticated`.
- Do not apply a production migration from the worker. Produce and verify the migration locally; the coordinator owns remote application after review.
- Do not modify or revert the read-only match-analysis audit worker's files or output.

---

### Task 1: Pure Sync Policy and Canonical Lock Identity

**Files:**
- Create: `lib/pubg/linkedPlayerSync.ts`
- Modify: `lib/pubg/responseCache.ts`
- Modify: `app/api/pubg/player/route.ts`
- Test: `tests/linked-player-sync.test.ts`
- Test: `tests/pubg-response-cache.test.ts`
- Test: `tests/player-cache-retention.test.ts`

**Interfaces:**
- Produce `LinkedPlayerSyncStatus`, `LinkedPlayerSyncCandidate`, and `LinkedPlayerSyncOutcome` types.
- Produce `getLinkedPlayerSyncBackoffMs(consecutiveFailures: number): number` returning `3600000`, `21600000`, or `86400000`.
- Produce `getLinkedPlayerSyncNextEligibleAt(outcome, nowMs): string`.
- Produce `buildPlayerRefreshLockKey(platform: string, nickname: string): string` returning `refresh:<normalized-platform>:<normalized-nickname>`.
- `claimForceRefresh` continues to accept an opaque lock key.

- [ ] **Step 1: Write failing policy and lock-key tests.**

```ts
expect(getLinkedPlayerSyncBackoffMs(1)).toBe(60 * 60 * 1000);
expect(getLinkedPlayerSyncBackoffMs(2)).toBe(6 * 60 * 60 * 1000);
expect(getLinkedPlayerSyncBackoffMs(3)).toBe(24 * 60 * 60 * 1000);
expect(buildPlayerRefreshLockKey("STEAM", "Fixture_Player")).toBe("refresh:steam:fixture_player");
```

- [ ] **Step 2: Run the tests and confirm they fail because the new interfaces do not exist.**

Run: `npm run test:unit -- tests/linked-player-sync.test.ts tests/pubg-response-cache.test.ts`

- [ ] **Step 3: Implement the pure policy helpers and canonical lock-key builder.**

```ts
export function getLinkedPlayerSyncBackoffMs(failures: number) {
  if (failures <= 1) return 60 * 60 * 1000;
  if (failures === 2) return 6 * 60 * 60 * 1000;
  return 24 * 60 * 60 * 1000;
}
```

- [ ] **Step 4: Change forced player refresh to claim `buildPlayerRefreshLockKey(platform, nickname)` instead of a season-dependent response-cache key.**

- [ ] **Step 5: Make existing-player non-force searches DB-only.**

When `pubg_player_cache` contains the player, return its stored season and mastery payload without escaping to the external API because mastery TTL expired or a requested season is absent. A missing explicitly selected season returns an empty stats bucket for that selected season; only cache miss or `refresh=true` may call PUBG.

- [ ] **Step 6: Run focused tests and commit.**

Run: `npm run test:unit -- tests/linked-player-sync.test.ts tests/pubg-response-cache.test.ts tests/player-cache-retention.test.ts tests/stats-page-controller.test.ts`

Commit: `feat: add linked player sync policy`

### Task 2: Supabase Sync State and Atomic RPC Boundary

**Files:**
- Create via CLI: the exact migration returned by `npx supabase migration new profile_linked_pubg_auto_sync`
- Create: `lib/pubg/linkedPlayerSync.server.ts`
- Test: `tests/linked-player-sync-migration.test.ts`
- Test: `tests/linked-player-sync-server.test.ts`

**Interfaces:**
- Produce RPC `list_pubg_linked_sync_candidates(p_limit integer, p_active_since timestamptz)`.
- Produce RPC `claim_pubg_linked_sync(p_platform text, p_normalized_nickname text, p_display_nickname text, p_lease_token uuid, p_lease_expires_at timestamptz)` returning boolean.
- Produce RPC `complete_pubg_linked_sync(p_platform text, p_normalized_nickname text, p_lease_token uuid, p_status text, p_last_success_at timestamptz, p_next_eligible_at timestamptz, p_consecutive_failures integer, p_last_error_code text)` returning boolean.
- Produce service wrappers `fetchLinkedPlayerSyncCandidates`, `claimLinkedPlayerSync`, and `completeLinkedPlayerSync`.

- [ ] **Step 1: Fetch and scan `https://supabase.com/changelog.md`; confirm the design does not use removed APIs.**

Record in the implementation notes that the 2026-04-28 Data API exposure change requires explicit service-role grants and a runtime access check.

- [ ] **Step 2: Create the migration through the Supabase CLI.**

Run: `npx supabase migration new profile_linked_pubg_auto_sync`

- [ ] **Step 3: Write failing migration-boundary tests.**

The tests must assert all of these fragments:

```ts
"create table"
"pubg_linked_player_sync_state"
"primary key (platform, normalized_nickname)"
"enable row level security"
"revoke all"
"to service_role"
"security invoker"
"list_pubg_linked_sync_candidates"
"claim_pubg_linked_sync"
"complete_pubg_linked_sync"
```

- [ ] **Step 4: Implement the table and service-role-only RPCs.**

The candidate RPC must group profiles by canonical platform/nickname, use `max(last_active_at)`, exclude unlinked and inactive profiles, join sync state, and order never-synced identities first. Claim and completion must compare the current lease token so a stale worker cannot settle another worker's attempt.

- [ ] **Step 5: Add server wrappers with strict runtime validation.**

```ts
export type LinkedPlayerSyncCandidateRow = {
  platform: "steam" | "kakao";
  normalizedNickname: string;
  displayNickname: string;
  lastActiveAt: string;
  lastSuccessAt: string | null;
  consecutiveFailures: number;
};
```

- [ ] **Step 6: Run focused tests, local migration checks, and commit.**

Run:

```bash
npm run test:unit -- tests/linked-player-sync-migration.test.ts tests/linked-player-sync-server.test.ts
npm run verify:migrations
```

Commit: `feat: add linked player sync state`

### Task 3: Linked-Only Candidate Selection and Stateful Sync Execution

**Files:**
- Modify: `lib/pubg/userSyncHelper.ts`
- Modify: `lib/pubg/playerMatchesIngest.ts`
- Modify: `scripts/sync_user_matches.ts`
- Test: `tests/sync-user-matches.test.ts`

**Interfaces:**
- `fetchSyncCandidateUsers` delegates to `fetchLinkedPlayerSyncCandidates`; it no longer reads `pubg_player_cache`.
- Produce a structured ingest outcome so the sync script can distinguish `saved`, `not_found`, `rate_limited`, `upstream_error`, and `network_error` without parsing log strings.
- The sync runner receives injectable dependencies in tests and returns a summary object instead of only printing output.

- [ ] **Step 1: Replace existing eligibility tests with failing linked-only tests.**

Cover:

```text
linked + active + stale => candidate
linked + inactive => excluded
unlinked high-search cache user => excluded
two profiles with same player identity => one candidate
success with zero new matches => success and next eligible in 24h
```

- [ ] **Step 2: Write failing execution tests for claim, lock collision, 404, 429, and exponential backoff.**

Assertions must include:

```ts
expect(summary.rateLimited).toBe(true);
expect(summary.stoppedReason).toBe("rate_limited");
expect(completeLinkedPlayerSync).toHaveBeenCalledWith(expect.objectContaining({ status: "invalid_nickname" }));
expect(completeLinkedPlayerSync).not.toHaveBeenCalledWith(expect.objectContaining({ status: "failed" })); // lock collision
```

- [ ] **Step 3: Add structured basic-match ingest outcomes while preserving current callers.**

Keep `fetchAndIngestBasicMatchSummary(...): Promise<PlayerMatchRecord | null>` as a compatibility wrapper. Add a new structured function for the scheduled sync so `/api/pubg/matches-summary` behavior does not change.

- [ ] **Step 4: Rewrite the script around the state machine.**

For each candidate:

```text
claim sync lease
claim canonical player refresh lock
check latest quota status
fetch player recent IDs
ingest missing latest IDs sequentially
complete state
```

Always complete or safely expire the sync lease. A lock collision is a skip, not a failure. A 429 records `rate_limited`, writes the GitHub output, and stops remaining candidates.

- [ ] **Step 5: Track rate-limit headers for player and match responses and emit one machine-readable run summary.**

- [ ] **Step 6: Run focused tests and commit.**

Run: `npm run test:unit -- tests/sync-user-matches.test.ts tests/player-matches.test.ts tests/pubg-response-cache.test.ts`

Commit: `feat: sync active linked PUBG players`

### Task 4: Daily Workflow Guardrails and Observability

**Files:**
- Modify: `.github/workflows/daily-tasks.yml`
- Modify: `tests/daily-tasks-workflow.test.ts`
- Modify: `tests/daily-maintenance-failure-notify.test.ts`

**Interfaces:**
- The existing `rate_limited` step output remains stable.
- Add summary outputs for candidate count, synced identities, new matches, lock collisions, and stopped reason.
- Hotdrop remains skipped when `rate_limited == true`.

- [ ] **Step 1: Write failing workflow-source tests for linked-only sync messaging and preserved 429 gating.**

- [ ] **Step 2: Update the step summary and failure notification extraction to surface the structured sync result without nickname values.**

- [ ] **Step 3: Confirm Smart Scraper and Bluezone remain before User Matches Sync and no new parallel PUBG job is introduced.**

- [ ] **Step 4: Run focused workflow tests and commit.**

Run: `npm run test:unit -- tests/daily-tasks-workflow.test.ts tests/daily-maintenance-failure-notify.test.ts tests/hotdrop-boundary.test.ts`

Commit: `chore: report linked PUBG auto sync`

### Task 5: Schema and End-to-End Verification

**Files:**
- Modify only if verification finds a defect.

- [ ] **Step 1: Run all unit and integration tests.**

```bash
npm run test:unit
npm test -- --runInBand
```

- [ ] **Step 2: Run static and production-build verification.**

```bash
npm run verify:core
npm run build
git diff --check
```

- [ ] **Step 3: Run Supabase security and performance advisors against project `kolwueoejdasoqyopkao`; do not mutate production.**

- [ ] **Step 4: Use a service-role read-only query or a temporary transaction on a non-production database to verify that linked active profiles are listed once per identity, inactive and unlinked profiles are absent, and anon/authenticated cannot read the state table.**

- [ ] **Step 5: Produce a migration application handoff containing the exact migration filename, advisor findings, test evidence, and rollback SQL. The coordinator decides whether to apply it remotely.**
