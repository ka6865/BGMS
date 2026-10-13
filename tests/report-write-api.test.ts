import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextResponse } from "next/server";

const mocks = vi.hoisted(() => ({ guard: vi.fn(), createClient: vi.fn() }));
vi.mock("../utils/supabase/guard", () => ({ withAuthGuard: mocks.guard }));
vi.mock("@supabase/supabase-js", () => ({ createClient: mocks.createClient }));

import { POST as vote } from "../app/api/report/vote/route";
import { POST as register } from "../app/api/report/route";

const markerId = "11111111-1111-4111-8111-111111111111";
let db: any;
beforeEach(() => {
  vi.clearAllMocks();
  const query: any = { select: vi.fn(() => query), eq: vi.fn(() => query), single: vi.fn(async () => ({ data: { id: markerId, role: "user", weight: 1, contributor_ids: [], downvoter_ids: [] }, error: null })), update: vi.fn(() => query), then: (resolve: (x: unknown) => unknown) => Promise.resolve({ error: null }).then(resolve) };
  db = { from: vi.fn(() => query), rpc: vi.fn(async () => ({ data: { status: "ok", weight: 2, down_weight: 0, triggerNotify: null }, error: null })), auth: { getUser: vi.fn(async () => ({ data: { user: { id: "verified-user" } }, error: null })) } };
  mocks.createClient.mockReturnValue(db);
  mocks.guard.mockResolvedValue({ user: { id: "verified-user" }, supabaseAdmin: db });
});

describe("제보 등록 서버 경계", () => {
  const body = { mapName: "Erangel", markerType: "Garage", x: 300, y: 400 };
  function configure(settings: any = null, category: any = null, error: any = null) {
    db.from.mockImplementation((table: string) => {
      const query: any = { select: vi.fn(() => query), eq: vi.fn(() => query), maybeSingle: vi.fn(async () => ({ data: table === "map_settings" ? settings : category, error })) };
      return query;
    });
    db.rpc.mockResolvedValue({ data: { status: "ok", id: markerId }, error: null });
  }
  it("서버가 확인한 사용자로 등록하고 위조 표와 작성자 필드는 무시한다", async () => {
    configure();
    const response = await register(request({ ...body, userId: "forged", weight: 999, is_notified: true }));
    expect(await response.json()).toEqual({ success: true, nearby: false, markerId });
    expect(db.rpc).toHaveBeenCalledWith("create_pending_marker", { p_actor_user_id: "verified-user", p_map_name: "Erangel", p_marker_type: "Garage", p_x: 300, p_y: 400 });
  });
  it("근접 제보는 새로 저장했다고 안내하지 않는다", async () => {
    configure(); db.rpc.mockResolvedValue({ data: { status: "nearby", id: markerId }, error: null });
    expect((await (await register(request(body))).json()).nearby).toBe(true);
  });
  it("관리자 등록 동적 카테고리도 허용한다", async () => {
    configure({ categories: ["CustomVehicle"] }, { id: "CustomVehicle", is_active: true });
    expect((await register(request({ ...body, markerType: "CustomVehicle" }))).status).toBe(200);
  });
  it.each([{ x: -1 }, { x: 8193 }, { y: "400" }, { mapName: "__proto__" }, { markerType: "" }])("잘못된 입력은 DB에 접근하지 않는다: %j", async (extra) => {
    configure();
    expect((await register(request({ ...body, ...extra }))).status).toBe(400);
    expect(db.from).not.toHaveBeenCalled(); expect(db.rpc).not.toHaveBeenCalled();
  });
  it("비활성 종류는 등록하지 않는다", async () => {
    configure({ categories: ["Garage"] }, { id: "Garage", is_active: false });
    expect((await register(request(body))).status).toBe(400);
    expect(db.rpc).not.toHaveBeenCalled();
  });
  it("설정 조회 실패 때 기본값으로 쓰지 않는다", async () => {
    configure(null, null, { message: "offline" });
    expect((await register(request(body))).status).toBe(503);
    expect(db.rpc).not.toHaveBeenCalled();
  });
  it("RPC 실패는 재시도 가능한 오류로 알린다", async () => {
    configure(); db.rpc.mockResolvedValue({ data: null, error: { code: "PGRST202" } });
    expect((await register(request(body))).status).toBe(503);
  });
});

function request(body: unknown) {
  return new Request("https://bgms.test/api/report/vote", { method: "POST", headers: { "content-type": "application/json", authorization: "Bearer fixture" }, body: JSON.stringify(body) });
}

describe("제보 투표 서버 경계", () => {
  it("검증한 사용자와 방향만 원자적 RPC에 전달하고 직접 덮어쓰지 않는다", async () => {
    const response = await vote(request({ markerId, voteType: "up", userId: "forged-user", weight: 999 }));
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ success: true, weight: 2, down_weight: 0, triggerNotify: null });
    expect(db.rpc).toHaveBeenCalledWith("vote_pending_marker", { p_marker_id: markerId, p_actor_user_id: "verified-user", p_direction: "up" });
    expect(db.from).not.toHaveBeenCalled();
  });
  it.each(["invalid", {}, 1, null])("잘못된 방향을 저장 전에 거절한다: %j", async (voteType) => {
    expect((await vote(request({ markerId, voteType }))).status).toBe(400);
    expect(db.from).not.toHaveBeenCalled(); expect(db.rpc).not.toHaveBeenCalled();
  });
  it("중복 투표 결과는 403으로 알린다", async () => {
    db.rpc.mockResolvedValue({ data: { status: "already_voted" }, error: null });
    expect((await vote(request({ markerId, voteType: "up" }))).status).toBe(403);
  });
  it("처리 중 사라진 제보는 404로 알린다", async () => {
    db.rpc.mockResolvedValue({ data: { status: "not_found" }, error: null });
    expect((await vote(request({ markerId, voteType: "down" }))).status).toBe(404);
  });
  it("DB 오류 때 다른 쓰기 경로로 전환하지 않는다", async () => {
    db.rpc.mockResolvedValue({ data: null, error: { code: "PGRST202" } });
    expect((await vote(request({ markerId, voteType: "up" }))).status).toBe(503);
    expect(db.from).not.toHaveBeenCalled();
  });
  it("인증 실패 때 투표를 저장하지 않는다", async () => {
    mocks.guard.mockResolvedValue({ error: NextResponse.json({ error: "로그인이 필요합니다." }, { status: 401 }) });
    expect((await vote(request({ markerId, voteType: "up" }))).status).toBe(401);
    expect(db.rpc).not.toHaveBeenCalled();
  });
  it.each([-1, "not-a-uuid", {}, null])("잘못된 제보 ID는 변경 전에 거절한다: %j", async (id) => {
    expect((await vote(request({ markerId: id, voteType: "up" }))).status).toBe(400);
    expect(db.from).not.toHaveBeenCalled(); expect(db.rpc).not.toHaveBeenCalled();
  });
});
