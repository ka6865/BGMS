import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => {
  const postMaybeSingle = vi.fn();
  const likeInsert = vi.fn();
  const likeDelete = vi.fn();
  const incrementLikes = vi.fn();

  const postsChain: any = {
    select: vi.fn(() => postsChain),
    eq: vi.fn(() => postsChain),
    maybeSingle: postMaybeSingle,
  };
  const deleteChain: any = {
    eq: vi.fn(() => deleteChain),
  };
  likeDelete.mockImplementation(() => deleteChain);
  const likesTable = {
    insert: likeInsert,
    delete: likeDelete,
  };
  const admin = {
    from: vi.fn((table: string) => {
      if (table === "posts") return postsChain;
      if (table === "post_likes") return likesTable;
      throw new Error(`unexpected table: ${table}`);
    }),
    rpc: incrementLikes,
  };
  const withAuthGuard = vi.fn();

  return {
    admin,
    withAuthGuard,
    postMaybeSingle,
    likeInsert,
    likeDelete,
    incrementLikes,
  };
});

vi.mock("@/utils/supabase/guard", () => ({
  withAuthGuard: mocks.withAuthGuard,
}));

import { POST as likePost } from "../app/api/mobile/board/posts/[postId]/likes/route";

describe("mobile board recommendation API", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.postMaybeSingle.mockReset();
    mocks.likeInsert.mockReset();
    mocks.incrementLikes.mockReset();
    mocks.withAuthGuard.mockResolvedValue({
      user: { id: "member-1" },
      supabaseAdmin: mocks.admin,
    });
    mocks.likeInsert.mockResolvedValue({ error: null });
    mocks.incrementLikes.mockResolvedValue({ error: null });
    mocks.postMaybeSingle.mockResolvedValue({ data: { id: 10, likes: 4 }, error: null });
  });

  it("회원 추천은 중복 키 저장 후 카운터를 증가시키고 최신 수를 반환한다", async () => {
    const response = await likePost(
      new Request("https://bgms.test/api/mobile/board/posts/10/likes", { method: "POST" }),
      { params: Promise.resolve({ postId: "10" }) },
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ success: true, liked: true, likes: 4 });
    expect(mocks.likeInsert).toHaveBeenCalledWith([{ post_id: 10, user_id: "member-1" }]);
    expect(mocks.incrementLikes).toHaveBeenCalledWith("increment_likes", { row_id: 10 });
  });

  it("중복 추천은 카운터를 다시 증가시키지 않는다", async () => {
    mocks.likeInsert.mockResolvedValueOnce({ error: { code: "23505" } });

    const response = await likePost(
      new Request("https://bgms.test/api/mobile/board/posts/10/likes", { method: "POST" }),
      { params: Promise.resolve({ postId: "10" }) },
    );

    expect(response.status).toBe(409);
    expect(mocks.incrementLikes).not.toHaveBeenCalled();
  });

  it("카운터 저장 실패 시 방금 만든 중복 마커를 정리하고 재시도를 허용한다", async () => {
    mocks.incrementLikes.mockResolvedValueOnce({ error: { message: "db unavailable" } });

    const response = await likePost(
      new Request("https://bgms.test/api/mobile/board/posts/10/likes", { method: "POST" }),
      { params: Promise.resolve({ postId: "10" }) },
    );

    expect(response.status).toBe(503);
    expect(mocks.likeDelete).toHaveBeenCalledWith();
  });
});
