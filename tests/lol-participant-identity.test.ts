import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const store = vi.hoisted(() => ({ names: vi.fn(), enabled: vi.fn() }));
vi.mock("server-only", () => ({}));
vi.mock("@/lib/lol/persistence.server", async (original) => ({
  ...await original<typeof import("@/lib/lol/persistence.server")>(),
  getLolAccountNamesByPuuids: store.names,
  isLolPersistenceEnabled: store.enabled,
}));
import {
  lolParticipantDto, lolParticipantPlayerKey, lolSearchResultDto, openLolParticipantRef, sealLolParticipantRef,
  type ServerLolRecentMatch, type ServerLolSearchResult,
} from "@/lib/lol/participantIdentity.server";
import { resolveLolParticipantRef } from "@/lib/lol/riotSearch.server";
import { summarizeRecentMatches } from "@/lib/lol/summary";

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubEnv("LOL_PARTICIPANT_REF_SECRET", "fixed-unit-test-secret");
  vi.stubEnv("LOL_PARTICIPANT_NAME_MODE", "known_current");
  store.enabled.mockReturnValue(true);
  store.names.mockResolvedValue([{ puuid: "peer", game_name: "Current", tag_line: "KR1", account_fetched_at: new Date().toISOString() }]);
});
afterEach(() => { vi.unstubAllEnvs(); vi.restoreAllMocks(); });

function match(riotId: string, puuid = "peer"): ServerLolRecentMatch {
  return {
    matchId: "KR_1", queueId: 420, gameMode: "CLASSIC", gameDuration: 1500, win: true,
    kills: 1, deaths: 1, assists: 1, remake: false, killParticipationPct: 50,
    teammates: [{ puuid, riotId, win: true }],
  } as ServerLolRecentMatch;
}

describe("LoL 참가자 식별자", () => {
  it("봉인 토큰은 왕복하고 raw PUUID를 드러내지 않으며 매번 달라진다", () => {
    const ref = sealLolParticipantRef("peer")!;
    expect(openLolParticipantRef(ref)).toBe("peer");
    expect(ref).not.toContain("peer");
    expect(sealLolParticipantRef("peer")).not.toBe(ref);
  });

  it("위조·절단·버전 변경·다른 secret·비정규 인코딩을 거부한다", () => {
    const ref = sealLolParticipantRef("peer")!;
    const changed = Buffer.from(ref, "base64url");
    changed[changed.length - 1] ^= 1;
    const version = Buffer.from(ref, "base64url");
    version[0] = 2;
    for (const invalid of [changed.toString("base64url"), ref.slice(0, -3), version.toString("base64url"), ref + "=", "x".repeat(1000)])
      expect(openLolParticipantRef(invalid)).toBeNull();
    vi.stubEnv("LOL_PARTICIPANT_REF_SECRET", "different-secret");
    expect(openLolParticipantRef(ref)).toBeNull();
  });

  it("playerKey는 결정적이고 PUUID와 secret에 따라 바뀐다", () => {
    expect(lolParticipantPlayerKey("peer")).toMatch(/^[a-f0-9]{32}$/);
    expect(lolParticipantPlayerKey("peer")).toBe(lolParticipantPlayerKey("peer"));
    expect(lolParticipantPlayerKey("peer")).not.toBe(lolParticipantPlayerKey("other"));
    const key = lolParticipantPlayerKey("peer");
    vi.stubEnv("LOL_PARTICIPANT_REF_SECRET", "different-secret");
    expect(lolParticipantPlayerKey("peer")).not.toBe(key);
  });

  it("현재 이름 모드는 일괄 조회하고 원본 캐시를 바꾸지 않으며 DTO 어디에도 puuid를 남기지 않는다", async () => {
    const input = { puuid: "owner-private", challenges: { soloKills: 2 }, matches: [match("Old#KR1"), match("Unknown#KR1", "unknown")],
      teams: [{ participants: [{ puuid: "peer", riotId: "Old#KR1" }] }] };
    const before = JSON.stringify(input);
    const dto = await lolParticipantDto(input);
    expect(store.names).toHaveBeenCalledWith(["peer", "unknown"]);
    expect(dto.matches[0].teammates![0]).toMatchObject({ riotId: "Current#KR1", playerKey: lolParticipantPlayerKey("peer") });
    expect(dto.matches[1].teammates![0].riotId).toBe("Unknown#KR1");
    expect(dto.teams[0].participants[0].riotId).toBe("Current#KR1");
    expect(JSON.stringify(dto)).not.toContain('"puuid"');
    expect(JSON.stringify(dto)).not.toContain('"challenges"');
    expect(JSON.stringify(dto)).not.toContain("owner-private");
    expect(JSON.stringify(input)).toBe(before);
  });

  it("match_time 모드는 이름 조회 없이 당시 이름을 유지하고 ref는 발급한다", async () => {
    vi.stubEnv("LOL_PARTICIPANT_NAME_MODE", "match_time");
    const dto = await lolParticipantDto(match("Old#KR1"));
    expect(store.names).not.toHaveBeenCalled();
    expect(dto.teammates![0].riotId).toBe("Old#KR1");
    expect(openLolParticipantRef(dto.teammates![0].ref!)).toBe("peer");
  });

  it("이름 모드 기본값은 known_current이고 조회는 100개 단위로 제한한다", async () => {
    vi.stubEnv("LOL_PARTICIPANT_NAME_MODE", "");
    await lolParticipantDto(Array.from({ length: 101 }, (_, i) => ({ puuid: `p${i}`, riotId: "Old#KR1" })));
    expect(store.names.mock.calls.slice(-2).map(([ids]) => ids.length)).toEqual([100, 1]);
  });

  it("secret 미설정은 이름 링크로 폴백하고 사유만 기록한다", async () => {
    vi.stubEnv("LOL_PARTICIPANT_REF_SECRET", "");
    const log = vi.spyOn(console, "warn").mockImplementation(() => {});
    const dto = await lolParticipantDto(match("Old#KR1"));
    expect(dto.teammates![0]).toEqual({ riotId: "Current#KR1", win: true });
    expect(log).toHaveBeenCalledWith("[lol-participant] fallback", { reasonCode: "missing_participant_ref_secret" });
    expect(JSON.stringify(log.mock.calls)).not.toContain("peer");
  });

  it("이름을 바꾼 동료는 playerKey로 한 줄에 합치며 이전 캐시는 이름으로 집계한다", async () => {
    vi.stubEnv("LOL_PARTICIPANT_NAME_MODE", "match_time");
    const matches = await lolParticipantDto([match("New#KR1"), match("Old#KR1")]);
    const result = summarizeRecentMatches(matches, "Self#KR1");
    expect(result.all.teammates).toHaveLength(1);
    expect(result.all.teammates[0]).toMatchObject({ riotId: "New#KR1", games: 2 });
    const legacy = [{ ...match("Legacy#KR1"), teammates: [{ riotId: "Legacy#KR1", win: true }] }];
    expect(summarizeRecentMatches([...legacy, ...legacy], "Self#KR1").all.teammates[0].games).toBe(2);
  });

  it("검색 캐시를 읽은 뒤 이름과 요약을 함께 다시 만든다", async () => {
    const cached = { account: { gameName: "Self", tagLine: "KR1" }, matches: [match("New#KR1"), match("Old#KR1")], summaries: {} } as ServerLolSearchResult;
    const dto = await lolSearchResultDto(cached);
    expect(dto.summaries.all.teammates).toHaveLength(1);
    expect(dto.summaries.all.teammates[0]).toMatchObject({ riotId: "Current#KR1", games: 2 });
    expect(JSON.stringify(dto)).not.toContain('"puuid"');
    expect(JSON.stringify(dto)).not.toContain('"challenges"');
  });

  it("ref 이동은 24시간 이내 계정 이름을 사용하고 위조 ref는 DB 조회 전에 거부한다", async () => {
    await expect(resolveLolParticipantRef(sealLolParticipantRef("peer")!)).resolves.toBe("Current#KR1");
    store.names.mockClear();
    await expect(resolveLolParticipantRef("forged")).rejects.toMatchObject({ kind: "invalid_request" });
    expect(store.names).not.toHaveBeenCalled();
  });
});
