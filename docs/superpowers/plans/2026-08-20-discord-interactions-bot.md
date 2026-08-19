# Discord Interactions Bot Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Vercel Next.js 환경에서 24시간 0원 비용으로 구동되는 Discord Interactions 전적 봇(/연동, /전적, /방금판) 및 웹사이트 유입 퍼널을 구축합니다.

**Architecture:** Discord Gateway의 HTTP 슬래시 커맨드 웹훅을 Next.js API(`/api/discord/interactions`)에서 ed25519 서명 검증 후 처리합니다. 디스코드 내에서는 LLM API를 호출하지 않고 DB 캐시와 AnalysisEngine 산출 지표를 0.3초 내 초고속으로 Embed 카드와 링크 버튼으로 반환합니다.

**Tech Stack:** Next.js App Router, Supabase PostgreSQL, `tweetnacl` (ed25519 서명 검증), TypeScript, Vitest

**Spec:** `docs/superpowers/specs/2026-08-20-discord-bot-design.md`

## Global Constraints

- 이모티콘 사용 금지: 커밋 메시지 및 PR 제목/본문에 이모티콘을 사용하지 않습니다.
- 비용 방어 원칙: 디스코드 응답 시 Gemini LLM을 직접 호출하지 않고 캐시/통계 데이터만 반환합니다.
- Vercel 서버리스 호환: 3초 타임아웃 방지를 위해 비동기 쿼리는 최적화된 DB 인덱스를 활용합니다.
- TDD 적용: 모든 기능은 테스트 작성 후 최소 구현으로 통과시킵니다.

---

### Task 1: Discord 유저 연동 DB 스키마 및 저장소 구현

**Files:**
- Create: `supabase/migrations/20260820120000_discord_user_links.sql`
- Create: `lib/discord/userLinkStore.ts`
- Create: `tests/discord-user-links.test.ts`

**Interfaces:**
- Produces:
  ```ts
  export interface DiscordUserLink {
    discord_user_id: string;
    pubg_nickname: string;
    pubg_platform: string;
    created_at: string;
    updated_at: string;
  }
  export function getDiscordUserLink(discordUserId: string, client?: any): Promise<DiscordUserLink | null>;
  export function setDiscordUserLink(discordUserId: string, pubgNickname: string, pubgPlatform?: string, client?: any): Promise<DiscordUserLink>;
  ```

- [ ] **Step 1: Write the failing test for userLinkStore**
- [ ] **Step 2: Run test to verify it fails**
- [ ] **Step 3: Write migration and minimal userLinkStore implementation**
- [ ] **Step 4: Run test to verify it passes**
- [ ] **Step 5: Commit**

---

### Task 2: Discord Interaction ed25519 서명 검증 유틸리티

**Files:**
- Create: `lib/discord/verify.ts`
- Create: `tests/discord-verify.test.ts`

**Interfaces:**
- Produces:
  ```ts
  export function verifyDiscordSignature(params: {
    rawBody: string;
    signature: string | null;
    timestamp: string | null;
    publicKey: string;
  }): boolean;
  ```

- [ ] **Step 1: Install `tweetnacl` and write failing test for verifyDiscordSignature**
- [ ] **Step 2: Run test to verify it fails**
- [ ] **Step 3: Implement verifyDiscordSignature with tweetnacl**
- [ ] **Step 4: Run test to verify it passes**
- [ ] **Step 5: Commit**

---

### Task 3: 닉네임 3단계 Resolver 및 Discord Embed / 버튼 빌더

**Files:**
- Create: `lib/discord/userResolver.ts`
- Create: `lib/discord/embeds.ts`
- Create: `tests/discord-embeds.test.ts`
- Create: `tests/discord-user-resolver.test.ts`

**Interfaces:**
- Produces:
  ```ts
  export function resolvePlayerNickname(params: {
    explicitNickname?: string | null;
    explicitPlatform?: string | null;
    discordUserId: string;
    guildNickname?: string | null;
    discordUsername?: string | null;
    linkStore?: typeof getDiscordUserLink;
  }): Promise<{ nickname: string; platform: string; source: "explicit" | "link" | "guild_nickname" } | null>;

  export function buildStatsEmbed(data: any, appUrl: string): { embeds: any[]; components: any[] };
  export function buildRecentMatchEmbed(data: any, appUrl: string): { embeds: any[]; components: any[] };
  ```

- [ ] **Step 1: Write failing tests for userResolver and embeds**
- [ ] **Step 2: Run tests to verify they fail**
- [ ] **Step 3: Implement userResolver and embeds builder**
- [ ] **Step 4: Run tests to verify they pass**
- [ ] **Step 5: Commit**

---

### Task 4: Discord Interaction API 라우트 및 커맨드 핸들러 통합

**Files:**
- Create: `lib/discord/commands/link.ts`
- Create: `lib/discord/commands/stats.ts`
- Create: `lib/discord/commands/recentMatch.ts`
- Create: `app/api/discord/interactions/route.ts`
- Create: `tests/discord-interactions-route.test.ts`

**Interfaces:**
- Produces: `POST /api/discord/interactions` endpoint handling PING (type 1), APPLICATION_COMMAND (type 2) for `/연동`, `/전적`, `/방금판`.

- [ ] **Step 1: Write failing integration test for interactions route**
- [ ] **Step 2: Run test to verify it fails**
- [ ] **Step 3: Implement command handlers and interaction route**
- [ ] **Step 4: Run test to verify it passes**
- [ ] **Step 5: Commit**

---

### Task 5: 슬래시 커맨드 등록 CLI 스크립트 및 통합 검증

**Files:**
- Create: `scripts/register_discord_commands.ts`
- Test: Full unit test suite, core verify, build

- [ ] **Step 1: Implement register_discord_commands.ts script**
- [ ] **Step 2: Run full test suite and verify:core**
- [ ] **Step 3: Run production build check**
- [ ] **Step 4: Commit**

