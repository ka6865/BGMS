# PUBG 과거 전적 영구 보존 및 90일 R2 텔레메트리 보존 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** PUBG 공식 API의 14일 보존 한계를 넘어 자사 DB에 과거 매치 기본 스탯을 영구 적재하고, R2 텔레메트리는 90일 보존 후 자동 정리하며, API 호출 없이 100% DB 커서 기반 무제한 전적 더보기(페이지네이션) 기능을 제공합니다.

**Architecture:** Supabase DB에 초경량 `pubg_player_matches` 테이블을 생성하여 유저별 전적 요약(K/D, 딜량, 순위, 맵, 일시)을 영구 저장합니다. 닉네임 검색 시 최근 14일 매치를 DB에 병합 upsert하고, 2페이지부터는 `/api/pubg/player/matches` 커서 쿼리로 DB만 즉시 읽습니다. R2 스토리지의 `analyze.json` 텔레메트리 파일은 `gzip` 압축 후 90일간 보존되며, 90일 초과 시 `cleanup_telemetry.ts` 스크립트로 정리되고 UI에 만료 뱃지가 표기됩니다.

**Tech Stack:** Next.js 16 (App Router), Supabase PostgreSQL, TypeScript, Cloudflare R2 S3 Client, Vitest

## Global Constraints
- Table Name: `pubg_player_matches`
- Primary Key: `(player_id, platform, match_id)`
- Index: `idx_pubg_player_matches_pagination` on `(player_id, platform, played_at DESC)`
- Default R2 Retention: 90 days (`CLEANUP_RETENTION_DAYS=90`)
- API Route: `GET /api/pubg/player/matches?nickname=...&platform=...&cursor=...`

---

### Task 1: Supabase Migration (`pubg_player_matches`)

**Files:**
- Create: `supabase/migrations/20260803100000_pubg_player_matches.sql`
- Test: `tests/player-matches-schema.test.ts`

**Interfaces:**
- Consumes: None
- Produces: `pubg_player_matches` DB table and `idx_pubg_player_matches_pagination` index

- [ ] **Step 1: Write the failing test for schema migration script**

```typescript
// tests/player-matches-schema.test.ts
import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import { join } from "path";

describe("pubg_player_matches Migration Schema", () => {
  it("should contain correct DDL for pubg_player_matches and index", () => {
    const migrationPath = join(process.cwd(), "supabase/migrations/20260803100000_pubg_player_matches.sql");
    const sql = readFileSync(migrationPath, "utf-8");
    expect(sql).toContain("CREATE TABLE IF NOT EXISTS pubg_player_matches");
    expect(sql).toContain("player_id VARCHAR(64) NOT NULL");
    expect(sql).toContain("PRIMARY KEY (player_id, platform, match_id)");
    expect(sql).toContain("CREATE INDEX IF NOT EXISTS idx_pubg_player_matches_pagination");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/player-matches-schema.test.ts`
Expected: FAIL (migration file does not exist yet)

- [ ] **Step 3: Write minimal migration SQL file**

```sql
-- supabase/migrations/20260803100000_pubg_player_matches.sql
CREATE TABLE IF NOT EXISTS pubg_player_matches (
  player_id VARCHAR(64) NOT NULL,
  platform VARCHAR(16) NOT NULL,
  match_id VARCHAR(64) NOT NULL,
  played_at TIMESTAMPTZ NOT NULL,
  game_mode VARCHAR(32) NOT NULL,
  map_name VARCHAR(32) NOT NULL,
  kills INT NOT NULL DEFAULT 0,
  damage INT NOT NULL DEFAULT 0,
  win_place INT NOT NULL DEFAULT 99,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (player_id, platform, match_id)
);

CREATE INDEX IF NOT EXISTS idx_pubg_player_matches_pagination
  ON pubg_player_matches(player_id, platform, played_at DESC);

ALTER TABLE pubg_player_matches ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Allow read pubg_player_matches" ON pubg_player_matches FOR SELECT USING (true);
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/player-matches-schema.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add supabase/migrations/20260803100000_pubg_player_matches.sql tests/player-matches-schema.test.ts
git commit -m "feat(db): add pubg_player_matches table migration"
```

---

### Task 2: Service Layer & DB Operations for Match Persistence & Cursor Query

**Files:**
- Create: `lib/pubg/playerMatches.ts`
- Test: `tests/player-matches.test.ts`

**Interfaces:**
- Consumes: Supabase Client, `pubg_player_matches` table
- Produces: `upsertPlayerMatches`, `fetchPlayerMatchesPaginated` helper functions

- [ ] **Step 1: Write the failing unit test**

```typescript
// tests/player-matches.test.ts
import { describe, it, expect, vi } from "vitest";
import { buildCursorQueryFilter, type PlayerMatchRecord } from "../lib/pubg/playerMatches";

describe("playerMatches helper", () => {
  it("builds cursor condition correctly when cursor is provided", () => {
    const filter = buildCursorQueryFilter("testuser", "steam", "2026-07-20T12:00:00Z");
    expect(filter.player_id).toBe("testuser");
    expect(filter.platform).toBe("steam");
    expect(filter.cursor).toBe("2026-07-20T12:00:00Z");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/player-matches.test.ts`
Expected: FAIL (file does not exist)

- [ ] **Step 3: Write minimal helper implementation**

```typescript
// lib/pubg/playerMatches.ts
import type { SupabaseClient } from "@supabase/supabase-js";
import { normalizeName } from "@/lib/pubg-analysis/utils";
import { normalizePlatform } from "@/lib/pubg-analysis/cacheIdentity";

export interface PlayerMatchRecord {
  player_id: string;
  platform: string;
  match_id: string;
  played_at: string;
  game_mode: string;
  map_name: string;
  kills: number;
  damage: number;
  win_place: number;
}

export function buildCursorQueryFilter(nickname: string, platform: string, cursor?: string | null) {
  return {
    player_id: normalizeName(nickname),
    platform: normalizePlatform(platform),
    cursor: cursor || null,
  };
}

export async function upsertPlayerMatches(
  supabase: SupabaseClient,
  records: PlayerMatchRecord[]
): Promise<void> {
  if (!records || records.length === 0) return;
  const { error } = await supabase
    .from("pubg_player_matches")
    .upsert(records, { onConflict: "player_id,platform,match_id" });
  if (error) {
    console.error("[playerMatches] upsert failed:", error.message);
  }
}

export async function fetchPlayerMatchesPaginated(
  supabase: SupabaseClient,
  nickname: string,
  platform: string,
  cursor?: string | null,
  limit = 20
): Promise<{ matches: PlayerMatchRecord[]; nextCursor: string | null }> {
  const playerId = normalizeName(nickname);
  const normPlatform = normalizePlatform(platform);

  let query = supabase
    .from("pubg_player_matches")
    .select("player_id, platform, match_id, played_at, game_mode, map_name, kills, damage, win_place")
    .eq("player_id", playerId)
    .eq("platform", normPlatform)
    .order("played_at", { ascending: false })
    .limit(limit);

  if (cursor) {
    query = query.lt("played_at", cursor);
  }

  const { data, error } = await query;
  if (error) {
    console.error("[playerMatches] fetch failed:", error.message);
    return { matches: [], nextCursor: null };
  }

  const matches = (data || []) as PlayerMatchRecord[];
  const nextCursor = matches.length >= limit ? matches[matches.length - 1].played_at : null;
  return { matches, nextCursor };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/player-matches.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add lib/pubg/playerMatches.ts tests/player-matches.test.ts
git commit -m "feat(pubg): implement playerMatches persistence and pagination helper"
```

---

### Task 3: Integration Ingestion Hook in `/api/pubg/player` & Match Persistence

**Files:**
- Modify: `lib/pubg-analysis/persistMatchAnalysis.ts`
- Modify: `app/api/pubg/player/route.ts`
- Test: `tests/player-match-ingestion.test.ts`

**Interfaces:**
- Consumes: `upsertPlayerMatches` from `lib/pubg/playerMatches.ts`
- Produces: Automatic upsert of match stats to `pubg_player_matches` during player search & match persistence

- [ ] **Step 1: Write failing integration test for match summary conversion**

```typescript
// tests/player-match-ingestion.test.ts
import { describe, it, expect } from "vitest";
import { buildPlayerMatchRecordFromParticipant } from "../lib/pubg/playerMatchesIngest";

describe("Player Match Ingestion Helper", () => {
  it("converts participant stats to PlayerMatchRecord format", () => {
    const record = buildPlayerMatchRecordFromParticipant({
      matchId: "match-123",
      nickname: "KangHeeSung",
      platform: "steam",
      createdAt: "2026-08-01T10:00:00Z",
      gameMode: "squad-fpp",
      mapName: "Erangel",
      kills: 5,
      damage: 450,
      winPlace: 1
    });
    expect(record.player_id).toBe("kangheesung");
    expect(record.match_id).toBe("match-123");
    expect(record.kills).toBe(5);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/player-match-ingestion.test.ts`
Expected: FAIL (`buildPlayerMatchRecordFromParticipant` not found)

- [ ] **Step 3: Implement `lib/pubg/playerMatchesIngest.ts` and integrate in `persistMatchAnalysis.ts`**

```typescript
// lib/pubg/playerMatchesIngest.ts
import { normalizeName } from "@/lib/pubg-analysis/utils";
import { normalizePlatform } from "@/lib/pubg-analysis/cacheIdentity";
import type { PlayerMatchRecord } from "./playerMatches";

export interface IngestParticipantInput {
  matchId: string;
  nickname: string;
  platform: string;
  createdAt: string;
  gameMode: string;
  mapName: string;
  kills: number;
  damage: number;
  winPlace: number;
}

export function buildPlayerMatchRecordFromParticipant(input: IngestParticipantInput): PlayerMatchRecord {
  return {
    player_id: normalizeName(input.nickname),
    platform: normalizePlatform(input.platform),
    match_id: input.matchId,
    played_at: input.createdAt,
    game_mode: input.gameMode,
    map_name: input.mapName,
    kills: input.kills,
    damage: Math.floor(input.damage),
    win_place: input.winPlace
  };
}
```

Update `lib/pubg-analysis/persistMatchAnalysis.ts` to call `upsertPlayerMatches` when persisting analysis.

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/player-match-ingestion.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add lib/pubg/playerMatchesIngest.ts lib/pubg-analysis/persistMatchAnalysis.ts tests/player-match-ingestion.test.ts
git commit -m "feat(pubg): hook pubg_player_matches ingestion into match analysis persistence"
```

---

### Task 4: New Cursor Pagination API Route (`/api/pubg/player/matches`)

**Files:**
- Create: `app/api/pubg/player/matches/route.ts`
- Test: `tests/player-matches-api.test.ts`

**Interfaces:**
- Consumes: `fetchPlayerMatchesPaginated` from `lib/pubg/playerMatches.ts`
- Produces: `GET /api/pubg/player/matches` route returning `{ matches, nextCursor }`

- [ ] **Step 1: Write failing API route test**

```typescript
// tests/player-matches-api.test.ts
import { describe, it, expect } from "vitest";

describe("GET /api/pubg/player/matches route validation", () => {
  it("requires nickname and platform parameters", async () => {
    const { GET } = await import("../app/api/pubg/player/matches/route");
    const req = new Request("http://localhost/api/pubg/player/matches");
    const res = await GET(req as any);
    expect(res.status).toBe(400);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/player-matches-api.test.ts`
Expected: FAIL (route module missing)

- [ ] **Step 3: Implement API Route (`app/api/pubg/player/matches/route.ts`)**

```typescript
// app/api/pubg/player/matches/route.ts
import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";
import { fetchPlayerMatchesPaginated } from "@/lib/pubg/playerMatches";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
);

export async function GET(request: NextRequest) {
  const { searchParams } = request.nextUrl;
  const nickname = searchParams.get("nickname");
  const platform = searchParams.get("platform") || "steam";
  const cursor = searchParams.get("cursor");

  if (!nickname) {
    return NextResponse.json({ error: "닉네임을 입력해주세요." }, { status: 400 });
  }

  try {
    const result = await fetchPlayerMatchesPaginated(supabase, nickname, platform, cursor, 20);
    return NextResponse.json(result);
  } catch (error: any) {
    return NextResponse.json({ error: error.message || "과거 매치 조회 실패" }, { status: 500 });
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/player-matches-api.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add app/api/pubg/player/matches/route.ts tests/player-matches-api.test.ts
git commit -m "feat(api): add GET /api/pubg/player/matches cursor pagination endpoint"
```

---

### Task 5: Frontend UI Update for Match History & Expiration Warning

**Files:**
- Modify: `components/stat/StatSearch.tsx`
- Modify: `components/stat/MatchCard.tsx`
- Test: `tests/stat-search-ui.test.ts`

**Interfaces:**
- Consumes: `/api/pubg/player/matches` API
- Produces: "Load More" pagination button & 90-day expired 3D replay tooltip indicator

- [ ] **Step 1: Write test checking 90-day expiry calculation helper**

```typescript
// tests/stat-search-ui.test.ts
import { describe, it, expect } from "vitest";
import { isMatchTelemetryExpired } from "../components/stat/matchExpiryHelper";

describe("Match Expiry Helper", () => {
  it("returns true when playedAt is older than 90 days", () => {
    const now = new Date("2026-08-03T00:00:00Z").getTime();
    const oldDate = "2026-04-01T00:00:00Z"; // >90 days ago
    expect(isMatchTelemetryExpired(oldDate, 90, now)).toBe(true);
  });

  it("returns false when playedAt is within 90 days", () => {
    const now = new Date("2026-08-03T00:00:00Z").getTime();
    const recentDate = "2026-07-15T00:00:00Z"; // ~19 days ago
    expect(isMatchTelemetryExpired(recentDate, 90, now)).toBe(false);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/stat-search-ui.test.ts`
Expected: FAIL (`isMatchTelemetryExpired` helper missing)

- [ ] **Step 3: Implement `matchExpiryHelper.ts` and connect UI components**

Create `components/stat/matchExpiryHelper.ts`:
```typescript
export function isMatchTelemetryExpired(
  playedAtIso: string,
  retentionDays = 90,
  nowMs = Date.now()
): boolean {
  if (!playedAtIso) return false;
  const playedMs = new Date(playedAtIso).getTime();
  if (!Number.isFinite(playedMs)) return false;
  const cutoffMs = nowMs - retentionDays * 24 * 60 * 60 * 1000;
  return playedMs < cutoffMs;
}
```

Add [Load More] button in `components/stat/StatSearch.tsx` to fetch next 20 items from `/api/pubg/player/matches`.
Update `components/stat/MatchCard.tsx` to show 90-day expiry badge if `isMatchTelemetryExpired(matchDate)` is true.

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/stat-search-ui.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add components/stat/matchExpiryHelper.ts components/stat/StatSearch.tsx components/stat/MatchCard.tsx tests/stat-search-ui.test.ts
git commit -m "feat(ui): add pagination load more and 90-day telemetry expiry indicator"
```

---

### Task 6: Verification of R2 Cleanup with 90-Day Retention

**Files:**
- Modify: `scripts/cleanup_telemetry.ts`
- Test: `tests/cleanup-telemetry-retention.test.ts`

**Interfaces:**
- Consumes: `CLEANUP_RETENTION_DAYS` environment variable
- Produces: Verified 90-day retention cleanup behavior

- [ ] **Step 1: Write test for cleanup retention default parameter**

```typescript
// tests/cleanup-telemetry-retention.test.ts
import { describe, it, expect } from "vitest";
import { getTelemetryRetentionDays } from "../scripts/cleanup_telemetry";

describe("Telemetry Cleanup Retention Config", () => {
  it("defaults retention days to 90 if env is unset", () => {
    const retentionDays = getTelemetryRetentionDays({});
    expect(retentionDays).toBe(90);
  });

  it("uses process.env value when CLEANUP_RETENTION_DAYS is provided", () => {
    const retentionDays = getTelemetryRetentionDays({ CLEANUP_RETENTION_DAYS: "60" });
    expect(retentionDays).toBe(60);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/cleanup-telemetry-retention.test.ts`
Expected: FAIL (`getTelemetryRetentionDays` function missing)

- [ ] **Step 3: Export `getTelemetryRetentionDays` helper in `scripts/cleanup_telemetry.ts`**

```typescript
export function getTelemetryRetentionDays(env: Record<string, string | undefined> = process.env): number {
  const raw = env.CLEANUP_RETENTION_DAYS?.trim();
  if (!raw) return 90;
  const val = Number(raw);
  return Number.isInteger(val) && val > 0 ? val : 90;
}
```

Update `runTelemetryCleanupFromEnvironment` to use `getTelemetryRetentionDays()`.

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/cleanup-telemetry-retention.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add scripts/cleanup_telemetry.ts tests/cleanup-telemetry-retention.test.ts
git commit -m "feat(cleanup): update telemetry retention default to 90 days"
```
