import {
  SUPPORT_LIMITS,
  type CreateSupportTicketInput,
  type ParseResult,
  type SupportAttachmentMeta,
  type SupportCategory,
  type SupportParseErrorCode,
  type SupportPlatform,
  type SupportTicketStatus,
} from "./contracts";

const CATEGORIES: readonly SupportCategory[] = ["privacy", "account", "community", "bug", "other"];
const PLATFORMS: readonly SupportPlatform[] = ["steam", "kakao"];
const MIME_TYPES = new Set(["image/png", "image/jpeg", "image/webp"]);
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

const error = <T>(code: SupportParseErrorCode): ParseResult<T> => ({ ok: false, code });

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function trimmedString(value: unknown): string | null {
  return typeof value === "string" ? value.trim() : null;
}

export function parseSupportCreateTicketInput(value: unknown): ParseResult<CreateSupportTicketInput> {
  const input = asRecord(value);
  if (!input) return error("invalid_input");

  const category = trimmedString(input.category);
  if (!category || !CATEGORIES.includes(category as SupportCategory)) return error("category_invalid");

  const subject = trimmedString(input.subject);
  if (!subject) return error("subject_required");
  if (subject.length > SUPPORT_LIMITS.subjectChars) return error("subject_too_long");

  const body = trimmedString(input.body);
  if (!body) return error("body_required");
  if (body.length > SUPPORT_LIMITS.bodyChars) return error("body_too_long");

  const rawAttachmentIds = input.attachmentIds;
  const attachmentIds = rawAttachmentIds === undefined
    ? []
    : Array.isArray(rawAttachmentIds) && rawAttachmentIds.every((id) => typeof id === "string" && UUID_RE.test(id))
      ? rawAttachmentIds
      : null;
  if (attachmentIds === null) return error("attachment_ids_invalid");
  if (attachmentIds.length > SUPPORT_LIMITS.maxAttachments) return error("too_many_attachments");
  if (new Set(attachmentIds).size !== attachmentIds.length) return error("attachment_ids_invalid");

  const rawPlatform = input.platform;
  const platform = rawPlatform === undefined ? undefined : trimmedString(rawPlatform);
  if (platform !== undefined && (!platform || !PLATFORMS.includes(platform as SupportPlatform))) {
    return error("platform_invalid");
  }

  const rawNickname = input.nickname;
  const nickname = rawNickname === undefined ? undefined : trimmedString(rawNickname);
  if (nickname !== undefined && !nickname) return error("nickname_required");
  if (nickname && nickname.length > 100) return error("nickname_too_long");

  if (category === "privacy") {
    if (!platform) return error("platform_required");
    if (!nickname) return error("nickname_required");
    if (attachmentIds.length === 0) return error("privacy_evidence_required");
  }

  return {
    ok: true,
    value: {
      category: category as SupportCategory,
      subject,
      body,
      platform: platform as SupportPlatform | undefined,
      nickname,
      attachmentIds,
      verificationStatus: category === "privacy" ? "pending" : "not_required",
    },
  };
}

export function parseSupportMessageInput(value: unknown): ParseResult<{ body: string }> {
  const input = asRecord(value);
  if (!input) return error("invalid_input");
  const body = trimmedString(input.body);
  if (!body) return error("body_required");
  if (body.length > SUPPORT_LIMITS.bodyChars) return error("body_too_long");
  return { ok: true, value: { body } };
}

export function validateSupportAttachmentMeta(input: unknown): ParseResult<SupportAttachmentMeta> {
  const record = asRecord(input);
  if (!record) return error("invalid_input");
  const mimeType = typeof record.mimeType === "string" ? record.mimeType.trim().toLowerCase() : "";
  if (!MIME_TYPES.has(mimeType)) return error("unsupported_mime");
  const byteSize = record.byteSize;
  if (typeof byteSize !== "number" || !Number.isSafeInteger(byteSize) || byteSize <= 0) {
    return error("attachment_size_invalid");
  }
  if (byteSize > SUPPORT_LIMITS.attachmentBytes) return error("attachment_too_large");
  return { ok: true, value: { mimeType, byteSize } };
}

const TRANSITIONS: Record<SupportTicketStatus, readonly SupportTicketStatus[]> = {
  new: ["in_progress", "rejected"],
  in_progress: ["awaiting_user", "answered", "resolved", "rejected"],
  awaiting_user: ["in_progress", "rejected"],
  answered: ["in_progress", "resolved"],
  resolved: ["in_progress"],
  rejected: ["in_progress"],
};

export function canTransitionSupportTicket(
  from: SupportTicketStatus,
  to: SupportTicketStatus,
): boolean {
  return TRANSITIONS[from]?.includes(to) ?? false;
}

export { SUPPORT_LIMITS };
