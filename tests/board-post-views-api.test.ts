import { createHash, createHmac } from "node:crypto";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => {
  const rpc = vi.fn();
  const createClient = vi.fn();

  return { rpc, createClient };
});

vi.mock("@supabase/supabase-js", () => ({
  createClient: mocks.createClient,
}));

vi.stubEnv("NEXT_PUBLIC_SUPABASE_URL", "https://test.supabase.co");
vi.stubEnv("SUPABASE_SERVICE_ROLE_KEY", "test-key");

import { POST as viewPost } from "../app/api/board/posts/[postId]/views/route";

function request(postId = "10", clientIp = "192.168.1.100") {
  const req = new Request(`https://bgms.test/api/board/posts/${postId}/views`, { method: "POST" });
  Object.defineProperty(req, "headers", {
    value: new Map([["x-forwarded-for", clientIp]]),
    writable: false,
  });

  return viewPost(req, { params: Promise.resolve({ postId }) });
}

describe("board post views API", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.createClient.mockReturnValue({ rpc: mocks.rpc });
    mocks.rpc.mockResolvedValue({ data: { status: "counted", views: 5 }, error: null });
  });

  it("increments views using the atomic RPC and returns the updated count", async () => {
    mocks.rpc.mockResolvedValue({ data: { status: "counted", views: 5 }, error: null });

    const response = await request();

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ success: true, views: 5 });
    expect(mocks.rpc).toHaveBeenCalledExactlyOnceWith("increment_board_post_views", {
      p_post_id: 10,
      p_ip_hash: expect.stringMatching(/^[a-f0-9]{64}$/),
    });
  });

  it("stores a keyed IP hash that plain SHA-256 cannot reproduce", async () => {
    await request("10", "203.0.113.7");

    const { p_ip_hash: ipHash } = mocks.rpc.mock.calls[0][1] as { p_ip_hash: string };
    expect(ipHash).toBe(createHmac("sha256", "test-key").update("203.0.113.7").digest("hex"));
    expect(ipHash).not.toBe(createHash("sha256").update("203.0.113.7").digest("hex"));
  });

  it("returns the current count without error when the view was already counted", async () => {
    mocks.rpc.mockResolvedValue({ data: { status: "already_counted", views: 1 }, error: null });

    const response = await request();

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ success: true, views: 1 });
  });

  it("maps a missing or unpublished post to 404", async () => {
    mocks.rpc.mockResolvedValueOnce({ data: { status: "not_found" }, error: null });

    const response = await request();

    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ error: "게시글을 찾을 수 없습니다." });
  });

  it("returns 503 on an RPC error without falling back to direct writes", async () => {
    mocks.rpc.mockResolvedValueOnce({ data: null, error: { message: "function unavailable" } });

    const response = await request();

    expect(response.status).toBe(503);
    expect(mocks.rpc).toHaveBeenCalledTimes(1);
  });

  it("returns 503 when the RPC transport rejects without falling back to direct writes", async () => {
    mocks.rpc.mockRejectedValueOnce(new Error("connection closed after commit"));

    const response = await request();

    expect(response.status).toBe(503);
    expect(mocks.rpc).toHaveBeenCalledTimes(1);
  });

  it("rejects malformed RPC acknowledgements instead of claiming a view", async () => {
    mocks.rpc.mockResolvedValueOnce({ data: { status: "counted", views: "5" }, error: null });

    const response = await request();

    expect(response.status).toBe(503);
  });

  it("rejects invalid post IDs", async () => {
    const response = await viewPost(
      new Request(`https://bgms.test/api/board/posts/invalid/views`, { method: "POST" }),
      { params: Promise.resolve({ postId: "invalid" }) },
    );

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: "게시글 ID가 올바르지 않습니다." });
    expect(mocks.rpc).not.toHaveBeenCalled();
  });

  it("extracts client IP from x-forwarded-for header", async () => {
    mocks.rpc.mockResolvedValue({ data: { status: "counted", views: 1 }, error: null });

    const req = new Request(`https://bgms.test/api/board/posts/10/views`, { method: "POST" });
    Object.defineProperty(req, "headers", {
      value: new Map([["x-forwarded-for", "203.0.113.45, 198.51.100.10"]]),
      writable: false,
    });

    await viewPost(req, { params: Promise.resolve({ postId: "10" }) });

    const callArg = mocks.rpc.mock.calls[0][1];
    expect(callArg.p_ip_hash).toBeDefined();
    expect(typeof callArg.p_ip_hash).toBe("string");
    expect(callArg.p_ip_hash).toMatch(/^[a-f0-9]{64}$/);
  });
});
