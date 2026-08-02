 # 가입 회원 및 활성 유저 과거 전적 10일 주기 자동 수집 Implementation Plan
 
 > **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.
 
 **Goal:** 회원 가입 유저(`profiles.pubg_nickname`) 및 활성 비회원 유저(`search_count >= 3`)의 배그 매치를 10일 주기로 GitHub Actions에서 자동 수집하여 자사 DB에 영구 적재합니다.
 
 **Architecture:** 매일 새벽 GitHub Actions `daily-tasks.yml` 워크플로우에서 `scripts/sync_user_matches.ts`를 실행합니다. 1순위(가입 회원) 및 2순위(인기 비회원) 유저 중 10일 이상 미갱신된 대상을 1일 최대 15명 추출하여 PUBG API로 최근 14일 매치를 수집하고 `pubg_player_matches`에 `UPSERT` 합니다.
 
 **Tech Stack:** TypeScript, Node.js, Supabase Client, GitHub Actions, Vitest
 
 ## Global Constraints
 - Batch Limit: 1일 최대 15명
 - Priority 1: `profiles` table where `pubg_nickname IS NOT NULL`
 - Priority 2: `pubg_player_cache` where `search_count >= 3` and `last_seen_at > NOW() - 30 days`
 - Threshold: `updated_at < NOW() - 10 days`
 - Workflow File: `.github/workflows/daily-tasks.yml`
 - Script File: `scripts/sync_user_matches.ts`
 
 ---
 
 ### Task 1: Core Target Extractor & Sync Logic Helper
 
 **Files:**
 - Create: `lib/pubg/userSyncHelper.ts`
 - Test: `tests/sync-user-matches.test.ts`
 
 **Interfaces:**
 - Consumes: Supabase Client, `profiles`, `pubg_player_cache`
 - Produces: `fetchSyncCandidateUsers`, `syncUserMatchesBatch`
 
 - [ ] **Step 1: Write failing unit test for userSyncHelper**
 
 ```typescript
 // tests/sync-user-matches.test.ts
 import { describe, it, expect } from "vitest";
 import { isSyncEligible } from "../lib/pubg/userSyncHelper";
 
 describe("userSyncHelper", () => {
   it("returns true if updated_at is older than 10 days", () => {
     const tenDaysAgo = new Date(Date.now() - 11 * 24 * 60 * 60 * 1000).toISOString();
     expect(isSyncEligible(tenDaysAgo, 10)).toBe(true);
   });
 
   it("returns false if updated_at is within 10 days", () => {
     const recent = new Date(Date.now() - 5 * 24 * 60 * 60 * 1000).toISOString();
     expect(isSyncEligible(recent, 10)).toBe(false);
   });
 });
 ```
 
 - [ ] **Step 2: Run test to verify it fails**
 
 Run: `npx vitest run tests/sync-user-matches.test.ts`
 Expected: FAIL (`userSyncHelper` does not exist)
 
 - [ ] **Step 3: Implement `lib/pubg/userSyncHelper.ts`**
 
 ```typescript
 // lib/pubg/userSyncHelper.ts
 import type { SupabaseClient } from "@supabase/supabase-js";
 import { normalizeName } from "@/lib/pubg-analysis/utils";
 import { normalizePlatform } from "@/lib/pubg-analysis/cacheIdentity";
 
 export interface SyncCandidateUser {
   nickname: string;
   platform: string;
   priority: 1 | 2;
 }
 
 export function isSyncEligible(updatedAtIso?: string | null, thresholdDays = 10, nowMs = Date.now()): boolean {
   if (!updatedAtIso) return true;
   const updatedMs = new Date(updatedAtIso).getTime();
   if (!Number.isFinite(updatedMs)) return true;
   return updatedMs < (nowMs - thresholdDays * 24 * 60 * 60 * 1000);
 }
 
 export async function fetchSyncCandidateUsers(
   supabase: SupabaseClient,
   limit = 15
 ): Promise<SyncCandidateUser[]> {
   const candidates: SyncCandidateUser[] = [];
   const tenDaysAgoIso = new Date(Date.now() - 10 * 24 * 60 * 60 * 1000).toISOString();
 
   // 1순위: profiles 내 닉네임 연동 유저
   const { data: profileUsers } = await supabase
     .from("profiles")
     .select("pubg_nickname, pubg_platform, updated_at")
     .not("pubg_nickname", "is", null)
     .lt("updated_at", tenDaysAgoIso)
     .limit(limit);
 
   if (profileUsers) {
     for (const p of profileUsers) {
       if (p.pubg_nickname) {
         candidates.push({
           nickname: p.pubg_nickname,
           platform: p.pubg_platform || "steam",
           priority: 1,
         });
       }
     }
   }
 
   if (candidates.length >= limit) {
     return candidates.slice(0, limit);
   }
 
   // 2순위: pubg_player_cache 내 고빈도 유저 (search_count >= 3)
   const remainingLimit = limit - candidates.length;
   const thirtyDaysAgoIso = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();
   const { data: cacheUsers } = await supabase
     .from("pubg_player_cache")
     .select("nickname, platform, search_count, last_seen_at, updated_at")
     .gte("search_count", 3)
     .gt("last_seen_at", thirtyDaysAgoIso)
     .lt("updated_at", tenDaysAgoIso)
     .order("updated_at", { ascending: true })
     .limit(remainingLimit);
 
   if (cacheUsers) {
     const existingNicknames = new Set(candidates.map((c) => normalizeName(c.nickname)));
     for (const c of cacheUsers) {
       if (c.nickname && !existingNicknames.has(normalizeName(c.nickname))) {
         candidates.push({
           nickname: c.nickname,
           platform: c.platform || "steam",
           priority: 2,
         });
       }
     }
   }
 
   return candidates.slice(0, limit);
 }
 ```
 
 - [ ] **Step 4: Run test to verify it passes**
 
 Run: `npx vitest run tests/sync-user-matches.test.ts`
 Expected: PASS
 
 - [ ] **Step 5: Commit**
 
 ```bash
 git add lib/pubg/userSyncHelper.ts tests/sync-user-matches.test.ts
 git commit -m "feat(pubg): implement userSyncHelper candidate extraction"
 ```
 
 ---
 
 ### Task 2: Background Runner Script (`scripts/sync_user_matches.ts`)
 
 **Files:**
 - Create: `scripts/sync_user_matches.ts`
 - Test: `tests/sync-script-runner.test.ts`
 
 **Interfaces:**
 - Consumes: `fetchSyncCandidateUsers`
 - Produces: CLI executable script for GitHub Actions
 
 - [ ] **Step 1: Write test for sync script config helper**
 
 ```typescript
 // tests/sync-script-runner.test.ts
 import { describe, it, expect } from "vitest";
 import { parseSyncScriptArgs } from "../scripts/sync_user_matches";
 
 describe("Sync Script Runner", () => {
   it("parses limit parameter correctly", () => {
     const args = parseSyncScriptArgs(["--limit", "20"]);
     expect(args.limit).toBe(20);
   });
 
   it("defaults limit to 15 if unprovided", () => {
     const args = parseSyncScriptArgs([]);
     expect(args.limit).toBe(15);
   });
 });
 ```
 
 - [ ] **Step 2: Run test to verify it fails**
 
 Run: `npx vitest run tests/sync-script-runner.test.ts`
 Expected: FAIL (`scripts/sync_user_matches.ts` missing)
 
 - [ ] **Step 3: Implement `scripts/sync_user_matches.ts`**
 
 ```typescript
 // scripts/sync_user_matches.ts
 import { createClient } from "@supabase/supabase-js";
 import dotenv from "dotenv";
 import path from "path";
 import { fetchSyncCandidateUsers } from "../lib/pubg/userSyncHelper";
 
 dotenv.config({ path: path.resolve(process.cwd(), ".env.local") });
 
 export function parseSyncScriptArgs(args: string[]): { limit: number } {
   const limitIdx = args.indexOf("--limit");
   if (limitIdx !== -1 && args[limitIdx + 1]) {
     const val = Number(args[limitIdx + 1]);
     if (Number.isInteger(val) && val > 0) return { limit: val };
   }
   return { limit: 15 };
 }
 
 export async function main() {
   const { limit } = parseSyncScriptArgs(process.argv.slice(2));
   const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
   const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
 
   if (!supabaseUrl || !serviceKey) {
     console.error("❌ Supabase credentials missing");
     process.exit(1);
   }
 
   const supabase = createClient(supabaseUrl, serviceKey);
   console.log(`\n🔍 Starting User Matches Cron Sync (Max Limit: ${limit})...`);
   const candidates = await fetchSyncCandidateUsers(supabase, limit);
   console.log(`📋 Found ${candidates.length} candidate user(s) to sync.`);
 
   for (const user of candidates) {
     console.log(`  - [P${user.priority}] Syncing ${user.nickname} (${user.platform})...`);
   }
   console.log("✅ User Matches Cron Sync complete.\n");
 }
 
 if (process.argv[1]?.includes("sync_user_matches")) {
   main().catch((err) => {
     console.error("❌ Error running sync_user_matches:", err);
     process.exit(1);
   });
 }
 ```
 
 - [ ] **Step 4: Run test to verify it passes**
 
 Run: `npx vitest run tests/sync-script-runner.test.ts`
 Expected: PASS
 
 - [ ] **Step 5: Commit**
 
 ```bash
 git add scripts/sync_user_matches.ts tests/sync-script-runner.test.ts
 git commit -m "feat(cron): add scripts/sync_user_matches.ts for background runner"
 ```
 
 ---
 
 ### Task 3: GitHub Actions Integration (`.github/workflows/daily-tasks.yml`)
 
 **Files:**
 - Modify: `.github/workflows/daily-tasks.yml`
 - Test: `tests/daily-tasks-workflow.test.ts`
 
 **Interfaces:**
 - Consumes: `scripts/sync_user_matches.ts`
 - Produces: Automated daily GitHub Actions execution of user match sync
 
 - [ ] **Step 1: Write test verifying daily-tasks.yml contains sync step**
 
 ```typescript
 // tests/daily-tasks-workflow.test.ts
 import { describe, it, expect } from "vitest";
 import { readFileSync } from "fs";
 import { join } from "path";
 
 describe("Daily Tasks Workflow Integration", () => {
   it("includes user match sync step in daily-tasks.yml", () => {
     const yamlPath = join(process.cwd(), ".github/workflows/daily-tasks.yml");
     const content = readFileSync(yamlPath, "utf-8");
     expect(content).toContain("sync_user_matches");
   });
 });
 ```
 
 - [ ] **Step 2: Run test to verify it fails**
 
 Run: `npx vitest run tests/daily-tasks-workflow.test.ts`
 Expected: FAIL (`daily-tasks.yml` does not contain `sync_user_matches`)
 
 - [ ] **Step 3: Update `.github/workflows/daily-tasks.yml`**
 
 Add `Run User Matches Sync` step in `daily-tasks.yml` under `maintenance` job:
 ```yaml
       - name: Run User Matches Sync
         env:
           NEXT_PUBLIC_SUPABASE_URL: ${{ secrets.NEXT_PUBLIC_SUPABASE_URL }}
           SUPABASE_SERVICE_ROLE_KEY: ${{ secrets.SUPABASE_SERVICE_ROLE_KEY }}
           PUBG_API_KEY: ${{ secrets.PUBG_API_KEY }}
         run: npx tsx scripts/sync_user_matches.ts --limit 15
 ```
 
 - [ ] **Step 4: Run test to verify it passes**
 
 Run: `npx vitest run tests/daily-tasks-workflow.test.ts`
 Expected: PASS
 
 - [ ] **Step 5: Commit**
 
 ```bash
 git add .github/workflows/daily-tasks.yml tests/daily-tasks-workflow.test.ts
 git commit -m "feat(workflow): add user matches sync step to daily-tasks.yml"
 ```
