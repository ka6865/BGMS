import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { parseMayhemTipInput } from "@/lib/lol/mayhemTips";

const mock = vi.hoisted(() => ({ guard: vi.fn(), auth: vi.fn(), list: vi.fn(), create: vi.fn() }));
vi.mock("server-only", () => ({}));
vi.mock("@/lib/lol/publicAccess.server", () => ({ guardLolPublicRequest: mock.guard }));
vi.mock("@/utils/supabase/guard", () => ({ withAuthGuard: mock.auth }));
vi.mock("@/lib/lol/augments/catalog.server", () => ({ getCachedLolAugmentCatalog: async () => ({ view: { clientPatch: "16.22", augments: [{ id: 1 }, { id: 2 }] } }) }));
vi.mock("@/lib/lol/champions.server", () => ({ getLolChampions: async () => ({ version: "16.22.1", champions: [{ id: 63 }] }) }));
vi.mock("@/lib/lol/mayhemTips.server", () => ({ getMayhemTipItems: async () => [{ id: 3020 }, { id: 6655 }], listMayhemTips: mock.list, createMayhemTip: mock.create }));

const valid = { championId: null, augmentIds: [1, 2], itemIds: [6655, 3020], summary: "공용으로 좋아요", usage: "초반에 고르면 좋음" };
const post = (body: unknown) => new Request("http://localhost/api/lol/mayhem/tips", { method: "POST", body: typeof body === "string" ? body : JSON.stringify(body) });
const route = () => import("@/app/api/lol/mayhem/tips/route");

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
    expect(parseMayhemTipInput({ ...valid, itemIds: [], summary: "  좋아요 " })).toMatchObject({ championId: null, itemIds: [], summary: "좋아요" });
    expect(parseMayhemTipInput({ ...valid, championId: 63 })?.championId).toBe(63);
  });
  it.each([
    ["증강 없음", { augmentIds: [] }], ["증강 7개", { augmentIds: [1, 2, 3, 4, 5, 6, 7] }], ["중복 증강", { augmentIds: [1, 1] }],
    ["아이템 7개", { itemIds: [1, 2, 3, 4, 5, 6, 7] }], ["한줄평 1자", { summary: "a" }], ["한줄평 61자", { summary: "가".repeat(61) }],
    ["한줄평 줄바꿈", { summary: "첫 줄\n둘째 줄" }], ["활용법 1001자", { usage: "가".repeat(1001) }], ["챔피언 문자열", { championId: "63" }],
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
    const response = await GET(new Request("http://localhost/api/lol/mayhem/tips?champion=common&offset=20"));
    expect(await response.json()).toMatchObject({ patch: "16.22", signedIn: true, offset: 20 });
    expect(mock.list).toHaveBeenCalledWith("16.22", "common", 20);
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
});
