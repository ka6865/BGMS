# Task 6 report: scheduled community worker and retention runner

Commit subject: `feat: schedule daily community publishing`

## Implemented

- Added `runCommunityWorker({ baseUrl, secret, fetchImpl })`, which calls only the existing `start`, `step`, `publish`, and `GET run` API contract. It follows `dc → naver → youtube → select → draft → verify`, uses the returned persisted run ID, and publishes only once the stored status is `ready`.
- Each API call sends the dedicated worker bearer secret, rejects redirects, and uses a 55-second abort timeout. The app URL accepts only an HTTPS origin; paths, query strings, fragments, and credentials are rejected. There is no localhost override.
- A lost stage response triggers exactly one `GET run` recovery. A persisted completed stage moves forward; running, failed, or absent recovered state stops without repeating that provider stage.
- Added `runCommunityCleanup` and `--cleanup-only`, which can call only `POST /api/admin/agent/community/cleanup` and print the same short `{ status, postId }` result shape.
- Added the cleanup-only route. It authenticates through the existing admin-or-dedicated-worker boundary before creating a store, rejects every request body, and invokes only `store.cleanup()`. Storage failures return the existing safe 503 shape.
- Added an independent daily GitHub Actions workflow. With configured app URL and worker secret it runs the normal worker only when `COMMUNITY_AGENT_SCHEDULE_ENABLED == 'true'`; otherwise it runs retention cleanup only. It has no database, Gemini, Naver, YouTube, or Discord credentials and does not depend on `daily-tasks`.
- Added the requested package scripts and README operations note. The documentation states that scheduled executions can start late and that disabled Actions or an unavailable app require manual cleanup.

## TDD evidence

### RED

The required runner test was added before the implementation. The shell did not provide `npx`, so the bundled Node runtime ran the same local Vitest entrypoint:

```text
/Users/kangheesung/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin/node node_modules/vitest/vitest.mjs run tests/community-agent-runner.test.ts
```

Result before implementation:

```text
FAIL tests/community-agent-runner.test.ts
Error: Cannot find module '../scripts/run_community_agent'
Test Files 1 failed (1); Tests no tests
```

### GREEN

Community lifecycle suite:

```text
/Users/kangheesung/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin/node node_modules/vitest/vitest.mjs run tests/community-agent-policy.test.ts tests/community-agent-store.test.ts tests/community-agent-sources.test.ts tests/community-agent-editorial.test.ts tests/community-agent-api.test.ts tests/community-agent-runner.test.ts
```

Result: 6 files and 70 tests passed.

Targeted lint:

```text
/Users/kangheesung/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin/node node_modules/eslint/bin/eslint.js scripts/run_community_agent.ts app/api/admin/agent/community/cleanup/route.ts tests/community-agent-runner.test.ts tests/community-agent-api.test.ts
```

Result: exit 0 with no output.

Full TypeScript check:

```text
/Users/kangheesung/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin/node node_modules/typescript/bin/tsc --noEmit --pretty false
```

Result: exit 0 with no output.

`git diff --check` also passed. The workflow YAML was parsed locally and the runner test asserts the workflow excludes database/provider/notification secrets.

## Files changed

- `scripts/run_community_agent.ts`
- `app/api/admin/agent/community/cleanup/route.ts`
- `.github/workflows/community-agent.yml`
- `tests/community-agent-runner.test.ts`
- `tests/community-agent-api.test.ts`
- `package.json`
- `README.md`

## Self-review

- Confirmed the existing public run action union remains unchanged; cleanup has a separate, fixed route.
- Confirmed cleanup authentication happens before `createCommunityStore`, and injected cleanup bodies never create a client or reach source/provider work.
- Confirmed normal execution never requests the cleanup endpoint: `start` preserves the existing server-owned cleanup-before-run behavior. The workflow cleanup-only branch cannot collect, call a model, or publish.
- Confirmed duplicate ready runs skip all stages and retain the server publish result, while response recovery cannot blindly repeat a source stage.
- Confirmed stdout contains only the result’s status and post ID. No Discord operation or production/provider request was made during verification.

## Concerns

- The local shell lacks `npx`, so test, lint, and TypeScript commands used the bundled Node runtime against the repository’s installed tools. GitHub Actions itself uses the requested `npx tsx` invocation after `npm ci`.
- No production API request, database migration, GitHub Actions dispatch, external provider call, or public post was performed. The workflow requires repository `APP_URL`, `COMMUNITY_AGENT_WORKER_SECRET`, and the explicit schedule variable before any normal collection or publication can occur.

## Review fix round 1: recovery read includes the persisted run ID

The review found that lost-response recovery used the bare run endpoint. `GET /api/admin/agent/community/run` requires exactly one `runId` query parameter before it reaches authentication or the store, so the recovery request would receive 400.

The runner now builds the recovery URL as:

```text
/api/admin/agent/community/run?runId=${encodeURIComponent(run.id)}
```

The existing lost-response regression now records every URL and asserts the exact GET query, as well as the existing no-repeat stage behavior.

### RED

```text
/Users/kangheesung/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin/node node_modules/vitest/vitest.mjs run tests/community-agent-runner.test.ts
```

Result before the fix: 1 failing test. The recorded recovery request was `https://bgms.test/api/admin/agent/community/run`; the required URL was `https://bgms.test/api/admin/agent/community/run?runId=11111111-1111-4111-8111-111111111111`.

### GREEN

Runner regression command above: 1 file and 9 tests passed.

```text
/Users/kangheesung/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin/node node_modules/eslint/bin/eslint.js scripts/run_community_agent.ts tests/community-agent-runner.test.ts
/Users/kangheesung/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin/node node_modules/typescript/bin/tsc --noEmit --pretty false
git diff --check
```

Result: all commands exited 0 with no lint, type, or diff errors. No live calls were made.
