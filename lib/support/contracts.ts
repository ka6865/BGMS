import type { SupabaseClient } from "@supabase/supabase-js";

export const SUPPORT_LIMITS = {
  subjectChars: 120,
  bodyChars: 5_000,
  maxAttachments: 3,
  attachmentBytes: 3 * 1024 * 1024,
  totalAttachmentBytes: 9 * 1024 * 1024,
  dailyTicketCount: 5,
} as const;

export type SupportCategory = "privacy" | "account" | "community" | "bug" | "other";
export type SupportTicketStatus =
  | "new"
  | "in_progress"
  | "awaiting_user"
  | "answered"
  | "resolved"
  | "rejected";
export type SupportVerificationStatus =
  | "not_required"
  | "pending"
  | "verified"
  | "additional_info"
  | "rejected";
export type SupportAttachmentStatus = "pending" | "ready" | "deleted";

export type SupportPlatform = "steam" | "kakao";

export type CreateSupportTicketInput = {
  category: SupportCategory;
  subject: string;
  body: string;
  platform?: SupportPlatform;
  nickname?: string;
  attachmentIds: string[];
  verificationStatus: SupportVerificationStatus;
};

export type SupportAttachmentMeta = {
  mimeType: string;
  byteSize: number;
};

export type SupportParseErrorCode =
  | "invalid_input"
  | "category_invalid"
  | "subject_required"
  | "subject_too_long"
  | "body_required"
  | "body_too_long"
  | "platform_required"
  | "platform_invalid"
  | "nickname_required"
  | "nickname_too_long"
  | "attachment_ids_invalid"
  | "privacy_evidence_required"
  | "too_many_attachments"
  | "unsupported_mime"
  | "attachment_size_invalid"
  | "attachment_too_large";

export type ParseResult<T> =
  | { ok: true; value: T }
  | { ok: false; code: SupportParseErrorCode };

/**
 * A deliberately broad Supabase client alias keeps server services injectable
 * while allowing tests to provide a narrow structural fake via a cast.
 */
export type SupportDb = SupabaseClient<any, any, any>;
