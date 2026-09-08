# Task 5 report: authenticated community agent API and service

Commit subject: `feat: expose scoped community agent execution`

## Implemented

- Added `resolveCommunityActor(request)` with a dedicated `COMMUNITY_AGENT_WORKER_SECRET` bearer branch and the existing `withAuthGuard` plus `verifyAdminRole` admin branch. No community store, source collector, or provider is created or read before this boundary succeeds.
- Added the service-role client factory after authentication. Worker scope is limited to starting a non-dry run, reading a run, executing one stored stage, and publishing a stored run.
- Added strict 16 KiB JSON request readers and exact action schemas. Unknown fields, query-string secrets, unrelated cron tokens, arbitrary stages, and supplied publish content are rejected.
- Added `executeAction(action, actor, store)`:
  - start performs cleanup and starts the DB-owned daily run;
  - collect stages claim a lease, collect one source within the existing source deadline, save evidence, and persist canonical evidence IDs under the lease;
  - select/draft/verify reload persisted run and evidence state and never accept editorial input from the client;
  - no usable evidence, no topic, and model/provider errors finish immediately through a bounded terminal result;
  - verification runs deterministic `checkDraft`, semantic `verifyDraft`, server rendering, and category selection;
  - unpublished publish attempts re-check the saved draft/evidence/hash before the atomic RPC, while already-published retries go directly to the RPC idempotency result.
- Added admin-only status/configuration and bot preparation API. The typed status includes policy, source state, recent seven-day runs, numeric token totals, and missing environment variable names.
- Added exact reserved bot account preparation for `bgms-community-agent@users.invalid`, nickname `BGMS AI 비서`, and server-owned `app_metadata.community_agent=true`. It uses a random 48-byte password, never returns it, verifies the ordinary profile, refuses marker collisions, and performs bounded exact-email recovery after a lost create response. It patches only `bot_user_id` and does not enable policy or publishing.
- Extended `CommunityStore` with narrow source cache/status and recent-run readers. Partial policy writes now send only supplied columns, preserving a concurrent operator pause.
- Extended the still-unapplied feature migration with a DB-owned `dry_run` flag, lease-checked terminal result envelope, bounded numeric prompt/completion token metadata, and dry-run publish rejection. Raw provider/source fields are discarded.
- Tightened select/draft model prompts with the strict parser enums, field types, lengths, evidence cardinality, recent-window enum, and single-source labeling requirements. The parser remains strict with no repair call or fallback.

## Interfaces

- `Actor = { kind: "admin"; userId: string } | { kind: "worker"; userId: null }`
- `resolveCommunityActor(request: Request): Promise<Actor | Response>`
- `createCommunityStore(): { client; store }`
- `prepareCommunityBot(client, store): Promise<PrepareBotResult>`
- `RunAction = start | step | publish`
- `executeAction(action: RunAction, actor: Actor, store: CommunityStore): Promise<RunSnapshot | PublishResult>`
- `CommunityAgentStatus` with `policy`, `sources`, `runs`, `usage`, and `missingEnv`
- `GET/POST /api/admin/agent/community`
- `GET/POST /api/admin/agent/community/run`

## TDD evidence

### RED

Command:

```text
npx vitest run tests/community-agent-api.test.ts
```

Expected failure before implementation:

```text
FAIL tests/community-agent-api.test.ts
Error: Cannot find module '/app/api/admin/agent/community/run/route'
Test Files 1 failed (1); Tests no tests
```

The new boundary test imported the required run route before it existed.

### GREEN

Focused API/store/editorial/source/policy plus existing Admin Agent API command:

```text
npx vitest run tests/community-agent-api.test.ts tests/community-agent-store.test.ts tests/community-agent-editorial.test.ts tests/community-agent-sources.test.ts tests/community-agent-policy.test.ts tests/admin-agent-api.test.ts
```

Result:

```text
Test Files 6 passed (6)
Tests 129 passed (129)
```

Task lint and TypeScript command:

```text
npx eslint lib/community-agent/auth.ts lib/community-agent/service.ts lib/community-agent/store.ts lib/community-agent/types.ts lib/community-agent/editorial.ts app/api/admin/agent/community/route.ts app/api/admin/agent/community/run/route.ts tests/community-agent-api.test.ts tests/community-agent-store.test.ts tests/community-agent-editorial.test.ts && npx tsc --noEmit --pretty false
```

Result: exit 0, no warnings or output.

Disposable local PostgreSQL 17 verifier:

```text
bash scripts/verify_community_agent_migration.sh
```

Result:

```text
community-agent sequential scenarios passed
concurrent publish serializes to one board post
concurrent stop/publish is serialized by the policy row
community-agent migration and atomic publishing checks passed
```

The scenario explicitly switches to `service_role` for the terminal lease and usage checks. No production database was contacted.

## Files changed

- `lib/community-agent/auth.ts`
- `lib/community-agent/service.ts`
- `app/api/admin/agent/community/route.ts`
- `app/api/admin/agent/community/run/route.ts`
- `tests/community-agent-api.test.ts`
- `lib/community-agent/store.ts`
- `lib/community-agent/types.ts`
- `lib/community-agent/editorial.ts`
- `tests/community-agent-store.test.ts`
- `tests/community-agent-editorial.test.ts`
- `supabase/migrations/20260908000000_community_agent_persistence.sql`
- `tests/fixtures/community-agent/scenarios.sql`

## Self-review

- Found and fixed a publish retry issue: a published run whose draft/evidence was later cleaned must still reach the atomic RPC and return `already_published`.
- Found and fixed a migration scenario date collision with the verifier's concurrency fixtures.
- Confirmed worker configuration/bot preparation is rejected before a service client is created.
- Confirmed policy partial updates do not read and resend a stale `enabled` value.
- Confirmed the generated password is passed only into Auth creation and is not persisted, logged, or returned.

## Concerns

- No production DB migration, deployment, bot preparation, external source request, provider call, or public post was performed. Runtime deployment duration limits still need the planned pre-deployment check.
- Provider-level priority relative to existing match analysis cannot be guaranteed; this implementation only preserves the requested per-run call cap, single model, no fallback, and immediate 429 defer behavior.

## Review fix round 1

The recorded two-call smoke returned a writer object with root `title` and `paragraphs` but no root `question`. The exact malformed field is not inferred beyond that recorded shape. The writer now passes the installed Gemini SDK a native `responseSchema` with required root `title`, `paragraphs`, and `question`, and required nested paragraph `text`, `kind`, `evidenceIds`, and `recentWindow`. The prompt also includes a complete JSON object example and explicitly places `question` at the root. The parser remains strict; no repair request, retry, model fallback, dependency change, live provider call, or dry-run change was added.

RED command:

```text
npx vitest run tests/community-agent-editorial.test.ts
```

Relevant result before implementation:

```text
FAIL 작성 provider schema는 root question과 paragraph 하위 필드를 구조적으로 강제한다
expected undefined to match object { type: 'object', ... }
Test Files 1 failed (1); Tests 2 failed | 18 passed
```

The second failure was an existing global mock-call count exposed by the new provider invocation; it was made relative to the prior call count without changing product behavior.

GREEN command:

```text
npx vitest run tests/community-agent-editorial.test.ts tests/community-agent-api.test.ts
```

Result:

```text
Test Files 2 passed (2)
Tests 37 passed (37)
```

Static verification:

```text
npx eslint lib/community-agent/editorial.ts tests/community-agent-editorial.test.ts tests/community-agent-api.test.ts && npx tsc --noEmit --pretty false
```

Result: exit 0, no warnings or output.

Files changed in this fix:

- `lib/community-agent/editorial.ts`
- `tests/community-agent-editorial.test.ts`
