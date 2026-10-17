import { describe, expect, it, vi } from "vitest";
import { cleanupExpiredSupportAttachments } from "@/lib/support/attachmentStorage.server";
import { resolveSupportAttachmentCleanupMode, runSupportAttachmentCleanup } from "@/scripts/cleanup_support_attachments";

const expiredPending = { id: "11111111-1111-4111-8111-111111111111", storage_key: "attachments/pending", status: "pending", ticket_id: null };
const oldTerminal = { id: "22222222-2222-4222-8222-222222222222", storage_key: "attachments/terminal", status: "ready", ticket_id: "ticket-1" };

function queryResult(data: unknown, error: unknown = null) {
  const query: any = {
    data,
    error,
    select() { return this; },
    is() { return this; },
    in() { return this; },
    lte() { return this; },
    eq() { return this; },
    update() { return this; },
    insert() { return this; },
    maybeSingle() { return Promise.resolve({ data: this.data, error: this.error }); },
    then(resolve: (value: unknown) => unknown, reject?: (reason: unknown) => unknown) { return Promise.resolve({ data: this.data, error: this.error }).then(resolve, reject); },
  };
  return query;
}

function makeDb(remove: ReturnType<typeof vi.fn>) {
  let claimRow = 0;
  const db: any = {
    from(table: string) {
      if (table !== "support_attachments") return queryResult([], null);
      return {
        select(selection: string) {
          return selection.includes("support_tickets")
            ? queryResult([oldTerminal], null)
            : queryResult([expiredPending], null);
        },
        update(values: { status?: string }) {
          if (values.status === "deleting") {
            const source = claimRow++ === 0 ? expiredPending : oldTerminal;
            return queryResult({ ...source, status: "deleting" }, null);
          }
          return queryResult(null, null);
        },
      };
    },
    storage: { from: () => ({ remove }) },
  };
  return db;
}

describe("support attachment cleanup", () => {
  it("defaults to dry-run and requires explicit apply", async () => {
    expect(resolveSupportAttachmentCleanupMode([])).toBe("dry-run");
    expect(resolveSupportAttachmentCleanupMode(["--dry-run"])).toBe("dry-run");
    expect(resolveSupportAttachmentCleanupMode(["--apply"])).toBe("apply");
    expect(() => resolveSupportAttachmentCleanupMode(["--force"])).toThrow();
    await expect(runSupportAttachmentCleanup({ env: {} })).rejects.toThrow("credentials-missing");
  });

  it("inspects candidates without mutating in dry-run mode", async () => {
    const writes: string[] = [];
    const remove = vi.fn().mockResolvedValue({ error: null });
    const db = makeDb(remove);
    // 테이블·스토리지 쓰기 메서드 접근을 모두 기록해 dry-run 무쓰기를 직접 확인한다
    const mutations: string[] = [];
    const readFrom = db.from.bind(db);
    db.from = (table: string) => new Proxy(readFrom(table), {
      get(target, property) {
        if (typeof property === "string" && ["insert", "update", "upsert", "delete"].includes(property)) {
          mutations.push(`${table}.${property}`);
        }
        return target[property];
      },
    });
    db.storage = { from: (bucket: string) => ({ remove: (...args: unknown[]) => { mutations.push(`storage:${bucket}.remove`); return remove(...args); } }) };

    const result = await runSupportAttachmentCleanup({
      dryRun: true,
      env: { NEXT_PUBLIC_SUPABASE_URL: "https://example.supabase.co", SUPABASE_SERVICE_ROLE_KEY: "service-role" },
      createServiceClient: () => db,
      now: () => new Date("2026-09-21T00:00:00.000Z"),
      write: (message) => writes.push(message),
    });
    expect(result).toEqual({ candidates: 2, pending: 1, terminal: 1 });
    expect(writes[0]).toContain("mode=dry-run");
    expect(mutations).toEqual([]);
    expect(remove).not.toHaveBeenCalled();
  });

  it("removes expired unlinked and old terminal objects, then marks rows deleted", async () => {
    const remove = vi.fn().mockResolvedValue({ error: null });
    const db = makeDb(remove);
    const result = await cleanupExpiredSupportAttachments(db, new Date("2026-09-21T00:00:00.000Z"));
    expect(remove).toHaveBeenCalledWith(["attachments/pending"]);
    expect(remove).toHaveBeenCalledWith(["attachments/terminal"]);
    expect(result).toEqual({ deleted: 2, deferred: 0 });
  });

  it("defers a storage failure and never reports that object as deleted", async () => {
    const remove = vi.fn().mockResolvedValue({ error: new Error("storage unavailable") });
    const db = makeDb(remove);
    await expect(cleanupExpiredSupportAttachments(db, new Date("2026-09-21T00:00:00.000Z"))).resolves.toEqual({ deleted: 0, deferred: 2 });
  });

  it("treats a storage 404 status as an already-removed object", async () => {
    const remove = vi.fn().mockResolvedValue({ error: { status: 404 } });
    const db = makeDb(remove);
    await expect(cleanupExpiredSupportAttachments(db, new Date("2026-09-21T00:00:00.000Z"))).resolves.toEqual({ deleted: 2, deferred: 0 });
  });
});
