import { describe, expect, it } from "vitest";
import { AnalysisEngine } from "@/lib/pubg-analysis/AnalysisEngine";
import { projectTelemetryEvent, filterTelemetryEvents } from "@/lib/pubg-analysis/telemetryContract";

// 계산 5 엔진 사양(tmp/calc5/spec.md)의 테스트 1~16을 손으로 만든 이벤트로 고정한다.
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

const damage = (t: number, attacker: string, victim: string, amount = 30, extra: Record<string, unknown> = {}) => ({
  t, _T: "LogPlayerTakeDamage", attacker: actor(attacker), victim: actor(victim), damage: amount,
  damageCauserName: "WeapHK416_C", damageTypeCategory: "Damage_Gun", damageReason: "TorsoShot", ...extra,
});
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
const smoke = (t: number, attackId: number) => ({
  t, _T: "LogPlayerUseThrowable", attackId, attacker: actor("Me"), weapon: { itemId: "Item_Weapon_SmokeBomb_C" },
});

describe("계산 5 E1 · 팀 전멸 개인 기여", () => {
  it("1. 팀원만 적 팀을 때리고 다른 팀이 전멸시키면 내 전멸은 0, 기존 규칙 값은 1", () => {
    const { result } = run([damage(10_000, "TB", "E1"), kill(20_000, "O1", "E1"), kill(21_000, "O1", "E2")]);
    expect(result.tradeStats.enemyTeamWipes).toBe(0);
    expect(result.tradeStats.teamParticipationWipes).toBe(1);
    expect(result.tradeStats.wipeEvidence).toEqual([]);
  });

  it("2. 나만 피해를 준 뒤 다른 팀이 마무리해도 내 전멸 1", () => {
    const { result } = run([damage(10_000, "Me", "E1", 50), kill(20_000, "O1", "E1"), kill(21_000, "O1", "E2")]);
    expect(result.tradeStats.enemyTeamWipes).toBe(1);
    expect(result.tradeStats.wipeEvidence).toEqual([
      { rosterSize: 2, wipedAtMs: 21_000, lastMyContributionMs: 10_000, kinds: ["damage"], botMembers: 0 },
    ]);
  });

  it("3. 다른 팀이 기절시킨 적에게 피해만 주면 0, 내가 확킬하면 1", () => {
    const damageOnly = run([
      kill(5_000, "O1", "E2"),
      knock(10_000, "O1", "E1"),
      damage(11_000, "Me", "E1", 30),
      kill(12_000, "O1", "E1"),
    ]);
    expect(damageOnly.result.tradeStats.enemyTeamWipes).toBe(0);

    const finished = run([
      kill(5_000, "O1", "E2"),
      knock(10_000, "O1", "E1"),
      damage(11_000, "Me", "E1", 30),
      kill(12_000, "Me", "E1", { finisher: actor("Me"), dBNOMaker: actor("O1") }),
    ]);
    expect(finished.result.tradeStats.enemyTeamWipes).toBe(1);
    expect(finished.result.tradeStats.wipeEvidence?.[0].kinds).toEqual(["kill", "finisher"]);
  });

  it("4. 내가 기절시킨 적이 출혈사(killer 없음, dBNOMaker=나)로 전멸하면 1", () => {
    const { result } = run([
      kill(5_000, "O1", "E1"),
      knock(10_000, "Me", "E2", 7),
      kill(40_000, null, "E2", { dBNOMaker: actor("Me"), dBNOId: 7, damageTypeCategory: "Damage_Groggy" }),
    ]);
    expect(result.tradeStats.enemyTeamWipes).toBe(1);
    expect(result.tradeStats.wipeEvidence?.[0].kinds).toEqual(["knock", "dbnoMaker"]);
  });

  it("actor 없는 사망 뒤 귀속이 늦게 붙어도 마지막 처치가 내 것이면 전멸 1", () => {
    const { result } = run([
      kill(5_000, "O1", "E1"),
      { t: 10_000, _T: "LogPlayerKill", victim: actor("E2") },
      kill(10_000, "Me", "E2"),
    ]);
    expect(result.tradeStats.enemyTeamWipes).toBe(1);
    expect(result.killContribution.solo).toBe(1);
  });
});

describe("계산 5 E2 · 재투입 상태", () => {
  it("5. 적 사망→재투입→나머지 처치는 전멸 0, 복귀자까지 처치하면 1", () => {
    const base = [kill(10_000, "Me", "E1"), { t: 20_000, _T: "LogPlayerRedeploy", character: actor("E1") }, kill(30_000, "Me", "E2")];
    const partial = run(base);
    expect(partial.result.tradeStats.enemyTeamWipes).toBe(0);
    expect(partial.state.playerAliveStatus.get("e1")).toBe(true);
    expect(partial.state.teamAliveMembers.get("r-e")).toEqual(new Set(["e1"]));

    const full = run([...base, kill(40_000, "Me", "E1")]);
    expect(full.result.tradeStats.enemyTeamWipes).toBe(1);
    // 재투입 뒤 새 생명의 처치는 다시 센다.
    expect(full.result.killContribution.solo).toBe(3);
  });

  it("사망 뒤 LogPlayerCreate도 재투입 완료로 보고, BR 시작 표기 별칭도 같게 처리한다", () => {
    const viaCreate = run([kill(10_000, "Me", "E1"), { t: 20_000, _T: "LogPlayerCreate", character: actor("E1") }, kill(30_000, "Me", "E2")]);
    expect(viaCreate.result.tradeStats.enemyTeamWipes).toBe(0);
    const viaBrStart = run([kill(10_000, "Me", "E1"), { t: 20_000, _T: "LogPlayerRedeployBrStart", characters: [{ character: actor("E1") }] }, kill(30_000, "Me", "E2")]);
    expect(viaBrStart.result.tradeStats.enemyTeamWipes).toBe(0);
  });

  it("6. Recall 요청만으로는 생존을 복구하지 않는다", () => {
    const { result, state } = run([
      kill(10_000, "E1", "TB"),
      { t: 20_000, _T: "LogPlayerRecall", recalledPlayers: [actor("TB")] },
      kill(30_000, "Me", "E1"),
      { t: 31_000, _T: "LogPlayerRecall", recalledPlayers: [actor("E1")] },
      kill(40_000, "Me", "E2"),
    ]);
    expect(state.playerAliveStatus.get("tb")).toBe(false);
    expect(state.playerAliveStatus.get("e1")).toBe(false);
    // 요청만 들어온 E1은 여전히 사망 상태라 E2 처치로 전멸이 완성된다.
    expect(result.tradeStats.enemyTeamWipes).toBe(1);
    // 요청 시점 타임라인은 기존처럼 한 번 남긴다.
    expect(result.timeline.filter(event => event.type === "TEAM_RECALL")).toHaveLength(1);
  });

  it("텔레메트리 수집 계약이 BR 시작 대소문자 별칭을 공식 표기로 보존한다", () => {
    const projected = projectTelemetryEvent({ _T: "LogPlayerRedeployBrStart", characters: [{ character: actor("E1") }] });
    expect(projected).toMatchObject({ _T: "LogPlayerRedeployBRStart", characters: [{ character: { name: "E1" } }] });
    expect(filterTelemetryEvents([{ _T: "LogPlayerRedeployBrStart", characters: [] }], { mode: "lite", teamNames: new Set(), teamAccountIds: new Set() }))
      .toHaveLength(1);
  });
});

describe("계산 5 E3 · 처치·소생 중복 제거", () => {
  it("7. 같은 KillV2 두 번은 처치 1·KILL 타임라인 1, 같은 Revive 두 번은 소생 1", () => {
    const { result } = run([
      kill(10_000, "Me", "E1"),
      kill(10_000, "Me", "E1"),
      knock(20_000, "E2", "TB", 3),
      revive(30_000, "Me", "TB"),
      revive(30_000, "Me", "TB"),
    ]);
    expect(result.killContribution.solo).toBe(1);
    expect(result.timeline.filter(event => event.type === "KILL")).toHaveLength(1);
    expect(result.tradeStats.revCount).toBe(1);
    expect(result.timeline.filter(event => event.type === "REVIVE")).toHaveLength(1);
  });
});

describe("계산 5 E4 · 자가 소생", () => {
  it("8. 내 자가 소생은 revCount 0, selfReviveCount 1이고 소생 임팩트 사유가 없다", () => {
    const { result } = run([knock(10_000, "E1", "Me", 1), revive(20_000, "Me", "Me")]);
    expect(result.tradeStats.revCount).toBe(0);
    expect(result.tradeStats.selfReviveCount).toBe(1);
    expect(result.benchmark?.impactReasons ?? []).not.toContain("소생 성공");
    expect(result.benchmark?.impactReasons ?? []).not.toContain("연막 없이 안전 소생");
  });

  it("9. 팀원 기절→내 연막→팀원 자가 소생은 연막 구출 0, 구조 기회 0", () => {
    const { result } = run([knock(10_000, "E1", "TB", 1), smoke(12_000, 101), revive(20_000, "TB", "TB")]);
    expect(result.tradeStats.smokeCount).toBe(1);
    expect(result.tradeStats.smokeRescues).toBe(0);
    expect(result.tradeStats.rescueOpportunityCount).toBe(0);
    expect(result.tradeStats.rescueCount).toBe(0);
    expect(result.tradeStats.teammateSelfReviveCount).toBe(1);
    expect(result.tradeStats.revCount).toBe(0);
  });
});

describe("계산 5 E5 · 구조 사건 단위", () => {
  it("10. 팀원 기절→내 연막→내 소생은 같은 사건 하나로 구조 1, 안전 소생 0", () => {
    const { result } = run([knock(10_000, "E1", "TB", 1), smoke(12_000, 101), revive(20_000, "Me", "TB")]);
    expect(result.tradeStats).toMatchObject({
      revCount: 1, smokeRescues: 1, rescueOpportunityCount: 1, rescueCount: 1, reviveWithOwnSmokeCount: 1,
    });
    expect(result.benchmark?.impactReasons ?? []).not.toContain("연막 없이 안전 소생");
  });

  it("서로 다른 사건의 내 소생과 내 연막 구출은 서로 차감하지 않는다(안전 소생 1)", () => {
    const { result } = run([
      knock(10_000, "E1", "TB", 1), smoke(12_000, 101), revive(20_000, "TC", "TB"),
      knock(60_000, "E1", "TC", 2), revive(70_000, "Me", "TC"),
    ]);
    expect(result.tradeStats).toMatchObject({
      revCount: 1, smokeRescues: 1, rescueOpportunityCount: 2, rescueCount: 2, reviveWithOwnSmokeCount: 0,
    });
    expect(result.benchmark?.impactReasons ?? []).toContain("연막 없이 안전 소생");
  });

  it("11. 두 팀원이 동시에 기절하면 연막 1회가 두 사건 모두에 붙는다", () => {
    const { result } = run([
      knock(10_000, "E1", "TB", 1),
      knock(10_000, "E1", "TC", 2),
      smoke(12_000, 101),
      kill(15_000, "E1", "TB"),
      revive(20_000, "Me", "TC"),
    ]);
    expect(result.tradeStats).toMatchObject({
      smokeCount: 1, smokeRescues: 1, revCount: 1,
      rescueOpportunityCount: 2, rescueCount: 1, reviveWithOwnSmokeCount: 1,
    });
  });

  it("12. 내가 끝까지 기절·사망 상태였던 사건은 기회가 아니고, 소생된 뒤 살리면 기회 1·성공 1", () => {
    const helpless = run([
      knock(10_000, "E1", "Me", 1),
      knock(12_000, "E1", "TB", 2),
      revive(20_000, "TC", "TB"),
      kill(25_000, "E1", "Me"),
    ]);
    expect(helpless.result.tradeStats.rescueOpportunityCount).toBe(0);
    expect(helpless.result.tradeStats.rescueCount).toBe(0);

    const recovered = run([
      knock(10_000, "E1", "Me", 1),
      knock(12_000, "E1", "TB", 2),
      revive(20_000, "TC", "Me"),
      revive(30_000, "Me", "TB"),
    ]);
    expect(recovered.result.tradeStats.rescueOpportunityCount).toBe(1);
    expect(recovered.result.tradeStats.rescueCount).toBe(1);
    expect(recovered.result.tradeStats.revCount).toBe(1);
  });

  it("공격자 없는 팀원 기절도 내가 서 있었으면 구조 기회다", () => {
    const { result } = run([knock(10_000, null, "TB"), kill(30_000, null, "TB", { damageTypeCategory: "Damage_BlueZone" })]);
    expect(result.tradeStats.rescueOpportunityCount).toBe(1);
    expect(result.tradeStats.rescueCount).toBe(0);
  });
});

describe("계산 5 E6 · 교전 세션 정리", () => {
  it("13. 팀원이 나를 때려도 역전 시도·반격 지연이 생기지 않고, 내가 팀원을 처치해도 KILL 타임라인이 없다", () => {
    const { result } = run([damage(10_000, "TB", "Me", 20), kill(20_000, "Me", "TB")]);
    expect(result.duelStats.reversalAttempts).toBe(0);
    expect(result.tradeStats.counterLatencyMs).toBeNull();
    expect(result.timeline.filter(event => event.type === "KILL")).toHaveLength(0);
    expect(result.timeline.filter(event => event.type === "TEAM_DIED")).toHaveLength(1);
  });

  it("14. 기절한 적에게 준 피해는 서 있는 적 거리 지표와 선제 시도에 들어가지 않는다", () => {
    const far = { x: POS.Me.x + 70_000, y: POS.Me.y };
    const { result } = run([
      knock(10_000, "O1", "E1"),
      { ...damage(11_000, "Me", "E1", 10), victim: actor("E1", far) },
      { ...damage(12_000, "Me", "E1", 10), victim: actor("E1", { x: POS.Me.x + 3_000, y: POS.Me.y }) },
    ]);
    expect(result.combatPressure.maxHitDist).toBe(700); // 기존 필드 의미는 유지
    expect(result.combatPressure.maxHitDistUpright).toBe(0);
    expect(result.itemUseStats.distanceDamageUpright).toEqual({ short: 0, mid: 0, long: 0 });
    expect(result.initiativeSampleCount).toBe(0);
  });

  it("서 있는 적에게 준 피해는 upright 거리 지표에 들어간다", () => {
    const { result } = run([{ ...damage(11_000, "Me", "E1", 25), victim: actor("E1", { x: POS.Me.x + 30_000, y: POS.Me.y }) }]);
    expect(result.combatPressure.maxHitDistUpright).toBe(300);
    expect(result.itemUseStats.distanceDamageUpright).toEqual({ short: 0, mid: 0, long: 25 });
  });

  it("R4. 적 선타 세션마다 첫 반격 1회만 센다", () => {
    const { result } = run([
      damage(10_000, "E1", "Me", 10),
      damage(10_500, "Me", "E1", 10),
      damage(11_000, "Me", "E1", 10),
    ]);
    expect(result.duelStats.firstReplyWithin3sCount).toBe(1);
    expect(result.duelStats.firstReplyLatencySumMs).toBe(500);
    // 기존 reactCount 기반 평균(두 타격 평균 750ms)은 그대로 둔다.
    expect(result.tradeStats.counterLatencyMs).toBe(750);
  });
});

describe("계산 5 E7 · lite 모드와 전멸", () => {
  it("15. 내 팀 전멸 31초 뒤 적 팀 최종 사망도 lite와 full의 enemyTeamWipes가 같다", () => {
    const events = [
      damage(10_000, "Me", "E1", 50),
      kill(20_000, "E2", "Me"),
      kill(20_000, "E2", "TB"),
      kill(20_000, "E2", "TC"),
      kill(51_000, "O1", "E1"),
      kill(52_000, "O1", "E2"),
    ];
    const lite = run(events, { mode: "lite" });
    const full = run(events, { mode: "full" });
    expect(full.result.tradeStats.enemyTeamWipes).toBe(1);
    expect(lite.result.tradeStats.enemyTeamWipes).toBe(1);
    // 타임라인 기록 제한은 그대로 유지한다.
    expect(lite.result.timeline.every(event => event.ts <= 50_000)).toBe(true);
  });
});

describe("계산 5 기록 필드", () => {
  it("16. myRosterSize·aliveTeammatesAtMyDeath·wipeEvidence의 roster 크기와 봇 수", () => {
    const { result } = run(
      [
        kill(5_000, "E1", "TC"),
        kill(10_000, "Me", "Bot1"),
        kill(20_000, "E1", "Me"),
      ],
      { rosterDef: { ...ROSTERS, "r-bot": ["Bot1"] } },
    );
    expect(result.teamContext).toEqual({ myRosterSize: 3, aliveTeammatesAtMyDeath: 1 });
    expect(result.tradeStats.enemyTeamWipes).toBe(1);
    expect(result.tradeStats.wipeEvidence).toEqual([
      { rosterSize: 1, wipedAtMs: 10_000, lastMyContributionMs: 10_000, kinds: ["kill"], botMembers: 1 },
    ]);
  });

  it("사망하지 않았으면 aliveTeammatesAtMyDeath는 null이다", () => {
    const { result } = run([]);
    expect(result.teamContext).toEqual({ myRosterSize: 3, aliveTeammatesAtMyDeath: null });
  });
});
