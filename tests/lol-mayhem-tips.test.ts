import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { parseMayhemTipCommentInput, parseMayhemTipInput } from "@/lib/lol/mayhemTips";

const mock = vi.hoisted(() => ({ guard: vi.fn(), auth: vi.fn(), list: vi.fn(), create: vi.fn(), update: vi.fn(), remove: vi.fn(), vote: vi.fn(), comments: vi.fn(), comment: vi.fn(), uncomment: vi.fn() }));
vi.mock("server-only", () => ({}));
vi.mock("@/lib/lol/publicAccess.server", () => ({ guardLolPublicRequest: mock.guard }));
vi.mock("@/utils/supabase/guard", () => ({ withAuthGuard: mock.auth }));
vi.mock("@/lib/lol/augments/catalog.server", () => ({ getCachedLolAugmentCatalog: async () => ({ view: { clientPatch: "16.22", augments: [{ id: 1 }, { id: 2 }] } }) }));
vi.mock("@/lib/lol/champions.server", () => ({ getLolChampions: async () => ({ version: "16.22.1", champions: [{ id: 63 }] }) }));
vi.mock("@/lib/lol/mayhemTips.server", () => ({ getMayhemTipItems: async () => [{ id: 3020 }, { id: 6655 }], listMayhemTips: mock.list, createMayhemTip: mock.create, updateMayhemTip: mock.update, deleteMayhemTip: mock.remove, voteMayhemTip: mock.vote, listMayhemTipComments: mock.comments, createMayhemTipComment: mock.comment, deleteMayhemTipComment: mock.uncomment }));

const valid = { championId: null, augmentIds: [1, 2], itemIds: [6655, 3020], summary: "공용으로 좋아요", usage: "초반에 고르면 좋음" };
const post = (body: unknown) => new Request("http://localhost/api/lol/mayhem/tips", { method: "POST", body: typeof body === "string" ? body : JSON.stringify(body) });
const route = () => import("@/app/api/lol/mayhem/tips/route");
const voteRoute = () => import("@/app/api/lol/mayhem/tips/vote/route");
const vote = (body: unknown) => new Request("http://localhost/api/lol/mayhem/tips/vote", { method: "POST", body: JSON.stringify(body) });

beforeEach(() => {
  vi.stubEnv("LOL_MAYHEM_TIPS_ENABLED", "true");
  mock.guard.mockResolvedValue(null);
  mock.auth.mockResolvedValue({ user: { id: "user-1" } });
  mock.list.mockResolvedValue({ rows: [], total: 0 });
  mock.create.mockImplementation(async (_user: string, patch: string, input: object) => ({ id: 1, patch, ...input }));
});
afterEach(() => { vi.unstubAllEnvs(); vi.clearAllMocks(); });

describe("조합 제보 입력", () => {
  it("공용 조합과 아이템 없는 제보를 받고 앞뒤 공백을 지운다", () => {
    expect(parseMayhemTipInput({ ...valid, itemIds: [], summary: "  좋아요 " })).toMatchObject({ championId: null, itemIds: [], summary: "좋아요", anonymous: false });
    expect(parseMayhemTipInput({ ...valid, anonymous: true })?.anonymous).toBe(true);
    expect(parseMayhemTipInput(valid)?.kind).toBe("tip");
  });
  it("질문은 증강 없이 올릴 수 있지만 조합 제보는 증강이 있어야 한다", () => {
    expect(parseMayhemTipInput({ ...valid, kind: "question", augmentIds: [], summary: "도미닉 오만 뭐가 좋아요?" })).toMatchObject({ kind: "question", augmentIds: [] });
    expect(parseMayhemTipInput({ ...valid, kind: "question", augmentIds: undefined })?.augmentIds).toEqual([]);
    expect(parseMayhemTipInput({ ...valid, augmentIds: [] })).toBeNull();
    expect(parseMayhemTipInput({ ...valid, kind: "guide" })).toBeNull();
    expect(parseMayhemTipInput({ ...valid, championId: 63 })?.championId).toBe(63);
  });
  it.each([
    ["증강 없음", { augmentIds: [] }], ["증강 7개", { augmentIds: [1, 2, 3, 4, 5, 6, 7] }], ["중복 증강", { augmentIds: [1, 1] }],
    ["아이템 7개", { itemIds: [1, 2, 3, 4, 5, 6, 7] }], ["한줄평 1자", { summary: "a" }], ["한줄평 61자", { summary: "가".repeat(61) }],
    ["한줄평 줄바꿈", { summary: "첫 줄\n둘째 줄" }], ["활용법 1001자", { usage: "가".repeat(1001) }], ["챔피언 문자열", { championId: "63" }], ["익명 문자열", { anonymous: "yes" }],
  ])("%s는 거부한다", (_name, patch) => {
    expect(parseMayhemTipInput({ ...valid, ...patch })).toBeNull();
  });
});

describe("조합 제보 API", () => {
  it("기능이 꺼져 있으면 404다", async () => {
    vi.stubEnv("LOL_MAYHEM_TIPS_ENABLED", "false");
    const { GET, POST } = await route();
    expect((await GET(new Request("http://localhost/api/lol/mayhem/tips"))).status).toBe(404);
    expect((await POST(post(valid))).status).toBe(404);
  });

  it("목록은 공용·챔피언 필터와 로그인 여부를 함께 준다", async () => {
    const { GET } = await route();
    const response = await GET(new Request("http://localhost/api/lol/mayhem/tips?champion=common&sort=top&offset=20"));
    expect(await response.json()).toMatchObject({ patch: "16.22", signedIn: true, offset: 20 });
    expect(mock.list).toHaveBeenCalledWith("16.22", "common", null, "top", 20, "user-1");
    mock.auth.mockResolvedValueOnce({ error: new Response() });
    expect(await (await GET(new Request("http://localhost/api/lol/mayhem/tips"))).json()).toMatchObject({ signedIn: false });
    expect(mock.list).toHaveBeenLastCalledWith("16.22", null, null, "recent", 0, null);
    await GET(new Request("http://localhost/api/lol/mayhem/tips?kind=question"));
    expect(mock.list).toHaveBeenLastCalledWith("16.22", null, "question", "recent", 0, "user-1");
    expect((await GET(new Request("http://localhost/api/lol/mayhem/tips?kind=guide"))).status).toBe(400);
    expect((await GET(new Request("http://localhost/api/lol/mayhem/tips?sort=old"))).status).toBe(400);
    expect((await GET(new Request("http://localhost/api/lol/mayhem/tips?champion=abc"))).status).toBe(400);
  });

  it("로그인한 사용자의 유효한 제보만 현재 패치로 저장한다", async () => {
    const { POST } = await route();
    expect((await POST(post(valid))).status).toBe(201);
    expect(mock.create).toHaveBeenCalledWith("user-1", "16.22", expect.objectContaining({ augmentIds: [1, 2], itemIds: [6655, 3020] }));
    mock.auth.mockResolvedValueOnce({ error: new Response() });
    expect((await POST(post(valid))).status).toBe(401);
  });

  it("목록에 없는 증강·아이템·챔피언과 깨진 본문은 거부한다", async () => {
    const { POST } = await route();
    for (const body of [{ ...valid, augmentIds: [99] }, { ...valid, itemIds: [1001] }, { ...valid, championId: 64 }]) expect((await POST(post(body))).status).toBe(400);
    expect((await POST(post("{"))).status).toBe(400);
    expect((await POST(post({ ...valid, usage: "x".repeat(9000) }))).status).toBe(413);
    expect(mock.create).not.toHaveBeenCalled();
  });

  it("하루 제한을 넘으면 429다", async () => {
    mock.create.mockResolvedValueOnce("daily_limit");
    const { POST } = await route();
    expect((await POST(post(valid))).status).toBe(429);
  });

  it("본인 제보만 고치고 지운다", async () => {
    const { PATCH, DELETE } = await route();
    mock.update.mockResolvedValueOnce({ id: 5 });
    const patch = (body: unknown) => new Request("http://localhost/api/lol/mayhem/tips", { method: "PATCH", body: JSON.stringify(body) });
    expect((await PATCH(patch({ ...valid, id: 5, anonymous: true }))).status).toBe(200);
    expect(mock.update).toHaveBeenCalledWith("user-1", 5, expect.objectContaining({ anonymous: true }));
    mock.update.mockResolvedValueOnce(null);
    expect((await PATCH(patch({ ...valid, id: 6 }))).status).toBe(404);
    expect((await PATCH(patch({ ...valid, id: "5" }))).status).toBe(400);
    mock.remove.mockResolvedValueOnce(true).mockResolvedValueOnce(false);
    expect((await DELETE(new Request("http://localhost/api/lol/mayhem/tips?id=5", { method: "DELETE" }))).status).toBe(200);
    expect(mock.remove).toHaveBeenCalledWith("user-1", 5);
    expect((await DELETE(new Request("http://localhost/api/lol/mayhem/tips?id=6", { method: "DELETE" }))).status).toBe(404);
    expect((await DELETE(new Request("http://localhost/api/lol/mayhem/tips?id=abc", { method: "DELETE" }))).status).toBe(400);
    mock.auth.mockResolvedValueOnce({ error: new Response() });
    expect((await DELETE(new Request("http://localhost/api/lol/mayhem/tips?id=5", { method: "DELETE" }))).status).toBe(401);
  });

  it("추천·비추천·취소만 받고 본인 제보 투표는 막는다", async () => {
    const { POST } = await voteRoute();
    mock.vote.mockResolvedValueOnce({ up: 3, down: 1 });
    expect(await (await POST(vote({ id: 5, value: 1 }))).json()).toEqual({ up: 3, down: 1, myVote: 1 });
    expect(mock.vote).toHaveBeenCalledWith("user-1", 5, 1);
    for (const body of [{ id: 5, value: 2 }, { id: 0, value: 1 }, { id: 5 }]) expect((await POST(vote(body))).status).toBe(400);
    mock.vote.mockResolvedValueOnce("own_tip");
    expect((await POST(vote({ id: 5, value: -1 }))).status).toBe(403);
    mock.vote.mockResolvedValueOnce("not_found");
    expect((await POST(vote({ id: 9, value: 0 }))).status).toBe(404);
    mock.auth.mockResolvedValueOnce({ error: new Response() });
    expect((await POST(vote({ id: 5, value: 1 }))).status).toBe(401);
  });

  it("댓글과 답글은 로그인 사용자만 달고, 형식이 틀리면 거부한다", async () => {
    const { GET, POST, DELETE } = await import("@/app/api/lol/mayhem/tips/comments/route");
    const comment = (body: unknown) => new Request("http://localhost/api/lol/mayhem/tips/comments", { method: "POST", body: JSON.stringify(body) });
    mock.comments.mockResolvedValue([{ id: 1 }]);
    expect(await (await GET(new Request("http://localhost/api/lol/mayhem/tips/comments?tipId=5"))).json()).toEqual({ comments: [{ id: 1 }] });
    expect(mock.comments).toHaveBeenCalledWith(5, "user-1");
    expect((await GET(new Request("http://localhost/api/lol/mayhem/tips/comments?tipId=x"))).status).toBe(400);
    mock.comments.mockResolvedValueOnce(null);
    expect((await GET(new Request("http://localhost/api/lol/mayhem/tips/comments?tipId=9"))).status).toBe(404);

    mock.comment.mockResolvedValueOnce("ok");
    expect((await POST(comment({ tipId: 5, parentId: 1, body: " 도미닉 추천 ", anonymous: true }))).status).toBe(201);
    expect(mock.comment).toHaveBeenCalledWith("user-1", { tipId: 5, parentId: 1, body: "도미닉 추천", anonymous: true });
    mock.comment.mockResolvedValueOnce("bad_parent");
    expect((await POST(comment({ tipId: 5, parentId: 2, body: "답글" }))).status).toBe(400);
    mock.comment.mockResolvedValueOnce("not_found");
    expect((await POST(comment({ tipId: 9, body: "댓글" }))).status).toBe(404);
    for (const body of [{ tipId: 5, body: " " }, { tipId: 5, body: "x".repeat(501) }, { tipId: 5, parentId: "1", body: "a" }, { body: "a" }]) expect((await POST(comment(body))).status).toBe(400);
    expect((await POST(comment({ tipId: 5, body: "존나 별로" }))).status).toBe(400);
    mock.auth.mockResolvedValueOnce({ error: new Response() });
    expect((await POST(comment({ tipId: 5, body: "댓글" }))).status).toBe(401);

    mock.uncomment.mockResolvedValueOnce(true).mockResolvedValueOnce(false);
    expect((await DELETE(new Request("http://localhost/api/lol/mayhem/tips/comments?id=3", { method: "DELETE" }))).status).toBe(200);
    expect(mock.uncomment).toHaveBeenCalledWith("user-1", 3);
    expect((await DELETE(new Request("http://localhost/api/lol/mayhem/tips/comments?id=4", { method: "DELETE" }))).status).toBe(404);
  });
});

describe("댓글 입력", () => {
  it("답글 대상은 양의 정수만 받는다", () => {
    expect(parseMayhemTipCommentInput({ tipId: 1, body: "좋아요" })).toEqual({ tipId: 1, parentId: null, body: "좋아요", anonymous: false });
    expect(parseMayhemTipCommentInput({ tipId: 1, parentId: 0, body: "좋아요" })).toBeNull();
    expect(parseMayhemTipCommentInput({ tipId: 1, body: "a", anonymous: "y" })).toBeNull();
  });
});
