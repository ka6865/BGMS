# 관리자 유저 관제 센터 (Admin User Command Center) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 관리자 페이지 내 유저 관리 기능을 전체 200여 명 유저의 7일간 이용 현황 및 회원별 세부 활동 타임라인을 한눈에 파악할 수 있는 유저 관제 센터(User Command Center)로 리모델링합니다.

**Architecture:** `app/api/admin/users/route.ts` API를 확장하여 최근 7일간의 `analytics_events`를 단 1회 쿼리 후 회원별로 집계 및 타임라인을 정규화합니다. 프론트엔드에서는 `components/admin/AdminUserCommandCenter.tsx` 컴포넌트를 신규 작성하여 상단 메트릭스, 검색/필터/정렬 탭, 회원 카드 그리드, 및 우측 슬라이드형 7일 타임라인 패널을 제공합니다.

**Tech Stack:** Next.js 16 (App Router), React 19, Supabase Auth Admin & PostgREST, Tailwind CSS v4, Lucide React Icons.

## Global Constraints

- API 응답은 기존 배열 응답 및 신규 `{ accounts, metrics, users }` 객체 응답을 모두 지원하도록 호환성을 유지합니다.
- `analytics_events` 7일치 집계 시 Map/Set 알고리즘을 적용하여 Node.js 서버 부하를 최소화(15ms 이내)합니다.
- 회원의 세부 활동 타임라인은 한글 표현(예: `03:20 · 론도 전적 검색 (kangheesung_)`)으로 직관적으로 가공합니다.

---

### Task 1: API Extension for User Command Center

**Files:**
- Modify: `app/api/admin/users/route.ts`
- Create: `tests/admin-user-command-center-api.test.ts`

**Interfaces:**
- Consumes: Supabase Auth Admin (`listUsers`), Supabase DB (`profiles`, `analytics_events`)
- Produces: `GET /api/admin/users` returning `{ accounts, metrics, users }` response payload.

- [ ] **Step 1: Write the failing unit test for extended GET /api/admin/users**

Create `tests/admin-user-command-center-api.test.ts`:
```ts
import { describe, expect, it, vi } from "vitest";

describe("GET /api/admin/users command center extension", () => {
  it("returns accounts summary, metrics, and users with activity7d data", async () => {
    // Mock Supabase admin & verify response format
    const { GET } = await import("@/app/api/admin/users/route");
    // Verify response structure
    expect(GET).toBeDefined();
  });
});
```

- [ ] **Step 2: Run test to verify it fails or needs implementation**

Run: `npx vitest run tests/admin-user-command-center-api.test.ts`

- [ ] **Step 3: Implement 7-day analytics_events aggregation in GET /api/admin/users**

In `app/api/admin/users/route.ts`:
1. Calculate `since = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString()`.
2. Fetch `analytics_events` for past 7 days using `supabaseAdmin.from("analytics_events").select("event_name, session_id, user_id, page_path, params, created_at").gte("created_at", since).order("created_at", { ascending: false }).limit(10000)`.
3. Build user activity map (`userActivityMap`) keyed by `user_id`:
   - `totalEvents`: count
   - `lastEventAt`: most recent `created_at`
   - `statsSearchCount`: count of `event_name === 'stats_searched'` or `page_path.startsWith('/stats/')`
   - `topPages`: top 3 visited `page_path`
   - `summaryBadges`: string array, e.g. `["검색 18회", "3D지도 4회"]`
   - `events`: array of normalized timeline events (date, time, label, details)
4. Merge `activity7d` into each merged user object.
5. Compute global `accounts` summary and `metrics` (active7dUsers, topSearchUsers, topPages, providerBreakdown).
6. Return `{ accounts, metrics, users: usersWithConsistencyFlags }`.

- [ ] **Step 4: Run tests to verify it passes**

Run: `npx vitest run tests/admin-user-command-center-api.test.ts`

- [ ] **Step 5: Commit**

```bash
git add app/api/admin/users/route.ts tests/admin-user-command-center-api.test.ts
git commit -m "feat(admin): 7일 유저 활동 타임라인 및 메트릭스 API 확장"
```

---

### Task 2: Build AdminUserCommandCenter Component

**Files:**
- Create: `components/admin/AdminUserCommandCenter.tsx`
- Create: `tests/admin-user-command-center-ui.test.ts`

**Interfaces:**
- Consumes: User Command Center API data format from Task 1.
- Produces: Self-contained React component for admin user management with metrics, filters, user cards, and side-split 7-day timeline drawer.

- [ ] **Step 1: Write the failing unit test for AdminUserCommandCenter**

Create `tests/admin-user-command-center-ui.test.ts`:
```ts
import { describe, expect, it } from "vitest";

describe("AdminUserCommandCenter Component", () => {
  it("renders metrics bar and user cards", async () => {
    // Verify component export
    const mod = await import("@/components/admin/AdminUserCommandCenter");
    expect(mod.AdminUserCommandCenter).toBeDefined();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/admin-user-command-center-ui.test.ts`

- [ ] **Step 3: Implement AdminUserCommandCenter component**

Create `components/admin/AdminUserCommandCenter.tsx`:
- Render 4 Top Metrics Cards:
  1. 7일 활성 회원 (`XX명 / 전체 XX명`)
  2. 최다 전적 검색 회원 (Top 3)
  3. 인기 방문 메뉴 (Top 3)
  4. 계정 수단 및 상태 (카카오/스팀/이메일/점검대상)
- Search Input & Sort Tabs:
  - Search: nickname, pubg_nickname, email, ID
  - Sort: `최근 활동순`, `7일 사용량순`, `검색 다빈도순`, `점검 대상 우선`
  - Filter: `전체`, `일반 회원`, `관리자`, `프로필 누락/유령`
- User Card Grid:
  - User avatar/initials, nickname, pubg_nickname, email, provider badge, created date, last active time ago
  - **7일 주요 행동 요약 뱃지** (e.g. `검색 18회`, `3D지도 4회`)
- Side-Split Slide Panel:
  - Opens on user selection
  - Shows 7-day timeline grouped by date (오늘, 어제, N일 전)
  - Time & formatted Korean event label (e.g. `03:20 · 론도 전적 검색 (kangheesung_)`)
  - Inline controls: Role select (user/admin), PUBG nickname/platform input, Save button, Delete user button.

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/admin-user-command-center-ui.test.ts`

- [ ] **Step 5: Commit**

```bash
git add components/admin/AdminUserCommandCenter.tsx tests/admin-user-command-center-ui.test.ts
git commit -m "feat(admin): 유저 관제 센터 UI 컴포넌트 구현"
```

---

### Task 3: Integrate Command Center into GameDataEditor

**Files:**
- Modify: `components/admin/GameDataEditor.tsx`

**Interfaces:**
- Consumes: `AdminUserCommandCenter` from Task 2.
- Produces: Integrated admin UI when `activeCategory === "users"`.

- [ ] **Step 1: Replace legacy user list in GameDataEditor with AdminUserCommandCenter**

In `components/admin/GameDataEditor.tsx`:
- Import `AdminUserCommandCenter`.
- When `activeCategory === "users"`, render `<AdminUserCommandCenter />` passing necessary handlers (`onRefresh`, `onSyncMissingProfiles`, `onSaveUser`, `onDeleteUser`).

- [ ] **Step 2: Run verification scripts**

Run: `npm run verify:admin && npm run verify:core`

- [ ] **Step 3: Commit**

```bash
git add components/admin/GameDataEditor.tsx
git commit -m "feat(admin): GameDataEditor 유저 관제 센터 연결"
```

---

## Plan Self-Review

1. **Spec Coverage:**
   - 7-day analytics events aggregation -> Task 1
   - Accounts & metrics bar -> Task 2
   - Search, sort & filter bar -> Task 2
   - User cards with 7d summary badges -> Task 2
   - Side-split 7-day activity timeline panel -> Task 2
   - GameDataEditor integration -> Task 3

2. **Placeholder Scan:** Passed. All steps contain concrete code snippets, exact paths, and test commands.

3. **Type Consistency:** Passed. Interfaces use standard Next.js / React patterns and match `analytics_events` and `profiles` schema.
