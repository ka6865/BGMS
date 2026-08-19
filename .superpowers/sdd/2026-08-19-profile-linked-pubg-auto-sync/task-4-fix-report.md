# Task 4 privacy P1 fix report

## Result

Closed the Task 4 review P1 from `task_f70c702dc740` on base `1cf6029`.

- `.github/workflows/daily-tasks.yml`
  - Removed raw `MATCHED_LINES` propagation from maintenance failure notification.
  - Reads each fetched job log only as local input and emits an allowlisted, deduplicated category set: `rate limit`, `timeout`, `HTTP NNN` (numeric status only), `Hotdrop failure`, `PUBG API failure`, and `step failure (details hidden)`.
  - Keeps the existing fixed fallback when no category can be classified; no raw log line, nickname, player/account identifier, URL, bearer token, or shell metacharacter is assigned to `ERROR_LINES`.
  - Keeps log lookup failure notes fixed instead of copying job metadata into the cause section.
  - Preserves all Task 4 aggregate outputs, the linked-sync summary, Smart Scraper/Bluezone ordering, the single sequential sync consumer, and the `rate_limited == true` Hotdrop skip gate.
- `tests/daily-maintenance-failure-notify.test.ts`
  - Adds an executable Bash regression harness around the YAML notification step using fake `gh` and `curl` commands.
  - Covers `playerId`, `player-id`, `player id`, `accountId`, an unlabeled nickname, URLs/secrets, and shell metacharacters.
  - Asserts useful fixed categories and `HTTP 503` remain, raw values never reach the captured Discord JSON, and shell metacharacters do not execute.
  - Updates source assertions to require category-only extraction and no `MATCHED_LINES` variable.

## TDD evidence

The adversarial test was run before the workflow change and failed for the expected reasons: the old script still contained `MATCHED_LINES`, and the captured payload contained raw `Linked_Player`/other log text instead of `Hotdrop failure`, `PUBG API failure`, and hidden generic failure categories. The allowlist implementation then made the focused test pass.

## Verification

- `npm run test:unit -- tests/daily-maintenance-failure-notify.test.ts` — 12/12 passed after the fix.
- `npm run test:unit -- tests/daily-tasks-workflow.test.ts tests/daily-maintenance-failure-notify.test.ts tests/hotdrop-boundary.test.ts` — 3 files, 23/23 passed.
- YAML parse with `js-yaml` — passed.
- Extracted `Notify Discord On Failure` shell — `bash -n` passed.
- `npm run test:unit` — 158 files passed, 2 skipped; 1,435 tests passed, 49 skipped.
- `npm test -- --runInBand` — 1 Jest suite, 2 tests passed.
- `npm run verify:core` — exit 0; 0 errors and 61 existing ESLint warnings.
- `git diff --check` — passed.

No remote, production, database, webhook, or subagent state was mutated. Commit message: `fix: redact maintenance failure details`.
