import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ rpc: vi.fn(), admin: vi.fn(), after: vi.fn(), lookup: vi.fn(), deleteAccount: vi.fn(), clearCaches: vi.fn() }));
vi.mock("server-only", () => ({}));
vi.mock("next/server", async (original) => ({ ...await original<typeof import("next/server")>(), after: mocks.after }));
vi.mock("@/lib/server/serviceRoleSupabase.server", () => ({ createServiceRoleSupabase: () => ({ rpc: mocks.rpc }) }));
vi.mock("@/lib/lol/access.server", () => ({ requireLolDevAdmin: mocks.admin }));
vi.mock("@/lib/lol/persistence.server", () => ({
  getLolAccountByRiotId: mocks.lookup, deleteLolAccountData: mocks.deleteAccount,
}));
vi.mock("@/lib/lol/riotSearch.server", () => ({ clearLolPersonalCaches: mocks.clearCaches,
  resolveLolAccountForDeletion: mocks.lookup, RiotSearchError: class extends Error {} }));

import { GET, POST } from "@/app/api/admin/lol/operations/route";
import { getLolOpsStatus, recordLolOpsMetric, type LolOpsMetric } from "@/lib/lol/ops.server";

const counts = { cache_rows: 2, match_rows: 1, account_rows: 0, lease_rows: 3 };
const status = {
  today: "2026-10-23", todayRiotCalls: 10, cooldownActive: true,
  metrics: [{ day: "2026-10-23", metric: "riot_key_error", value: 1 }],
  rateLimits: [{ host: "global", budgetDay: "2026-10-23", usedCount: 12, blockedUntil: "2026-10-23T01:00:00Z" }],
  tables: [{ table: "lol_matches", rows: 10, totalBytes: 8192 }], pending: counts,
};
function post(body: unknown, origin = "http://localhost") {
  return new Request("http://localhost/api/admin/lol/operations", {
    method: "POST", headers: { Origin: origin, Host: "localhost", "Content-Type": "application/json" }, body: JSON.stringify(body),
  });
}

beforeEach(() => {
  vi.resetAllMocks();
  vi.stubEnv("LOL_PERSISTENCE_ENABLED", "true");
  vi.stubEnv("RIOT_API_KEY", "fixture-private-key");
  mocks.admin.mockResolvedValue({ ok: true });
  mocks.rpc.mockImplementation(() => ({ abortSignal: async () => ({ data: status, error: null }) }));
});
afterEach(() => { vi.unstubAllEnvs(); vi.restoreAllMocks(); });

describe("LoL 운영 메트릭", () => {
  it("응답 후 기록을 예약하고 요청은 DB 완료를 기다리지 않는다", async () => {
    recordLolOpsMetric("riot_429");
    expect(mocks.rpc).not.toHaveBeenCalled();
    expect(mocks.after).toHaveBeenCalledOnce();
    await mocks.after.mock.calls[0][0]();
    expect(mocks.rpc).toHaveBeenCalledWith("increment_lol_ops_metric", { p_metric: "riot_429", p_by: 1 });
  });
  it("기록 실패는 안전 로그만 남기고 재시도·재귀하지 않는다", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    mocks.rpc.mockImplementation(() => ({ abortSignal: async () => { throw new Error("private-puuid fixture-private-key"); } }));
    recordLolOpsMetric("db_error");
    await expect(mocks.after.mock.calls[0][0]()).resolves.toBeUndefined();
    expect(mocks.rpc).toHaveBeenCalledOnce();
    expect(mocks.after).toHaveBeenCalledOnce();
    expect(JSON.stringify(error.mock.calls)).toContain("metric_failed");
    expect(JSON.stringify(error.mock.calls)).not.toMatch(/private-puuid|fixture-private-key/);
  });
  it("비활성화 또는 허용되지 않은 메트릭은 기록하지 않는다", () => {
    recordLolOpsMetric("arbitrary-private-value" as LolOpsMetric);
    vi.stubEnv("LOL_PERSISTENCE_ENABLED", "false");
    recordLolOpsMetric("riot_success");
    expect(mocks.after).not.toHaveBeenCalled();
    expect(mocks.rpc).not.toHaveBeenCalled();
  });
});

describe("LoL 관리자 운영 API", () => {
  it("허용된 집계 필드만 노출하고 키 오류는 키 확인 필요로 전달한다", async () => {
    mocks.rpc.mockImplementation(() => ({ abortSignal: async () => ({ data: {
      ...status, puuid: "private-puuid", key: "fixture-private-key", user: "private-member",
    } }) }));
    const response = await GET();
    expect(response.status).toBe(200);
    expect(response.headers.get("Cache-Control")).toBe("private, no-store");
    const body = await response.json();
    expect(body).toMatchObject({ ...status, keyNeedsAttention: true, enabled: true });
    expect(JSON.stringify(body)).not.toMatch(/private-puuid|fixture-private-key|private-member/);
    expect(mocks.rpc).toHaveBeenCalledWith("get_lol_ops_status", {});
  });
  it("영속 저장 비활성화는 DB에 접근하지 않고 표시한다", async () => {
    vi.stubEnv("LOL_PERSISTENCE_ENABLED", "false");
    vi.stubEnv("RIOT_API_KEY", "");
    expect(await getLolOpsStatus()).toMatchObject({ enabled: false, keyNeedsAttention: true, tables: [] });
    expect(mocks.rpc).not.toHaveBeenCalled();
  });
  it("비활성 영속 저장의 미리보기와 삭제는 DB에 접근하지 않는다", async () => {
    vi.stubEnv("LOL_PERSISTENCE_ENABLED", "false");
    expect((await POST(post({ action: "preview" }))).status).toBe(503);
    expect((await POST(post({ action: "cleanup", confirm: true }))).status).toBe(503);
    expect(mocks.rpc).not.toHaveBeenCalled();
  });
  it.each([401, 403, 404, 503])("관리자 가드 %s면 조회·미리보기·삭제 RPC를 호출하지 않는다", async (code) => {
    mocks.admin.mockImplementation(async () => ({ ok: false, error: Response.json({ error: "접근 불가" }, { status: code }) }));
    expect((await GET()).status).toBe(code);
    expect((await POST(post({ action: "preview" }))).status).toBe(code);
    expect((await POST(post({ action: "cleanup", confirm: true }))).status).toBe(code);
    expect(mocks.rpc).not.toHaveBeenCalled();
  });
  it.each(["http://evil.test", "null", "", "http://localhost/", "https://localhost"])("출처 %s는 삭제 전에 거절한다", async (origin) => {
    expect((await POST(post({ action: "cleanup", confirm: true }, origin))).status).toBe(403);
    expect(mocks.rpc).not.toHaveBeenCalled();
  });
  it.each([{}, null, [], { action: "cleanup" }, { action: "cleanup", confirm: "true" },
    { action: "cleanup", confirm: true, limit: 1001 }, { action: "cleanup", confirm: true, limit: 0 },
    { action: "cleanup", confirm: true, limit: 1.5 }])("잘못된 정리 요청 %j는 실행하지 않는다", async (body) => {
    expect((await POST(post(body))).status).toBe(400);
    expect(mocks.rpc).not.toHaveBeenCalled();
  });
  it("미리보기는 읽기 RPC만 실행하고 확인된 배치만 한 번 실행한다", async () => {
    mocks.rpc.mockImplementation((name) => ({ abortSignal: async () => ({
      data: name === "preview_lol_expired_data" ? counts : { deleted: counts, remaining: counts }, error: null,
    }) }));
    const preview = await POST(post({ action: "preview" }));
    expect(await preview.json()).toEqual(counts);
    expect(mocks.rpc).toHaveBeenLastCalledWith("preview_lol_expired_data", {});
    const cleanup = await POST(post({ action: "cleanup", confirm: true, limit: 100 }));
    expect(await cleanup.json()).toEqual({ deleted: counts, remaining: counts });
    expect(mocks.rpc).toHaveBeenLastCalledWith("cleanup_lol_expired_batch", { p_limit: 100 });
  });
  it("DB 실패는 상세 원문을 숨긴 503과 안전한 로그로 반환한다", async () => {
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    mocks.rpc.mockImplementation(() => ({ abortSignal: async () => ({ error: new Error("private-puuid fixture-private-key") }) }));
    const response = await GET();
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ error: "LoL 운영 저장소를 사용할 수 없습니다." });
    expect(JSON.stringify(log.mock.calls)).toContain("db_error");
    expect(JSON.stringify(log.mock.calls)).not.toMatch(/private-puuid|fixture-private-key/);
  });
});

describe("LoL 계정 삭제 API", () => {
  it("대상 확인은 Account-V1을 조회하고 식별자를 응답에 노출하지 않는다", async () => {
    mocks.lookup.mockResolvedValue({ puuid: "private-puuid", gameName: "Owner", tagLine: "SUM" });
    const result = await POST(post({ action: "account-preview", riotId: "Owner#SUM" }));
    expect(await result.json()).toEqual({ riotId: "Owner#SUM" });
    expect(mocks.lookup).toHaveBeenCalledWith("Owner#SUM");
    expect(mocks.deleteAccount).not.toHaveBeenCalled();
  });
  it.each([undefined, false, "true"])("명시적인 삭제 확인 %s 없이는 조회·삭제하지 않는다", async (confirm) => {
    expect((await POST(post({ action: "account-delete", riotId: "Owner#SUM", confirm }))).status).toBe(400);
    expect(mocks.lookup).not.toHaveBeenCalled();
    expect(mocks.deleteAccount).not.toHaveBeenCalled();
  });
  it.each(["", "Owner", "Owner#SUM#BAD", "#SUM", "Owner#", "Owner#SUM\n"])("잘못된 Riot ID %j는 거절한다", async (riotId) => {
    expect((await POST(post({ action: "account-delete", riotId, confirm: true }))).status).toBe(400);
    expect(mocks.deleteAccount).not.toHaveBeenCalled();
  });
  it("관리자·동일 출처·활성화 확인 뒤에만 실행한다", async () => {
    const body = { action: "account-delete", riotId: "Owner#SUM", confirm: true };
    expect((await POST(post(body, "http://evil.test"))).status).toBe(403);
    mocks.admin.mockResolvedValue({ ok: false, error: Response.json({}, { status: 403 }) });
    expect((await POST(post(body))).status).toBe(403);
    mocks.admin.mockResolvedValue({ ok: true });
    vi.stubEnv("LOL_PERSISTENCE_ENABLED", "false");
    expect((await POST(post(body))).status).toBe(503);
    expect(mocks.deleteAccount).not.toHaveBeenCalled();
  });
  it("조회 대상을 다시 확인하고 RPC 한 번과 메모리 무효화를 실행한다", async () => {
    mocks.lookup.mockResolvedValue({ puuid: "private-puuid", gameName: "Owner", tagLine: "SUM" });
    mocks.deleteAccount.mockResolvedValue({ account_rows: 1, history_rows: 3 });
    const result = await POST(post({ action: "account-delete", riotId: "Owner#SUM", confirm: true }));
    expect(await result.json()).toEqual({ account_rows: 1, history_rows: 3 });
    expect(mocks.deleteAccount).toHaveBeenCalledExactlyOnceWith("private-puuid");
    expect(mocks.clearCaches).toHaveBeenCalledOnce();
  });
  it("없는 대상과 DB 실패는 안전한 응답으로 반환한다", async () => {
    expect((await POST(post({ action: "account-preview", riotId: "Missing#SUM" }))).status).toBe(404);
    mocks.lookup.mockRejectedValue(new Error("private-puuid secret"));
    const result = await POST(post({ action: "account-delete", riotId: "Owner#SUM", confirm: true }));
    expect(result.status).toBe(503);
    expect(JSON.stringify(await result.json())).not.toMatch(/private-puuid|secret/);
    expect(mocks.deleteAccount).not.toHaveBeenCalled();
  });
});
