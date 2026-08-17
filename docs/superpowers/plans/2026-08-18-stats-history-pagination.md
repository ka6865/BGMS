# Stats History Numbered Pagination Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the stats page's cumulative “load more” history control with 20-record numbered pagination backed by the stored match table.

**Architecture:** The match-history route will use a stable page-number query with an exact database count and return one 20-record page. The controller will load page 1 after the player result, retain the current page and total pages, and replace visible match IDs on page changes while preserving already-built summaries in its cache.

**Tech Stack:** Next.js App Router, React hooks, TypeScript, Supabase PostgREST, Vitest, Testing Library, Puppeteer smoke verification.

## Global Constraints

- Keep the fixed page size at 20 records.
- History pagination must read `pubg_player_matches` and must not call the PUBG player API.
- Keep existing match filters, summary loading, lazy detail loading, and partial-state reporting behavior.
- Sort pages by `played_at DESC, match_id DESC` for deterministic boundaries.
- Preserve the current initial recent-match experience until stored page 1 is available.

### Task 1: Page-based stored-history API

**Files:**
- Modify: `lib/pubg/playerMatches.ts`
- Modify: `app/api/pubg/player/matches/route.ts`
- Test: `tests/player-matches.test.ts`
- Test: `tests/player-matches-api.test.ts`

**Interfaces:**
- Produce `fetchPlayerMatchesPaginated(supabase, nickname, platform, page, limit)` returning `matches`, `page`, `pageSize`, `totalCount`, and `totalPages`.
- Accept a positive `page` query value in the route; invalid or missing values fall back to page 1.

- [ ] Write helper tests for page normalization and page metadata.
- [ ] Implement a Supabase `select(..., { count: "exact" })` query with `.range((page - 1) * limit, page * limit - 1)` and stable ordering.
- [ ] Update the route to return page metadata and retain nickname validation.
- [ ] Run `npm run test:unit -- tests/player-matches.test.ts tests/player-matches-api.test.ts`.
- [ ] Commit the API change with `feat: add numbered match history pages`.

### Task 2: Controller page state

**Files:**
- Modify: `hooks/useStatsPageController.ts`
- Modify: `types/stats-page.ts`
- Test: `tests/stats-page-controller.test.ts`
- Test: `tests/stats-page-shell.test.ts`

**Interfaces:**
- Expose `historyPage`, `historyTotalPages`, and `setHistoryPage(page)` from `StatsPageController`.
- Replace cursor-only fields and `loadMoreHistory` with page loading while retaining `historyStatus`.

- [ ] Add a controller test that loads page 1, navigates to page 2, replaces visible IDs, and confirms only one player API request occurred.
- [ ] Reset page metadata on a new player/search.
- [ ] Load stored page 1 after the player result and keep the recent API IDs as the pre-history fallback.
- [ ] Implement guarded page changes, page bounds, loading state, and retry-safe errors.
- [ ] Run controller and shell tests.
- [ ] Commit the controller change with `feat: connect stats page navigation state`.

### Task 3: Numbered MatchFeed controls

**Files:**
- Modify: `components/stat/matches/MatchFeed.tsx`
- Modify: `components/stat/layout/StatsPageShell.tsx`
- Test: `tests/match-feed.test.tsx` (or the existing MatchFeed test file)

**Interfaces:**
- MatchFeed consumes `historyPage`, `historyTotalPages`, `historyStatus`, and `onPageChange(page)`.
- Render `이전 전적 페이지`, numbered page buttons, and `다음 전적 페이지` with accessible pressed/disabled state.

- [ ] Add a compact page-window helper so small totals show every page and larger totals show the first, current neighborhood, ellipsis, and last page.
- [ ] Replace `전체 전적 불러오기` and `이전 전적 더 보기` with numbered navigation.
- [ ] Keep the match count and current filter layout usable at mobile and desktop widths.
- [ ] Add loading/error copy without reintroducing a cumulative list.
- [ ] Run the focused MatchFeed and shell tests.
- [ ] Commit the UI change with `feat: render numbered match history pagination`.

### Task 4: End-to-end verification

**Files:**
- Modify: only if verification finds a defect.

- [ ] Run `npm run test:unit`.
- [ ] Run `npm run verify:core`.
- [ ] Run `npm test -- --runInBand`.
- [ ] Use the running local server to verify desktop and mobile show the same page controls, page 2 replaces page 1, and no additional `/api/pubg/player?` request occurs.
- [ ] Run `git diff --check` and confirm the worktree is clean after the final commit.
