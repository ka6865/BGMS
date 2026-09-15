import { describe, expect, it, vi, beforeEach } from "vitest";

const mocks = vi.hoisted(() => {
  class MockBanWatchError extends Error {
    code: string;
    status: number;
    retryAfterSeconds?: number;
    constructor(code: string, status: number, message = code, retryAfterSeconds?: number) {
      super(message);
      this.name = "BanWatchError";
      this.code = code;
      this.status = status;
      this.retryAfterSeconds = retryAfterSeconds;
    }
  }
  class MockSourceError extends Error {
    code = "PUBG_DEATH_ENCOUNTER_SOURCE_UNAVAILABLE";
    status = 404;
    source = { kind: "unavailable", matchId: "match-1", platform: "steam", verifiedSubjectAccountId: "account.subject", checkedAt: "2026-09-11T00:00:00.000Z" };
    constructor() { super("source unavailable"); }
  }
  const cache = vi.fn();
  return {
    cache,
    BanWatchError: MockBanWatchError,
    DeathEncounterSourceError: MockSourceError,
    requireUser: vi.fn(),
    list: vi.fn(),
    parseCreate: vi.fn(),
    parseUpdate: vi.fn(),
    create: vi.fn(),
    update: vi.fn(),
    remove: vi.fn(),
    admin: vi.fn(() => { const chain: any = { select: () => chain, eq: () => chain, maybeSingle: cache }; return { from: () => chain }; }),
    quota: vi.fn(),
    load: vi.fn(),
    private: vi.fn(),
  };
});

vi.mock("@/lib/pubg/banWatch.server", () => ({
  BanWatchError: mocks.BanWatchError,
  requireBanWatchUserId: mocks.requireUser,
  listBanWatchItems: mocks.list,
  parseBanWatchCreateInput: mocks.parseCreate,
  parseBanWatchEncounterRequest: (value: unknown) => value,
  parseBanWatchUpdateInput: mocks.parseUpdate,
  createBanWatchItem: mocks.create,
  updateBanWatchItem: mocks.update,
  deleteBanWatchItem: mocks.remove,
  getBanWatchAdminClient: mocks.admin,
  acquireEncounterRequest: mocks.quota,
}));
vi.mock("@/lib/pubg/deathEncounters.server", () => ({
  DeathEncounterSourceError: mocks.DeathEncounterSourceError,
  loadDeathEncounters: mocks.load,
}));
vi.mock("@/lib/pubg/privatePlayers", () => ({ isPlayerPrivate: mocks.private }));

import { DELETE, GET, PATCH, POST } from "@/app/api/pubg/ban-watch/route";
import { POST as POST_ENCOUNTERS } from "@/app/api/pubg/ban-watch/encounters/route";

const input = {
  platform: "steam" as const,
  subjectAccountId: "account.subject",
  subjectNicknameAtMatch: "Subject",
  targetAccountId: "account.target",
  matchId: "match-1",
  eventAt: "2026-09-11T00:00:00.000Z",
  role: "killer" as const,
  nicknameAtMatch: "Target",
  weapon: "AKM",
  mapName: "Erangel",
  note: "review",
};
const source = {
  kind: "upstream" as const,
  matchId: "match-1",
  platform: "steam" as const,
  verifiedSubjectAccountId: "account.subject",
  verifiedSubjectNicknameAtMatch: "Subject",
  checkedAt: "2026-09-11T00:00:00.000Z",
};
const encounter = { ...input, subjectAccountId: "account.subject", targetAccountId: "account.target", nicknameAtMatch: "Target", mapName: undefined, role: "killer" as const, weapon: "AKM" };

function request(body: unknown, url = "https://bgms.test/api/pubg/ban-watch") {
  return new Request(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.cache.mockResolvedValue({data:null,error:null});
  mocks.requireUser.mockResolvedValue("user-a");
  mocks.parseCreate.mockReturnValue(input);
  mocks.parseUpdate.mockReturnValue({ id: "watch-1", note: "updated" });
  mocks.quota.mockReturnValue({ allowed: true, retryAfterSeconds: 0, reason: "ok", release: vi.fn() });
  mocks.load.mockResolvedValue({ encounters: [encounter], source });
  mocks.private.mockResolvedValue(false);
  mocks.create.mockResolvedValue({ created: true, scheduled: true, item: { id: "watch-1" } });
  mocks.update.mockResolvedValue({ id: "watch-1" });
  mocks.list.mockResolvedValue({ items: [], statuses: [], events: [] });
  mocks.remove.mockResolvedValue(undefined);
});

describe("ban-watch API authentication and source boundaries", () => {
  it("requires a session before reading the personal list", async () => {
    mocks.requireUser.mockRejectedValueOnce(new mocks.BanWatchError("unauthenticated", 401, "login required"));
    const response = await GET();
    expect(response.status).toBe(401);
    expect(mocks.list).not.toHaveBeenCalled();
  });

  it("revalidates the subject nickname and stores only the verified encounter fields", async () => {
    mocks.parseCreate.mockReturnValue({ ...input, subjectNicknameAtMatch: "Subject" });
    const response = await POST(request({ ...input, nicknameAtMatch: "spoof", weapon: "spoof" }));
    expect(response.status).toBe(201);
    expect(mocks.load).toHaveBeenCalledWith({ platform: "steam", matchId: "match-1", subjectAccountId: "account.subject", nickname: "Subject" });
    expect(mocks.create).toHaveBeenCalledWith("user-a", expect.objectContaining({ nicknameAtMatch: "Target", weapon: "AKM", mapName: null }), expect.anything());
  });

  it("returns private-player refusal without writing a watch row", async () => {
    mocks.private.mockResolvedValueOnce(true);
    const response = await POST(request(input));
    expect(response.status).toBe(403);
    expect(mocks.create).not.toHaveBeenCalled();
  });

  it("preserves source status and provenance when encounter loading fails", async () => {
    mocks.load.mockRejectedValueOnce(new mocks.DeathEncounterSourceError());
    const response = await POST_ENCOUNTERS(request({ platform: "steam", matchId: "match-1", nickname: "Subject" }, "https://bgms.test/api/pubg/ban-watch/encounters"));
    const body = await response.json();
    expect(response.status).toBe(404);
    expect(body.code).toBe("PUBG_DEATH_ENCOUNTER_SOURCE_UNAVAILABLE");
    expect(body.source.kind).toBe("unavailable");
  });

  it("returns Retry-After and reset headers for encounter rate limits", async () => {
    mocks.quota.mockReturnValueOnce({ allowed: false, retryAfterSeconds: 42, reason: "rate_limited", release: vi.fn() });
    const response = await POST_ENCOUNTERS(request({ platform: "steam", matchId: "match-1" }, "https://bgms.test/api/pubg/ban-watch/encounters"));
    expect(response.status).toBe(429);
    expect(response.headers.get("retry-after")).toBe("42");
    expect(response.headers.get("x-ratelimit-reset")).toBeTruthy();
  });

  it("passes the session owner to update and delete operations", async () => {
    const patchResponse = await PATCH(new Request("https://bgms.test/api/pubg/ban-watch", { method: "PATCH", body: JSON.stringify({ id: "watch-1", note: "updated" }) }));
    expect(patchResponse.status).toBe(200);
    expect(mocks.update).toHaveBeenCalledWith("user-a", { id: "watch-1", note: "updated" }, expect.anything());
    const deleteResponse = await DELETE(new Request("https://bgms.test/api/pubg/ban-watch?id=watch-1", { method: "DELETE" }));
    expect(deleteResponse.status).toBe(200);
    expect(mocks.remove).toHaveBeenCalledWith("user-a", "watch-1", expect.anything());
  });
});


describe("보관된 상대 등록 근거",()=>{
 it("검증된 저장 관계가 있으면 만료 원본을 다시 요청하지 않는다",async()=>{
  mocks.cache.mockResolvedValue({data:{result:{encounters:[encounter],source}},error:null});
  const response=await POST(new Request("http://localhost/api/pubg/ban-watch",{method:"POST",body:JSON.stringify(input)}));
  expect(response.status).toBe(201);expect(mocks.load).not.toHaveBeenCalled();
 });
 it("다른 계정의 캐시 내부 근거를 사용하지 않는다",async()=>{
  mocks.cache.mockResolvedValue({data:{result:{encounters:[encounter],source:{...source,verifiedSubjectAccountId:"account.other"}}},error:null});
  await POST(new Request("http://localhost/api/pubg/ban-watch",{method:"POST",body:JSON.stringify(input)}));
  expect(mocks.load).toHaveBeenCalledOnce();
 });
});
