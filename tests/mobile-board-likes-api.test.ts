import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => {
  const rpc = vi.fn();
  const from = vi.fn();
  const admin = { from, rpc };
  const withAuthGuard = vi.fn();

  return { admin, from, rpc, withAuthGuard };
});

vi.mock("@/utils/supabase/guard", () => ({
  withAuthGuard: mocks.withAuthGuard,
}));

import { POST as likePost } from "../app/api/mobile/board/posts/[postId]/likes/route";

const USER_ID = "11111111-1111-4111-8111-111111111111";

function request(postId = "10") {
  return likePost(
    new Request(`https://bgms.test/api/mobile/board/posts/${postId}/likes`, { method: "POST" }),
    { params: Promise.resolve({ postId }) },
  );
}

describe("mobile board recommendation API", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.withAuthGuard.mockResolvedValue({
      user: { id: USER_ID },
      supabaseAdmin: mocks.admin,
    });
    mocks.rpc.mockResolvedValue({ data: { status: "liked", likes: 5 }, error: null });
  });

  it("uses one atomic RPC and returns its acknowledged count", async () => {
    const response = await request();

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ success: true, liked: true, likes: 5 });
    expect(mocks.rpc).toHaveBeenCalledExactlyOnceWith("recommend_mobile_board_post", {
      p_post_id: 10,
      p_user_id: USER_ID,
    });
    expect(mocks.from).not.toHaveBeenCalled();
  });

  it("preserves the duplicate response without issuing any compensating write", async () => {
    mocks.rpc.mockResolvedValueOnce({ data: { status: "already_liked", likes: 5 }, error: null });

    const response = await request();

    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({ error: "이미 추천한 게시글입니다." });
    expect(mocks.rpc).toHaveBeenCalledTimes(1);
    expect(mocks.from).not.toHaveBeenCalled();
  });

  it("maps a missing or unpublished post to 404", async () => {
    mocks.rpc.mockResolvedValueOnce({ data: { status: "not_found", likes: null }, error: null });

    const response = await request();

    expect(response.status).toBe(404);
    expect(mocks.from).not.toHaveBeenCalled();
  });

  it("returns 503 on an RPC error without falling back to direct writes", async () => {
    mocks.rpc.mockResolvedValueOnce({ data: null, error: { message: "function unavailable" } });

    const response = await request();

    expect(response.status).toBe(503);
    expect(mocks.rpc).toHaveBeenCalledTimes(1);
    expect(mocks.from).not.toHaveBeenCalled();
  });

  it("returns 503 when the RPC transport rejects without falling back to direct writes", async () => {
    mocks.rpc.mockRejectedValueOnce(new Error("connection closed after commit"));

    const response = await request();

    expect(response.status).toBe(503);
    expect(mocks.rpc).toHaveBeenCalledTimes(1);
    expect(mocks.from).not.toHaveBeenCalled();
  });

  it("rejects malformed RPC acknowledgements instead of claiming a like", async () => {
    mocks.rpc.mockResolvedValueOnce({ data: { status: "liked", likes: "5" }, error: null });

    const response = await request();

    expect(response.status).toBe(503);
    expect(mocks.from).not.toHaveBeenCalled();
  });

  it("requires a UUID from the authenticated user before calling the RPC", async () => {
    mocks.withAuthGuard.mockResolvedValueOnce({
      user: { id: "member-1" },
      supabaseAdmin: mocks.admin,
    });

    const response = await request();

    expect(response.status).toBe(401);
    expect(mocks.rpc).not.toHaveBeenCalled();
  });
});
