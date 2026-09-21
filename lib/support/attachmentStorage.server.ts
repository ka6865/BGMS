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
  | "upload_metadata_invalid"
  | "upload_metadata_mismatch"
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
  status: "pending" | "ready" | "deleting" | "deleted";
  mime_type?: string;
  byte_size?: number;
  original_name?: string;
};

type StorageObjectRow = {
  name?: string;
  metadata?: unknown;
};

type UploadedObjectMeta = {
  mimeType: string;
  byteSize: number;
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

function isMissingStorageObjectError(value: unknown): boolean {
  const candidate = typeof value === "object" && value !== null ? value as Record<string, unknown> : null;
  const status = Number(candidate?.status ?? candidate?.statusCode ?? candidate?.httpStatus);
  if (status === 404) return true;
  const message = value instanceof Error ? value.message : candidate && "message" in candidate
    ? String(candidate.message ?? "") : String(value ?? "");
  return /not.?found|no such key|does not exist|404/i.test(message);
}

function errorFromValidation(code: string): SupportAttachmentError {
  if (code === "unsupported_mime") return new SupportAttachmentError("unsupported_mime");
  if (code === "attachment_too_large") return new SupportAttachmentError("attachment_too_large");
  return new SupportAttachmentError("attachment_size_invalid");
}

function parseUploadedObjectMeta(value: unknown): UploadedObjectMeta | null {
  if (!value || typeof value !== "object") return null;
  const metadata = value as Record<string, unknown>;
  const rawMimeType = metadata.mimetype ?? metadata.mimeType ?? metadata.contentType;
  const rawByteSize = metadata.size ?? metadata.byteSize;
  const mimeType = typeof rawMimeType === "string" ? rawMimeType.trim().toLowerCase() : "";
  const byteSize = typeof rawByteSize === "number"
    ? rawByteSize
    : typeof rawByteSize === "string" && rawByteSize.trim() !== ""
      ? Number(rawByteSize)
      : NaN;
  if (!mimeType || !Number.isSafeInteger(byteSize) || byteSize <= 0) return null;
  return { mimeType, byteSize };
}

async function inspectUploadedObject(
  db: SupportDb,
  attachment: Pick<AttachmentRow, "storage_key" | "mime_type" | "byte_size">,
  attachmentId: string,
): Promise<UploadedObjectMeta> {
  let listed: { data: Array<{ name?: string }> | null; error: unknown };
  try {
    listed = await storageFrom(db).list("attachments", { search: attachmentId });
  } catch {
    throwStorageError("unavailable");
  }
  const storageName = attachment.storage_key.split("/").pop() ?? attachmentId;
  const listedObject = !listed.error && (listed.data ?? []).some((item) => (
    item.name === storageName || item.name === attachment.storage_key || item.name?.endsWith(`/${storageName}`)
  ));
  if (!listedObject) throwStorageError("upload_missing");

  const schema = (db as any).schema;
  if (typeof schema !== "function") throwStorageError("unavailable");
  let objectResult: { data: StorageObjectRow | null; error: { message?: string } | null };
  try {
    objectResult = await queryResult<StorageObjectRow | null>(schema("storage")
      .from("objects")
      .select("name,metadata")
      .eq("bucket_id", SUPPORT_EVIDENCE_BUCKET)
      .eq("name", attachment.storage_key)
      .maybeSingle());
  } catch {
    throwStorageError("unavailable");
  }
  if (objectResult.error) throwStorageError("unavailable");
  if (!objectResult.data) throwStorageError("upload_missing");

  const uploaded = parseUploadedObjectMeta(objectResult.data.metadata);
  if (!uploaded || !attachment.mime_type || typeof attachment.byte_size !== "number") {
    throwStorageError("upload_metadata_invalid");
  }
  if (uploaded.mimeType !== attachment.mime_type.trim().toLowerCase() || uploaded.byteSize !== attachment.byte_size) {
    throwStorageError("upload_metadata_mismatch");
  }
  return uploaded;
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
  const originalName = sanitizeOriginalName(input.originalName);

  const reserveRpc = (input.supabaseAdmin as any).rpc;
  if (typeof reserveRpc === "function") {
    let reserved: { data: Array<{ id?: string; bucket_id?: string; storage_key?: string }> | null; error: { message?: string; code?: string } | null };
    try {
      reserved = await reserveRpc("reserve_support_attachment", {
        p_owner_user_id: input.ownerUserId,
        p_mime_type: meta.value.mimeType,
        p_byte_size: meta.value.byteSize,
        p_original_name: originalName,
      });
    } catch {
      throwStorageError("unavailable");
    }
    if (reserved.error) {
      if (reserved.error.message?.includes("support_attachment_quota")) throwStorageError("attachment_quota");
      if (reserved.error.message?.includes("support_attachment_invalid_input")) throwStorageError("invalid_input");
      throwStorageError("unavailable");
    }
    const row = reserved.data?.[0];
    if (!row?.id || !row.bucket_id || !row.storage_key) throwStorageError("unavailable");
    let signed: { data: { token?: string } | null; error: unknown };
    try {
      signed = await storageFrom(input.supabaseAdmin).createSignedUploadUrl(row.storage_key, { upsert: false });
    } catch {
      throwStorageError("unavailable");
    }
    if (signed.error || !signed.data?.token) throwStorageError("unavailable");
    return { attachmentId: row.id, bucketId: row.bucket_id, storageKey: row.storage_key, token: signed.data.token };
  }

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
      original_name: originalName,
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
    .select("id,ticket_id,uploader_id,storage_key,status,mime_type,byte_size")
    .eq("id", input.attachmentId)
    .maybeSingle());
  if (found.error || !found.data || found.data.uploader_id !== input.ownerUserId || found.data.status === "deleted") {
    throwStorageError("not_found");
  }
  if (found.data.status === "ready") return { attachmentId: found.data.id, status: "ready" };

  const rpc = (input.supabaseAdmin as any).rpc;
  if (typeof rpc === "function") {
    let completion: { data: string | null; error: { message?: string } | null };
    try {
      completion = await rpc("complete_support_attachment", {
        p_attachment_id: input.attachmentId,
        p_owner_user_id: input.ownerUserId,
      });
    } catch {
      throwStorageError("unavailable");
    }
    if (completion.error) throwStorageError("unavailable");
    if (completion.data === "upload_missing") throwStorageError("upload_missing");
    if (completion.data === "upload_metadata_invalid") throwStorageError("upload_metadata_invalid");
    if (completion.data === "upload_metadata_mismatch") throwStorageError("upload_metadata_mismatch");
    if (completion.data !== "ready") throwStorageError("not_found");
    return { attachmentId: input.attachmentId, status: "ready" };
  }

  await inspectUploadedObject(input.supabaseAdmin, found.data, input.attachmentId);

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
  if (found.error || !found.data || found.data.status !== "ready") throwStorageError("not_found");
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
    .in("status", ["pending", "ready", "deleting"])
    .lte("expires_at", nowIso));
  if (pending.error) throwStorageError("unavailable");
  const terminal = await queryResult<AttachmentRow[]>((db as any)
    .from("support_attachments")
    .select("id,storage_key,status,ticket_id,support_tickets!inner(status,resolved_at)")
    .in("status", ["pending", "ready", "deleting"])
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
    let claimed: { data: AttachmentRow | null; error: { message?: string } | null };
    const rpc = (db as any).rpc;
    if (typeof rpc === "function") {
      try {
        const result = await rpc("claim_support_attachment_cleanup", {
          p_attachment_id: row.id,
          p_now: nowIso,
        });
        const data = Array.isArray(result?.data) ? result.data[0] ?? null : result?.data ?? null;
        claimed = {
          data: data ? { ...data, status: "deleting" } as AttachmentRow : null,
          error: result?.error ?? null,
        };
      } catch {
        claimed = { data: null, error: { message: "cleanup_claim_failed" } };
      }
    } else {
      const claimQuery = (db as any)
        .from("support_attachments")
        .update({ status: "deleting" })
        .eq("id", row.id)
        .eq("status", row.status);
      const scopedClaim = row.ticket_id
        ? claimQuery.eq("ticket_id", row.ticket_id)
        : claimQuery.is("ticket_id", null);
      claimed = await queryResult<AttachmentRow | null>(scopedClaim
        .select("id,ticket_id,storage_key,status")
        .maybeSingle());
    }
    if (claimed.error || !claimed.data) {
      deferred += 1;
      continue;
    }

    const originalStatus = row.status;
    const claimedRow = claimed.data;

    let removed: { error: unknown };
    try {
      removed = await storageFrom(db).remove([claimedRow.storage_key]);
    } catch {
      await (db as any).from("support_attachments").update({ status: originalStatus }).eq("id", row.id).eq("status", "deleting");
      deferred += 1;
      continue;
    }
    if (removed.error && !isMissingStorageObjectError(removed.error)) {
      await (db as any).from("support_attachments").update({ status: originalStatus }).eq("id", row.id).eq("status", "deleting");
      deferred += 1;
      continue;
    }
    if (claimedRow.ticket_id) {
      // Keep the audit event ahead of finalization. If the event table is
      // temporarily unavailable, the row remains `deleting` and the next run
      // retries the event; missing-object errors are treated as an already
      // completed storage deletion below.
      const eventResult = await (db as any).from("support_ticket_events").insert({
        ticket_id: claimedRow.ticket_id,
        actor_id: null,
        event_type: "retention_deleted",
        metadata: { attachment_id: row.id },
      });
      if (eventResult?.error && eventResult.error.code !== "23505") {
        deferred += 1;
        continue;
      }
    }
    const finalized = await queryResult<unknown>((db as any)
      .from("support_attachments")
      .update({ status: "deleted", deleted_at: nowIso })
      .eq("id", row.id)
      .eq("status", "deleting"));
    if (finalized.error) {
      deferred += 1;
      continue;
    }
    deleted += 1;
  }
  return { deleted, deferred };
}
