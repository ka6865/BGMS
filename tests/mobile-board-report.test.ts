import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => {
  const auth = vi.fn();
  const maybeSingle = vi.fn();
  const reportQueries: Array<{ table: string; filters: Array<[string, unknown]>; count: boolean }> = [];
  const inserts = vi.fn();

  const admin = {
    from: vi.fn((table: string) => {
      const query = { table, filters: [] as Array<[string, unknown]>, count: false };
      const chain: any = {
        select: vi.fn((_columns: string, options?: { count?: string }) => {
          query.count = options?.count === "exact";
          reportQueries.push(query);
          return chain;
        }),
        eq: vi.fn((column: string, value: unknown) => {
          query.filters.push([column, value]);
          return chain;
        }),
        maybeSingle: vi.fn(() => maybeSingle(table, query)),
        limit: vi.fn(() => Promise.resolve({ data: [], error: null })),
        insert: vi.fn((rows: unknown) => inserts(table, rows)),
        then: (resolve: (value: unknown) => unknown, reject: (reason: unknown) => unknown) =>
          Promise.resolve({ count: 1, error: null }).then(resolve, reject),
      };
      return chain;
    }),
  };

  return { auth, admin, maybeSingle, reportQueries, inserts };
});

vi.mock("@/utils/supabase/guard", () => ({ withOptionalAuth: mocks.auth }));
vi.mock("@/lib/board/ipUtils", () => ({ extractClientIp: () => "203.0.113.10" }));

import { POST } from "../app/api/board/report/route";

describe("board report target boundary", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.reportQueries.length = 0;
    mocks.auth.mockResolvedValue({ user: null, supabaseAdmin: mocks.admin });
    mocks.maybeSingle.mockImplementation((table: string) => Promise.resolve({
      data: table === "posts" ? { id: 42 } : null,
      error: null,
    }));
    mocks.inserts.mockResolvedValue({ error: null });
  });

  it("malformed JSON returns 400", async () => {
    const response = await POST(new Request("https://bgms.test/api/board/report", {
      method: "POST",
      body: "{",
    }));

    expect(response.status).toBe(400);
    expect(mocks.admin.from).not.toHaveBeenCalled();
  });

  it("rejects a hidden post before inserting a report", async () => {
    mocks.maybeSingle.mockResolvedValueOnce({ data: null, error: null });
    const response = await POST(new Request("https://bgms.test/api/board/report", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ target_type: "post", target_id: 42, reason: "부적절한 내용" }),
    }));

    expect(response.status).toBe(404);
    expect(mocks.inserts).not.toHaveBeenCalled();
  });

  it("accepts the numeric target IDs sent by the existing web report callers", async () => {
    const response = await POST(new Request("https://bgms.test/api/board/report", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ target_type: "post", target_id: 42, reason: "부적절한 내용" }),
    }));

    expect(response.status).toBe(200);
    expect(mocks.inserts).toHaveBeenCalledWith("reports", [expect.objectContaining({
      target_type: "post",
      target_id: 42,
      reporter_ip: "203.0.113.10",
    })]);
  });
});
