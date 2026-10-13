import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ createClient: vi.fn(), compare: vi.fn() }));
vi.mock("@supabase/supabase-js", () => ({ createClient: mocks.createClient }));
vi.mock("bcryptjs", () => ({ default: { compare: mocks.compare } }));

import { POST as deletePost } from "../app/api/board/posts/delete/route";
import { POST as deleteComment } from "../app/api/board/comments/delete/route";

function database(input: { userId?: string | null; legacyHash?: string | null; secretHash?: string | null } = {}) {
  const writes: string[] = [];
  const from = vi.fn((table: string) => {
    let deleting = false;
    const result = () => ({ data: deleting ? null : table.endsWith("_delete_credentials")
      ? (input.secretHash ? { password_hash: input.secretHash } : null)
      : { id: 7, user_id: input.userId ?? null, password_hash: input.legacyHash ?? null }, error: null });
    const query = {
      select: vi.fn(() => query), eq: vi.fn(() => query),
      delete: vi.fn(() => { deleting = true; writes.push(table); return query; }),
      single: vi.fn(async () => result()), maybeSingle: vi.fn(async () => result()),
      then: (resolve: (value: ReturnType<typeof result>) => unknown) => Promise.resolve(result()).then(resolve),
    };
    return query;
  });
  return { from, rpc: vi.fn(async () => ({ data: true as boolean | null, error: null as unknown })), writes };
}

const routes = [
  { name: "글", handler: deletePost, idField: "postId", scope: "post_delete", table: "posts", secretTable: "board_post_delete_credentials" },
  { name: "댓글", handler: deleteComment, idField: "commentId", scope: "comment_delete", table: "comments", secretTable: "board_comment_delete_credentials" },
] as const;

function request(body: unknown) {
  return new Request("https://bgms.test/api/board/delete", { method: "POST", headers: { "content-type": "application/json", "x-forwarded-for": "203.0.113.7" }, body: JSON.stringify(body) });
}

beforeEach(() => { vi.clearAllMocks(); mocks.compare.mockResolvedValue(true); });

describe.each(routes)("비회원 $name 삭제", (route) => {
  it("공개 행의 해시가 이동했어도 서버 전용 해시로 기존 비밀번호를 검증한다", async () => {
    const db = database({ secretHash: "preserved-hash" }); mocks.createClient.mockReturnValue(db);
    const response = await route.handler(request({ [route.idField]: 7, password: "original password" }));
    expect(response.status).toBe(200);
    expect(mocks.compare).toHaveBeenCalledWith("original password", "preserved-hash");
    expect(db.from).toHaveBeenCalledWith(route.secretTable);
    expect(db.writes).toContain(route.table);
  });

  it("migration 전의 기존 해시와 72바이트가 넘는 비밀번호도 유지한다", async () => {
    const bcrypt = await vi.importActual<typeof import("bcryptjs")>("bcryptjs");
    const password = "기존 비밀번호".repeat(12);
    const hash = await bcrypt.hash(password, 4);
    const db = database({ legacyHash: hash }); mocks.createClient.mockReturnValue(db);
    mocks.compare.mockImplementation(bcrypt.compare);
    expect((await route.handler(request({ [route.idField]: "7", password }))).status).toBe(200);
    expect(db.from).not.toHaveBeenCalledWith(route.secretTable);
  });

  it("시도 제한에 도달하면 조회·bcrypt·삭제 전에 429를 반환한다", async () => {
    const db = database({ legacyHash: "hash" }); db.rpc.mockResolvedValue({ data: false, error: null }); mocks.createClient.mockReturnValue(db);
    const response = await route.handler(request({ [route.idField]: 7, password: "wrong" }));
    expect(response.status).toBe(429);
    expect(db.rpc).toHaveBeenCalledWith("consume_board_write_quota", expect.objectContaining({ p_scope: route.scope, p_window_seconds: 60, p_limit: 5 }));
    expect(db.from).not.toHaveBeenCalled(); expect(mocks.compare).not.toHaveBeenCalled(); expect(db.writes).toEqual([]);
  });

  it("제한 저장소 장애 때 비교·삭제 없이 503을 반환한다", async () => {
    const db = database({ legacyHash: "hash" }); db.rpc.mockResolvedValue({ data: null, error: { message: "offline" } }); mocks.createClient.mockReturnValue(db);
    expect((await route.handler(request({ [route.idField]: 7, password: "password" }))).status).toBe(503);
    expect(mocks.compare).not.toHaveBeenCalled(); expect(db.writes).toEqual([]);
  });

  it("잘못된 비밀번호는 401이며 글·댓글을 삭제하지 않는다", async () => {
    const db = database({ secretHash: "hash" }); mocks.createClient.mockReturnValue(db); mocks.compare.mockResolvedValue(false);
    expect((await route.handler(request({ [route.idField]: 7, password: "wrong" }))).status).toBe(401);
    expect(db.writes).toEqual([]);
  });

  it("회원의 콘텐츠는 비회원 비밀번호로 삭제할 수 없다", async () => {
    const db = database({ userId: "member-id", legacyHash: "hash" }); mocks.createClient.mockReturnValue(db);
    expect((await route.handler(request({ [route.idField]: 7, password: "password" }))).status).toBe(403);
    expect(mocks.compare).not.toHaveBeenCalled(); expect(db.writes).toEqual([]);
  });

  it.each([{ password: {} }, { password: 7 }, { password: "" }, { password: "valid", id: -1 }, { password: "valid", id: "not-a-number" }])("잘못된 입력은 인증값 조회 전에 거절한다: %j", async (input) => {
    const db = database(); mocks.createClient.mockReturnValue(db);
    expect((await route.handler(request({ [route.idField]: input.id ?? 7, password: input.password }))).status).toBe(400);
    expect(db.from).not.toHaveBeenCalled(); expect(db.rpc).not.toHaveBeenCalled(); expect(mocks.compare).not.toHaveBeenCalled();
  });
});
