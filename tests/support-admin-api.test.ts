import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextResponse } from "next/server";

const mocks = vi.hoisted(() => ({
  admin: vi.fn(),
  from: vi.fn(),
  listAdmin: vi.fn(),
  getTicket: vi.fn(),
  appendMessage: vi.fn(),
  notification: vi.fn(),
  privateList: vi.fn(),
  addPrivate: vi.fn(),
}));

vi.mock("@/lib/server/adminGuard", () => ({ requireAdmin: mocks.admin }));
vi.mock("@/lib/support/ticketStore.server", () => ({
  listSupportTicketsForAdmin: mocks.listAdmin,
  getSupportTicketForActor: mocks.getTicket,
  appendSupportMessage: mocks.appendMessage,
  SupportStoreError: class SupportStoreError extends Error {
    code: string;
    constructor(code: string) { super(code); this.code = code; }
  },
}));
vi.mock("@/lib/support/supportNotifications.server", () => ({
  createSupportReplyNotification: mocks.notification,
}));
vi.mock("@/lib/pubg/privatePlayers", () => ({
  getPrivatePlayersList: mocks.privateList,
  addPrivatePlayer: mocks.addPrivate,
}));

import { GET as listGET } from "@/app/api/admin/support/tickets/route";
import { GET as detailGET, PATCH as detailPATCH } from "@/app/api/admin/support/tickets/[id]/route";
import { POST as replyPOST } from "@/app/api/admin/support/tickets/[id]/messages/route";
import { POST as privacyPOST } from "@/app/api/admin/support/tickets/[id]/privacy-action/route";
import { GET as faqGET, POST as faqPOST, PATCH as faqPATCH, DELETE as faqDELETE } from "@/app/api/admin/support/faqs/route";
import { applySupportPrivacyAction } from "@/lib/support/privacyAction.server";

const ticketId = "11111111-1111-4111-8111-111111111111";
const context = { params: Promise.resolve({ id: ticketId }) };

function queryResult(result: unknown) {
  const query: Record<string, ReturnType<typeof vi.fn>> & { then?: unknown } = {};
  for (const method of ["select", "eq", "in", "ilike", "order", "insert", "update", "delete", "match"]) {
    query[method] = vi.fn(() => query);
  }
  query.maybeSingle = vi.fn().mockResolvedValue(result);
  query.single = vi.fn().mockResolvedValue(result);
  query.then = (resolve: (value: unknown) => unknown, reject?: (reason: unknown) => unknown) => Promise.resolve(result).then(resolve, reject);
  return query;
}

function request(path: string, body?: unknown, method = "GET") {
  return new Request(`http://localhost${path}`, {
    method,
    ...(body === undefined ? {} : {
      body: JSON.stringify(body),
      headers: { "content-type": "application/json" },
    }),
  });
}

const adminContext = () => ({
  ok: true as const,
  user: { id: "admin-1" },
  nickname: "관리자",
  supabaseAdmin: { from: mocks.from },
});

const ticket = {
  id: ticketId,
  requester_id: "user-a",
  category: "privacy",
  subject: "비공개 요청",
  status: "in_progress",
  verification_status: "pending",
  target_platform: "steam",
  target_nickname: "Player",
  target_account_id: "account.player",
  target_resolved_nickname: "Player",
  last_message_at: "2026-09-21T00:00:00.000Z",
  last_message_sender: "user",
};

beforeEach(() => {
  vi.clearAllMocks();
  mocks.admin.mockResolvedValue(adminContext());
  mocks.listAdmin.mockResolvedValue([ticket]);
  mocks.getTicket.mockResolvedValue({ ...ticket, messages: [], attachments: [], events: [] });
  mocks.appendMessage.mockResolvedValue({ id: "message-1", ticket_id: ticketId, sender_type: "admin", body: "확인했습니다." });
  mocks.privateList.mockResolvedValue([]);
  mocks.addPrivate.mockResolvedValue([]);
  mocks.notification.mockResolvedValue(undefined);
});

describe("admin support APIs", () => {
  it("returns 403 for every admin surface when requireAdmin rejects", async () => {
    mocks.admin.mockResolvedValue({ ok: false, error: NextResponse.json({ error: "forbidden" }, { status: 403 }) });
    expect((await listGET(request("/api/admin/support/tickets"))).status).toBe(403);
    expect((await detailGET(request("/api/admin/support/tickets/" + ticketId), context)).status).toBe(403);
    expect((await detailPATCH(request("/api/admin/support/tickets/" + ticketId, {} , "PATCH"), context)).status).toBe(403);
    expect((await replyPOST(request("/api/admin/support/tickets/" + ticketId + "/messages", { body: "답변" }, "POST"), context)).status).toBe(403);
    expect((await privacyPOST(request("/api/admin/support/tickets/" + ticketId + "/privacy-action", {}, "POST"), context)).status).toBe(403);
    expect((await faqGET()).status).toBe(403);
    expect((await faqPOST(request("/api/admin/support/faqs", {}, "POST"))).status).toBe(403);
  });

  it("passes allowlisted list filters to the oldest-first admin inbox", async () => {
    mocks.from.mockReturnValue(queryResult({ data: [], error: null }));
    const response = await listGET(request("/api/admin/support/tickets?status=in_progress&category=privacy&q=Player"));
    expect(response.status).toBe(200);
    expect(mocks.listAdmin).toHaveBeenCalledWith(expect.anything(), {
      status: "in_progress",
      category: "privacy",
      q: "Player",
    });
  });

  it("rejects a disallowed status transition and accepts an allowed one", async () => {
    mocks.getTicket.mockResolvedValue({ ...ticket, status: "new" });
    const response = await detailPATCH(request("/api/admin/support/tickets/" + ticketId, { status: "resolved" }, "PATCH"), context);
    expect(response.status).toBe(400);
    expect(mocks.from).not.toHaveBeenCalled();

    mocks.from.mockReturnValue(queryResult({ data: { ...ticket, status: "in_progress" }, error: null }));
    const allowed = await detailPATCH(request("/api/admin/support/tickets/" + ticketId, { status: "in_progress" }, "PATCH"), context);
    expect(allowed.status).toBe(200);
  });

  it("stores an admin reply and creates a support reply notification", async () => {
    const response = await replyPOST(request("/api/admin/support/tickets/" + ticketId + "/messages", { body: "확인했습니다." }, "POST"), context);
    expect(response.status).toBe(201);
    expect(mocks.appendMessage).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ senderType: "admin" }));
    expect(mocks.notification).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      ticketId,
      requesterId: "user-a",
      adminId: "admin-1",
    }));
  });

  it("rejects privacy action until verification is verified", async () => {
    const response = await privacyPOST(request("/api/admin/support/tickets/" + ticketId + "/privacy-action", {}, "POST"), context);
    expect(response.status).toBe(400);
    expect(mocks.addPrivate).not.toHaveBeenCalled();
  });

  it("runs privacy registration idempotently and distinguishes an already registered player", async () => {
    const db = {
      from: vi.fn()
        .mockReturnValueOnce(queryResult({ data: { ...ticket, verification_status: "verified" }, error: null }))
        .mockReturnValueOnce(queryResult({ data: null, error: null }))
        .mockReturnValueOnce(queryResult({ data: null, error: null }))
        .mockReturnValueOnce(queryResult({ data: null, error: null }))
        .mockReturnValueOnce(queryResult({ data: { ...ticket, status: "resolved", verification_status: "verified", resolved_at: "2026-09-21T00:00:00.000Z" }, error: null }))
        .mockReturnValueOnce(queryResult({ data: null, error: { code: "23505" } })),
    } as any;
    mocks.privateList.mockResolvedValueOnce([]).mockResolvedValueOnce([{
      platform: "steam", nickname: "OldPlayer", lower_nickname: "oldplayer", account_id: "account.player", created_at: "2026-09-21T00:00:00.000Z",
    }]);

    const first = await applySupportPrivacyAction({ ticketId, actorId: "admin-1", db });
    const second = await applySupportPrivacyAction({ ticketId, actorId: "admin-1", db });
    expect(first.outcome).toBe("registered");
    expect(second.outcome).toBe("already_registered");
    expect(mocks.addPrivate).toHaveBeenCalledTimes(1);
  });

  it("supports FAQ create, update, and soft delete without HTML", async () => {
    const query = queryResult({ data: { id: "faq-1", question: "질문", answer: "답변" }, error: null });
    mocks.from.mockReturnValue(query);
    expect((await faqPOST(request("/api/admin/support/faqs", {
      category: "stats", question: "질문", answer: "<b>답변</b>", sortOrder: 1, isPublished: true,
    }, "POST"))).status).toBe(201);
    expect((await faqPATCH(request("/api/admin/support/faqs", {
      id: "faq-1", category: "stats", question: "질문", answer: "수정", sortOrder: 2, isPublished: true,
    }, "PATCH"))).status).toBe(200);
    expect((await faqDELETE(request("/api/admin/support/faqs", { id: "faq-1" }, "DELETE"))).status).toBe(200);
    expect(query.insert).toHaveBeenCalledWith(expect.objectContaining({ answer: "답변" }));
  });
});
