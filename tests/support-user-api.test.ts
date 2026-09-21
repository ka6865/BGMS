import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextResponse } from "next/server";

const mocks = vi.hoisted(() => ({
  auth: vi.fn(),
  from: vi.fn(),
  publicFrom: vi.fn(),
  createClient: vi.fn(),
  resolveTarget: vi.fn(),
  createTicket: vi.fn(),
  listTickets: vi.fn(),
  getTicket: vi.fn(),
  appendMessage: vi.fn(),
}));

vi.mock("@/utils/supabase/guard", () => ({ withAuthGuard: mocks.auth }));
vi.mock("@/utils/supabase/server", () => ({ createClient: mocks.createClient }));
vi.mock("@/lib/support/playerTarget.server", () => ({
  resolveSupportPlayerTarget: mocks.resolveTarget,
  SupportPlayerLookupError: class SupportPlayerLookupError extends Error {
    code: "not_found" | "rate_limited" | "unavailable";
    constructor(code: "not_found" | "rate_limited" | "unavailable") {
      super(code);
      this.code = code;
    }
  },
}));
vi.mock("@/lib/support/ticketStore.server", () => ({
  createSupportTicket: mocks.createTicket,
  listSupportTicketsForUser: mocks.listTickets,
  getSupportTicketForActor: mocks.getTicket,
  appendSupportMessage: mocks.appendMessage,
  SupportStoreError: class SupportStoreError extends Error {
    code: "not_found" | "forbidden" | "database" | "duplicate";
    constructor(code: "not_found" | "forbidden" | "database" | "duplicate") {
      super(code);
      this.code = code;
    }
  },
}));

import { GET as faqGET } from "@/app/api/support/faqs/route";
import { POST as targetPOST } from "@/app/api/support/player-target/route";
import { GET as ticketsGET, POST as ticketsPOST } from "@/app/api/support/tickets/route";
import { GET as ticketGET } from "@/app/api/support/tickets/[id]/route";
import { POST as messagePOST } from "@/app/api/support/tickets/[id]/messages/route";

const user = { id: "user-a" };
const ticketId = "11111111-1111-4111-8111-111111111111";
const attachmentId = "22222222-2222-4222-8222-222222222222";
const context = { params: Promise.resolve({ id: ticketId }) };

function queryResult(result: unknown) {
  const query: Record<string, ReturnType<typeof vi.fn>> & { then?: unknown } = {};
  for (const method of ["select", "eq", "gte", "in", "is", "order", "ilike", "or", "insert", "update"]) {
    query[method] = vi.fn(() => query);
  }
  query.maybeSingle = vi.fn().mockResolvedValue(result);
  query.single = vi.fn().mockResolvedValue(result);
  query.then = (resolve: (value: unknown) => unknown, reject?: (reason: unknown) => unknown) => Promise.resolve(result).then(resolve, reject);
  return query;
}

function request(path: string, body?: unknown, method = "POST") {
  return new Request(`http://localhost${path}`, {
    method,
    ...(body === undefined ? {} : {
      body: typeof body === "string" ? body : JSON.stringify(body),
      headers: { "content-type": "application/json" },
    }),
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.auth.mockResolvedValue({ user, supabaseAdmin: { from: mocks.from } });
  mocks.createClient.mockResolvedValue({ from: mocks.publicFrom });
  mocks.resolveTarget.mockResolvedValue({
    platform: "steam",
    requestedNickname: "Player",
    canonicalNickname: "Player",
    accountId: "account.player",
  });
  mocks.createTicket.mockResolvedValue({
    id: ticketId,
    requester_id: user.id,
    category: "account",
    subject: "문의",
    status: "new",
    verification_status: "not_required",
    last_message_at: "2026-09-21T00:00:00.000Z",
    last_message_sender: "user",
  });
});

describe("support user APIs", () => {
  it("returns only published FAQ rows and escapes wildcard search", async () => {
    const query = queryResult({ data: [{ id: "faq-1", question: "전적", answer: "고객센터" }], error: null });
    mocks.publicFrom.mockReturnValue(query);
    const response = await faqGET(new Request("http://localhost/api/support/faqs?category=stats&q=100%_"));

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ faqs: [{ id: "faq-1", question: "전적", answer: "고객센터" }] });
    expect(query.eq).toHaveBeenCalledWith("is_published", true);
    expect(query.ilike).toHaveBeenCalledWith("question", "%100\\%\\_%");
    expect(query.order).toHaveBeenNthCalledWith(1, "sort_order", { ascending: true });
  });

  it("requires authentication for ticket creation, listing, and target preview", async () => {
    mocks.auth.mockResolvedValue({ error: NextResponse.json({ error: "로그인이 필요합니다." }, { status: 401 }) });

    expect((await ticketsPOST(request("/api/support/tickets", {}))).status).toBe(401);
    expect((await ticketsGET()).status).toBe(401);
    expect((await targetPOST(request("/api/support/player-target", { platform: "steam", nickname: "Player" })))).toMatchObject({ status: 401 });
  });

  it("rejects malformed and overlong ticket bodies before writing", async () => {
    expect((await ticketsPOST(request("/api/support/tickets", "{"))).status).toBe(400);
    expect((await ticketsPOST(request("/api/support/tickets", {
      category: "account",
      subject: "x".repeat(121),
      body: "내용",
    }))).status).toBe(400);
    expect(mocks.createTicket).not.toHaveBeenCalled();
  });

  it("requires privacy evidence and rejects a target mismatch", async () => {
    const countQuery = queryResult({ data: null, count: 0, error: null });
    mocks.from.mockReturnValue(countQuery);
    mocks.resolveTarget.mockResolvedValue({
      platform: "steam",
      requestedNickname: "Player",
      canonicalNickname: "DifferentPlayer",
      accountId: "account.player",
    });
    expect((await ticketsPOST(request("/api/support/tickets", {
      category: "privacy",
      subject: "비공개",
      body: "요청",
      platform: "steam",
      nickname: "Player",
      attachmentIds: [],
    }))).status).toBe(400);

    expect((await ticketsPOST(request("/api/support/tickets", {
      category: "privacy",
      subject: "비공개",
      body: "요청",
      platform: "steam",
      nickname: "Player",
      attachmentIds: [attachmentId],
    }))).status).toBe(400);
    expect(mocks.resolveTarget).toHaveBeenCalled();
    expect(mocks.createTicket).not.toHaveBeenCalled();
  });

  it("returns a canonical target without the upstream payload", async () => {
    const response = await targetPOST(request("/api/support/player-target", { platform: "steam", nickname: "Player" }));

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ target: {
      platform: "steam",
      requestedNickname: "Player",
      canonicalNickname: "Player",
      accountId: "account.player",
    } });
  });

  it("hides another user's detail and posts user replies through the store", async () => {
    mocks.getTicket.mockResolvedValue(null);
    expect((await ticketGET(request("/api/support/tickets/" + ticketId, undefined, "GET"), context)).status).toBe(404);

    mocks.getTicket.mockResolvedValue({ id: ticketId, status: "awaiting_user" });
    mocks.appendMessage.mockResolvedValue({ id: "message-1", ticket_id: ticketId, sender_type: "user", body: "추가" });
    const response = await messagePOST(request(`/api/support/tickets/${ticketId}/messages`, { body: "추가" }), context);
    expect(response.status).toBe(201);
    expect(mocks.appendMessage).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      ticketId,
      senderType: "user",
      body: "추가",
    }));
  });

  it("returns 429 before player or storage work after five tickets in 24 hours", async () => {
    const countQuery = queryResult({ data: null, count: 5, error: null });
    mocks.from.mockReturnValue(countQuery);
    const response = await ticketsPOST(request("/api/support/tickets", {
      category: "account",
      subject: "문의",
      body: "본문",
    }));

    expect(response.status).toBe(429);
    expect(mocks.resolveTarget).not.toHaveBeenCalled();
    expect(mocks.createTicket).not.toHaveBeenCalled();
  });

  it("rejects a foreign or already-linked attachment", async () => {
    const countQuery = queryResult({ data: null, count: 0, error: null });
    const attachmentQuery = queryResult({ data: [{ id: attachmentId, uploader_id: "user-b", ticket_id: null, status: "ready", byte_size: 100 }], error: null });
    mocks.from.mockReturnValueOnce(countQuery).mockReturnValueOnce(attachmentQuery);
    const response = await ticketsPOST(request("/api/support/tickets", {
      category: "account",
      subject: "문의",
      body: "본문",
      attachmentIds: [attachmentId],
    }));
    expect(response.status).toBe(400);
    expect(mocks.createTicket).not.toHaveBeenCalled();
  });
});
