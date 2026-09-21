import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextResponse } from "next/server";
import type { SupportDb } from "@/lib/support/contracts";
import {
  cleanupExpiredSupportAttachments,
  completeSupportAttachment,
  getSupportAttachmentSignedUrl,
  reserveSupportAttachment,
} from "@/lib/support/attachmentStorage.server";
import { withAuthGuard } from "@/utils/supabase/guard";
import { POST as reservePOST } from "@/app/api/support/attachments/reserve/route";

vi.mock("@/utils/supabase/guard", () => ({
  withAuthGuard: vi.fn(),
}));

const mockedWithAuthGuard = vi.mocked(withAuthGuard);

function resolvedQuery<T>(result: T) {
  const query: Record<string, ReturnType<typeof vi.fn>> & { then?: unknown } = {};
  for (const method of ["select", "eq", "is", "neq", "in", "lte", "insert", "update", "delete", "order", "limit"]) {
    query[method] = vi.fn(() => query);
  }
  query.maybeSingle = vi.fn().mockResolvedValue(result);
  query.single = vi.fn().mockResolvedValue(result);
  query.then = (resolve: (value: T) => unknown, reject?: (reason: unknown) => unknown) => Promise.resolve(result).then(resolve, reject);
  return query;
}

function storageFake(options: {
  uploadToken?: string;
  objectExists?: boolean;
  objectName?: string;
  objectMetadata?: unknown;
  storageObjectExists?: boolean;
  readUrl?: string;
  removeError?: Error | null;
}) {
  const list = vi.fn().mockResolvedValue({
    data: options.objectExists === false ? [] : [{ name: options.objectName ?? "attachment-object" }],
    error: null,
  });
  const createSignedUploadUrl = vi.fn().mockResolvedValue({
    data: { token: options.uploadToken ?? "upload-token" },
    error: null,
  });
  const createSignedUrl = vi.fn().mockResolvedValue({
    data: { signedUrl: options.readUrl ?? "https://signed.invalid/evidence" },
    error: null,
  });
  const remove = vi.fn().mockResolvedValue({ error: options.removeError ?? null });
  const storageObjectQuery = resolvedQuery({
    data: options.storageObjectExists === false ? null : {
      name: options.objectName ?? "attachment-object",
      metadata: options.objectMetadata ?? { mimetype: "image/png", size: 100 },
    },
    error: null,
  });
  return {
    storage: {
      from: vi.fn(() => ({ list, createSignedUploadUrl, createSignedUrl, remove })),
    },
    schema: vi.fn(() => ({ from: vi.fn(() => storageObjectQuery) })),
    list,
    createSignedUploadUrl,
    createSignedUrl,
    remove,
  };
}

describe("support attachment storage", () => {
  beforeEach(() => vi.clearAllMocks());

  it("rejects an unauthenticated reserve route before touching storage", async () => {
    mockedWithAuthGuard.mockResolvedValue({
      error: NextResponse.json({ error: "로그인이 필요합니다." }, { status: 401 }),
    });

    const response = await reservePOST(new Request("http://localhost/api/support/attachments/reserve", {
      method: "POST",
      body: JSON.stringify({ mimeType: "image/png", byteSize: 100, originalName: "proof.png" }),
      headers: { "content-type": "application/json" },
    }));

    expect(response.status).toBe(401);
  });

  it("reserves an unlinked attachment with a private storage key", async () => {
    const quotaQuery = resolvedQuery({ data: [], error: null });
    const insertQuery = resolvedQuery({
      data: {
        id: "11111111-1111-4111-8111-111111111111",
        bucket_id: "support-evidence",
        storage_key: "attachments/11111111-1111-4111-8111-111111111111",
      },
      error: null,
    });
    const db = {
      from: vi.fn()
        .mockReturnValueOnce(quotaQuery)
        .mockReturnValueOnce(insertQuery),
      ...storageFake({}),
    } as unknown as SupportDb;

    const result = await reserveSupportAttachment({
      supabaseAdmin: db,
      ownerUserId: "user-a",
      mimeType: "image/png",
      byteSize: 100,
      originalName: "screenshots/proof.png",
    });

    expect(result.storageKey).toMatch(/^attachments\/[0-9a-f-]+$/);
    expect(insertQuery.insert).toHaveBeenCalledWith(expect.objectContaining({
      ticket_id: null,
      uploader_id: "user-a",
      status: "pending",
      original_name: "screenshots_proof.png",
    }));
    expect((db as any).storage.from).toHaveBeenCalledWith("support-evidence");
  });

  it("does not mark a missing uploaded object ready", async () => {
    const attachmentQuery = resolvedQuery({
      data: {
        id: "11111111-1111-4111-8111-111111111111",
        uploader_id: "user-a",
        ticket_id: null,
        storage_key: "attachments/11111111-1111-4111-8111-111111111111",
        status: "pending",
      },
      error: null,
    });
    const storage = storageFake({ objectExists: false });
    const db = {
      from: vi.fn(() => attachmentQuery),
      ...storage,
    } as unknown as SupportDb;

    await expect(completeSupportAttachment({
      supabaseAdmin: db,
      ownerUserId: "user-a",
      attachmentId: "11111111-1111-4111-8111-111111111111",
    })).rejects.toMatchObject({ code: "upload_missing" });
    expect(attachmentQuery.update).not.toHaveBeenCalled();
  });

  it("marks an uploaded object ready only when storage metadata matches the reservation", async () => {
    const attachmentId = "11111111-1111-4111-8111-111111111111";
    const attachmentQuery = resolvedQuery({
      data: {
        id: attachmentId,
        uploader_id: "user-a",
        ticket_id: null,
        storage_key: `attachments/${attachmentId}`,
        status: "pending",
        mime_type: "image/png",
        byte_size: 100,
      },
      error: null,
    });
    const storage = storageFake({
      objectName: attachmentId,
      objectMetadata: { mimetype: "image/png", size: 100 },
    });
    const db = { from: vi.fn(() => attachmentQuery), ...storage } as unknown as SupportDb;

    await expect(completeSupportAttachment({
      supabaseAdmin: db,
      ownerUserId: "user-a",
      attachmentId,
    })).resolves.toEqual({ attachmentId, status: "ready" });
    expect(attachmentQuery.update).toHaveBeenCalledWith({ status: "ready" });
  });

  it("rejects a storage object whose actual size or MIME differs from the reservation", async () => {
    const attachmentId = "11111111-1111-4111-8111-111111111111";
    const attachmentQuery = resolvedQuery({
      data: {
        id: attachmentId,
        uploader_id: "user-a",
        ticket_id: null,
        storage_key: `attachments/${attachmentId}`,
        status: "pending",
        mime_type: "image/png",
        byte_size: 100,
      },
      error: null,
    });
    const storage = storageFake({
      objectName: attachmentId,
      objectMetadata: { mimetype: "image/jpeg", size: 101 },
    });
    const db = { from: vi.fn(() => attachmentQuery), ...storage } as unknown as SupportDb;

    await expect(completeSupportAttachment({
      supabaseAdmin: db,
      ownerUserId: "user-a",
      attachmentId,
    })).rejects.toMatchObject({ code: "upload_metadata_mismatch" });
    expect(attachmentQuery.update).not.toHaveBeenCalled();
  });

  it("allows an owner or admin to sign a URL but hides it from another user", async () => {
    const row = {
      id: "11111111-1111-4111-8111-111111111111",
      uploader_id: "user-a",
      ticket_id: "22222222-2222-4222-8222-222222222222",
      storage_key: "attachments/11111111-1111-4111-8111-111111111111",
      status: "ready",
    };
    const storage = storageFake({ readUrl: "https://signed.invalid/proof" });
    const db = { from: vi.fn(() => resolvedQuery({ data: row, error: null })), ...storage } as unknown as SupportDb;

    await expect(getSupportAttachmentSignedUrl({
      supabaseAdmin: db,
      attachmentId: row.id,
      actor: { userId: "user-b", isAdmin: false },
    })).rejects.toMatchObject({ code: "not_found" });
    await expect(getSupportAttachmentSignedUrl({
      supabaseAdmin: db,
      attachmentId: row.id,
      actor: { userId: "user-a", isAdmin: false },
    })).resolves.toBe("https://signed.invalid/proof");
    await expect(getSupportAttachmentSignedUrl({
      supabaseAdmin: db,
      attachmentId: row.id,
      actor: { userId: "admin", isAdmin: true },
    })).resolves.toBe("https://signed.invalid/proof");
  });

  it("cleans expired attachments but defers storage failures", async () => {
    const expired = {
      id: "11111111-1111-4111-8111-111111111111",
      storage_key: "attachments/11111111-1111-4111-8111-111111111111",
      status: "pending",
      ticket_id: null,
    };
    const terminal = {
      id: "22222222-2222-4222-8222-222222222222",
      storage_key: "attachments/22222222-2222-4222-8222-222222222222",
      status: "ready",
      ticket_id: "ticket-a",
    };
    const pendingQuery = resolvedQuery({ data: [expired], error: null });
    const terminalQuery = resolvedQuery({ data: [terminal], error: null });
    const pendingClaim = resolvedQuery({ data: { ...expired, status: "deleting" }, error: null });
    const pendingFinal = resolvedQuery({ data: null, error: null });
    const terminalClaim = resolvedQuery({ data: { ...terminal, status: "deleting" }, error: null });
    const retentionEvent = resolvedQuery({ data: null, error: null });
    const terminalFinal = resolvedQuery({ data: null, error: null });
    const storage = storageFake({});
    const db = {
      from: vi.fn()
        .mockReturnValueOnce(pendingQuery)
        .mockReturnValueOnce(terminalQuery)
        .mockReturnValueOnce(pendingClaim)
        .mockReturnValueOnce(pendingFinal)
        .mockReturnValueOnce(terminalClaim)
        .mockReturnValueOnce(retentionEvent)
        .mockReturnValueOnce(terminalFinal),
      ...storage,
    } as unknown as SupportDb;

    const result = await cleanupExpiredSupportAttachments(db, new Date("2026-10-31T00:00:00.000Z"));

    expect(result).toEqual({ deleted: 2, deferred: 0 });
    expect(storage.remove).toHaveBeenCalledTimes(2);
    expect(pendingFinal.update).toHaveBeenCalledWith(expect.objectContaining({ status: "deleted" }));
  });
});
