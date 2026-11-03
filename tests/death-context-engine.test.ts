import { describe, expect, it } from "vitest";
import { AnalysisEngine } from "@/lib/pubg-analysis/AnalysisEngine";

// 내가 기절·사망한 순간의 팀원 근접(deathContext)을 손으로 만든 이벤트로 고정한다.
// 내 팀: Me·TB·TC(r-me), 적 팀: E1·E2(r-e), 다른 팀: O1(r-o)

const baseTime = Date.parse("2026-10-27T10:00:00Z");
const at = (ms: number) => new Date(baseTime + ms).toISOString();

type Pos = { x: number; y: number };
const POS: Record<string, Pos> = {
  Me: { x: 100000, y: 100000 },
  TB: { x: 100500, y: 100000 },
  TC: { x: 101000, y: 100000 },
  E1: { x: 102000, y: 100000 },
  E2: { x: 102500, y: 100000 },
  O1: { x: 150000, y: 100000 },
  Bot1: { x: 103000, y: 100000 },
};
const accountOf = (name: string) => (name.startsWith("Bot") ? `ai.${name}` : `account.${name.toLowerCase()}`);
const actor = (name: string, pos: Pos = POS[name]) => ({
  name,
  accountId: accountOf(name),
  location: { x: pos.x, y: pos.y, z: 0 },
});

const ROSTERS: Record<string, string[]> = { "r-me": ["Me", "TB", "TC"], "r-e": ["E1", "E2"], "r-o": ["O1"] };

function buildMatch(rosterDef: Record<string, string[]> = ROSTERS) {
  const participants = Object.values(rosterDef).flat().map(name => ({
    id: `p-${name}`,
    attributes: {
      stats: {
        name,
        playerId: accountOf(name),
        damageDealt: 100,
        kills: 0,
        assists: 0,
        DBNOs: 0,
        winPlace: 5,
        timeSurvived: 900,
      },
      accountId: accountOf(name),
    },
  }));
  const rosters = Object.entries(rosterDef).map(([id, members]) => ({
    id,
    relationships: { participants: { data: members.map(name => ({ id: `p-${name}` })) } },
  }));
  return { participants, rosters };
}

function run(
  events: Array<Record<string, unknown> & { t: number }>,
  options: { mode?: string; rosterDef?: Record<string, string[]> } = {},
) {
  const { participants, rosters } = buildMatch(options.rosterDef);
  const engine = new AnalysisEngine(
    "Me",
    "account.me",
    new Set(["me", "tb", "tc"]),
    new Set(["account.me", "account.tb", "account.tc"]),
    new Set(),
    new Set(),
    "r-me",
    options.mode ?? "lite",
  );
  const telemetry = [
    { _T: "LogMatchStart", _D: at(0) },
    ...events.map(({ t, ...event }) => ({ ...event, _D: at(t) })),
  ];
  const me = participants.find(p => p.attributes.stats.name === "Me")!.attributes.stats;
  const team = participants.filter(p => ["Me", "TB", "TC"].includes(p.attributes.stats.name)).map(p => p.attributes.stats);
  const result = engine.run(telemetry, { id: "calc5", createdAt: at(0), gameMode: "squad", mapName: "Baltic_Main", matchType: "official" }, rosters, participants, me, team, {});
  return { result, state: (engine as any).state };
}

const knock = (t: number, attacker: string | null, victim: string, dBNOId?: number) => ({
  t, _T: "LogPlayerMakeGroggy", ...(attacker ? { attacker: actor(attacker) } : {}), victim: actor(victim),
  damageCauserName: "WeapHK416_C", ...(dBNOId !== undefined ? { dBNOId } : {}),
});
const kill = (t: number, killer: string | null, victim: string, extra: Record<string, unknown> = {}) => ({
  t, _T: "LogPlayerKillV2", ...(killer ? { killer: actor(killer) } : {}), victim: actor(victim),
  damageCauserName: "WeapHK416_C", ...extra,
});
const revive = (t: number, reviver: string, victim: string) => ({
  t, _T: "LogPlayerRevive", reviver: actor(reviver), victim: actor(victim),
});
const position = (t: number, name: string, pos: Pos) => ({
  t, _T: "LogPlayerPosition", character: actor(name, pos),
});
// Me(100000,100000) 기준 거리: TB 200m, TC 300m
const TB_FAR = { x: 120000, y: 100000 };
const TC_FAR = { x: 130000, y: 100000 };

describe("기절·사망 시점 팀원 근접(deathContext)", () => {
  it("기절과 사망 시점마다 가장 가까운 생존 팀원 거리를 잰다", () => {
    const { result } = run([
      position(1_000, "TB", TB_FAR), position(1_000, "TC", TC_FAR),
      knock(5_000, "E1", "Me"),
      position(15_000, "TB", { x: 140000, y: 100000 }), position(15_000, "TC", TC_FAR),
      kill(20_000, "E1", "Me"),
    ]);
    expect(result.deathContext).toEqual({
      atKnock: { atMs: 5_000, nearestAliveTeammateM: 200, aliveTeammateCount: 2, locationAgeMs: 4_000 },
      atDeath: { atMs: 20_000, nearestAliveTeammateM: 300, aliveTeammateCount: 2, locationAgeMs: 5_000 },
    });
  });

  it("15초보다 오래된 팀원 위치는 거리로 쓰지 않는다", () => {
    const { result } = run([
      position(1_000, "TB", TB_FAR), position(1_000, "TC", TC_FAR),
      kill(20_000, "E1", "Me"),
    ]);
    expect(result.deathContext).toEqual({
      atKnock: null,
      atDeath: { atMs: 20_000, nearestAliveTeammateM: null, aliveTeammateCount: 2, locationAgeMs: null },
    });
  });

  it("생존 팀원이 없으면 마지막 생존자로 기록하고 거리는 비운다", () => {
    const { result } = run([
      position(1_000, "TB", TB_FAR), position(1_000, "TC", TC_FAR),
      kill(2_000, "E1", "TB"), kill(3_000, "E1", "TC"),
      kill(10_000, "E1", "Me"),
    ]);
    expect(result.deathContext?.atDeath).toEqual({ atMs: 10_000, nearestAliveTeammateM: null, aliveTeammateCount: 0, locationAgeMs: null });
  });

  it("기절한 팀원은 생존 팀원으로 세지 않는다", () => {
    const { result } = run([
      position(1_000, "TB", TB_FAR), position(1_000, "TC", TC_FAR),
      knock(2_000, "E1", "TB"),
      kill(10_000, "E1", "Me"),
    ]);
    expect(result.deathContext?.atDeath).toMatchObject({ nearestAliveTeammateM: 300, aliveTeammateCount: 1 });
  });

  it("소생된 기절은 기록에서 지운다", () => {
    const { result } = run([
      position(1_000, "TB", TB_FAR), position(1_000, "TC", TC_FAR),
      knock(5_000, "E1", "Me"),
      revive(8_000, "TB", "Me"),
      position(18_000, "TB", TB_FAR), position(18_000, "TC", TC_FAR),
      kill(20_000, "E1", "Me"),
    ]);
    expect(result.deathContext?.atKnock).toBeNull();
    expect(result.deathContext?.atDeath).toMatchObject({ nearestAliveTeammateM: 200 });
  });

  it("사망하지 않았으면 null이다", () => {
    const { result } = run([position(1_000, "TB", TB_FAR), knock(5_000, "E1", "Me"), revive(8_000, "TB", "Me")]);
    expect(result.deathContext).toBeNull();
  });
});
