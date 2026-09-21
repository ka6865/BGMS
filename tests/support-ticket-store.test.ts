import { describe, expect, it, vi } from "vitest";
import type { SupportDb } from "@/lib/support/contracts";
import {
  appendSupportMessage,
  createSupportTicket,
  getSupportTicketForActor,
} from "@/lib/support/ticketStore.server";

function chain(result: unknown) {
  const query: Record<string, ReturnType<typeof vi.fn>> = {};
  for (const method of ["select", "eq", "order", "limit", "maybeSingle", "single", "insert", "update"]) {
    query[method] = vi.fn(() => query);
  }
  query.maybeSingle.mockResolvedValue(result);
  query.single.mockResolvedValue(result);
  return query;
}

describe("support ticket store", () => {
  it("creates the ticket through the atomic RPC with the authenticated user and first message", async () => {
    const ticketId = "11111111-1111-4111-8111-111111111111";
    const ticketQuery = chain({
      data: {
        id: ticketId,
        requester_id: "user-a",
        category: "account",
        subject: "로그인",
        status: "new",
        verification_status: "not_required",
        last_message_at: "2026-09-21T00:00:00.000Z",
        last_message_sender: "user",
      },
      error: null,
    });
    const db = {
      rpc: vi.fn().mockResolvedValue({ data: ticketId, error: null }),
      from: vi.fn(() => ticketQuery),
    } as unknown as SupportDb;

    const result = await createSupportTicket(db, {
      requesterId: "user-a",
      category: "account",
      subject: "로그인",
      body: "확인 부탁드립니다.",
      verificationStatus: "not_required",
      targetPlatform: null,
      targetNickname: null,
      targetAccountId: null,
      targetResolvedNickname: null,
      attachmentIds: [],
    });

    expect(db.rpc).toHaveBeenCalledWith("create_support_ticket", expect.objectContaining({
      p_requester_id: "user-a",
      p_body: "확인 부탁드립니다.",
      p_attachment_ids: [],
    }));
    expect(result.id).toBe(ticketId);
  });

  it("returns null when another user requests the ticket detail", async () => {
    const ticketQuery = chain({
      data: {
        id: "ticket-a",
        requester_id: "user-a",
        category: "account",
        subject: "비공개",
        status: "new",
        verification_status: "not_required",
      },
      error: null,
    });
    const db = { from: vi.fn(() => ticketQuery) } as unknown as SupportDb;

    await expect(getSupportTicketForActor(db, "ticket-a", {
      userId: "user-b",
      isAdmin: false,
    })).resolves.toBeNull();
  });

  it("reopens awaiting_user and records a user message", async () => {
    const ticketQuery = chain({
      data: {
        id: "ticket-a",
        requester_id: "user-a",
        category: "account",
        subject: "문의",
        status: "awaiting_user",
        verification_status: "not_required",
      },
      error: null,
    });
    const messageQuery = chain({
      data: { id: "message-a", ticket_id: "ticket-a", sender_type: "user", body: "추가 정보입니다." },
      error: null,
    });
    const db = {
      from: vi.fn((table: string) => table === "support_messages" ? messageQuery : ticketQuery),
    } as unknown as SupportDb;

    const result = await appendSupportMessage(db, {
      ticketId: "ticket-a",
      actor: { userId: "user-a", isAdmin: false },
      senderType: "user",
      body: "추가 정보입니다.",
    });

    expect(result.id).toBe("message-a");
    expect(ticketQuery.update).toHaveBeenCalledWith(expect.objectContaining({
      status: "in_progress",
      last_message_sender: "user",
    }));
  });
});
