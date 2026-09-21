import { isUuid } from "@/lib/board/imageStorageContract";
import { SUPPORT_LIMITS, type SupportDb } from "./contracts";
import { validateSupportAttachmentMeta } from "./validation";

export const SUPPORT_EVIDENCE_BUCKET = "support-evidence";
const UNLINKED_RETENTION_MS = 24 * 60 * 60 * 1000;
const TERMINAL_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;

type AttachmentErrorCode =
  | "invalid_input"
  | "unsupported_mime"
  | "attachment_size_invalid"
  | "attachment_too_large"
  | "attachment_quota"
  | "not_found"
  | "upload_missing"
  | "unavailable";

export class SupportAttachmentError extends Error {
  readonly code: AttachmentErrorCode;

  constructor(code: AttachmentErrorCode) {
    super(code);
    this.name = "SupportAttachmentError";
    this.code = code;
  }
}

type AttachmentRow = {
  id: string;
  ticket_id: string | null;
  uploader_id: string | null;
  storage_key: string;
  status: "pending" | "ready" | "deleted";
  mime_type?: string;
  byte_size?: number;
  original_name?: string;
};

function throwStorageError(code: AttachmentErrorCode): never {
  throw new SupportAttachmentError(code);
}

function sanitizeOriginalName(value: string): string {
  const sanitized = value
    .replace(/[\\/]+/g, "_")
    .replace(/[\u0000-\u001f\u007f]/g, "")
    .trim()
    .slice(0, 255);
  return sanitized || "attachment";
}

async function queryResult<T>(query: unknown): Promise<{ data: T; error: { message?: string } | null }> {
  return await query as { data: T; error: { message?: string } | null };
}

function storageFrom(db: SupportDb) {
  return (db as any).storage.from(SUPPORT_EVIDENCE_BUCKET);
}

function errorFromValidation(code: string): SupportAttachmentError {
  if (code === "unsupported_mime") return new SupportAttachmentError("unsupported_mime");
  if (code === "attachment_too_large") return new SupportAttachmentError("attachment_too_large");
  return new SupportAttachmentError("attachment_size_invalid");
}

export async function reserveSupportAttachment(input: {
  supabaseAdmin: SupportDb;
  ownerUserId: string;
  mimeType: string;
  byteSize: number;
  originalName: string;
}): Promise<{ attachmentId: string; bucketId: string; storageKey: string; token: string }> {
  const meta = validateSupportAttachmentMeta({ mimeType: input.mimeType, byteSize: input.byteSize });
  if (!meta.ok) throw errorFromValidation(meta.code);
  if (!input.ownerUserId || typeof input.originalName !== "string") throwStorageError("invalid_input");

  const existing = await queryResult<Pick<AttachmentRow, "id" | "byte_size">[]>((input.supabaseAdmin as any)
    .from("support_attachments")
    .select("id,byte_size")
    .eq("uploader_id", input.ownerUserId)
    .is("ticket_id", null)
    .in("status", ["pending", "ready"]));
  if (existing.error) throwStorageError("unavailable");
  const existingRows = existing.data ?? [];
  const totalBytes = existingRows.reduce((sum, row) => sum + (typeof row.byte_size === "number" ? row.byte_size : 0), 0);
  if (existingRows.length >= SUPPORT_LIMITS.maxAttachments
    || totalBytes + meta.value.byteSize > SUPPORT_LIMITS.totalAttachmentBytes) {
    throwStorageError("attachment_quota");
  }

  const attachmentId = crypto.randomUUID();
  const storageKey = `attachments/${attachmentId}`;
  const inserted = await queryResult<AttachmentRow | null>((input.supabaseAdmin as any)
    .from("support_attachments")
    .insert({
      id: attachmentId,
      ticket_id: null,
      uploader_id: input.ownerUserId,
      bucket_id: SUPPORT_EVIDENCE_BUCKET,
      storage_key: storageKey,
      original_name: sanitizeOriginalName(input.originalName),
      mime_type: meta.value.mimeType,
      byte_size: meta.value.byteSize,
      status: "pending",
      expires_at: new Date(Date.now() + UNLINKED_RETENTION_MS).toISOString(),
    })
    .select("id,bucket_id,storage_key,status")
    .single());
  if (inserted.error || !inserted.data) throwStorageError("unavailable");

  let signed: { data: { token?: string } | null; error: unknown };
  try {
    signed = await storageFrom(input.supabaseAdmin).createSignedUploadUrl(storageKey, { upsert: false });
  } catch {
    throwStorageError("unavailable");
  }
  if (signed.error || !signed.data?.token) throwStorageError("unavailable");

  return {
    attachmentId,
    bucketId: SUPPORT_EVIDENCE_BUCKET,
    storageKey,
    token: signed.data.token,
  };
}

export async function completeSupportAttachment(input: {
  supabaseAdmin: SupportDb;
  ownerUserId: string;
  attachmentId: string;
}): Promise<{ attachmentId: string; status: "ready" }> {
  if (!isUuid(input.attachmentId)) throwStorageError("not_found");
  const found = await queryResult<AttachmentRow | null>((input.supabaseAdmin as any)
    .from("support_attachments")
    .select("id,ticket_id,uploader_id,storage_key,status")
    .eq("id", input.attachmentId)
    .maybeSingle());
  if (found.error || !found.data || found.data.uploader_id !== input.ownerUserId || found.data.status === "deleted") {
    throwStorageError("not_found");
  }
  if (found.data.status === "ready") return { attachmentId: found.data.id, status: "ready" };

  let listed: { data: Array<{ name?: string }> | null; error: unknown };
  try {
    listed = await storageFrom(input.supabaseAdmin).list("attachments", { search: input.attachmentId });
  } catch {
    throwStorageError("unavailable");
  }
  const objectExists = !listed.error && (listed.data ?? []).some((item) => item.name === input.attachmentId);
  if (!objectExists) throwStorageError("upload_missing");

  const updated = await queryResult<unknown>((input.supabaseAdmin as any)
    .from("support_attachments")
    .update({ status: "ready" })
    .eq("id", input.attachmentId)
    .eq("uploader_id", input.ownerUserId));
  if (updated.error) throwStorageError("unavailable");
  return { attachmentId: input.attachmentId, status: "ready" };
}

export async function getSupportAttachmentSignedUrl(input: {
  supabaseAdmin: SupportDb;
  attachmentId: string;
  actor: { userId: string; isAdmin: boolean };
}): Promise<string> {
  if (!isUuid(input.attachmentId)) throwStorageError("not_found");
  const found = await queryResult<AttachmentRow | null>((input.supabaseAdmin as any)
    .from("support_attachments")
    .select("id,ticket_id,uploader_id,storage_key,status")
    .eq("id", input.attachmentId)
    .maybeSingle());
  if (found.error || !found.data || found.data.status === "deleted") throwStorageError("not_found");
  if (!input.actor.isAdmin && found.data.uploader_id !== input.actor.userId) throwStorageError("not_found");

  let signed: { data: { signedUrl?: string } | null; error: unknown };
  try {
    signed = await storageFrom(input.supabaseAdmin).createSignedUrl(found.data.storage_key, 300);
  } catch {
    throwStorageError("unavailable");
  }
  if (signed.error || !signed.data?.signedUrl) throwStorageError("unavailable");
  return signed.data.signedUrl;
}

export async function cleanupExpiredSupportAttachments(
  db: SupportDb,
  now: Date,
): Promise<{ deleted: number; deferred: number }> {
  const nowIso = now.toISOString();
  const terminalCutoff = new Date(now.getTime() - TERMINAL_RETENTION_MS).toISOString();
  const pending = await queryResult<AttachmentRow[]>((db as any)
    .from("support_attachments")
    .select("id,storage_key,status,ticket_id")
    .is("ticket_id", null)
    .in("status", ["pending", "ready"])
    .lte("expires_at", nowIso));
  if (pending.error) throwStorageError("unavailable");
  const terminal = await queryResult<AttachmentRow[]>((db as any)
    .from("support_attachments")
    .select("id,storage_key,status,ticket_id,support_tickets!inner(status,resolved_at)")
    .in("support_tickets.status", ["resolved", "rejected"])
    .lte("support_tickets.resolved_at", terminalCutoff));
  if (terminal.error) throwStorageError("unavailable");

  const candidates = new Map<string, AttachmentRow>();
  for (const row of [...(pending.data ?? []), ...(terminal.data ?? [])]) {
    if (isUuid(row.id) && typeof row.storage_key === "string") candidates.set(row.id, row);
  }

  let deleted = 0;
  let deferred = 0;
  for (const row of candidates.values()) {
    let removed: { error: unknown };
    try {
      removed = await storageFrom(db).remove([row.storage_key]);
    } catch {
      deferred += 1;
      continue;
    }
    if (removed.error) {
      deferred += 1;
      continue;
    }
    const finalized = await queryResult<unknown>((db as any)
      .from("support_attachments")
      .update({ status: "deleted", deleted_at: nowIso })
      .eq("id", row.id));
    if (finalized.error) deferred += 1;
    else deleted += 1;
  }
  return { deleted, deferred };
}
