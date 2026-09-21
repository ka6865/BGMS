# BGMS Customer Center Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** BGMS에 공개 FAQ, 로그인 사용자 전용 1:1 문의, 스크린샷 기반 전적 비공개 요청 검증, 관리자 처리함을 추가한다.

**Architecture:** 공개 게시판과 분리된 `support_*` Supabase 도메인을 만들고, 모든 문의·답변·첨부 변경을 서버 Route Handler가 인증 후 수행한다. 전적 비공개 증빙은 private Storage 버킷과 5분 signed URL로 제공하며, 검증 완료된 문의만 기존 `addPrivatePlayer` 흐름을 호출한다. 기존 알림 테이블에는 nullable `support_ticket_id`를 추가해 이메일 없이 앱 알림으로 답변을 전달한다.

**Tech Stack:** Next.js 16.3 App Router, React 19, TypeScript, Supabase Auth/SSR/Storage/Postgres, Vitest, Testing Library, Tailwind CSS 4, lucide-react.

**Spec:** `docs/superpowers/specs/2026-09-21-support-center-design.md`

## Global Constraints

- 1:1 문의는 로그인 사용자만 작성하고 비로그인 사용자는 FAQ만 조회한다.
- `privacy` 문의는 플랫폼·닉네임·서버가 확정한 `account_id`·ready 상태 스크린샷 없이는 제출하지 못한다.
- 스크린샷은 공개 `board-images-v2`를 사용하지 않고 private `support-evidence` 버킷에 저장한다.
- 문의/검증 상태는 각각 `new|in_progress|awaiting_user|answered|resolved|rejected`와 `not_required|pending|verified|additional_info|rejected`를 사용한다.
- 제목은 120자, 본문은 5,000자, 첨부는 문의당 3개·파일당 3 MiB·전체 9 MiB로 제한한다.
- 허용 첨부 MIME은 `image/png`, `image/jpeg`, `image/webp`뿐이다.
- 동일 `(requester_id, target_platform, target_account_id)`에 처리 중인 privacy 문의는 하나만 허용한다.
- 해결/반려 문의의 증빙은 종료 30일 후 삭제하고, 미종료 문의 증빙은 처리될 때까지 보관한다.
- PUBG API 키와 원본 API 응답은 브라우저·문의 본문·로그에 노출하지 않는다.
- 외부 티켓 SaaS, 이메일 발송, PUBG 계정 OAuth, 비로그인 1:1 문의는 구현하지 않는다.

## Review Focus

- **Cross-user privacy leak:** 사용자가 다른 사용자의 ticket ID를 알아도 404와 signed URL 거부가 반환되어야 한다. Task 4의 사용자 API 테스트와 Task 3의 첨부 테스트에서 고정한다.
- **Unverified privacy request:** 서버에서 account ID를 다시 확정하거나 ready 스크린샷을 확인하지 않은 요청은 저장되지 않아야 한다. Task 2·4의 실패 테스트에서 고정한다.
- **Duplicate privacy action:** 관리자 재시도와 이미 등록된 플레이어가 중복 목록·중복 이벤트를 만들지 않아야 한다. Task 5의 idempotency 테스트에서 고정한다.
- **Private storage retention:** public 버킷 접근은 없어야 하고, pending/만료 첨부와 종료 30일 첨부가 삭제되어야 한다. Task 3·8의 storage/cleanup 테스트에서 고정한다.
- **Notification compatibility:** `support_reply` 알림이 기존 댓글 알림을 깨뜨리지 않고 정확히 `/support/[ticketId]`로 이동해야 한다. Task 7의 헤더 테스트에서 고정한다.

---

### Task 1: Support domain contracts and database migration

**Files:**
- Create: `supabase/migrations/20260921100000_support_center.sql`
- Create: `lib/support/contracts.ts`
- Create: `lib/support/validation.ts`
- Test: `tests/support-center-contracts.test.ts`
- Test: `tests/support-center-migration.test.ts`

**Interfaces:**
- Produces `SupportCategory`, `SupportTicketStatus`, `SupportVerificationStatus`, `SupportAttachmentStatus` and `SUPPORT_LIMITS` from `lib/support/contracts.ts`.
- Produces `parseSupportCreateTicketInput(value: unknown): ParseResult<CreateSupportTicketInput>`, `parseSupportMessageInput(value: unknown): ParseResult<{ body: string }>`, `validateSupportAttachmentMeta(input): ParseResult<SupportAttachmentMeta>`, and `canTransitionSupportTicket(from, to): boolean` from `lib/support/validation.ts`.
- Produces an injected `SupportDb` type from `lib/support/contracts.ts` for server services so player lookup, storage, and ticket-store tests never depend on a live Supabase client.
- Migration creates `support_faqs`, `support_tickets`, `support_messages`, `support_attachments`, `support_ticket_events`, private `support-evidence`, and nullable `notifications.support_ticket_id`.
- Migration also creates a service-role-only `create_support_ticket` RPC so the ticket, first message, and `created` event commit in one transaction.

- [ ] **Step 1: Write failing contract tests**

```ts
import { describe, expect, it } from "vitest";
import {
  SUPPORT_LIMITS,
  canTransitionSupportTicket,
  parseSupportCreateTicketInput,
  validateSupportAttachmentMeta,
} from "@/lib/support/validation";

describe("support contracts", () => {
  it("requires account target and attachment IDs for privacy input", () => {
    expect(parseSupportCreateTicketInput({
      category: "privacy", subject: "비공개", body: "요청",
      platform: "steam", nickname: "player", attachmentIds: [],
    })).toEqual({ ok: false, code: "privacy_evidence_required" });
  });

  it("accepts a bounded general ticket without privacy verification", () => {
    const result = parseSupportCreateTicketInput({
      category: "account", subject: "로그인 문의", body: "확인 부탁드립니다.",
    });
    expect(result.ok).toBe(true);
  });

  it("rejects executable or oversized attachments", () => {
    expect(validateSupportAttachmentMeta({ mimeType: "image/svg+xml", byteSize: 100 })).toEqual(
      { ok: false, code: "unsupported_mime" },
    );
    expect(validateSupportAttachmentMeta({ mimeType: "image/png", byteSize: SUPPORT_LIMITS.attachmentBytes + 1 })).toEqual(
      { ok: false, code: "attachment_too_large" },
    );
  });

  it("allows only explicit status transitions", () => {
    expect(canTransitionSupportTicket("new", "in_progress")).toBe(true);
    expect(canTransitionSupportTicket("new", "resolved")).toBe(false);
    expect(canTransitionSupportTicket("resolved", "in_progress")).toBe(true);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm exec vitest run tests/support-center-contracts.test.ts`

Expected: FAIL because the support contract modules do not exist.

- [ ] **Step 3: Implement the constants and parsers**

Use literal unions rather than free-form strings:

```ts
export const SUPPORT_LIMITS = {
  subjectChars: 120,
  bodyChars: 5_000,
  maxAttachments: 3,
  attachmentBytes: 3 * 1024 * 1024,
  totalAttachmentBytes: 9 * 1024 * 1024,
  dailyTicketCount: 5,
} as const;

export type SupportCategory = "privacy" | "account" | "community" | "bug" | "other";
export type SupportTicketStatus = "new" | "in_progress" | "awaiting_user" | "answered" | "resolved" | "rejected";
export type SupportVerificationStatus = "not_required" | "pending" | "verified" | "additional_info" | "rejected";
export type SupportAttachmentStatus = "pending" | "ready" | "deleted";
```

`parseSupportCreateTicketInput` trims strings, enforces the limits, permits `steam|kakao` only for `privacy`, and requires a non-empty `attachmentIds` array for privacy. `validateSupportAttachmentMeta` checks only the declared MIME and byte size; the storage completion step will perform the authoritative object check.

- [ ] **Step 4: Write migration assertions before the SQL**

```ts
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const migration = readFileSync(
  new URL("../supabase/migrations/20260921100000_support_center.sql", import.meta.url),
  "utf8",
);

it("creates private support tables and refuses public storage reads", () => {
  expect(migration).toMatch(/create table public\.support_tickets/i);
  expect(migration).toMatch(/create table public\.support_messages/i);
  expect(migration).toMatch(/insert into storage\.buckets[\s\S]*support-evidence[\s\S]*false/i);
  expect(migration).toMatch(/support_ticket_id uuid/i);
  expect(migration).toMatch(/alter table public\.support_attachments enable row level security/i);
  expect(migration).not.toMatch(/support-evidence[\s\S]*public.*true/i);
});
```

- [ ] **Step 5: Add the migration**

Create the five support tables and checks from the spec, then add these exact constraints and indexes:

```sql
create unique index support_tickets_open_privacy_identity_idx
  on public.support_tickets(requester_id, target_platform, target_account_id)
  where category = 'privacy' and status not in ('resolved', 'rejected');

create unique index support_ticket_privacy_action_once_idx
  on public.support_ticket_events(ticket_id)
  where event_type in ('privacy_player_registered', 'privacy_player_already_registered');

insert into storage.buckets (id, name, public)
values ('support-evidence', 'support-evidence', false)
on conflict (id) do update set public = false;

alter table public.notifications
  add column if not exists support_ticket_id uuid references public.support_tickets(id) on delete cascade;
```

Make `support_attachments.ticket_id` nullable, require `uploader_id` for newly reserved rows, and use `attachments/<attachmentId>` as the storage key so a file can be uploaded before a ticket exists. Enable RLS on every support table. Allow public/authenticated SELECT only for published FAQ rows; allow ticket/message/linked-attachment SELECT for the requester or an admin, and allow unlinked pending/ready attachment SELECT only for its uploader or an admin; allow event SELECT for admins only; revoke direct writes from `anon` and `authenticated` so Route Handlers use the service role after auth checks. Add the FAQ seed rows from the spec as published plain-text rows.

Define `create_support_ticket(p_requester_id uuid, p_category text, p_subject text, p_body text, p_verification_status text, p_target_platform text, p_target_nickname text, p_target_account_id text, p_target_resolved_nickname text, p_attachment_ids uuid[]) returns uuid` as a `security definer` function with a fixed `search_path`, revoked from public/anon/authenticated, and granted only to service role. The function inserts the ticket, first message, ready attachment links, and `created` event, and raises a stable `support_ticket_duplicate` exception on the partial unique index.

The RPC must lock and validate every supplied attachment as `status = 'ready'`, `ticket_id is null`, and `uploader_id = p_requester_id`; it sets both `ticket_id` and `message_id` to the newly inserted rows. It rejects missing, duplicate, or already-linked attachment IDs before committing.

- [ ] **Step 6: Run contract and migration tests**

Run: `npm exec vitest run tests/support-center-contracts.test.ts tests/support-center-migration.test.ts`

Expected: PASS.

- [ ] **Step 7: Commit the domain foundation**

```bash
git add supabase/migrations/20260921100000_support_center.sql lib/support/contracts.ts lib/support/validation.ts tests/support-center-contracts.test.ts tests/support-center-migration.test.ts
git commit -m "feat: 고객센터 데이터 모델과 계약 추가"
```

### Task 2: Server stores and PUBG player target resolution

**Files:**
- Create: `lib/support/playerTarget.server.ts`
- Create: `lib/support/ticketStore.server.ts`
- Test: `tests/support-player-target.test.ts`
- Test: `tests/support-ticket-store.test.ts`

**Interfaces:**
- `resolveSupportPlayerTarget(input: { platform: "steam" | "kakao"; nickname: string; supabaseAdmin: SupportDb; signal?: AbortSignal }): Promise<ResolvedSupportPlayer>` returns `{ platform, requestedNickname, canonicalNickname, accountId }` or throws typed `SupportPlayerLookupError` with `code` `not_found|rate_limited|unavailable`.
- `createSupportTicket(db, input): Promise<SupportTicketRow>` calls the service-role `create_support_ticket` RPC so the ticket, first message, attachment links, and `created` event commit together after the caller has validated the user and unlinked ready attachments.
- `getSupportTicketForActor(db, ticketId, actor): Promise<SupportTicketDetail | null>` returns null for non-owner/non-admin access.
- `listSupportTicketsForUser(db, userId): Promise<SupportTicketSummary[]>` and `listSupportTicketsForAdmin(db, filters): Promise<SupportTicketSummary[]>` provide the user and admin inbox queries.
- `appendSupportMessage(db, input): Promise<SupportMessageRow>` updates `last_message_*`, status reopening rules, and the corresponding read timestamp.

- [ ] **Step 1: Write player resolution tests**

Mock the injected Supabase query and `createPlayerApiClient`. Pin these cases: cache hit returns the cached immutable account ID; upstream payload with a different player name throws `not_found`; unsupported platform fails before a network call; `PlayerApiError` 429 maps to `rate_limited` and other failures map to `unavailable`.

- [ ] **Step 2: Implement `resolveSupportPlayerTarget`**

Read `pubg_player_cache` by `(platform, lower_nickname)` first. On a miss, call `createPlayerApiClient` with the server-only `PUBG_API_KEY`, request `https://api.pubg.com/shards/${platform}/players?filter[playerNames]=...`, validate with `isPlayerPayload`, and select the row whose attributes name matches the requested nickname case-insensitively. Accept only `/^account\.[A-Za-z0-9_-]+$/`; never return the raw payload. Do not call the public `/api/pubg/player` route because it includes stats side effects and privacy response semantics.

- [ ] **Step 3: Write store tests**

Use a chainable fake Supabase client. Assert that `createSupportTicket` inserts the ticket, first message, and event with the authenticated user ID; `getSupportTicketForActor` returns null for another user; `appendSupportMessage` changes `awaiting_user` to `in_progress` for a user message and updates `last_message_sender`.

- [ ] **Step 4: Implement the ticket store**

Keep all database access in `ticketStore.server.ts`. Use service-role queries, select only the fields needed by the caller, and derive unread as `last_message_sender === "admin" && last_message_at > user_last_read_at` for users (the admin equivalent uses `admin_last_read_at`). When loading a detail, update the viewer’s read timestamp after the access check. Never include `storage_key` in a user-facing response. `createSupportTicket` passes the ready, unlinked attachment IDs to the RPC; it must not insert a ticket first and attach files in a second transaction.

- [ ] **Step 5: Run store tests and commit**

Run: `npm exec vitest run tests/support-player-target.test.ts tests/support-ticket-store.test.ts`

Expected: PASS.

```bash
git add lib/support/playerTarget.server.ts lib/support/ticketStore.server.ts tests/support-player-target.test.ts tests/support-ticket-store.test.ts
git commit -m "feat: 고객센터 저장소와 PUBG 대상 확인 추가"
```

### Task 3: Private support attachment lifecycle

**Files:**
- Create: `lib/support/attachmentStorage.server.ts`
- Create: `app/api/support/attachments/reserve/route.ts`
- Create: `app/api/support/attachments/complete/route.ts`
- Create: `app/api/support/attachments/[id]/url/route.ts`
- Test: `tests/support-attachments.test.ts`

**Interfaces:**
- `reserveSupportAttachment(input): Promise<{ attachmentId: string; bucketId: string; storageKey: string; token: string }>` verifies the authenticated uploader, MIME, and limits before creating a pending row with `ticket_id = null` and a signed upload URL.
- `completeSupportAttachment(input): Promise<{ attachmentId: string; status: "ready" }>` verifies the object exists, then marks the row ready.
- `getSupportAttachmentSignedUrl(input): Promise<string>` verifies requester/admin access and returns a five-minute signed URL.
- `cleanupExpiredSupportAttachments(db, now): Promise<{ deleted: number; deferred: number }>` removes expired pending/terminal objects and marks rows deleted.

- [ ] **Step 1: Write lifecycle tests**

Cover: unauthenticated reserve returns 401 through the route; an attachment is initially unlinked and cannot be completed by another user; SVG, 3 MiB + 1 byte, fourth attachment, and 9 MiB total are rejected at submission; completion of a missing storage object does not mark ready; owner/admin receives a signed URL for a linked ticket (uploader receives one for an unlinked row); another user receives 404; cleanup removes expired objects and leaves unresolved ready evidence intact.

- [ ] **Step 2: Implement storage service**

Use the private `support-evidence` bucket and key format `attachments/${attachmentId}`. Reuse `isUuid`/mime checks from `lib/board/imageStorageContract` only as pure helpers; do not reuse the public board bucket. Store original filename only after stripping path separators and control characters. Generate signed upload URLs with `upsert: false` and signed read URLs with `{ expiresIn: 300 }`.

- [ ] **Step 3: Implement routes with `withAuthGuard`**

`reserve` parses `{ mimeType, byteSize, originalName }` and creates an unlinked row owned by the authenticated user; `complete` parses `{ attachmentId }`; `url` takes the UUID route parameter. Each route returns fixed error messages and status codes from the spec, never Supabase storage errors or bucket keys.

- [ ] **Step 4: Run attachment tests and commit**

Run: `npm exec vitest run tests/support-attachments.test.ts`

Expected: PASS.

```bash
git add lib/support/attachmentStorage.server.ts app/api/support/attachments tests/support-attachments.test.ts
git commit -m "feat: 고객센터 비공개 증빙 저장 수명주기 추가"
```

### Task 4: User support APIs

**Files:**
- Create: `app/api/support/faqs/route.ts`
- Create: `app/api/support/player-target/route.ts`
- Create: `app/api/support/tickets/route.ts`
- Create: `app/api/support/tickets/[id]/route.ts`
- Create: `app/api/support/tickets/[id]/messages/route.ts`
- Test: `tests/support-user-api.test.ts`

**Interfaces:**
- `GET /api/support/faqs` is public and returns only `is_published` rows, filtered by allowlisted category and escaped search text.
- `POST /api/support/player-target` is authenticated and calls `resolveSupportPlayerTarget`, returning only `{ target: { platform, requestedNickname, canonicalNickname, accountId } }`.
- `POST /api/support/tickets` accepts `{ category, subject, body, platform?, nickname?, attachmentIds? }` and returns `{ ticket }`.
- `GET /api/support/tickets` returns `{ tickets }` for the authenticated user.
- `GET /api/support/tickets/[id]` returns `{ ticket }` or 404 and updates the user read timestamp after ownership verification.
- `POST /api/support/tickets/[id]/messages` accepts `{ body }`, returns `{ message }`, and reopens a terminal/answered ticket to `in_progress`.

- [ ] **Step 1: Write route tests**

Mock `withAuthGuard`, `ticketStore`, `resolveSupportPlayerTarget`, and `attachmentStorage`. Assert public FAQ filtering; 401 for ticket POST/list/target preview; 400 for malformed JSON and 413 for overlong body; privacy POST rejects absent attachments, linked/foreign attachments, and mismatched target; target preview returns only the canonical identity; another user’s detail is 404; user messages update status; a five-ticket daily quota returns 429.

- [ ] **Step 2: Implement FAQ GET**

Accept only `stats|account|community|feature` as category. Escape `%` and `_` before using an `ilike` filter, cap `q` at 100 characters, order by `sort_order`, then `updated_at`. Return plain text answers.

- [ ] **Step 3: Implement ticket creation**

Call `withAuthGuard` before any write. Parse with `parseSupportCreateTicketInput`, count the authenticated user’s tickets from the last 24 hours, and return 429 before PUBG/storage work if the limit is reached. For privacy, call `resolveSupportPlayerTarget`, compare the requested platform/nickname to the server result, verify every attachment belongs to the user, has `ticket_id is null`, and is `ready`, and then call `createSupportTicket` with `verification_status: "pending"`; the RPC links those attachments to the new ticket and first message. For other categories set `not_required` and ignore target fields.

- [ ] **Step 4: Implement list/detail/message routes**

Use UUID parsing before database access. Delegate ownership and status transitions to `ticketStore.server.ts`; translate null detail results to 404 and store errors to 503. Do not return `storage_key` or private profile fields.

- [ ] **Step 5: Run user API tests and commit**

Run: `npm exec vitest run tests/support-user-api.test.ts`

Expected: PASS.

```bash
git add app/api/support tests/support-user-api.test.ts
git commit -m "feat: 사용자 고객센터 문의 API 추가"
```

### Task 5: Admin support APIs and privacy action

**Files:**
- Create: `lib/support/privacyAction.server.ts`
- Create: `lib/support/supportNotifications.server.ts`
- Create: `app/api/admin/support/tickets/route.ts`
- Create: `app/api/admin/support/tickets/[id]/route.ts`
- Create: `app/api/admin/support/tickets/[id]/messages/route.ts`
- Create: `app/api/admin/support/tickets/[id]/privacy-action/route.ts`
- Create: `app/api/admin/support/faqs/route.ts`
- Test: `tests/support-admin-api.test.ts`

**Interfaces:**
- `requireAdmin` guards every admin route.
- `applySupportPrivacyAction(input: { ticketId: string; actorId: string; db: SupportDb }): Promise<{ outcome: "registered" | "already_registered" }>` requires `verification_status = "verified"`, calls `addPrivatePlayer`, and writes one unique privacy event.
- `createSupportReplyNotification(db, { ticketId, requesterId, adminId, previewText }): Promise<void>` inserts a `support_reply` row with `post_id = null`.

- [ ] **Step 1: Write admin API tests**

Cover non-admin 403 for every route; list filters and oldest-first ordering; allowed and disallowed status transitions; user-visible admin reply plus notification; privacy action rejects pending/additional_info/rejected tickets; registration is idempotent when the player is already in the existing list; a repeated event insert does not create a second action.

- [ ] **Step 2: Implement admin list/detail and state mutation**

Use `requireAdmin`, parse the allowlisted filters, and select requester nickname separately from `profiles`. `PATCH` accepts only `{ status?, verificationStatus? }`, validates `canTransitionSupportTicket`, updates `resolved_at` when entering `resolved|rejected`, and inserts `status_changed`/`verification_changed` events.

- [ ] **Step 3: Implement admin reply and notification**

Insert an `admin` message through `appendSupportMessage`, then insert the notification using the same service-role client. Preview text is the first 200 characters with whitespace collapsed; it must not include screenshot URLs. Update `admin_last_read_at` when the admin detail is loaded.

- [ ] **Step 4: Implement idempotent privacy action**

Re-read the ticket under the service role, require `category = "privacy"` and `verification_status = "verified"`, then call `addPrivatePlayer(ticket.target_platform, ticket.target_resolved_nickname ?? ticket.target_nickname, ticket.target_account_id)`. If the account is already present, emit `privacy_player_already_registered`; otherwise emit `privacy_player_registered`. The partial unique event index makes retries safe; update the ticket to `resolved` only after the list operation succeeds.

- [ ] **Step 5: Implement FAQ admin CRUD**

Validate question/answer/category/sort order, sanitize no HTML because answers are plain text, and record `created_by`/`updated_by`. Delete means set `is_published = false` unless the row is already unpublished; do not physically delete a published FAQ from the admin UI.

- [ ] **Step 6: Run admin API tests and commit**

Run: `npm exec vitest run tests/support-admin-api.test.ts`

Expected: PASS.

```bash
git add lib/support/privacyAction.server.ts lib/support/supportNotifications.server.ts app/api/admin/support tests/support-admin-api.test.ts
git commit -m "feat: 관리자 문의 처리와 비공개 등록 API 추가"
```

### Task 6: User FAQ, ticket form, and thread UI

**Files:**
- Create: `app/support/page.tsx`
- Create: `app/support/new/page.tsx`
- Create: `app/support/[ticketId]/page.tsx`
- Create: `components/support/SupportCenter.tsx`
- Create: `components/support/TicketForm.tsx`
- Create: `components/support/TicketThread.tsx`
- Create: `components/support/SupportStatusBadge.tsx`
- Test: `tests/support-center-ui.test.ts`

**Interfaces:**
- `SupportCenter` receives `{ faqs, isAuthenticated }` and renders public FAQ plus login-gated actions.
- `TicketForm` calls the attachment reserve/upload/complete APIs before ticket POST and receives `{ onCreated(ticketId): void }`.
- `TicketThread` receives a ticket detail and posts user messages, never rendering `storage_key`.

- [ ] **Step 1: Read the repository’s Next.js 16 App Router guidance**

Before creating pages or Route Handler-dependent client code, read the relevant guide under `node_modules/next/dist/docs/` as required by `AGENTS.md`. Keep FAQ data loading in the server page and mutations in client components calling the API routes.

- [ ] **Step 2: Write UI tests**

Use Testing Library with mocked `useAuth`, `fetch`, and `next/navigation`. Assert: anonymous users see FAQ and a login action but no form; privacy selection reveals platform/nickname/screenshot requirement; a missing screenshot disables submit; a successful submit navigates to `/support/[ticketId]`; thread renders admin reply and posts a new message; attachment error leaves the form retryable.

- [ ] **Step 3: Implement `/support`**

Load published FAQ rows with the server Supabase client, pass them to `SupportCenter`, render category/search controls, and show `1:1 문의하기` and `내 문의` links. The client checks `useAuth` only for the login gate; it does not query private tables directly.

- [ ] **Step 4: Implement `TicketForm`**

Keep form state for category, subject, body, platform, nickname, resolved target, and attachment IDs. For privacy, call `POST /api/support/player-target` before allowing file upload; display canonical nickname and account ID confirmation. Accept PNG/JPEG/WebP only, call reserve → signed upload → complete, then POST the ticket. Disable submit while any attachment is pending and show the fixed server error message on failure.

- [ ] **Step 5: Implement `/support/[ticketId]` and `TicketThread`**

Fetch the ticket detail from the API; render status/verification badges, target fields, evidence thumbnails through signed URLs, messages, and a reply form. Refresh after a reply. If the API returns 404, render the same “문의가 없습니다” state for both missing and unauthorized IDs.

- [ ] **Step 6: Run UI tests and commit**

Run: `npm exec vitest run tests/support-center-ui.test.ts`

Expected: PASS.

```bash
git add app/support components/support tests/support-center-ui.test.ts
git commit -m "feat: 사용자 고객센터 FAQ와 문의 화면 추가"
```

### Task 7: Admin inbox, FAQ editor, and notification routing

**Files:**
- Create: `app/admin/support/page.tsx`
- Create: `components/admin/SupportInbox.tsx`
- Create: `components/admin/SupportTicketDetail.tsx`
- Create: `components/admin/SupportFaqEditor.tsx`
- Modify: `types/map.ts:49-58`
- Modify: `components/common/GlobalHeader.tsx:140-162`
- Modify: `components/map/NotificationDropdown.tsx:93-112`
- Test: `tests/support-admin-ui.test.ts`
- Test: `tests/global-header-support-notification.test.ts`

**Interfaces:**
- `SupportInbox` consumes `/api/admin/support/tickets` and emits selected ticket IDs.
- `SupportTicketDetail` consumes admin detail API and emits state, verification, reply, and privacy-action requests.
- `NotificationItem` becomes `{ type: "reply" | "comment" | "support_reply"; post_id: string | number | null; support_ticket_id?: string | null; ... }`.

- [ ] **Step 1: Write admin UI and notification tests**

Assert an admin can filter by status/category, open a ticket, mark verification, see the privacy button disabled until verified, reply, and see the result update. Assert a support notification routes to `/support/ticket-id`, while a comment/reply notification still routes to `/board/123`.

- [ ] **Step 2: Implement the admin page and inbox**

Keep `/admin/support` behind the existing middleware and client role check. Provide status/category/search filters, pending counts, oldest-first list, and a detail pane. Use the existing dark/amber admin styling and `toast` for mutation results.

- [ ] **Step 3: Implement ticket detail and FAQ editor**

Show requester nickname, target identity, signed evidence preview, timeline, and reply box. Render `비공개 목록에 등록` only when `verification_status === "verified"`; disable it during the request. In the FAQ editor, use plain-text textarea, category select, sort-order input, and publish toggle.

- [ ] **Step 4: Extend existing notification types and routing**

Update `GlobalHeader`’s `handleNotiClick` so it marks the row read and chooses:

```ts
if (noti.type === "support_reply" && noti.support_ticket_id) {
  router.push(`/support/${noti.support_ticket_id}`);
} else if (noti.post_id !== null) {
  router.push(`/board/${noti.post_id}`);
}
```

Update the dropdown copy to say “관리자가 고객센터 문의에 답변했습니다.” for `support_reply`; preserve the existing comment/reply labels.

- [ ] **Step 5: Run UI tests and commit**

Run: `npm exec vitest run tests/support-admin-ui.test.ts tests/global-header-support-notification.test.ts`

Expected: PASS.

```bash
git add app/admin/support components/admin/SupportInbox.tsx components/admin/SupportTicketDetail.tsx components/admin/SupportFaqEditor.tsx types/map.ts components/common/GlobalHeader.tsx components/map/NotificationDropdown.tsx tests/support-admin-ui.test.ts tests/global-header-support-notification.test.ts
git commit -m "feat: 관리자 고객센터와 문의 알림 화면 추가"
```

### Task 8: Navigation, privacy policy, and attachment retention job

**Files:**
- Modify: `components/common/Footer.tsx`
- Modify: `components/common/GlobalMobileMenu.tsx`
- Modify: `components/mypage/MyPage.tsx`
- Modify: `app/privacy/page.tsx`
- Create: `scripts/cleanup_support_attachments.ts`
- Modify: `.github/workflows/daily-tasks.yml`
- Test: `tests/support-navigation.test.ts`
- Test: `tests/support-attachment-cleanup.test.ts`

**Interfaces:**
- `cleanupExpiredSupportAttachments(db, now)` from Task 3 is the only cleanup implementation; the script only supplies the service-role client, logs counts, and exits non-zero on failure.

- [ ] **Step 1: Write navigation and cleanup tests**

Assert the footer, mobile drawer, and mypage contain `/support`; cleanup deletes expired pending/terminal storage objects, marks rows `deleted`, preserves unresolved ready evidence, and reports a storage deletion failure without falsely marking the row deleted.

- [ ] **Step 2: Add navigation links**

Add a `고객센터` link beside the existing community/privacy links in `Footer`, a `1:1 문의/FAQ` support card in the mobile menu’s Support section, and a `고객센터` action in the mypage activity/settings area. Do not remove the Discord link.

- [ ] **Step 3: Update the privacy policy**

Add a numbered section describing support inquiry/profile data, PUBG target identity, screenshot evidence, administrator access, private storage, 30-day terminal retention, and the `/support` request path. Update the effective date to the implementation release date only when the feature is actually shipped.

- [ ] **Step 4: Add daily cleanup**

Implement a script with explicit service-role environment checks; it defaults to `--dry-run` and only mutates storage/database when invoked with `--apply`. Add a separate non-blocking step to `.github/workflows/daily-tasks.yml` after board image cleanup, using `npx tsx scripts/cleanup_support_attachments.ts --apply`; the step must report its own failure and not skip unrelated maintenance jobs.

- [ ] **Step 5: Run tests and commit**

Run: `npm exec vitest run tests/support-navigation.test.ts tests/support-attachment-cleanup.test.ts`

Expected: PASS.

```bash
git add components/common/Footer.tsx components/common/GlobalMobileMenu.tsx components/mypage/MyPage.tsx app/privacy/page.tsx scripts/cleanup_support_attachments.ts .github/workflows/daily-tasks.yml tests/support-navigation.test.ts tests/support-attachment-cleanup.test.ts
git commit -m "feat: 고객센터 진입점과 증빙 보존 정리 추가"
```

### Task 9: Full verification and release handoff

**Files:**
- Modify only files that fail the targeted checks from Tasks 1–8.
- Test: all new support tests plus existing admin/security suites.

**Interfaces:**
- No new public interface. This task verifies the interfaces delivered by the previous tasks and the migration against the existing repository.

- [ ] **Step 1: Run targeted support tests**

Run:

```bash
npm exec vitest run tests/support-center-contracts.test.ts tests/support-center-migration.test.ts tests/support-player-target.test.ts tests/support-ticket-store.test.ts tests/support-attachments.test.ts tests/support-user-api.test.ts tests/support-admin-api.test.ts tests/support-center-ui.test.ts tests/support-admin-ui.test.ts tests/global-header-support-notification.test.ts tests/support-navigation.test.ts tests/support-attachment-cleanup.test.ts
```

Expected: PASS with no skipped support test.

- [ ] **Step 2: Run existing security and admin verification**

Run: `npm run verify:admin` and `npm run verify:security`

Expected: PASS. If an existing test expects `NotificationItem.post_id` to be non-null, update the type fixture to include the support nullable case without weakening the old board path.

- [ ] **Step 3: Run typecheck and lint**

Run: `npm run verify:core`

Expected: ESLint and `tsc --noEmit --pretty false` pass.

- [ ] **Step 4: Run migration verification**

Run: `bash scripts/verify_migrations_local.sh`

Expected: the new migration applies after the current head, RLS policies are accepted, and the private bucket remains `public = false`.

- [ ] **Step 5: Perform a manual dry run**

With a test user and test admin: open `/support`, read a FAQ while signed out, create an account inquiry, create a privacy inquiry with a screenshot, verify the account ID, reply as admin, click the support notification, approve privacy, confirm the existing player lookup returns `PLAYER_PRIVATE`, then verify a second privacy action is a no-op. Mark the test ticket resolved and invoke the cleanup helper with a clock 31 days after `resolved_at` (or run the cleanup script in `--apply` mode against the test project) so test evidence is removed without manually deleting unrelated data.

- [ ] **Step 6: Commit verification fixes and report**

Run `git diff --check`, inspect `git status`, and commit only verification fixes with a Korean feature-specific message. Report the migration name, API routes, tests run, and any environment-dependent manual checks that could not run locally.
