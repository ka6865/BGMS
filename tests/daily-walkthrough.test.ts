import { describe, expect, it } from "vitest";
import type { DailyRankerStory } from "../lib/learn/dailyStories";
import { buildDailyWalkthrough } from "../lib/learn/dailyWalkthrough";

const fact = (id: string, timeSeconds: number, kind: string, text = id, position?: { x: number; y: number }) => ({
  id, timeSeconds, kind, text, ...(position ? { position, positionTimeSeconds: timeSeconds } : {}),
});

function story(overrides: Record<string, unknown> = {}): DailyRankerStory {
  return {
    dayKst: "2026-09-28", matchId: "match", nickname: "Ranker", mode: "solo", mapName: "Miramar",
    leaderboardRank: 1, playedAt: "2026-09-28T00:00:00.000Z", publishedAt: "2026-09-28T00:00:00.000Z",
    kills: 11, damage: 1000, teamKills: 11, headline: "", conclusion: "", points: [], facts: [], weapons: [],
    killEvents: [], teamKillEvents: [], route: [], aircraft: [],
    zones: [], limitations: [],
    ...overrides,
  } as unknown as DailyRankerStory;
}

function soloMatch(): DailyRankerStory {
  const killRows = [
    [362.234, "Kar98k"], [944.543, "M416"], [959.197, "M24"], [985.141, "M416"],
    [1157.258, "M416"], [1162.418, "M24"], [1220.896, "M416"], [1229.669, "수류탄"],
    [1390.231, "링스 AMR"], [1427.205, "링스 AMR"], [1673.913, "수류탄"],
  ] as const;
  const zoneRows = [
    [1, 100.663, 1264, 502.418], [2, 520.64, 429, 552.422], [3, 700.624, 0, 702.433],
    [4, 880.653, 0, 882.444], [5, 1060.639, 135, 1122.437], [6, 1230.619, 107, 1332.401],
    [7, 1410.625, 0, 1412.432], [8, 1560.622, 0, 1562.426],
  ] as const;
  const facts = [
    fact("landing", 76.757, "landing", "착지", { x: 2947, y: 4504 }),
    ...zoneRows.map(([phase, at, outside]) => fact("zone-" + phase, at, "zone", phase + "번째 자기장 공개" + (outside ? " · 경계 밖 약 " + outside + "m" : " · 원 안 위치 관측"))),
    ...killRows.map(([at, weapon], index) => fact("kill-" + (index + 1), at, "kill", weapon + " 처치")),
    fact("find-m24", 430.875, "weapon_find", "전리품 상자 M24 획득"),
    fact("find-lynx", 1315.096, "weapon_find", "보급품 링스 AMR 획득"),
    fact("vehicle-bike", 438.549, "vehicle", "오토바이 탑승"),
    fact("vehicle-car", 518.203, "vehicle", "미라도 탑승"),
    fact("route-before", 50, "route"),
    fact("route-losleones", 542.442, "route"),
    fact("route-final", 1670, "route"),
    fact("route-after", 1680, "route"),
    fact("encounter-final", 1668.06, "encounter"),
    fact("finish", 1678.263, "finish", "경기 종료 기록 · 1위"),
  ];
  return story({
    facts,
    kills: 11,
    teamKills: 11,
    killEvents: killRows.map(([timeSeconds, weapon]) => ({ timeSeconds, weapon, victim: "opponent", distanceMeters: weapon === "Kar98k" ? 329 : 154 })),
    teamKillEvents: killRows.map(([timeSeconds, weapon]) => ({ timeSeconds, killer: "Ranker", victim: "opponent", weapon })),
    weaponFinds: [
      { timeSeconds: 430.875, player: "Ranker", weapon: "M24", source: "lootbox", owner: "opponent" },
      { timeSeconds: 1315.096, player: "Ranker", weapon: "링스 AMR", source: "carepackage", owner: null },
    ],
    route: [
      { timeSeconds: 50, x: 100, y: 100, place: null, spreadMeters: 0, players: [] },
      { timeSeconds: 542.442, x: 5135, y: 5458, place: "losleones", spreadMeters: 0, players: [] },
      { timeSeconds: 1670, x: 5400, y: 6970, place: null, spreadMeters: 0, players: [] },
      { timeSeconds: 1680, x: 1, y: 1, place: null, spreadMeters: 0, players: [] },
    ],
    zones: zoneRows.map(([phase, observedSeconds, outsideMeters, firstInsideSeconds]) => ({
      phase, observedSeconds, outsideMeters, firstInsideSeconds,
      center: { x: 5300, y: 6900 }, radius: 1000, sourceIndices: [phase],
    })),
    encounters: [{
      id: "encounter-final", startSeconds: 1668.06, endSeconds: 1673.913, opponents: ["opponent"], allies: ["Ranker"],
      teamKills: 1, rankerWeapons: ["수류탄"], firstRankerShot: null, precontactMovement: [], arrival: null, vehicle: null, actions: [],
      snapshots: [{ offsetSeconds: 0, anchorLabel: "처음 기록된 피해", targetTimeSeconds: 1668.06, missingPlayers: [], points: [
        { player: "Ranker", side: "ally", directlyInvolved: true, x: 540879.4, y: 696901.2, sampleTimeSeconds: 1672.405, ageSeconds: 4 },
        { player: "other", side: "opponent", directlyInvolved: true, x: 544271.5, y: 703946.3, sampleTimeSeconds: 1672.542, ageSeconds: 4 },
        { player: "Ranker", side: "ally", directlyInvolved: true, x: 540985, y: 697129, sampleTimeSeconds: 1693.335, ageSeconds: 4 },
      ] }],
    }],
  });
}

function connectedSolo(): DailyRankerStory {
  const input = soloMatch();
  for (const item of input.facts) {
    const kill = input.killEvents.find(({ timeSeconds }) => timeSeconds === item.timeSeconds);
    if (["landing", "finish", "vehicle", "weapon_find", "kill"].includes(item.kind)) {
      Object.assign(item, { actorId: "ranker-id", actorTeamId: 1, sourceIndices: [Math.floor(item.timeSeconds)] });
    }
    if (kill) Object.assign(item, { victimId: "target-id", weapon: kill.weapon });
    if (item.id === "landing") Object.assign(item, { place: "로스 레오네스" });
    if (item.kind === "vehicle") Object.assign(item, { vehicleName: item.id === "vehicle-bike" ? "오토바이" : "미라도" });
    if (item.kind === "weapon_find") Object.assign(item, { weapon: item.id === "find-lynx" ? "링스 AMR" : "M24" });
  }
  for (const find of input.weaponFinds!) find.playerId = "ranker-id";
  Object.assign(input.zones[0], { shrinkObservedSeconds: 180, positions: [
    { timeSeconds: 80, x: 1, y: 1, sourceIndices: [80] },
    { timeSeconds: 90, x: 3000, y: 4500, sourceIndices: [90] },
    { timeSeconds: 130, x: 3200, y: 4600, sourceIndices: [130] },
    { timeSeconds: 438.549, x: 4200, y: 5000, sourceIndices: [438] },
    { timeSeconds: 502.418, x: 5000, y: 6000, sourceIndices: [502] },
    { timeSeconds: 520.64, x: 2, y: 2, sourceIndices: [520] },
    { timeSeconds: 550, x: 3, y: 3, sourceIndices: [550] },
  ] });
  input.encounters![0].actions = [
    { timeSeconds: 1668.06, kind: "first_hit", actor: "Ranker", victim: "opponent", weapon: "수류탄", distanceMeters: 78,
      actorId: "ranker-id", victimId: "target-id", actorTeamId: 1, victimTeamId: 2, sourceIndices: [1668] },
    { timeSeconds: 1673.913, kind: "kill", actor: "Ranker", victim: "opponent", weapon: "수류탄", distanceMeters: 78,
      actorId: "ranker-id", victimId: "target-id", actorTeamId: 1, victimTeamId: 2, sourceIndices: [1673] },
  ];
  return input;
}

describe("daily walkthrough", () => {
  it("shows first damage, recorded return fire, same-target close follow-up, vehicle status and finishers", () => {
    const action = (timeSeconds: number, kind: string, actor: string, victim: string, weapon: string,
      distanceMeters: number, actorId: string, victimId: string, actorInVehicle: boolean, victimInVehicle = false) => ({
      timeSeconds, kind, actor, victim, weapon, distanceMeters, actorId, victimId,
      actorTeamId: actorId.startsWith("enemy") ? 2 : 1,
      victimTeamId: victimId.startsWith("enemy") ? 2 : 1,
      actorInVehicle, victimInVehicle,
    });
    const actions = [
      action(479.228, "first_hit", "angodieHl", "LianYuan-18cm", "뮤턴트", 59, "ally-angodie", "enemy-lian", true),
      action(479.28, "knock", "angodieHl", "LianYuan-18cm", "뮤턴트", 58, "ally-angodie", "enemy-lian", true),
      action(486.527, "first_hit", "24El", "angodieHl", "ACE32", 12, "enemy-24", "ally-angodie", false, true),
      action(486.852, "knock", "BSF-202", "24El", "RPD", 7, "ally-bsf", "enemy-24", true),
      action(487.589, "first_hit", "9DFMLG", "BSF-202", "AUG", 12, "enemy-9", "ally-bsf", false, true),
      action(487.639, "knock", "BSF-202", "9DFMLG", "RPD", 7, "ally-bsf", "enemy-9", true),
      action(490.1, "kill", "BSF-202", "24El", "RPD", 5, "ally-bsf", "enemy-24", true),
      action(491.959, "kill", "BSF-202", "9DFMLG", "RPD", 6, "ally-bsf", "enemy-9", true),
      action(494.981, "kill", "angodieHl", "LianYuan-18cm", "뮤턴트", 15, "ally-angodie", "enemy-lian", false),
    ];
    const teamKillEvents = [
      { timeSeconds: 490.1, killer: "BSF-202", victim: "24El", weapon: "RPD" },
      { timeSeconds: 491.959, killer: "BSF-202", victim: "9DFMLG", weapon: "RPD" },
      { timeSeconds: 494.981, killer: "angodieHl", victim: "LianYuan-18cm", weapon: "뮤턴트" },
    ];
    const input = story({ mode: "squad", nickname: "Ranker", kills: 0, teamKills: 3, teamKillEvents,
      facts: [
        { ...fact("landing", 90, "landing"), actorId: "ranker", actorTeamId: 1 },
        { ...fact("route-before-fight", 470, "route"), sourceIndices: [470] },
        fact("fight", 479.228, "encounter"),
        ...teamKillEvents.map((kill, index) => ({ ...fact("kill-" + index, kill.timeSeconds, "teammate_kill"),
          actorId: index < 2 ? "ally-bsf" : "ally-angodie", actorTeamId: 1,
          victimId: ["enemy-24", "enemy-9", "enemy-lian"][index], weapon: kill.weapon })),
        fact("finish", 600, "finish", "경기 종료 기록 · 1위"),
      ],
      route: [{ timeSeconds: 470, x: 1000, y: 1000, place: null, spreadMeters: 0, players: [] }],
      zones: [{ phase: 7, observedSeconds: 450, outsideMeters: 0, firstInsideSeconds: 450,
        center: { x: 1000, y: 1000 }, radius: 500 }],
      encounters: [{ id: "fight", startSeconds: 479.228, endSeconds: 494.981, actions,
        rosterAllies: ["Ranker", "BSF-202", "angodieHl", "MateC"],
        vehicle: "첫 피해 때 angodieHl이(가) 차량에 타고 있었습니다.", precontactMovement: [], arrival: null }],
    });
    const original = structuredClone(input);
    const result = buildDailyWalkthrough(input);
    const scene = result.combatScenes!.find(({ id }) => id === "combat-fight")!;
    expect(scene.brief?.situation).toContain("07:59 팀원 2(차량 탑승)의 뮤턴트 공격 → 상대 3 피해 기록");
    expect(scene.brief?.action).toContain("팀원 2(차량 탑승) · 뮤턴트 · 상대 3 기절");
    expect(scene.brief?.action).toContain("상대 팀 반격 기록");
    expect(scene.brief?.action).toContain("상대 1 → 팀원 2(차량 탑승) (ACE32, 12m)");
    expect(scene.brief?.action).toContain("팀원 1(차량 탑승) · RPD · 상대 1·상대 2 기절");
    expect(scene.brief?.outcome).toBe("08:10–08:11 팀원 1 처치: 상대 1·상대 2, 08:14 팀원 2 처치: 상대 3 · 팀 3킬 (개인 0킬)");
    expect(scene.action).toContain("상대 1 → 팀원 2(차량 탑승) · ACE32 · 피해 기록");
    expect(scene.action).toContain("참가자 이름: 팀원 2=angodieHl");
    expect([...new Set((scene.brief?.situation + " " + scene.brief?.action + " " + scene.brief?.outcome)
      .match(/팀원 \d+/g) ?? [])]).toHaveLength(2);
    expect(input).toEqual(original);
    const legacy = structuredClone(input);
    delete legacy.encounters![0].actions[0].actorInVehicle;
    expect(buildDailyWalkthrough(legacy).combatScenes?.find(({ id }) => id === "combat-fight")?.brief?.situation)
      .toContain("팀원 2 차량 탑승 기록(첫 피해 시점)");
    const finalHighlight = result.highlights!.find(({ id }) => id === "highlight-fight")!;
    expect(finalHighlight.brief?.situation).toBe(scene.brief?.situation);
    expect(finalHighlight.brief?.action).toBe(scene.brief?.action);
    expect(finalHighlight.brief?.outcome).toContain("팀 3킬 (개인 0킬)");
    expect(finalHighlight.brief?.outcome).not.toContain("경기 종료");
    expect(finalHighlight.kind).toBe("combat");
    expect(finalHighlight.endSeconds).toBe(494.981);
    expect(finalHighlight.startSeconds).toBe(scene.startSeconds);
    expect(finalHighlight.anchorSeconds).toBe(scene.anchorSeconds);
    expect(finalHighlight.mapSnapshot).toEqual(scene.mapSnapshot);
    expect(finalHighlight.combatZone).toEqual(scene.combatZone);
    expect(finalHighlight.evidenceIds).toEqual(expect.arrayContaining(scene.evidenceIds));
    expect(finalHighlight.sourceIndices).toEqual(expect.arrayContaining(scene.sourceIndices ?? []));
  });

  it("keeps role aliases stable across reengagements and limits nicknames to the detail lookup", () => {
    const input = story({ mode: "duo", facts: [
      { ...fact("landing", 10, "landing"), actorId: "ranker-id", actorTeamId: 1 },
      fact("fight-a", 100, "encounter"), fact("fight-b", 200, "encounter"), fact("finish", 300, "finish"),
    ], encounters: [100, 200].map((at, index) => ({
      id: "fight-" + (index ? "b" : "a"), startSeconds: at, endSeconds: at + 1,
      rosterAllies: ["Ranker", "AllyName"], allies: ["Ranker", "AllyName"], opponents: ["EnemyName"],
      actions: [{ timeSeconds: at, kind: "first_hit", actor: "AllyName", victim: "EnemyName", weapon: "M416",
        distanceMeters: 30, actorId: "ally-id", victimId: "enemy-id", actorTeamId: 1, victimTeamId: 2 }],
    })) });
    const original = structuredClone(input);
    const scenes = buildDailyWalkthrough(input).combatScenes!;
    expect(scenes).toHaveLength(2);
    for (const scene of scenes) {
      expect(scene.brief?.situation).toContain("팀원 1의 M416 공격 → 상대 1 피해 기록");
      expect(scene.brief?.situation).not.toContain("AllyName");
      expect(scene.brief?.situation).not.toContain("EnemyName");
      expect(scene.action).toContain("참가자 이름: 팀원 1=AllyName, 상대 1=EnemyName");
    }
    expect(input).toEqual(original);
  });

  it("uses fresh observed blue circles and retrospective shrink timing at each scene anchor", () => {
    const moments = [90, 110, 120, 130, 200, 210, 231, 251, 255];
    const input = story({ kills: 0, teamKills: 0,
      facts: [fact("landing", 90, "landing", "착지", { x: 100, y: 100 }),
        fact("zone-1", 100, "zone"), fact("zone-2", 200, "zone"), fact("zone-3", 250, "zone"),
        ...moments.map((at) => fact("fight-" + at, at, "encounter")),
        ...moments.map((at) => fact("route-" + at, at, "route")), fact("finish", 270, "finish")],
      route: moments.map((at) => ({ timeSeconds: at, x: 100, y: 100, place: null, spreadMeters: 0, players: [] })),
      zones: [
        { phase: 1, observedSeconds: 100, outsideMeters: 0, firstInsideSeconds: 100,
          shrinkObservedSeconds: 120, center: { x: 100, y: 100 }, radius: 500 },
        { phase: 2, observedSeconds: 200, outsideMeters: 0, firstInsideSeconds: 200,
          shrinkObservedSeconds: 240, center: { x: 100, y: 100 }, radius: 200 },
        { phase: 3, observedSeconds: 250, outsideMeters: 0, firstInsideSeconds: 250,
          center: { x: 100, y: 100 }, radius: 0.5 },
      ],
      blueZoneSamples: [
        { timeSeconds: 90, center: { x: 100, y: 100 }, radius: 1000, sourceIndex: 90 },
        { timeSeconds: 100, center: { x: 100, y: 100 }, radius: 1000, sourceIndex: 100 },
        { timeSeconds: 110, center: { x: 100, y: 100 }, radius: 1000, sourceIndex: 110 },
        { timeSeconds: 120, center: { x: 100, y: 100 }, radius: 800, sourceIndex: 120 },
        { timeSeconds: 130, center: { x: 100, y: 100 }, radius: 500, sourceIndex: 130 },
        { timeSeconds: 199, center: { x: 100, y: 100 }, radius: 500, sourceIndex: 199 },
        { timeSeconds: 200, center: { x: 100, y: 100 }, radius: 400, sourceIndex: 200 },
        { timeSeconds: 210, center: { x: 100, y: 100 }, radius: 400, sourceIndex: 210 },
        { timeSeconds: 240, center: { x: 100, y: 100 }, radius: 300, sourceIndex: 240 },
        { timeSeconds: 250, center: { x: 100, y: 100 }, radius: 1, sourceIndex: 250 },
        { timeSeconds: 251, center: { x: 100, y: 100 }, radius: 1, sourceIndex: 251 },
        { timeSeconds: 255, center: { x: 100, y: 100 }, radius: 0.5, sourceIndex: 255 },
      ],
      encounters: moments.map((at) => ({ id: "fight-" + at, startSeconds: at, endSeconds: at,
        actions: [{ timeSeconds: at, kind: "first_hit", actor: "Ranker", victim: "Enemy", weapon: "M416",
          actorId: "ranker-id", victimId: "enemy-id", actorTeamId: 1 }] })),
    });
    const result = buildDailyWalkthrough(input);
    const at = (seconds: number) => result.combatScenes!.find(({ anchorSeconds }) => anchorSeconds === seconds)?.mapSnapshot?.blueZone;
    expect(at(90)).toEqual({ x: 100, y: 100, radius: 1000, observedSeconds: 90, sourceIndex: 90, status: "unknown" });
    expect(at(110)).toEqual({ x: 100, y: 100, radius: 1000, observedSeconds: 110, sourceIndex: 110,
      status: "waiting", phase: 1, countdownSeconds: 10 });
    expect(at(120)).toEqual(expect.objectContaining({ radius: 800, status: "shrinking", phase: 1 }));
    expect(at(120)?.countdownSeconds).toBeUndefined();
    expect(at(130)).toEqual(expect.objectContaining({ radius: 500, status: "complete", phase: 1 }));
    expect(at(200)).toEqual(expect.objectContaining({ radius: 400, status: "waiting", phase: 2, countdownSeconds: 40 }));
    expect(at(210)?.countdownSeconds).toBe(30);
    expect(at(231)).toBeUndefined();
    expect(at(251)).toEqual(expect.objectContaining({ radius: 1, status: "unknown", phase: 3 }));
    expect(at(255)).toEqual(expect.objectContaining({ radius: 0.5, status: "complete", phase: 3, sourceIndex: 255 }));
    expect(result.chapters[0].mapSnapshot?.blueZone?.observedSeconds).toBeLessThanOrEqual(result.chapters[0].anchorSeconds);
    expect(result.highlights?.[0].mapSnapshot?.blueZone?.observedSeconds).toBeLessThanOrEqual(result.highlights![0].anchorSeconds);
    expect(result.combatScenes?.every(({ anchorSeconds, mapSnapshot }) =>
      !mapSnapshot?.blueZone || mapSnapshot.blueZone.observedSeconds <= anchorSeconds)).toBe(true);
  });

  it("uses only a recent past ranker position for circle context and keeps it on the final map", () => {
    const build = (positions: { timeSeconds: number; x: number; y: number; sourceIndices?: number[] }[], snapshots: unknown[] = []) => {
      const ownKill = { timeSeconds: 190, killer: "Ranker", victim: "Enemy", weapon: "M416" };
      return buildDailyWalkthrough(story({ mode: "duo", kills: 1, teamKills: 1,
        facts: [
          { ...fact("landing", 90, "landing"), actorId: "ranker-id", actorTeamId: 1 },
          { ...fact("zone", 100, "zone"), sourceIndices: [100] },
          { ...fact("encounter", 180, "encounter"), sourceIndices: [180] },
          { ...fact("kill", 190, "kill"), actorId: "ranker-id", actorTeamId: 1,
            victimId: "enemy-id", victimTeamId: 2, weapon: "M416", sourceIndices: [190] },
          { ...fact("finish", 200, "finish", "경기 종료 기록 · 1위"), actorId: "ranker-id", actorTeamId: 1 },
        ],
        killEvents: [{ timeSeconds: 190, victim: "Enemy", weapon: "M416" }], teamKillEvents: [ownKill],
        zones: [{ phase: 1, observedSeconds: 100, outsideMeters: 0, firstInsideSeconds: 100, shrinkObservedSeconds: 170,
          center: { x: 1000, y: 1000 }, radius: 100, positions }],
        encounters: [{ id: "encounter", startSeconds: 180, endSeconds: 190, snapshots, actions: [
          { timeSeconds: 180, kind: "first_hit", actor: "Ranker", actorId: "ranker-id", actorTeamId: 1,
            victim: "Enemy", victimId: "enemy-id", victimTeamId: 2, weapon: "M416", sourceIndices: [180] },
          { timeSeconds: 190, kind: "kill", actor: "Ranker", actorId: "ranker-id", actorTeamId: 1,
            victim: "Enemy", victimId: "enemy-id", victimTeamId: 2, weapon: "M416", sourceIndices: [190] },
        ] }],
      }));
    };

    const recent = build([{ timeSeconds: 165, x: 2500, y: 1000, sourceIndices: [165] }]).highlights!.at(-1)!;
    expect(recent.brief?.situation).toContain("02:45 본인 위치 · 1번째 원 밖 약 1400m");
    expect(recent.brief?.situation).toContain("축소 시작 확인 후");
    expect(recent.mapSnapshot?.observations).toContainEqual(expect.objectContaining({ timeSeconds: 165, x: 2500, y: 1000 }));
    expect(recent.sourceIndices).toContain(165);

    const nonRankerOrFuture = build([], [{ offsetSeconds: 0, anchorLabel: "fight", targetTimeSeconds: 180,
      missingPlayers: [], points: [
        { player: "Ranker", side: "ally", directlyInvolved: true, x: 250000, y: 100000, sampleTimeSeconds: 181, ageSeconds: 1 },
        { player: "Ally", side: "ally", directlyInvolved: true, x: 250000, y: 100000, sampleTimeSeconds: 179, ageSeconds: 1 },
      ] }]).highlights!.at(-1)!;
    expect(nonRankerOrFuture.brief?.situation).not.toContain("본인 위치");

    const staleOrInvalid = build([
      { timeSeconds: 150, x: 2500, y: 1000, sourceIndices: [150] },
      { timeSeconds: 179, x: Number.NaN, y: 1000, sourceIndices: [179] },
    ]).highlights!.at(-1)!;
    expect(staleOrInvalid.brief?.situation).not.toContain("본인 위치");
  });

  it("accounts for eleven solo kills once, including explicit ungrouped fallbacks", () => {
    const result = buildDailyWalkthrough(connectedSolo());
    const scenes = result.combatScenes!;
    const highlights = result.highlights!;
    expect(scenes).toHaveLength(11);
    expect(highlights).toHaveLength(7);
    expect(highlights[0].id).toBe("highlight-opening");
    expect(highlights.some(({ id }) => id === "combat-ungrouped-team-0")).toBe(true);
    expect(highlights.at(-1)?.id).toBe("highlight-encounter-final");
    expect(new Set(highlights.flatMap(({ evidenceIds }) => evidenceIds.filter((id) => id.startsWith("kill-")))).size)
      .toBe(highlights.flatMap(({ evidenceIds }) => evidenceIds.filter((id) => id.startsWith("kill-"))).length);
    const killIds = scenes.flatMap(({ evidenceIds }) => evidenceIds.filter((id) => id.startsWith("kill-")));
    expect(killIds).toHaveLength(11);
    expect(new Set(killIds).size).toBe(11);
    expect(scenes.filter(({ id }) => id.startsWith("combat-ungrouped-"))).toHaveLength(10);
    expect(scenes.at(-1)?.brief?.outcome).toContain("이 교전: 1킬");
    expect(scenes.at(-1)?.title).toContain("교전 · 1킬");
    expect([...highlights, ...scenes].every(({ title, outcome, brief }) =>
      !/팀 \d+킬|개인 \d+킬/.test([title, outcome, brief?.outcome].join(" ")))).toBe(true);
    const duo = connectedSolo();
    duo.mode = "duo";
    expect(buildDailyWalkthrough(duo).combatScenes?.at(-1)?.brief?.outcome).toContain("팀 1킬 (개인 1킬)");
  });

  it("keeps both consequential recoveries and early/late circle movement in the eight-card bridge", () => {
    const input = connectedSolo();
    input.mode = "duo";
    input.zones[0].outsideMeters = 0;
    input.zones[0].firstInsideSeconds = input.zones[0].observedSeconds;
    input.zones[1].shrinkObservedSeconds = 580.283;
    Object.assign(input.zones[6], { outsideMeters: 34, firstInsideSeconds: 1533.653, shrinkObservedSeconds: 1470.283 });
    input.zones[6].positions = [
      { timeSeconds: 1405, x: 6334, y: 6900 },
      { timeSeconds: 1513.673, x: 6322.9, y: 6900 },
      { timeSeconds: 1523.667, x: 6312.3, y: 6900 },
      { timeSeconds: 1533.653, x: 6299, y: 6900 },
    ];
    input.facts.push(
      { ...fact("down-one", 1000, "down"), victimId: "ranker-id", victimTeamId: 1 },
      { ...fact("revive-one", 1010, "revive"), actorId: "ally-id", actorTeamId: 1, victimId: "ranker-id", victimTeamId: 1 },
      { ...fact("kill-after-revive", 1054, "kill"), actorId: "ranker-id", actorTeamId: 1,
        victimId: "return-target", victimTeamId: 2, weapon: "M416" },
      { ...fact("down-two", 1080, "down"), victimId: "ranker-id", victimTeamId: 1 },
      { ...fact("revive-two", 1090, "revive"), actorId: "ally-id", actorTeamId: 1, victimId: "ranker-id", victimTeamId: 1 },
    );
    input.killEvents!.push({ timeSeconds: 1054, victim: "return-target", weapon: "M416" });
    input.teamKillEvents!.push({ timeSeconds: 1054, killer: "Ranker", victim: "return-target", weapon: "M416", attackId: null });

    const result = buildDailyWalkthrough(input);
    const highlights = result.highlights!;
    expect(highlights).toHaveLength(8);
    expect(result.summary).toContain("본인은 두 번 기절했지만 팀원이 모두 살렸고, 이후에도 킬을 올렸습니다.");
    expect(result.summary.split(/[.!?]\s/).length).toBeLessThanOrEqual(3);
    expect(result.chapters.flatMap(({ evidenceIds }) => evidenceIds)).toEqual(expect.arrayContaining([
      "down-one", "revive-one", "down-two", "revive-two",
    ]));
    expect(highlights.map(({ id }) => id)).toEqual(expect.arrayContaining([
      "highlight-zone-2", "highlight-revive-one", "highlight-zone-7",
    ]));
    expect(highlights.filter(({ kind }) => kind === "recovery")).toHaveLength(2);
    expect(highlights.map(({ id }) => id)).toEqual(expect.arrayContaining([
      "highlight-revive-one", "highlight-revive-two", "highlight-zone-2", "highlight-zone-7",
    ]));
    expect(highlights.find(({ id }) => id === "highlight-zone-2")?.brief?.outcome).toContain("축소 시작 확인 전");
    expect(highlights.find(({ id }) => id === "highlight-zone-7")?.brief?.outcome).toContain("축소 시작 확인 후");
    expect(highlights.find(({ id }) => id === "highlight-zone-7")?.brief?.action)
      .toContain("25:23 원 밖 약 12m → 25:33 원 안쪽 경계");
    const lateMovement = highlights.find(({ id }) => id === "highlight-zone-7")!;
    expect(lateMovement.operatingPoint?.conditions).toContain("23:30 7번째 원 공개 기준 기록 거리 약 34m 밖");
    expect(lateMovement.operatingPoint?.conditions).toContain("관측된 축소 시작까지 약 1분");
    expect(lateMovement.operatingPoint?.point).toBe("25:33 원 안 위치 확인 · 관측된 축소 시작 약 1분 3초 뒤.");
    const recovery = highlights.find(({ id }) => id === "highlight-revive-one")!;
    expect(recovery.operatingPoint?.conditions).toContain("16:50 본인 소생 시점");
    expect(recovery.operatingPoint?.conditions).toContain("직전 기절 기록 16:40");
    expect(recovery.operatingPoint?.point).toContain("소생한 본인은 17:34 M416 킬");
    expect(result.takeaways.some(({ text }) => text === recovery.operatingPoint?.point)).toBe(true);
    expect(result.takeaways.some(({ evidenceIds }) => evidenceIds.includes("zone-7"))).toBe(true);
    expect(result.takeaways.filter(({ evidenceIds }) => evidenceIds.some((id) => id.startsWith("revive-")))).toHaveLength(2);
    expect(result.takeaways.every(({ text }) => !text.includes("교전 결과"))).toBe(true);
    expect(result.takeaways.every(({ text }) => text.length <= 90 && !text.includes("알려주세요"))).toBe(true);

    input.zones[6].positions = undefined;
    const missingPositions = buildDailyWalkthrough(input).highlights?.find(({ id }) => id === "highlight-zone-7");
    expect(missingPositions?.brief?.action).toBe("이동을 보여주는 위치 기록 없음");
    const oneRecovery = { ...input, facts: input.facts.filter(({ id }) => id !== "down-two" && id !== "revive-two") };
    expect(buildDailyWalkthrough(oneRecovery).highlights).toHaveLength(7);
    expect(missingPositions?.operatingPoint).toBeUndefined();
    input.zones[6].positions = [
      { timeSeconds: 1405, x: 6334, y: 6900 }, { timeSeconds: 1533.653, x: 6299, y: 6900 },
    ];
    input.zones[6].center = { x: Number.NaN, y: 6900 };
    expect(buildDailyWalkthrough(input).highlights?.find(({ id }) => id === "highlight-zone-7")?.operatingPoint).toBeUndefined();
  });

  it("shows fifteen squad kills once across encounters, including a recorded zero-kill fight and the observed circle", () => {
    const teamKillEvents = Array.from({ length: 15 }, (_, index) => ({
      timeSeconds: 121 + Math.floor(index / 3) * 50 + index % 3,
      killer: index < 3 ? "Ranker" : "Ally", victim: "enemy-" + index, weapon: index % 2 ? "M416" : "수류탄",
    }));
    const encounters = Array.from({ length: 5 }, (_, group) => {
      const startSeconds = 120 + group * 50;
      return { id: "group-" + group, startSeconds, endSeconds: startSeconds + 4,
        actions: [
          { timeSeconds: startSeconds, kind: "first_hit", actor: group ? "Ally" : "Ranker", victim: "enemy-" + group * 3,
            actorId: group ? "ally-id" : "ranker-id", victimId: "enemy-id-" + group * 3,
            actorTeamId: 1, weapon: "M416", distanceMeters: 30 },
          ...teamKillEvents.slice(group * 3, group * 3 + 3).map((kill, local) => ({
            timeSeconds: kill.timeSeconds, kind: "kill", actor: kill.killer, victim: kill.victim,
            actorId: group ? "ally-id" : "ranker-id", victimId: "enemy-id-" + (group * 3 + local),
            actorTeamId: 1, weapon: kill.weapon, distanceMeters: 20,
          })),
        ], precontactMovement: [], arrival: null, vehicle: null };
    });
    encounters.push({ id: "no-kill", startSeconds: 440, endSeconds: 443,
      actions: [{ timeSeconds: 440, kind: "knock", actor: "Ally", victim: "another-enemy", actorId: "ally-id",
        victimId: "another-id", actorTeamId: 1, weapon: "M416", distanceMeters: 40 }],
      precontactMovement: [], arrival: null, vehicle: null });
    const input = story({ mode: "squad", kills: 3, teamKills: 15, teamKillEvents,
      killEvents: teamKillEvents.slice(0, 3).map(({ timeSeconds, victim, weapon }) => ({ timeSeconds, victim, weapon })),
      facts: [
        { ...fact("landing", 10, "landing"), actorId: "ranker-id", actorTeamId: 1 },
        fact("zone-1", 100, "zone"), fact("zone-2", 250, "zone"),
        { ...fact("vehicle-first", 140, "vehicle"), actorId: "ranker-id", actorTeamId: 1, vehicleName: "UAZ" },
        ...encounters.map((encounter) => fact(encounter.id, encounter.startSeconds, "encounter")),
        ...teamKillEvents.map((kill, index) => ({ ...fact("kill-" + index, kill.timeSeconds,
          index < 3 ? "kill" : "teammate_kill"), actorId: index < 3 ? "ranker-id" : "ally-id",
          actorTeamId: 1, victimId: "enemy-id-" + index, sourceIndices: [1000 + index] })),
        ...encounters.map((encounter, index) => fact("route-" + index, encounter.startSeconds - 5, "route")),
        fact("route-first-entry", 150, "route"),
        { ...fact("finish", 500, "finish", "경기 종료 기록 · 1위"), actorId: "ranker-id", actorTeamId: 1 },
      ],
      route: [...encounters.map((encounter, index) => ({ timeSeconds: encounter.startSeconds - 5, x: 200 + index * 10,
        y: 300, place: null, spreadMeters: 0, players: [] })),
        { timeSeconds: 150, x: 350, y: 400, place: null, spreadMeters: 0, players: [] }],
      zones: [
        { phase: 1, observedSeconds: 100, outsideMeters: 500, firstInsideSeconds: 150, center: { x: 100, y: 200 }, radius: 400 },
        { phase: 2, observedSeconds: 250, outsideMeters: 100, firstInsideSeconds: null, center: { x: 400, y: 500 }, radius: 300 },
      ], encounters,
    });
    const walkthrough = buildDailyWalkthrough(input);
    const scenes = walkthrough.combatScenes!;
    expect(scenes).toHaveLength(6);
    expect(walkthrough.highlights).toHaveLength(6);
    expect(walkthrough.highlights![0].id).toBe("highlight-opening");
    expect(walkthrough.highlights?.some(({ id }) => id === "combat-group-0")).toBe(true);
    const chronology = walkthrough.highlights!.map(({ id }) => id);
    expect(chronology.indexOf("combat-group-0")).toBeLessThan(chronology.indexOf("highlight-opening-movement"));
    expect(chronology.indexOf("highlight-opening-movement")).toBeLessThan(chronology.indexOf("combat-group-1"));
    const firstFight = walkthrough.highlights!.find(({ id }) => id === "combat-group-0")!;
    const firstMovement = walkthrough.highlights!.find(({ id }) => id === "highlight-opening-movement")!;
    expect(firstFight.endSeconds).toBeLessThanOrEqual(firstMovement.startSeconds);
    expect(firstMovement.brief?.situation).toContain("교전 뒤 첫 원 이동");
    expect(firstMovement.brief?.action).toContain("02:20 UAZ 탑승");
    expect(walkthrough.summary).toContain("초반 교전에서 팀 3킬");
    expect(walkthrough.summary).not.toMatch(/\d{2}:\d{2}/);
    const killIds = scenes.flatMap(({ evidenceIds }) => evidenceIds.filter((id) => id.startsWith("kill-")));
    expect(killIds).toHaveLength(15);
    expect(new Set(killIds).size).toBe(15);
    expect(scenes[0].brief?.outcome).toContain("팀 3킬 (개인 3킬)");
    expect(scenes[0].title).toContain("교전 · 팀 3킬");
    expect(scenes.at(-1)?.brief?.outcome).toBe("이 교전에서 처치 기록 없음");
    expect(scenes[0].mapSnapshot?.zone).toEqual({ x: 100, y: 200, radius: 400 });
    expect(scenes[0].combatZone?.phase).toBe(1);
    expect(scenes[3].combatZone?.phase).toBe(2);
    expect(scenes[0].combatZone!.observedSeconds).toBeLessThanOrEqual(scenes[0].anchorSeconds);
    expect(scenes.every(({ mapSnapshot, startSeconds, endSeconds }) => mapSnapshot?.observations?.every(
      ({ timeSeconds }) => timeSeconds >= startSeconds && timeSeconds <= endSeconds) ?? true)).toBe(true);
    expect(scenes.at(-1)?.action).toContain("참가자 이름:");
  });

  it("connects exact landing, same-phase boarding and observed entry with bounded phase maps", () => {
    const input = connectedSolo();
    input.facts.push({ ...fact("ally-landing", 85, "landing", "untrusted name", { x: 3500, y: 4500 }), actorId: "ally-id", actorTeamId: 1 });
    input.facts.push({ ...fact("enemy-landing", 86, "landing", "teammate text", { x: 3600, y: 4500 }), actorId: "enemy-id", actorTeamId: 2 });
    const before = JSON.stringify(input);
    const result = buildDailyWalkthrough(input);
    const opening = result.highlights![0];
    expect(opening.movement).toEqual({ landing: { timeSeconds: 76.757, place: "로스 레오네스" }, phase: 1,
      revealedSeconds: 100.663, shrinkObservedSeconds: 180, outsideMeters: 1264 });
    expect(opening.brief?.action).toContain("03:00 원 수축 확인");
    expect(opening.brief?.action).not.toContain("07:18 오토바이 탑승");
    expect(opening.brief?.action).not.toContain("미라도");
    expect(opening.endSeconds).toBe(362.234);
    expect(opening.mapSnapshot?.path?.[0]).toEqual({ x: 2947, y: 4504 });
    expect(opening.mapSnapshot?.path).toContainEqual({ x: 3000, y: 4500 });
    expect(opening.mapSnapshot?.path).not.toContainEqual({ x: 1, y: 1 });
    expect(opening.mapSnapshot?.path).not.toContainEqual({ x: 3500, y: 4500 });
    expect(opening.mapSnapshot?.marks).toContainEqual(expect.objectContaining({ kind: "teammate", x: 3500, y: 4500 }));
    expect(opening.mapSnapshot?.marks).not.toContainEqual(expect.objectContaining({ x: 3600 }));
    expect(opening.mapSnapshot?.observations?.every(({ timeSeconds }) => timeSeconds <= 362.234)).toBe(true);
    expect(opening.sourceIndices).not.toContain(502);
    const firstMovement = result.highlights!.find(({ id }) => id === "highlight-opening-movement");
    expect(firstMovement?.brief?.action).toContain("07:18 오토바이 탑승");
    expect(firstMovement?.endSeconds).toBe(502.418);
    expect(firstMovement?.sourceIndices).toContain(502);
    expect(result.chapters[0].mapSnapshot?.path).toContainEqual({ x: 3200, y: 4600 });
    expect(result.chapters[0].movement?.insideObservedSeconds).toBeUndefined();
    expect(result.highlights).toHaveLength(7);
    expect(result.highlights?.some(({ id }) => id === "combat-ungrouped-team-0")).toBe(true);
    expect(result.highlights?.at(-1)?.id).toBe("highlight-encounter-final");
    expect(result.takeaways.some(({ evidenceIds }) => evidenceIds.includes("zone-1"))).toBe(true);
    expect(JSON.stringify(input)).toBe(before);
  });

  it("retains phase movement when entry is unknown and never uses the next phase or a future place as landing", () => {
    const input = connectedSolo();
    input.zones[0].firstInsideSeconds = null;
    input.zones[0].shrinkObservedSeconds = null;
    input.facts.find(({ id }) => id === "landing")!.place = undefined;
    const opening = buildDailyWalkthrough(input).highlights![0];
    expect(opening.endSeconds).toBe(502.418);
    expect(opening.brief?.outcome).toBe("이 원 안의 위치는 확인되지 않음");
    expect(opening.movement?.shrinkObservedSeconds).toBeUndefined();
    expect(opening.movement?.insideObservedSeconds).toBeUndefined();
    expect(opening.movement?.landing?.place).toBeNull();
    expect(opening.brief?.situation).not.toContain("Los Leones");
    expect(opening.mapSnapshot?.path).not.toContainEqual({ x: 2, y: 2 });
    expect(opening.mapSnapshot?.path).not.toContainEqual({ x: 3, y: 3 });
    input.zones[0].outsideMeters = 0;
    const alreadyInside = buildDailyWalkthrough(input);
    expect(alreadyInside.highlights![0].endSeconds).toBe(100.663);
    expect(alreadyInside.highlights!.some(({ kind, movement }) => kind === "movement" && movement?.phase === 2)).toBe(true);
  });

  it("requires episode and target identities, preserves weapon changes, and leaves full chapters intact", () => {
    const input = connectedSolo();
    input.encounters![0].actions[0].weapon = "AUG";
    const result = buildDailyWalkthrough(input);
    expect(result.highlights?.at(-1)?.brief?.situation).toContain("AUG 공격");
    expect(result.highlights?.at(-1)?.brief?.outcome).toContain("27:53 본인 처치: 상대 1");
    const full = result.chapters;
    input.encounters![0].actions[0].victimId = "another-target";
    const otherVictim = buildDailyWalkthrough(input).highlights!.at(-1)!;
    expect(otherVictim.brief?.situation).toContain("AUG 공격");
    expect(otherVictim.brief?.action).not.toContain("→");
    input.encounters![0].actions[0].victimId = "target-id";
    input.encounters![0].actions[0].actorId = "same-name-other-id";
    const otherActor = buildDailyWalkthrough(input).highlights!.at(-1)!;
    expect(otherActor.brief?.situation).toContain("AUG 공격");
    expect(otherActor.brief?.action).not.toContain("→");
    for (const action of input.encounters![0].actions) { action.actorId = undefined; action.victimId = undefined; }
    const legacy = buildDailyWalkthrough(input);
    expect(legacy.highlights?.some(({ kind }) => kind === "finish")).toBe(false);
    expect(legacy.chapters).toEqual(full);
  });

  it("keeps the squad grenade target separate from the later MG3 target and credits the teammate", () => {
    const input = story({ mode: "squad", facts: [
      { ...fact("landing", 10, "landing"), actorId: "ranker", actorTeamId: 1 },
      { ...fact("encounter-team", 120, "encounter"), sourceIndices: [10, 11, 12] },
      { ...fact("teammate-kill-a", 130, "teammate_kill"), actorId: "ally", actorTeamId: 1, victimId: "a", weapon: "수류탄" },
      { ...fact("teammate-kill-b", 131, "teammate_kill"), actorId: "ally", actorTeamId: 1, victimId: "b", weapon: "MG3" },
      { ...fact("finish", 135, "finish", "경기 종료 기록 · 1위"), actorId: "ranker", actorTeamId: 1 },
    ], killEvents: [], teamKillEvents: [
      { timeSeconds: 130, killer: "Ally", victim: "EnemyA", weapon: "수류탄" },
      { timeSeconds: 131, killer: "Ally", victim: "EnemyB", weapon: "MG3" },
    ], encounters: [{ id: "encounter-team", startSeconds: 120, endSeconds: 131, actions: [
      { timeSeconds: 120, kind: "knock", actor: "Ally", actorId: "ally", actorTeamId: 1, victim: "EnemyA", victimId: "a", weapon: "수류탄", distanceMeters: 38 },
      { timeSeconds: 130, kind: "kill", actor: "Ally", actorId: "ally", actorTeamId: 1, victim: "EnemyA", victimId: "a", weapon: "수류탄", distanceMeters: 22 },
      { timeSeconds: 131, kind: "kill", actor: "Ally", actorId: "ally", actorTeamId: 1, victim: "EnemyB", victimId: "b", weapon: "MG3", distanceMeters: 18 },
    ] }] });
    const final = buildDailyWalkthrough(input).highlights!.at(-1)!;
    expect(final.brief?.action).toContain("팀원 1 · 수류탄 · 상대 1 기절");
    expect(final.brief?.action).not.toContain("상대 2 기절");
    expect(final.brief?.outcome).toContain("팀 2킬 (개인 0킬)");
    expect(final.action).toContain("팀원 1 → 상대 1 · 수류탄");
    expect(final.action).toContain("팀원 1 → 상대 2 · MG3");
    expect(final.brief?.outcome).toContain("상대 2");
    expect(final.sourceIndices).toEqual(expect.arrayContaining([10, 11, 12]));
  });

  it("connects a revive only to the same identified downed player without parsing display prose", () => {
    const input = connectedSolo();
    input.mode = "duo";
    input.facts.push(
      { ...fact("down-own", 1000, "down", "misleading nickname"), victimId: "ranker-id", victimTeamId: 1 },
      { ...fact("revive-own", 1010, "revive", "WrongA → WrongB 소생"), actorId: "ally-id", victimId: "ranker-id", actorTeamId: 1, victimTeamId: 1 },
    );
    let recovery = buildDailyWalkthrough(input).highlights?.find(({ kind }) => kind === "recovery");
    expect(recovery?.brief?.situation).toContain("본인 기절");
    expect(recovery?.title).toBe("16:50 본인 소생");
    expect(recovery?.brief?.action).toContain("팀원 1 → 본인");
    expect(recovery?.brief?.outcome).not.toMatch(/킬|전원|복귀/);
    input.facts.find(({ id }) => id === "revive-own")!.victimId = "other-id";
    recovery = buildDailyWalkthrough(input).highlights?.find(({ kind }) => kind === "recovery");
    expect(recovery).toBeUndefined();
  });

  it("omits empty intervals and labels incoming damage without inventing a different target", () => {
    const emptyInterval = story({ kills: 2, teamKills: 2,
      killEvents: [{ timeSeconds: 50, weapon: "M416", victim: "enemy-1" }, { timeSeconds: 250, weapon: "M416", victim: "enemy-2" }],
      facts: [fact("landing", 10, "landing"), fact("zone-1", 20, "zone"), fact("kill-1", 50, "kill"),
        fact("zone-2", 100, "zone"), fact("zone-3", 200, "zone"), fact("kill-2", 250, "kill"),
        fact("encounter-final", 300, "encounter"), fact("finish", 400, "finish", "경기 종료 기록 · 1위")],
      zones: [20, 100, 200].map((observedSeconds, index) => ({ phase: index + 1, observedSeconds,
        outsideMeters: 0, firstInsideSeconds: observedSeconds })),
      encounters: [{ id: "encounter-final", startSeconds: 300, endSeconds: 301, actions: [] }],
    });
    expect(buildDailyWalkthrough(emptyInterval).chapters.every(({ brief }) => brief?.action !== "이 구간은 기록 없음")).toBe(true);

    const input = connectedSolo();
    input.mode = "duo";
    const encounter = input.encounters![0];
    encounter.actions = [
      { timeSeconds: 1668.06, kind: "first_hit", actor: "opponent", victim: "Ranker", weapon: "M416",
        distanceMeters: 24, actorId: "target-id", victimId: "ranker-id", actorTeamId: 2, victimTeamId: 1 },
      { timeSeconds: 1670, kind: "first_hit", actor: "Ranker", victim: "opponent", weapon: "AUG",
        distanceMeters: 24, actorId: "ranker-id", victimId: "target-id", actorTeamId: 1, victimTeamId: 2 },
      { timeSeconds: 1673.913, kind: "kill", actor: "Ranker", victim: "opponent", weapon: "수류탄",
        distanceMeters: 24, actorId: "ranker-id", victimId: "target-id", actorTeamId: 1, victimTeamId: 2 },
    ];
    const incomingScene = buildDailyWalkthrough(input).combatScenes!.find(({ id }) => id === "combat-encounter-final")!;
    expect(incomingScene.brief?.situation).toContain("상대 1의 M416 공격 → 본인 피해 기록");
    expect(incomingScene.action).toContain("상대 1 → 본인 · M416 · 피해 기록");
    expect(incomingScene.brief?.action).toContain("아군 반격 사격 기록: 본인 → 상대 1 (AUG, 24m)");
    expect(incomingScene.brief?.outcome).toContain("본인 처치: 상대 1");
    expect(incomingScene.action).not.toContain("다른 상대");

    encounter.startSeconds = 1560;
    encounter.actions[0] = { ...encounter.actions[0], timeSeconds: 1600, actor: "Ranker", victim: "opponent",
      actorId: "ranker-id", victimId: "target-id", actorTeamId: 1, victimTeamId: 2 };
    const longGap = buildDailyWalkthrough(input).combatScenes!.find(({ id }) => id === "combat-encounter-final")!;
    expect(longGap.brief?.situation).toContain("26:40 본인의 M416 공격 → 상대 1 피해 기록");
    expect(longGap.brief?.action).toBe("기절 기록 없이 처치로 마무리");
    expect(longGap.brief?.outcome).toContain("27:53 본인 처치: 상대 1");
  });

  it("groups final kills in the same displayed second without crediting only the last player", () => {
    const input = connectedSolo();
    const encounter = input.encounters![0];
    encounter.endSeconds = 1673.913;
    encounter.actions.push({ timeSeconds: 1673.912, kind: "kill", actor: "Ally", victim: "second-opponent", weapon: "M24",
      distanceMeters: 86, actorId: "ally-id", victimId: "second-target-id", actorTeamId: 1, victimTeamId: 2 });
    input.teamKillEvents!.push({ timeSeconds: 1673.912, killer: "Ally", victim: "second-opponent", weapon: "M24" });
    input.facts.push({ ...fact("kill-ally-final", 1673.912, "teammate_kill"), actorId: "ally-id", actorTeamId: 1,
      victimId: "second-target-id", weapon: "M24" });
    const result = buildDailyWalkthrough(input);
    expect(result.headline).toContain("마지막 교전에서 2명 처치");
    expect(result.summary).toContain("마지막 두 상대 처치 무기는 M24·수류탄");
    expect(result.summary).toMatch(/경기 결과는 1위입니다\.$/);
    expect(result.summary).not.toMatch(/\d{2}:\d{2}/);
    expect(result.chapters.at(-1)?.brief?.action).toBe("27:53 팀원 1 M24 처치·본인 수류탄 처치");

    input.teamKillEvents!.find(({ timeSeconds }) => timeSeconds === 1673.912)!.killer = "Ranker";
    input.teamKillEvents!.find(({ timeSeconds }) => timeSeconds === 1673.912)!.weapon = "수류탄";
    input.killEvents.push({ timeSeconds: 1673.912, victim: "second-opponent", weapon: "수류탄" });
    const extraKill = input.facts.find(({ id }) => id === "kill-ally-final")!;
    Object.assign(extraKill, { kind: "kill", actorId: "ranker-id", victimId: "second-target-id" });
    Object.assign(encounter.actions.at(-1)!, { actor: "Ranker", actorId: "ranker-id", weapon: "수류탄" });
    const grouped = buildDailyWalkthrough(input);
    expect(grouped.summary).toContain("마지막 두 상대 처치 무기는 수류탄");
    expect(grouped.chapters.at(-1)?.brief?.action).toBe("27:53 본인 수류탄 2킬");
  });

  it("links a carepackage only to that player's later kill with the same weapon", () => {
    const input = connectedSolo();
    expect(buildDailyWalkthrough(input).highlights?.find(({ id }) => id === "highlight-find-lynx")?.brief?.outcome).toContain("23:10");
    input.weaponFinds![1].playerId = "other-id";
    expect(buildDailyWalkthrough(input).highlights?.some(({ id }) => id === "highlight-find-lynx")).toBe(false);
    input.weaponFinds![1].playerId = "ranker-id";
    input.weaponFinds![1].weapon = "WeapL6_C";
    expect(buildDailyWalkthrough(input).highlights?.some(({ id }) => id === "highlight-find-lynx")).toBe(false);
  });

  it("covers the complete solo timeline in five evidence-backed chapters", () => {
    const result = buildDailyWalkthrough(soloMatch());
    expect(result.chapters).toHaveLength(5);
    expect(result.chapters[0].startSeconds).toBe(76.757);
    expect(result.chapters.at(-1)?.endSeconds).toBe(1678.263);
    expect(result.chapters.every((chapter, index) => index === 0 || result.chapters[index - 1].endSeconds <= chapter.startSeconds)).toBe(true);
    expect(result.chapters.flatMap(({ evidenceIds }) => evidenceIds).filter((id) => id.startsWith("kill-"))).toHaveLength(11);
    expect(result.chapters[0].action).toContain("Kar98k 1킬");
    expect(result.chapters[0].brief?.situation).toBe("01:16 착지 · 01:40 1번째 원 1.3km 밖");
    expect(result.summary).toContain("1번째 원 공개 때 안전 구역에서 약 1.3km 떨어져");
    expect(result.chapters[0].action).toContain("06:02");
    expect(result.chapters.at(-1)?.action).toContain("수류탄 킬이 마지막 킬");
    expect(result.chapters.at(-1)?.outcome).toBe("경기 종료. 총 11킬.");
    expect(result.chapters.every(({ outcome }) => !outcome.includes("팀원"))).toBe(true);
    expect(result.chapters[1].action).toContain("원 안 위치를 관측했습니다. 실제 진입 시각은 다를 수 있습니다.");
    expect(result.chapters[1].action).toContain("전리품 상자에서 M24");
    expect(result.chapters[1].action).toContain("오토바이에 탔습니다");
    expect(result.chapters[1].action).toContain("09:02에는 Los Leones");
    expect(result.chapters[2].action).toContain("135m");
    expect(result.chapters[2].action).toContain("18:42");
    expect(result.chapters[3].action).toContain("107m");
    expect(result.chapters[3].action).toContain("22:12");
    expect(result.chapters[1].situation).toContain("3번째 원 공개 · 원 안");
    expect(result.chapters[2].situation).toContain("4번째 원 공개 · 원 안");
    expect(result.chapters[3].action).toContain("링스 AMR 2킬");
    expect(result.chapters[4].title).toContain("수류탄 킬 이후 1위");
    expect(result.chapters[4].action).toContain("27:58 경기 종료");
    expect(result.chapters[4].action).not.toMatch(/마지막 남은 적|최후의 상대/);
    expect(result.overview?.path).not.toContainEqual({ x: 1, y: 1 });
    expect(result.overview?.path).not.toContainEqual({ x: 100, y: 100 });
    expect(result.chapters.at(-1)?.mapSnapshot?.path).toContainEqual({ x: 5408.794, y: 6969.012 });
    expect(result.chapters.at(-1)?.mapSnapshot?.observations?.every(({ timeSeconds }) => timeSeconds <= 1678.263)).toBe(true);
    expect(result.chapters.every(({ action }) => action.split("\n\n").length <= 4)).toBe(true);
    expect(result.chapters.every(({ evidenceIds }) => new Set(evidenceIds).size === evidenceIds.length)).toBe(true);
    expect(result.takeaways).toHaveLength(1);
    const selectedLesson = result.highlights?.find(({ lesson }) => lesson === result.takeaways[0].text);
    expect(selectedLesson).toBeDefined();
    expect(result.takeaways[0].evidenceIds).toEqual(selectedLesson?.evidenceIds);
  });

  it("builds short factual briefs without changing the full chapter or using future first hits", () => {
    const input = soloMatch();
    const before = buildDailyWalkthrough(input);
    input.encounters![0].actions = [
      { timeSeconds: 1668.06, kind: "first_hit", actor: "Ranker", victim: "opponent", weapon: "수류탄", distanceMeters: 78 },
      { timeSeconds: 1690, kind: "first_hit", actor: "Ranker", victim: "opponent", weapon: "M416", distanceMeters: 12 },
    ];
    const result = buildDailyWalkthrough(input);
    const withoutBrief = (chapter: typeof result.chapters[number]) => {
      const copy = { ...chapter };
      delete copy.brief;
      return copy;
    };
    expect(result.chapters.map(withoutBrief)).toEqual(before.chapters.map(withoutBrief));
    expect(result.chapters.at(-1)?.brief).toEqual({
      situation: "피해를 준 거리 약 78m",
      action: "27:48 본인 수류탄 피해 → 27:53 본인 수류탄 마지막 킬",
      outcome: "27:58 경기 종료 · 11킬 1위",
    });
    expect(result.chapters[1].brief?.action).toBe("07:18 오토바이 탑승");
    expect(result.chapters[1].brief?.outcome).toBe("08:22 1번째 원 안에서 첫 위치 확인");
    expect(result.chapters.every(({ brief }) => Object.values(brief!).every((line) =>
      line.length <= 70 && (line.match(/\d{2}:\d{2}/g) ?? []).length <= 2))).toBe(true);
    expect(result.summary.length).toBeLessThan(100);
    expect(result.takeaways.every(({ text }) => text.length <= 90)).toBe(true);
    input.encounters![0].actions[0].victim = "different-opponent";
    expect(buildDailyWalkthrough(input).chapters.at(-1)?.brief?.action).toBe("27:53 본인 수류탄 마지막 킬");
    input.encounters![0].actions[0].victim = "opponent";
    input.encounters![0].actions[0].weapon = "M416";
    expect(buildDailyWalkthrough(input).chapters.at(-1)?.brief?.action)
      .toBe("27:48 본인 M416 피해 → 27:53 본인 수류탄 마지막 킬");
  });

  it("handles absent maps and zero personal kills without inventing a finish", () => {
    const input = story({
      facts: [fact("landing", 20, "landing", "착지"), fact("finish", 120, "finish", "경기 종료 기록 · 8위")],
      route: undefined,
      zones: [],
    });
    const result = buildDailyWalkthrough(input);
    expect(result.chapters).toHaveLength(1);
    expect(result.chapters[0].kind).toBe("finish");
    expect(result.chapters[0].mapSnapshot).toBeUndefined();
    expect(result.overview).toBeUndefined();
    expect(result.chapters[0].outcome).toContain("경기 종료.");
    expect(result.chapters[0].outcome).toContain("총 0킬");
    expect(result.takeaways).toEqual([]);
  });

  it("separates the last recorded kill from the verified ending and keeps late recovery and knock evidence", () => {
    const ranker = "ranker-id";
    const ally = "ally-id";
    const terminalSource = [900, 901];
    const makeStory = (mode: "solo" | "duo" | "squad" = "squad") => buildDailyWalkthrough(story({
      mode, nickname: "Ranker", kills: 1, teamKills: 5,
      facts: [
        { ...fact("landing", 20, "landing"), actorId: ranker, actorTeamId: 16, sourceIndices: [1] },
        { ...fact("zone-1", 100, "zone"), sourceIndices: [2] },
        ...[400, 420, 450, 480].map((at, index) => ({ ...fact("team-kill-" + index, at, "teammate_kill"),
          actorId: ally, actorTeamId: 16, victimId: "early-" + index, victimTeamId: 2, sourceIndices: [10 + index] })),
        { ...fact("early-fight", 400, "encounter"), sourceIndices: [10, 11, 12, 13] },
        { ...fact("last-kill", 759, "kill"), actorId: ranker, actorTeamId: 16, victimId: "last-victim", victimTeamId: 15,
          weapon: "AUG", sourceIndices: [20] },
        { ...fact("last-fight", 750, "encounter"), sourceIndices: [20] },
        { ...fact("late-down", 1007.982, "down"), victimId: ally, victimTeamId: 16, sourceIndices: [21] },
        { ...fact("late-revive", 1028.651, "revive"), actorId: "helper-id", actorTeamId: 16,
          victimId: ally, victimTeamId: 16, sourceIndices: [22] },
        { ...fact("ranker-down", 1134.274, "down"), victimId: ranker, victimTeamId: 16, sourceIndices: [23] },
        { ...fact("terminal", 1187.631, "terminal_opponent_death"), victimId: "second-id", victimTeamId: 15,
          deathCause: "blue_zone", position: { x: 2345, y: 4567 }, positionTimeSeconds: 1187.631,
          sourceIndices: terminalSource },
        { ...fact("finish", 1191.1, "finish", "경기 종료 기록 · 1위"), actorId: ranker, actorTeamId: 16, sourceIndices: [901] },
      ],
      zones: [{ phase: 1, observedSeconds: 100, outsideMeters: 1500, firstInsideSeconds: 600,
        center: { x: 1000, y: 1000 }, radius: 1000,
        positions: [{ timeSeconds: 1187.631, x: 1200, y: 1300, sourceIndices: [24] }] }],
      killEvents: [{ timeSeconds: 759, victim: "last-victim", weapon: "AUG" }],
      teamKillEvents: [
        ...[400, 420, 450, 480].map((timeSeconds, index) => ({ timeSeconds, killer: "Ally", victim: "early-" + index, weapon: "M416" })),
        { timeSeconds: 759, killer: "Ranker", victim: "last-victim", weapon: "AUG" },
      ],
      encounters: [
        { id: "early-fight", startSeconds: 400, endSeconds: 480, opponents: ["early team"], allies: ["Ally"],
          teamKills: 4, rankerWeapons: [], firstRankerShot: null, precontactMovement: [], arrival: null, vehicle: null,
          actions: [{ timeSeconds: 400, kind: "first_hit", actor: "Ally", actorId: ally, actorTeamId: 16,
            victim: "early-0", victimId: "early-0", victimTeamId: 2, weapon: "M416", distanceMeters: 50 },
          ...[420, 450, 480].map((timeSeconds, index) => ({ timeSeconds, kind: "kill" as const, actor: "Ally", actorId: ally,
            actorTeamId: 16, victim: "early-" + (index + 1), victimId: "early-" + (index + 1), victimTeamId: 2,
            weapon: "M416", distanceMeters: 50 }))] },
        { id: "last-fight", startSeconds: 750, endSeconds: 759, opponents: ["last-victim"], allies: ["Ranker"],
          teamKills: 1, rankerWeapons: ["AUG"], firstRankerShot: null,
          precontactMovement: [{ player: "Ranker", meters: 41 }], arrival: null, vehicle: null,
          actions: [{ timeSeconds: 759, kind: "kill", actor: "Ranker", actorId: ranker, actorTeamId: 16,
            victim: "last-victim", victimId: "last-victim", victimTeamId: 15, weapon: "AUG", distanceMeters: 20 }] },
      ],
      roster: [{ name: "Ranker", kills: 1, isRanker: true }, { name: "Ally", kills: 4, isRanker: false }],
    }));

    const result = makeStory();
    const lastKill = result.highlights!.find(({ id }) => id === "highlight-last-fight")!;
    const ending = result.highlights!.find(({ id }) => id === "highlight-terminal-outcome")!;
    expect(lastKill.title).toBe("마지막으로 기록된 팀 킬");
    expect(lastKill.brief?.outcome).toContain("12:39");
    expect(ending).toMatchObject({ kind: "finish", title: "우승 직전", startSeconds: 1134.274, anchorSeconds: 1187.631, endSeconds: 1191.1 });
    expect(ending.action).toContain("18:54 본인 기절");
    expect(ending.action).toMatch(/19:47 상대 \d+ 자기장 사망/);
    expect(ending.action).toContain("19:51 팀 1위");
    expect(ending.mapSnapshot?.path).toContainEqual({ x: 1200, y: 1300 });
    expect(ending.mapSnapshot?.kills).toEqual(expect.arrayContaining([
      expect.objectContaining({ x: 2345, y: 4567, label: expect.stringMatching(/^19:47 상대 \d+ 자기장 사망$/) }),
    ]));
    expect(ending.sourceIndices).toContain(24);
    expect(result.highlights!.some(({ kind, evidenceIds }) => kind === "recovery" && evidenceIds.includes("late-revive"))).toBe(true);
    expect(result.summary).toContain("팀원 소생");
    expect(result.summary).toContain("2위 상대가 자기장으로 사망한 뒤 팀 1위");
    expect(result.summary).toContain("후반 팀원 소생과 본인 기절도 기록됐고, 2위 상대가");
    expect(result.summary).not.toContain("있었고.");
    expect(result.summary.split(/[.!?]\s/).length).toBeLessThanOrEqual(3);
    expect(JSON.stringify(result)).not.toContain("41m");
    expect(result.highlights!.flatMap(({ evidenceIds }) => evidenceIds)).toEqual(expect.arrayContaining(["terminal", "finish", "ranker-down"]));
    expect(result.headline).toContain("팀 1위");

    const solo = makeStory("solo");
    expect(solo.headline).toContain("19:51 1위");
    expect(solo.headline).not.toContain("팀 1위");
    expect(solo.highlights!.find(({ id }) => id === "highlight-terminal-outcome")?.outcome).toContain("19:51 경기 종료 기록 · 1위");
    const soloCombat = buildDailyWalkthrough(story({ mode: "solo", kills: 1, teamKills: 1,
      facts: [
        { ...fact("landing", 1, "landing"), actorId: ranker, actorTeamId: 1 },
        { ...fact("solo-fight", 10, "encounter") },
        { ...fact("solo-kill", 12, "kill"), actorId: ranker, actorTeamId: 1, victimId: "enemy", victimTeamId: 2 },
        { ...fact("finish", 20, "finish", "경기 종료 기록 · 1위"), actorId: ranker, actorTeamId: 1 },
      ],
      killEvents: [{ timeSeconds: 12, victim: "enemy", weapon: "M416" }],
      teamKillEvents: [{ timeSeconds: 12, killer: "Ranker", victim: "enemy", weapon: "M416" }],
      encounters: [{ id: "solo-fight", startSeconds: 10, endSeconds: 12, opponents: ["enemy"], allies: ["Ranker"],
        teamKills: 1, rankerWeapons: [], firstRankerShot: null, precontactMovement: [], arrival: null, vehicle: null,
        actions: [{ timeSeconds: 12, kind: "kill", actor: "Ranker", actorId: ranker, actorTeamId: 1,
          victim: "enemy", victimId: "enemy", victimTeamId: 2, weapon: "M416", distanceMeters: 20 }] }],
    }));
    expect(soloCombat.takeaways.some(({ text }) => text.includes("개인 1킬"))).toBe(true);
    expect(soloCombat.takeaways.some(({ text }) => text.includes("팀 1킬"))).toBe(false);
  });

  it("shows verified death, reappearance, final death and team win without drawing through the dead gap", () => {
    const ranker = "ranker-id";
    const routeRows = [
      [500, 100], [620, 200], [700, 300], [900, 400], [1100, 500],
    ] as const;
    const input = story({
      mode: "squad", nickname: "Ranker", kills: 0, teamKills: 1,
      facts: [
        { ...fact("landing", 1, "landing"), actorId: ranker, actorTeamId: 16 },
        ...routeRows.map(([at]) => ({ ...fact("route-" + at, at, "route"), actorId: ranker, actorTeamId: 16 })),
        { ...fact("first-life-death", 596.897, "player_death"), victimId: ranker, victimTeamId: 16, sourceIndices: [20419] },
        { ...fact("player-reappeared", 690.379, "player_return"), actorId: ranker, actorTeamId: 16, sourceIndices: [23308] },
        { ...fact("final-life-death", 1011.394, "player_death"), victimId: ranker, victimTeamId: 16, sourceIndices: [31386] },
        { ...fact("last-team-kill", 1150, "teammate_kill"), actorId: "ally-id", actorTeamId: 16,
          victimId: "enemy-id", victimTeamId: 15, sourceIndices: [40000] },
        { ...fact("terminal-opponent", 1257, "terminal_opponent_death"), victimId: "second-id", victimTeamId: 15,
          deathCause: "blue_zone", sourceIndices: [50000, 50001] },
        { ...fact("finish", 1260, "finish", "경기 종료 기록 · 1위"), actorId: ranker, actorTeamId: 16, sourceIndices: [50001] },
      ],
      zones: [{ phase: 1, observedSeconds: 100, outsideMeters: 0, firstInsideSeconds: 100,
        center: { x: 100, y: 100 }, radius: 50 }],
      route: routeRows.map(([timeSeconds, x]) => ({ timeSeconds, x, y: x + 1, place: null, spreadMeters: 0, players: [] })),
      teamKillEvents: [{ timeSeconds: 1150, killer: "Ally", victim: "Enemy", weapon: "M416", attackId: null }],
      killEvents: [],
    });

    const result = buildDailyWalkthrough(input);
    expect(result.summary).toContain("09:56에 사망한 뒤 11:30에 재등장했고, 16:51에 다시 사망했습니다.");
    expect(result.summary).toContain("19:10 팀 킬 기록이 있었고, 20:57 2위 상대가 자기장으로 사망한 뒤 21:00 팀 1위");
    expect(result.summary).not.toMatch(/소생|리콜|팀원 살리기/);
    const returned = result.highlights!.find(({ id }) => id === "highlight-player-return-player-reappeared")!;
    expect(returned).toMatchObject({ kind: "recovery", title: "11:30 본인 재등장" });
    expect(returned.brief).toEqual({
      situation: "09:56 본인 사망 기록",
      action: "11:30 본인 재등장 기록",
      outcome: "16:51 본인 사망 기록",
    });
    expect(returned.evidenceIds).toEqual(expect.arrayContaining([
      "first-life-death", "player-reappeared", "final-life-death",
    ]));
    const chapterActions = result.chapters.map(({ action }) => action).join("\n");
    expect(chapterActions).toContain("09:56 본인 사망 기록 → 11:30 본인 재등장 기록 → 16:51 본인 사망 기록");
    expect(chapterActions).toContain("20:57 2위 상대 자기장 사망 기록");
    expect(chapterActions).toContain("21:00 경기 종료");

    expect(result.overview?.path).toEqual([{ x: 100, y: 101 }, { x: 300, y: 301 }, { x: 400, y: 401 }]);
    expect(result.overview?.pathSegments).toEqual([
      [{ x: 100, y: 101 }],
      [{ x: 300, y: 301 }, { x: 400, y: 401 }],
    ]);
    expect(result.overview?.observations?.map(({ timeSeconds }) => timeSeconds)).not.toEqual(expect.arrayContaining([620, 1100]));
    expect(returned.mapSnapshot?.pathSegments).toEqual([[{ x: 300, y: 301 }, { x: 400, y: 401 }]]);
  });

  it("separates personal and teammate kills, retains revives, and uses only the ranker's samples for the path", () => {
    const input = story({
      mode: "squad",
      kills: 1,
      teamKills: 3,
      facts: [
        fact("landing-ally", 5, "landing", "팀원 착지", { x: 42, y: 42 }),
        fact("landing", 10, "landing", "착지", { x: 900, y: 900 }),
        fact("kill-own", 100, "kill", "개인 처치"),
        { ...fact("down", 120, "down", "AllyB 기절"), actorId: "enemy-id", actorTeamId: 2,
          victimId: "ally-b-id", victimTeamId: 1 },
        { ...fact("revive", 130, "revive", "AllyA → AllyB 소생"), actorId: "ally-a-id", actorTeamId: 1,
          victimId: "ally-b-id", victimTeamId: 1 },
        fact("encounter", 180, "encounter", "교전"),
        fact("finish", 200, "finish", "경기 종료 기록 · 1위"),
      ],
      killEvents: [{ timeSeconds: 100, victim: "enemy", weapon: "M416", distanceMeters: 30 }],
      teamKillEvents: [
        { timeSeconds: 100, killer: "Ranker", victim: "enemy", weapon: "M416" },
        { timeSeconds: 170, killer: "AllyA", victim: "enemy", weapon: "M416" },
        { timeSeconds: 190, killer: "AllyA", victim: "enemy", weapon: "M416" },
      ],
      route: [{ timeSeconds: 175, x: 900, y: 900, place: null, spreadMeters: 0, players: [] }],
      encounters: [{
        id: "encounter", startSeconds: 180, endSeconds: 180, opponents: ["enemy"], allies: ["Ranker", "AllyA"],
        teamKills: 0, rankerWeapons: [], firstRankerShot: null, precontactMovement: [], arrival: null, vehicle: null, actions: [],
        snapshots: [{ offsetSeconds: 0, anchorLabel: "처음 기록된 교전 행동", targetTimeSeconds: 180, missingPlayers: [], points: [
          { player: "Ranker", side: "ally", directlyInvolved: true, x: 100000, y: 100000, sampleTimeSeconds: 180, ageSeconds: 0 },
          { player: "AllyA", side: "ally", directlyInvolved: false, x: 300000, y: 300000, sampleTimeSeconds: 180, ageSeconds: 0 },
          { player: "enemy", side: "opponent", directlyInvolved: true, x: 500000, y: 500000, sampleTimeSeconds: 180, ageSeconds: 0 },
        ] }],
      }],
    });
    const result = buildDailyWalkthrough(input);
    const chapters = result.chapters;
    expect(chapters[0].startSeconds).toBe(10);
    expect(result.overview?.path).not.toContainEqual({ x: 42, y: 42 });
    expect(chapters.flatMap(({ evidenceIds }) => evidenceIds)).toContain("revive");
    expect(chapters.some(({ action, evidenceIds }) => action.includes("소생 기록: 팀원 → 팀원")
      && evidenceIds.includes("down") && evidenceIds.includes("revive"))).toBe(true);
    expect(chapters.at(-1)?.action).toContain("팀원 1의 M416 킬이 팀의 마지막 킬");
    expect(chapters.at(-1)?.outcome).toContain("개인 1킬, 팀 전체 3킬 (팀원 2킬 포함)");
    expect(result.chapters.at(-1)?.action).toContain("팀원 1의 M416 킬이 팀의 마지막 킬");
    const encounterChapter = chapters.find(({ mapSnapshot }) => mapSnapshot?.observations?.some(({ evidenceId }) => evidenceId === "encounter"));
    expect(encounterChapter?.mapSnapshot?.path).toContainEqual({ x: 1000, y: 1000 });
    expect(encounterChapter?.mapSnapshot?.path).not.toContainEqual({ x: 3000, y: 3000 });
    expect(encounterChapter?.mapSnapshot?.path).not.toContainEqual({ x: 5000, y: 5000 });
    expect(encounterChapter?.mapSnapshot?.marks).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: "teammate", x: 3000, y: 3000, label: expect.stringContaining("팀원 1") }),
      expect.objectContaining({ kind: "opponent", x: 5000, y: 5000, label: expect.stringContaining("상대 1") }),
    ]));
  });

  it("orders summary observations even when entry precedes the first personal kill", () => {
    const result = buildDailyWalkthrough(story({
      facts: [fact("landing-ally", 80, "landing"), fact("landing", 90.409, "landing"), fact("zone", 100, "zone"),
        fact("kill", 532, "kill"), fact("find", 892, "weapon_find"), fact("ride", 918, "vehicle", "차량 탑승"),
        fact("finish", 1752, "finish", "경기 종료 기록 · 1위")],
      zones: [{ phase: 1, observedSeconds: 100, outsideMeters: 600, firstInsideSeconds: 416 }],
      killEvents: [{ timeSeconds: 532, victim: "other", weapon: "BP_MolotovFireDebuff_C" }],
      weaponFinds: [{ timeSeconds: 892, player: "Ranker", weapon: "AWM", source: "carepackage", owner: null }],
    }));
    expect(result.chapters[0].startSeconds).toBe(90.409);
    expect(result.summary).not.toMatch(/\d{2}:\d{2}/);
    expect(result.chapters.some(({ action }) => action.includes("06:56") && action.includes("원 안 위치"))).toBe(true);
    expect(result.chapters.some(({ action }) => action.includes("화염병"))).toBe(true);
    expect(JSON.stringify(result)).not.toContain("BP_Molotov");
    expect(result.takeaways[0].text).toContain("경계 밖 약 600m");
  });

  it("does not guess a target landing or a finish and preserves known weapon labels", () => {
    const result = buildDailyWalkthrough(story({
      facts: [fact("landing-ally", 10, "landing"), fact("kill", 100, "kill")],
      killEvents: [{ timeSeconds: 100, victim: "enemy", weapon: "M416" }],
      route: undefined,
    }));
    expect(result.chapters[0].startSeconds).toBe(100);
    expect(result.chapters.every(({ kind }) => kind !== "finish")).toBe(true);
    expect(result.summary).not.toContain("착지");
    expect(result.chapters[0].action).toContain("M416");
    expect(result.takeaways.at(-1)?.text).toContain("M416");
  });

  it("sanitizes unknown weapon IDs in every display field", () => {
    const result = buildDailyWalkthrough(story({
      facts: [fact("landing", 10, "landing"), fact("find", 50, "weapon_find"), fact("kill", 100, "kill"),
        fact("finish", 200, "finish", "경기 종료 기록 · 1위")],
      killEvents: [{ timeSeconds: 100, victim: "enemy", weapon: "BP_FutureUnknown_C" }],
      weaponFinds: [{ timeSeconds: 50, player: "Ranker", weapon: "BP_FutureUnknown_C", source: "carepackage", owner: null }],
    }));
    expect(JSON.stringify(result)).not.toContain("BP_FutureUnknown_C");
    expect(result.headline).toContain("마지막 교전");
    expect(result.headline).not.toContain("무기 미확인");
    expect(result.chapters.at(-1)?.title).not.toContain("무기 미확인");
    expect(result.takeaways.find(({ title }) => title.includes("보급"))?.text).toContain("무기 미확인");
  });

  it("includes the final kill even when a later encounter occurs before the verified finish", () => {
    const input = soloMatch();
    input.killEvents = input.killEvents.slice(0, -1);
    input.teamKillEvents = input.teamKillEvents?.slice(0, -1);
    const result = buildDailyWalkthrough(input);
    expect(result.chapters.at(-1)!.startSeconds).toBeLessThanOrEqual(1427.205);
    expect(result.chapters.at(-1)!.action).toContain("23:47");
    expect(result.chapters.at(-1)!.action).toContain("27:58");
    expect(result.chapters.at(-1)!.endSeconds).toBe(1678.263);
    expect(result.summary.endsWith("경기 종료 결과는 1위입니다.")).toBe(true);
    expect(result.takeaways.every(({ text }) => !text.includes("시점은 별도로 확인"))).toBe(true);
  });

  it("keeps overlapping enemy teams separate and reports observed sample time and roster outcome", () => {
    const first = {
      id: "encounter-a", startSeconds: 100, endSeconds: 110, opponents: ["Enemy A", "Enemy A2", "Enemy A3"], allies: ["Ranker"],
      opponentIdentity: { key: "team-2", teamId: 2, playerIds: ["enemy-a", "enemy-a2", "enemy-a3"], players: [
        { id: "enemy-a", name: "Enemy A", deathTimeSeconds: 110, deathKillerTeamId: 1 },
        { id: "enemy-a2", name: "Enemy A2", deathTimeSeconds: 108, deathKillerTeamId: 3 },
        { id: "enemy-a3", name: "Enemy A3" },
      ] },
      teamKills: 1, rankerWeapons: [], firstRankerShot: null, precontactMovement: [], arrival: null, vehicle: null,
      sourceIndices: [10], actions: [
        { timeSeconds: 100, kind: "first_hit", actor: "Enemy A", actorId: "enemy-a", actorTeamId: 2,
          victim: "Ranker", victimId: "ranker-id", victimTeamId: 1, weapon: "M416", distanceMeters: 50 },
        { timeSeconds: 110, kind: "kill", actor: "Ranker", actorId: "ranker-id", actorTeamId: 1,
          victim: "Enemy A", victimId: "enemy-a", victimTeamId: 2, weapon: "M416", distanceMeters: 50 },
      ],
      snapshots: [{ offsetSeconds: 0, anchorLabel: "처음 기록된 피해", targetTimeSeconds: 100, missingPlayers: ["Enemy A2"], points: [
        { playerId: "ranker-id", player: "Ranker", side: "ally", directlyInvolved: true, x: 100000, y: 100000, sampleTimeSeconds: 99, ageSeconds: 1, sourceIndices: [99] },
        { player: "Enemy A", side: "opponent", directlyInvolved: true, x: 110000, y: 100000, sampleTimeSeconds: 96, ageSeconds: 4, sourceIndices: [96] },
      ] }],
    };
    const second = {
      ...first, id: "encounter-b", startSeconds: 102, endSeconds: 112, opponents: ["Enemy B"],
      opponentIdentity: { key: "team-3", teamId: 3, playerIds: ["enemy-b"], players: [{ id: "enemy-b", name: "Enemy B" }] },
      sourceIndices: [20], actions: [{ timeSeconds: 102, kind: "first_hit", actor: "Enemy B", actorId: "enemy-b", actorTeamId: 3,
        victim: "Ranker", victimId: "ranker-id", victimTeamId: 1, weapon: "M416", distanceMeters: 60 }],
      snapshots: [{ offsetSeconds: 0, anchorLabel: "처음 기록된 피해", targetTimeSeconds: 102, missingPlayers: [], points: [
        { playerId: "ranker-id", player: "Ranker", side: "ally", directlyInvolved: true, x: 100000, y: 100000, sampleTimeSeconds: 101, ageSeconds: 1, sourceIndices: [101] },
        { player: "Enemy B", side: "opponent", directlyInvolved: true, x: 130000, y: 100000, sampleTimeSeconds: 102, ageSeconds: 0, sourceIndices: [102] },
      ] }],
    };
    const result = buildDailyWalkthrough(story({
      mode: "squad", facts: [
        { ...fact("landing", 1, "landing"), actorId: "ranker-id", actorTeamId: 1 },
        { ...fact("encounter-a", 100, "encounter"), sourceIndices: [10] },
        { ...fact("encounter-b", 102, "encounter"), sourceIndices: [20] },
        { ...fact("kill-a", 110, "kill"), actorId: "ranker-id", actorTeamId: 1, victimId: "enemy-a", victimTeamId: 2 },
        { ...fact("finish", 200, "finish", "경기 종료 기록 · 1위"), actorId: "ranker-id", actorTeamId: 1 },
      ],
      roster: [{ name: "Ranker", kills: 1, isRanker: true }],
      kills: 1, teamKills: 1, killEvents: [{ timeSeconds: 110, victim: "Enemy A", weapon: "M416" }],
      teamKillEvents: [{ timeSeconds: 110, killer: "Ranker", victim: "Enemy A", weapon: "M416" }],
      encounters: [first, second],
    }));
    const firstScene = result.combatScenes!.find(({ id }) => id === "combat-encounter-a")!;
    const chapter = result.chapters.find(({ mapSnapshot }) => mapSnapshot?.observations?.some(({ evidenceId }) => evidenceId === "encounter-a"));
    const labels = firstScene.mapSnapshot!.observations!.map(({ label }) => label);
    expect(chapter?.mapSnapshot?.observations).toContainEqual(expect.objectContaining({
      timeSeconds: 96, sourceIndices: [96], label: expect.stringContaining("4초 전 표본"),
    }));
    expect(labels.some((label) => label.includes("Enemy B"))).toBe(false);
    expect(firstScene.mapSnapshot!.observations).toContainEqual(expect.objectContaining({
      timeSeconds: 96, sourceIndices: [96], label: expect.stringContaining("4초 전 표본"),
    }));
    expect(firstScene.brief?.situation).toContain("교전 시작 전후 15초 내 위치: 1/3명");
    expect(firstScene.brief?.situation).toContain("상대 2·상대 3 위치 미확인");
    expect(firstScene.brief?.outcome).toContain("상대 팀 3명 중 1명 처치");
    expect(firstScene.brief?.outcome).toContain("1명은 처치 기록 없음 · 교전 중 타팀 처치 1명");
    expect(firstScene.brief?.outcome).not.toContain("전원 처치 기록 확인");
    expect(result.combatScenes!.find(({ id }) => id === "combat-encounter-b")!.mapSnapshot!.observations)
      .not.toContainEqual(expect.objectContaining({ label: expect.stringContaining("Enemy A") }));
  });

  it("does not label a snapshot-time kill as an opponent death before the encounter", () => {
    const encounter = {
      id: "kill-anchored", startSeconds: 759, endSeconds: 759, opponents: ["Enemy 13"], allies: ["Ranker"],
      opponentIdentity: { key: "team-13", teamId: 13, playerIds: ["enemy-13"], players: [
        { id: "enemy-13", name: "Enemy 13", deathTimeSeconds: 759, deathKillerTeamId: 16 },
      ] },
      teamKills: 1, rankerWeapons: [], firstRankerShot: null, precontactMovement: [], arrival: null, vehicle: null,
      actions: [{ timeSeconds: 759, kind: "kill", actor: "Ranker", actorId: "ranker-id", actorTeamId: 16,
        victim: "Enemy 13", victimId: "enemy-13", victimTeamId: 13, weapon: "AUG", distanceMeters: 30 }],
      snapshots: [{ offsetSeconds: 0, anchorLabel: "마지막 킬", targetTimeSeconds: 759, missingPlayers: [],
        deadPlayerIds: ["enemy-13"], points: [
          { playerId: "ranker-id", player: "Ranker", side: "ally", directlyInvolved: true,
            x: 100000, y: 100000, sampleTimeSeconds: 759, ageSeconds: 0 },
        ] }],
    };
    const result = buildDailyWalkthrough(story({
      mode: "squad", facts: [
        { ...fact("landing", 1, "landing"), actorId: "ranker-id", actorTeamId: 16 },
        { ...fact("encounter", 759, "encounter"), sourceIndices: [12] },
        { ...fact("kill", 759, "kill"), actorId: "ranker-id", actorTeamId: 16, victimId: "enemy-13", victimTeamId: 13 },
      ],
      encounters: [encounter], kills: 1, teamKills: 1,
      killEvents: [{ timeSeconds: 759, victim: "Enemy 13", weapon: "AUG" }],
      teamKillEvents: [{ timeSeconds: 759, killer: "Ranker", victim: "Enemy 13", weapon: "AUG" }],
    }));
    const scene = result.combatScenes!.find(({ id }) => id === "combat-kill-anchored")!;
    expect(scene.brief?.situation).not.toContain("교전 전 사망");
    expect(scene.brief?.situation).toContain("위치 미확인");
  });
});
