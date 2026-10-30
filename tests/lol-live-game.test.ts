import { describe, expect, it } from "vitest";
import {
  LolLiveParseError, isUnsupportedLiveGame, liveChampionStat, liveIdentity, parseLiveCurrentGame, parseLiveRiotIdText, pickLiveSoloEntry, liveWinRate,
} from "../lib/lol/liveGame";

const puuid = "test-puuid-abcdefghijklmnop";

describe("진행 중 경기 Riot ID 파서", () => {
  it("게임 이름과 태그를 나누고 형식이 틀리면 거절한다", () => {
    expect(parseLiveRiotIdText("홍길동#KR1")).toEqual({ gameName: "홍길동", tagLine: "KR1" });
    expect(parseLiveRiotIdText("  홍길동 # KR1 ")).toEqual({ gameName: "홍길동", tagLine: "KR1" });
    expect(parseLiveRiotIdText("#KR1")).toBeNull();
    expect(parseLiveRiotIdText("a#b#c")).toBeNull();
    expect(parseLiveRiotIdText("이름#")).toBeNull();
    expect(parseLiveRiotIdText("이름\u0000#KR1")).toBeNull();
    expect(parseLiveRiotIdText(42)).toBeNull();
  });
});

describe("참가자 신원 분류", () => {
  it("puuid와 Riot ID가 모두 있을 때만 공개로 본다", () => {
    expect(liveIdentity({ puuid, riotId: "플레이어#KR1" })).toEqual({ status: "visible", puuid, riotId: "플레이어#KR1" });
  });
  it("puuid가 null이면 익명이다", () => {
    expect(liveIdentity({ puuid: null, riotId: "플레이어#KR1" })).toEqual({ status: "private" });
  });
  it("Riot ID가 없거나 형식이 깨지면 익명이다", () => {
    expect(liveIdentity({ puuid })).toEqual({ status: "private" });
    expect(liveIdentity({ puuid, riotId: "" })).toEqual({ status: "private" });
    expect(liveIdentity({ puuid, riotId: "#KR1" })).toEqual({ status: "private" });
  });
  it("puuid 형식이 맞지 않으면 익명이다", () => {
    expect(liveIdentity({ puuid: "짧음", riotId: "플레이어#KR1" })).toEqual({ status: "private" });
  });
  it("봇은 봇으로만 표시한다", () => {
    expect(liveIdentity({ bot: true, puuid: null })).toEqual({ status: "bot" });
  });
});

describe("진행 중 경기 응답 파서", () => {
  const participant = (teamId: number, championId: number, extra: Record<string, unknown> = {}) => ({
    teamId, championId, spell1Id: 4, spell2Id: 14, puuid, riotId: "플레이어#KR1", bot: false,
    perks: { perkIds: [8005, 9111, 9104, 8014, 8345, 8347, 5008, 5002], perkStyle: 8000, perkSubStyle: 8100 }, ...extra,
  });
  const raw = (over: Record<string, unknown> = {}) => ({
    gameId: 7001, gameType: "MATCHED_GAME", gameQueueConfigId: 420, gameLength: 312, mapId: 11,
    bannedChampions: [{ championId: 9, teamId: 100, pickTurn: 1 }, { championId: 0, teamId: 200, pickTurn: 2 }],
    participants: [participant(100, 1), participant(200, 2, { puuid: null, riotId: undefined })],
    ...over,
  });

  it("필요한 필드만 정규화하고 익명 참가자를 private로 분류한다", () => {
    const game = parseLiveCurrentGame(raw());
    expect(game.queueId).toBe(420);
    expect(game.gameLengthSeconds).toBe(312);
    expect(game.bans).toEqual([{ teamId: 100, championId: 9 }]);
    expect(game.participants[0]).toMatchObject({ teamId: 100, championId: 1, spell1Id: 4, perkStyle: 8000, perkSubStyle: 8100, perkIds: expect.any(Array) });
    expect(game.participants[0].identity.status).toBe("visible");
    expect(game.participants[1].identity.status).toBe("private");
  });

  it("참가자 구조가 깨지면 파서 오류를 낸다", () => {
    expect(() => parseLiveCurrentGame(raw({ participants: "x" }))).toThrow(LolLiveParseError);
    expect(() => parseLiveCurrentGame(raw({ gameQueueConfigId: undefined }))).toThrow(LolLiveParseError);
    expect(() => parseLiveCurrentGame(raw({ participants: [participant(100, 0)] }))).toThrow(LolLiveParseError);
  });

  it("커스텀 게임(CUSTOM_GAME 또는 queue 0)은 지원하지 않는 경기로 본다", () => {
    expect(isUnsupportedLiveGame({ gameType: "CUSTOM_GAME", queueId: 0 })).toBe(true);
    expect(isUnsupportedLiveGame({ gameType: "MATCHED_GAME", queueId: 0 })).toBe(true);
    expect(isUnsupportedLiveGame({ gameType: "CUSTOM_GAME", queueId: 420 })).toBe(true);
    expect(isUnsupportedLiveGame({ gameType: "MATCHED_GAME", queueId: 420 })).toBe(false);
  });
});

describe("솔로 랭크 항목과 승률", () => {
  it("솔로 랭크 항목만 고르고 없으면 언랭크로 본다", () => {
    expect(pickLiveSoloEntry([{ queueType: "RANKED_FLEX_SR", tier: "GOLD", rank: "I", leaguePoints: 1, wins: 1, losses: 1 },
      { queueType: "RANKED_SOLO_5x5", tier: "GOLD", rank: "II", leaguePoints: 45, wins: 30, losses: 25 }]))
      .toEqual({ tier: "GOLD", rank: "II", leaguePoints: 45, wins: 30, losses: 25 });
    expect(pickLiveSoloEntry([{ queueType: "RANKED_FLEX_SR", tier: "GOLD", rank: "I", leaguePoints: 1, wins: 1, losses: 1 }])).toBeNull();
    expect(pickLiveSoloEntry("bad")).toBe("invalid");
    expect(pickLiveSoloEntry([{ queueType: "RANKED_SOLO_5x5", tier: "GOLD", rank: "II", leaguePoints: -1, wins: 1, losses: 1 }])).toBe("invalid");
  });
  it("승률은 승패가 없으면 null이다", () => {
    expect(liveWinRate(3, 1)).toBe(0.75);
    expect(liveWinRate(0, 0)).toBeNull();
  });
});

describe("챔피언 통계 표시 규칙", () => {
  const rows = [
    { team_position: "TOP" as const, champion_id: 100, games: 15, wins: 9, bans: 40, matches: 1000 },
    { team_position: "MIDDLE" as const, champion_id: 100, games: 10, wins: 6, bans: 40, matches: 1000 },
    { team_position: "MIDDLE" as const, champion_id: 101, games: 5, wins: 3, bans: 2, matches: 1000 },
  ];
  it("포지션 행을 합쳐 픽률·밴율·승률을 계산한다", () => {
    expect(liveChampionStat(100, rows, 1000)).toEqual({ status: "ok", games: 25, winRate: 15 / 25, pickRate: 25 / 1000, banRate: 40 / 1000 });
  });
  it("20판 미만은 승률 대신 표본 부족으로 둔다", () => {
    expect(liveChampionStat(101, rows, 1000)).toEqual({ status: "small_sample", games: 5, pickRate: 5 / 1000, banRate: 2 / 1000 });
  });
  it("통계 행이 없는 챔피언은 통계 없음이다", () => {
    expect(liveChampionStat(999, rows, 1000)).toEqual({ status: "none" });
  });
});
