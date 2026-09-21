import { describe, expect, it } from "vitest";
import {
  SUPPORT_LIMITS,
  canTransitionSupportTicket,
  parseSupportCreateTicketInput,
  parseSupportMessageInput,
  validateSupportAttachmentMeta,
} from "@/lib/support/validation";

describe("support contracts", () => {
  it("requires account target and attachment IDs for privacy input", () => {
    expect(parseSupportCreateTicketInput({
      category: "privacy",
      subject: "비공개",
      body: "요청",
      platform: "steam",
      nickname: "player",
      attachmentIds: [],
    })).toEqual({ ok: false, code: "privacy_evidence_required" });
  });

  it("accepts a bounded general ticket without privacy verification", () => {
    const result = parseSupportCreateTicketInput({
      category: "account",
      subject: "로그인 문의",
      body: "확인 부탁드립니다.",
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.verificationStatus).toBe("not_required");
    }
  });

  it("rejects executable or oversized attachments", () => {
    expect(validateSupportAttachmentMeta({ mimeType: "image/svg+xml", byteSize: 100 })).toEqual(
      { ok: false, code: "unsupported_mime" },
    );
    expect(validateSupportAttachmentMeta({ mimeType: "image/png", byteSize: SUPPORT_LIMITS.attachmentBytes + 1 })).toEqual(
      { ok: false, code: "attachment_too_large" },
    );
  });

  it("parses a bounded message and rejects whitespace-only text", () => {
    expect(parseSupportMessageInput({ body: "  답변 부탁드립니다.  " })).toEqual({
      ok: true,
      value: { body: "답변 부탁드립니다." },
    });
    expect(parseSupportMessageInput({ body: "   " })).toEqual({
      ok: false,
      code: "body_required",
    });
  });

  it("allows only explicit status transitions", () => {
    expect(canTransitionSupportTicket("new", "in_progress")).toBe(true);
    expect(canTransitionSupportTicket("new", "resolved")).toBe(false);
    expect(canTransitionSupportTicket("resolved", "in_progress")).toBe(true);
  });
});
