import { parseLolMatchBuild } from "@/lib/lol/matchBuild";

const match = { info: { participants: [
  { participantId: 1, teamId: 100, championId: 157, puuid: "private-a" },
  { participantId: 2, teamId: 200, championId: 238, puuid: "private-b" },
] } };
const event = (type: string, participantId: number, timestamp: number, extra: Record<string, unknown> = {}) =>
  ({ type, participantId, timestamp, ...extra });
const timeline = (events: unknown[]) => ({ metadata: { matchId: "KR_1" }, info: { frames: [{ events }] } });

describe("타임라인 빌드 추출", () => {
  it("분 단위로 구매를 묶고 구매 되돌리기와 진화 스킬은 제외한다", () => {
    const build = parseLolMatchBuild(timeline([
      event("ITEM_PURCHASED", 1, 2000, { itemId: 1055 }), event("ITEM_PURCHASED", 1, 3000, { itemId: 2003 }),
      event("ITEM_PURCHASED", 1, 61_000, { itemId: 1036 }), event("ITEM_UNDO", 1, 62_000, { beforeId: 1036, afterId: 0 }),
      event("ITEM_UNDO", 1, 63_000, { beforeId: 0, afterId: 2003 }), event("ITEM_PURCHASED", 1, 600_000, { itemId: 3031 }),
      event("SKILL_LEVEL_UP", 1, 1000, { skillSlot: 1, levelUpType: "NORMAL" }),
      event("SKILL_LEVEL_UP", 1, 2000, { skillSlot: 2, levelUpType: "EVOLVE" }),
      event("SKILL_LEVEL_UP", 1, 3000, { skillSlot: 9, levelUpType: "NORMAL" }),
      event("ITEM_PURCHASED", 2, 5000, { itemId: 1056 }),
    ]), match, "KR_1");
    expect(build.players[0]).toEqual({ teamId: 100, championId: 157, skills: [1],
      items: [{ minute: 0, items: [1055, 2003] }, { minute: 10, items: [3031] }], timeline: [] });
    expect(build.players[1].items).toEqual([{ minute: 0, items: [1056] }]);
    expect(JSON.stringify(build)).not.toContain("private");
  });
  it("다른 경기의 타임라인이나 형식이 틀린 값은 거부한다", () => {
    expect(() => parseLolMatchBuild(timeline([]), match, "KR_2")).toThrow();
    expect(() => parseLolMatchBuild({ metadata: { matchId: "KR_1" }, info: {} }, match, "KR_1")).toThrow();
  });
  it("참가자별 누적 골드와 라인·정글 CS를 실제 시각으로 묶고 누락을 보존한다", () => {
    const build = parseLolMatchBuild({ metadata: { matchId: "KR_1" }, info: { frames: [
      { timestamp: 0, participantFrames: { "1": { totalGold: 500, minionsKilled: 0, jungleMinionsKilled: 0 } } },
      { timestamp: 60_000, participantFrames: {
        "1": { totalGold: 800, minionsKilled: 5, jungleMinionsKilled: 3 },
        "2": { totalGold: 750, minionsKilled: 3, jungleMinionsKilled: 0, puuid: "private-b" },
      } },
      { timestamp: 120_000, participantFrames: { "1": { totalGold: -1, minionsKilled: 10 } } },
      { timestamp: 145_000, participantFrames: { "1": { totalGold: 1100, minionsKilled: 9, jungleMinionsKilled: 4 } } },
    ] } }, match, "KR_1");
    expect(build.players[0].timeline).toEqual([
      { timestamp: 0, gold: 500, cs: 0 }, { timestamp: 60_000, gold: 800, cs: 8 },
      { timestamp: 120_000, gold: null, cs: null }, { timestamp: 145_000, gold: 1100, cs: 13 },
    ]);
    expect(build.players[1].timeline[0]).toEqual({ timestamp: 0, gold: null, cs: null });
    expect(build.players[1].timeline[1]).toEqual({ timestamp: 60_000, gold: 750, cs: 3 });
    expect(JSON.stringify(build)).not.toContain("private");
  });
  it("뒤섞인 프레임을 정렬하고 중복·잘못된 시각과 참가자 불일치를 제외한다", () => {
    const build = parseLolMatchBuild({ metadata: { matchId: "KR_1" }, info: { frames: [
      { timestamp: 60_000, participantFrames: { "1": { participantId: 2, totalGold: 800, minionsKilled: 5, jungleMinionsKilled: 0 } } },
      { timestamp: 0, participantFrames: { "1": { totalGold: 500, minionsKilled: 0, jungleMinionsKilled: 0 } } },
      { timestamp: 0, participantFrames: { "1": { totalGold: 999 } } },
      { timestamp: -1 }, { timestamp: "120000" },
      { timestamp: 120_000, participantFrames: { "1": { totalGold: Infinity, minionsKilled: Number.MAX_SAFE_INTEGER, jungleMinionsKilled: 1 } } },
    ] } }, match, "KR_1");
    expect(build.players[0].timeline).toEqual([
      { timestamp: 0, gold: 500, cs: 0 }, { timestamp: 60_000, gold: null, cs: null },
      { timestamp: 120_000, gold: null, cs: null },
    ]);
  });
});
