# Current Season Summary and Quota Protection Implementation Plan

> For agentic workers: REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox syntax for tracking.

**Goal:** Add a readable current-season ranked summary card to the stats page while preventing lower-priority PUBG API work from issuing more requests after a 429 response.

**Architecture:** Derive the card entirely from the existing PlayerStatsResponse cache payload. Add a pure summary-model function and a focused profile-card component, keeping the existing detailed mode/party controls unchanged. Propagate the daily sync script's rate-limit state through GITHUB_OUTPUT and make the maintenance workflow skip Hotdrop after a 429.

**Tech Stack:** Next.js 16, React 19, TypeScript, Tailwind CSS, Testing Library, Vitest, GitHub Actions, existing Supabase-backed cache.

## Global Constraints

- Do not add a season-specific PUBG API route or an extra browser fetch.
- The representative card uses ranked statistics and prefers squad, then duo, then solo only when the preferred bucket has no played rounds.
- Missing optional fields render as "—"; do not invent zero values for unavailable data.
- Keep the existing distributed cache and 60-second forced-refresh cooldown unchanged.
- A 429 detected by sync_user_matches must make Hotdrop skip in the same maintenance run.
- Do not add a Supabase table, migration, package, or public API surface for this feature.
- Preserve the existing 44px interaction target and responsive layout conventions.

---

## Task 1: Propagate PUBG API rate-limit state and fix failure-log extraction

**Files:**
- Modify: scripts/sync_user_matches.ts
- Modify: .github/workflows/daily-tasks.yml
- Modify: tests/sync-user-matches.test.ts
- Modify: tests/hotdrop-boundary.test.ts
- Modify: tests/daily-maintenance-failure-notify.test.ts

**Interfaces:**
- Produces writeRateLimitOutput(rateLimited: boolean, outputPath?: string): void from scripts/sync_user_matches.ts.
- Produces the GitHub step output rate_limited from the Run User Matches Sync step.
- Consumes steps.sync_user_matches.outputs.rate_limited in the Hotdrop condition.

- [ ] Step 1: Add a failing output-contract test.

In tests/sync-user-matches.test.ts, import the new helper and write true to a temporary file. Assert the file contains exactly rate_limited=true followed by a newline. The test must use node:fs/promises, node:os, and node:path so it does not depend on repository files.

- [ ] Step 2: Run the focused test and verify it fails.

~~~bash
npm run test:unit -- tests/sync-user-matches.test.ts
~~~

Expected: FAIL because writeRateLimitOutput is not defined.

- [ ] Step 3: Implement the output helper and script state.

Import appendFileSync from node:fs and add:

~~~ts
export function writeRateLimitOutput(
  rateLimited: boolean,
  outputPath = process.env.GITHUB_OUTPUT,
): void {
  if (!outputPath) return;
  appendFileSync(outputPath, "rate_limited=" + rateLimited + "\n");
}
~~~

Track a local rateLimited boolean in main(). Set it to true at both existing 429 branches: player lookup and match-detail ingestion. In a finally block, call writeRateLimitOutput(rateLimited) so the step emits false on a normal run and true after a rate limit. Keep the existing lower-priority loop break behavior.

- [ ] Step 4: Run the focused test and verify it passes.

~~~bash
npm run test:unit -- tests/sync-user-matches.test.ts
~~~

Expected: PASS.

- [ ] Step 5: Add workflow skip behavior.

Give the Run User Matches Sync step the id sync_user_matches. Add the maintenance job output pubg_rate_limited from steps.sync_user_matches.outputs.rate_limited. Add a warning-only step immediately before Hotdrop whose condition requires the rate_limited output to equal true and whose run command says that Hotdrop is being skipped until the next run. Add the condition steps.sync_user_matches.outputs.rate_limited != 'true' to the existing Run Hotdrop Collection condition. Do not set continue-on-error on Hotdrop.

- [ ] Step 6: Add static workflow contracts.

Extend tests/hotdrop-boundary.test.ts and tests/daily-tasks-workflow.test.ts to assert the sync step id, pubg_rate_limited job output, warning step, and the Hotdrop condition. Preserve the existing single-consumer and environment assertions.

- [ ] Step 7: Make Discord failure extraction prefer real error lines.

In .github/workflows/daily-tasks.yml, replace the broad supabase-matching pipeline with explicit runtime-error patterns such as Hotdrop 수집 실패, PUBG API error, HTTP status errors, rate limit, timeout, and Error:. Filter setup/deprecation noise, redact URLs and bearer tokens, and use tail -n 8 after filtering. The implementation must retain Hotdrop 수집 실패: PUBG API error 429 even when earlier setup lines contain masked Supabase environment names.

Add assertions in tests/daily-maintenance-failure-notify.test.ts for tail -n 8 and for the absence of supabase as a raw error-match token.

- [ ] Step 8: Run all Task 1 tests.

~~~bash
npm run test:unit -- tests/sync-user-matches.test.ts tests/hotdrop-boundary.test.ts tests/daily-tasks-workflow.test.ts tests/daily-maintenance-failure-notify.test.ts
~~~

Expected: PASS.

- [ ] Step 9: Commit the quota protection slice.

~~~bash
git add scripts/sync_user_matches.ts .github/workflows/daily-tasks.yml tests/sync-user-matches.test.ts tests/hotdrop-boundary.test.ts tests/daily-tasks-workflow.test.ts tests/daily-maintenance-failure-notify.test.ts
git commit -m "fix: stop low-priority PUBG jobs after rate limits"
~~~

## Task 2: Add pure current-season summary metrics

**Files:**
- Modify: types/stats-page.ts
- Modify: lib/stats/statsPageModel.ts
- Modify: tests/stats-page-model.test.ts

**Interfaces:**
- Produces StatsSeasonSummaryMetrics and getCurrentSeasonSummary(player: PlayerStatsResponse): StatsSeasonSummaryMetrics.
- Consumes PlayerStatsResponse, StatsBucket, selectCanonicalRankBucket, and the cached season list.

- [ ] Step 1: Add failing metric tests.

For the existing fixture values (12 games, 2 wins, 0.5 Top 10 ratio, 24 kills, 8 assists, 10 deaths, 3600 damage, 12000 survival seconds, 6 headshot kills), assert:

~~~ts
expect(getCurrentSeasonSummary(playerReadyFixture)).toMatchObject({
  kind: "ready",
  seasonName: "Season 8",
  partySize: "squad",
  roundsPlayed: 12,
  wins: 2,
  winRate: "16.7%",
  top10Rate: "50.0%",
  kda: "3.20",
  averageDamage: "300",
  averageSurvival: "16:40",
  headshotRate: "25.0%",
});
~~~

Add tests for roundsPlayed: 0, no ranked buckets, kills: 0, and top10s fallback when top10Ratio is absent.

- [ ] Step 2: Run the model tests and verify they fail.

~~~bash
npm run test:unit -- tests/stats-page-model.test.ts
~~~

Expected: FAIL because the new type and function are not defined.

- [ ] Step 3: Implement the metric type and pure function.

Add a discriminated union with empty and ready variants. The ready variant must contain seasonId, seasonName, partySize, tier, subTier, rankPoint, roundsPlayed, wins, winRate, top10s, top10Rate, kda, averageDamage, averageSurvival, and headshotRate. Implement getCurrentSeasonSummary in lib/stats/statsPageModel.ts. Resolve the season label from player.seasons, choose ranked squad first and the existing canonical ranked fallback only when the preferred bucket has no rounds, guard all division by roundsPlayed, format survival seconds as MM:SS, and return empty when no bucket has played rounds.

- [ ] Step 4: Run the model tests and verify they pass.

~~~bash
npm run test:unit -- tests/stats-page-model.test.ts
~~~

Expected: PASS.

- [ ] Step 5: Commit the metric slice.

~~~bash
git add types/stats-page.ts lib/stats/statsPageModel.ts tests/stats-page-model.test.ts
git commit -m "feat: derive current season summary metrics"
~~~

## Task 3: Build and integrate the readable season card

**Files:**
- Create: components/stat/profile/CurrentSeasonSummaryCard.tsx
- Modify: components/stat/profile/PlayerProfileHeader.tsx
- Modify: tests/player-profile-header.test.ts

**Interfaces:**
- Consumes StatsSeasonSummaryMetrics and getCurrentSeasonSummary.
- Produces a semantic section with accessible labels for season, ranked mode, party size, tier, RP, wins, win rate, Top 10 rate, average damage, KDA, survival time, and headshot rate.

- [ ] Step 1: Add failing card assertions.

Extend tests/player-profile-header.test.ts to assert a region named 현재 시즌 경쟁전 스쿼드 요약, the season name, 승률 10.0%, Top 10률 40.0%, and a formatted 평균 생존 value. Add a no-ranked-rounds fixture and assert 기록 없음 while the header controls remain present.

- [ ] Step 2: Run the profile tests and verify they fail.

~~~bash
npm run test:unit -- tests/player-profile-header.test.ts
~~~

Expected: FAIL because the season summary region does not exist.

- [ ] Step 3: Implement CurrentSeasonSummaryCard.

Use a focused presentational component. Header row: season name, 현재 시즌, and 경쟁전 · 스쿼드. Desktop layout: tier block at left and four key metric cells at right. Mobile layout: tier block followed by a two-column key metric grid. Use a four-cell secondary grid. Use existing getTierIconPath, amber accents, dark card surfaces, and 44px controls. Key labels: 경기, 승, 승률, Top 10률. Secondary labels: 평균 딜량, KDA, 평균 생존, 헤드샷률. Render — for optional values and 기록 없음 for an empty bucket.

- [ ] Step 4: Integrate without adding a fetch.

In PlayerProfileHeader, call getCurrentSeasonSummary(player) and render CurrentSeasonSummaryCard in place of the standalone rank row. Keep season select, refresh, favorite, compare, weapons, clan, ban, and updated-time controls unchanged. Do not add useEffect, fetch, or route calls.

- [ ] Step 5: Run profile and controller tests.

~~~bash
npm run test:unit -- tests/player-profile-header.test.ts tests/stats-page-shell.test.ts tests/stat-search-season-refresh.test.ts
~~~

Expected: PASS.

- [ ] Step 6: Commit the UI slice.

~~~bash
git add components/stat/profile/CurrentSeasonSummaryCard.tsx components/stat/profile/PlayerProfileHeader.tsx tests/player-profile-header.test.ts
git commit -m "feat: add current season stats card"
~~~

## Task 4: Full verification and developer server

**Files:**
- Modify only if verification exposes a directly related defect in the files above.
- Create: docs/superpowers/plans/2026-08-18-season-summary-quota-plan.md

- [ ] Step 1: Run the complete relevant unit suite.

~~~bash
npm run test:unit -- tests/stats-page-model.test.ts tests/player-profile-header.test.ts tests/stats-page-shell.test.ts tests/stat-search-season-refresh.test.ts tests/pubg-response-cache.test.ts tests/sync-user-matches.test.ts tests/hotdrop-boundary.test.ts tests/daily-tasks-workflow.test.ts tests/daily-maintenance-failure-notify.test.ts
~~~

Expected: all selected test files pass.

- [ ] Step 2: Run core static verification.

~~~bash
npm run verify:core
~~~

Expected: ESLint and TypeScript complete with exit code 0.

- [ ] Step 3: Start the development server.

~~~bash
npm run dev -- --hostname 0.0.0.0
~~~

Keep the process running and record the actual local URL, normally http://localhost:3000.

- [ ] Step 4: Verify the server in a browser.

Use agent-browser:

~~~bash
agent-browser open http://localhost:3000/stats
agent-browser wait --load networkidle
agent-browser screenshot --annotate
agent-browser snapshot -i
agent-browser eval 'document.querySelector("[data-nextjs-dialog]") ? "ERROR_OVERLAY" : "OK"'
agent-browser eval 'document.body.innerText.trim().length > 0 ? "HAS_CONTENT" : "BLANK"'
~~~

Expected: the stats search landing page has meaningful content, no framework error overlay, and accessible search controls. Do not search a real player during automated verification because that would consume the PUBG API budget; the user can inspect a cached player from the provided URL.

- [ ] Step 5: Check the final diff and server state.

~~~bash
git status --short --branch
git diff HEAD~3..HEAD --stat
~~~

Confirm only the design/plan documents, quota protection, metric model, card component, workflow, and related tests changed. Keep the dev server running for the user's visual inspection.

