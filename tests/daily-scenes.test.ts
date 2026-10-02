import { describe, expect, it } from "vitest";
import type { DailyEvidence } from "../lib/learn/dailyEvidence";
import { buildDailySceneCandidates, validateDailySceneSelection } from "../lib/learn/dailyScenes";

const fact = (id: string, timeSeconds: number, kind: string, text: string, sourceIndex: number) => ({ id, timeSeconds, kind, text, sourceIndices: [sourceIndex], eventType: kind });

function evidence(overrides: Partial<DailyEvidence> = {}): DailyEvidence {
  return {
    dayKst: "2026-09-26", matchId: "match-1", accountId: "ranker", nickname: "player", mode: "squad", mapName: "Erangel",
    leaderboardRank: 1, playedAt: "2026-09-26T00:00:00.000Z", kills: 1, damage: 100, teamKills: 2,
    facts: [fact("landing", 35, "landing", "착지", 0), fact("route-early", 110, "route", "위치 표본 · (100, 100)m", 1),
      fact("zone", 180, "zone", "1번째 자기장 공개 · 안전지대까지 약 200m", 2), fact("encounter", 300, "encounter", "상대 팀(A)과 교전 · 아군 1킬", 3),
      fact("revive", 420, "revive", "아군 → 팀원 소생", 4), fact("finish", 900, "finish", "경기 종료 확인 · 우승", 5)],
    weapons: [], killEvents: [{ timeSeconds: 300, victim: "A", weapon: "M416" }], teamKillEvents: [],
    route: [{ timeSeconds: 40, x: 100, y: 100, place: "Pochinki", spreadMeters: 0, players: [{ name: "player", x: 100, y: 100 }] },
      { timeSeconds: 110, x: 200, y: 200, place: null, spreadMeters: 0, players: [{ name: "player", x: 200, y: 200 }] }],
    aircraft: [], zones: [{ phase: 1, observedSeconds: 180, center: { x: 500, y: 500 }, radius: 300, outsideMeters: 200, firstInsideSeconds: 250 }], limitations: [], ...overrides,
  } as DailyEvidence;
}

describe("daily scene candidates", () => {
  it("builds chronological, evidence-backed observations with a real finish scene", () => {
    const scenes = buildDailySceneCandidates(evidence());
    expect(scenes.length).toBeGreaterThanOrEqual(3);
    expect(scenes.length).toBeGreaterThan(3);
    expect(scenes.map(({ kind }) => kind)).toContain("opening");
    expect(scenes.map(({ kind }) => kind)).toContain("recovery");
    expect(scenes.at(-1)?.kind).toBe("finish");
    expect(scenes.every((scene) => scene.evidenceIds.length > 0 && scene.situation && scene.action && scene.outcome)).toBe(true);
    expect(scenes.every((scene, index) => index === 0 || scene.anchorSeconds >= scenes[index - 1].anchorSeconds)).toBe(true);
  });

  it("does not infer a finish from the last kill or invent a map sample", () => {
    const source = evidence({ facts: [fact("landing", 35, "landing", "착지", 0), fact("encounter", 300, "encounter", "교전", 1), fact("kill", 320, "kill", "상대 처치", 2)], route: [], zones: [] });
    const scenes = buildDailySceneCandidates(source);
    expect(scenes.some((scene) => scene.kind === "finish")).toBe(false);
    expect(scenes.every((scene) => !scene.mapSnapshot)).toBe(true);
  });

  it("labels vehicle boarding as movement rather than match end", () => {
    const scenes = buildDailySceneCandidates(evidence({ facts: [fact("vehicle-1", 600, "vehicle", "차량 탑승", 8)] }));
    expect(scenes[0].title).toBe("차량 탑승");
    expect(scenes[0].kind).toBe("movement");
  });

  it("uses only contemporaneous position and zone observations for the selected scene", () => {
    const source = evidence({
      nickname: "Winner",
      facts: [fact("encounter-1", 300, "encounter", "교전", 3)],
      encounters: [{ id: "encounter-1", startSeconds: 300, endSeconds: 315, opponents: ["A"], allies: ["Winner"], rosterAllies: ["Winner", "Teammate"], teamKills: 1,
        rankerWeapons: ["M416"], firstRankerShot: null, precontactMovement: [], arrival: null, vehicle: null,
        actions: [
          { timeSeconds: 303, kind: "kill", actor: "Opponent", victim: "Teammate", weapon: "AKM", distanceMeters: null, sourceIndices: [9], actorId: "enemy-id" },
          { timeSeconds: 305, kind: "kill", actor: "Winner", victim: "A", weapon: "M416", distanceMeters: 10, sourceIndices: [10], actorId: "ranker" },
        ],
        snapshots: [{ offsetSeconds: 0, anchorLabel: "처음 기록된 교전 행동", targetTimeSeconds: 300, missingPlayers: [],
          points: [
            { player: "Teammate", side: "ally", directlyInvolved: true, x: 28000, y: 28000, sampleTimeSeconds: 298, ageSeconds: 2 },
            { player: "Opponent", side: "opponent", directlyInvolved: true, x: 32000, y: 32000, sampleTimeSeconds: 299, ageSeconds: 1 },
            { player: "Winner", side: "ally", directlyInvolved: true, x: 30000, y: 30000, sampleTimeSeconds: 300, ageSeconds: 0 },
          ] }],
      }],
      zones: [{ phase: 1, observedSeconds: 270, center: { x: 1, y: 2 }, radius: 10, outsideMeters: null, firstInsideSeconds: null },
        { phase: 2, observedSeconds: 450, center: { x: 900, y: 900 }, radius: 10, outsideMeters: null, firstInsideSeconds: null }],
    });
    const scene = buildDailySceneCandidates(source).find(({ kind }) => kind === "combat");
    expect(scene?.mapSnapshot?.path).toEqual([{ x: 300, y: 300 }]);
    expect(scene?.mapSnapshot?.marks).toEqual(expect.arrayContaining([
      expect.objectContaining({ x: 280, y: 280, kind: "teammate", label: "Teammate · 04:58 관측 위치" }),
      expect.objectContaining({ x: 320, y: 320, kind: "opponent", label: "Opponent · 04:59 관측 위치" }),
    ]));
    expect(scene?.mapSnapshot?.zone).toEqual({ x: 1, y: 2, radius: 10 });
    expect(scene?.mapSnapshot?.pathEndSeconds).toBe(300);
    expect(scene?.title).toContain("교전");
    expect(scene?.action).toContain("05:05");
    expect(scene?.action).not.toContain("Opponent → Teammate");
    expect(scene?.outcome).toContain("팀 처치 1명");
  });


  it("uses direct landing and revive positions and attaches only the reviewed conditional lesson", () => {
    const landing = { ...fact("landing", 35, "landing", "Winner 착지", 0), actorId: "ranker", position: { x: 50, y: 60 } };
    const revive = { ...fact("revive", 420, "revive", "Winner → Teammate 소생", 4), actorId: "ranker", position: { x: 400, y: 600 } };
    const scenes = buildDailySceneCandidates(evidence({ facts: [landing, revive, fact("finish", 900, "finish", "경기 종료 · 1위", 5)] }));
    expect(scenes.find(({ kind }) => kind === "opening")?.mapSnapshot?.path).toEqual([{ x: 50, y: 60 }]);
    const recovery = scenes.find(({ kind }) => kind === "recovery")!;
    expect(recovery.mapSnapshot?.path).toEqual([{ x: 400, y: 600 }]);
    expect(recovery.lesson).toBe("팀원이 쓰러졌다면, 다음 이동 전에 소생 가능 여부와 합류 상태를 확인해 보세요.");
    expect(scenes.find(({ kind }) => kind === "finish")?.lesson).toBeUndefined();
  });

  it("connects only source-linked route samples inside one movement scene", () => {
    const source = evidence({
      facts: [fact("route-1", 100, "route", "위치 표본 1", 10), fact("route-2", 180, "route", "위치 표본 2", 11),
        fact("route-3", 400, "route", "위치 표본 3", 12)],
      route: [
        { timeSeconds: 100, x: 100, y: 200, place: null, spreadMeters: 0, players: [] },
        { timeSeconds: 180, x: 300, y: 400, place: null, spreadMeters: 0, players: [] },
        { timeSeconds: 400, x: 500, y: 600, place: null, spreadMeters: 0, players: [] },
      ], zones: [],
    });
    const scenes = buildDailySceneCandidates(source).filter(({ kind }) => kind === "movement");
    expect(scenes[0].mapSnapshot?.path).toEqual([{ x: 100, y: 200 }, { x: 300, y: 400 }]);
    expect(scenes[0].evidenceIds).toEqual(["route-1", "route-2"]);
    expect(scenes[0].mapSnapshot?.observations?.map(({ timeSeconds }) => timeSeconds)).toEqual([100, 180]);
    expect(scenes[0].mapSnapshot?.marks).toBeUndefined();
  });

  it("splits route samples across the ranker's death and return without changing the flat path", () => {
    const source = evidence({
      facts: [fact("route-1", 100, "route", "위치 표본 1", 10), fact("route-2", 110, "route", "위치 표본 2", 11),
        { ...fact("death", 120, "player_death", "사망", 12), victimId: "ranker" },
        { ...fact("return", 200, "player_return", "복귀", 13), actorId: "ranker" },
        fact("route-3", 220, "route", "위치 표본 3", 14), fact("route-4", 240, "route", "위치 표본 4", 15)],
      route: [
        { timeSeconds: 100, x: 100, y: 200, place: null, spreadMeters: 0, players: [] },
        { timeSeconds: 110, x: 150, y: 250, place: null, spreadMeters: 0, players: [] },
        { timeSeconds: 220, x: 7000, y: 7100, place: null, spreadMeters: 0, players: [] },
        { timeSeconds: 240, x: 7050, y: 7150, place: null, spreadMeters: 0, players: [] },
      ], zones: [],
    });
    const scene = buildDailySceneCandidates(source).find(({ kind }) => kind === "movement")!;
    expect(scene.mapSnapshot?.path).toEqual([
      { x: 100, y: 200 }, { x: 150, y: 250 }, { x: 7000, y: 7100 }, { x: 7050, y: 7150 },
    ]);
    expect(scene.mapSnapshot?.pathSegments).toEqual([
      [{ x: 100, y: 200 }, { x: 150, y: 250 }],
      [{ x: 7000, y: 7100 }, { x: 7050, y: 7150 }],
    ]);
  });

  it("keeps an empty segment list after a final death before the stored route samples", () => {
    const source = evidence({
      facts: [
        { ...fact("death", 90, "player_death", "사망", 9), victimId: "ranker" },
        fact("route-1", 100, "route", "위치 표본 1", 10), fact("route-2", 110, "route", "위치 표본 2", 11),
      ],
      route: [
        { timeSeconds: 100, x: 100, y: 200, place: null, spreadMeters: 0, players: [] },
        { timeSeconds: 110, x: 7000, y: 7100, place: null, spreadMeters: 0, players: [] },
      ], zones: [],
    });
    const scene = buildDailySceneCandidates(source).find(({ kind }) => kind === "movement")!;
    expect(scene.mapSnapshot?.path).toHaveLength(2);
    expect(scene.mapSnapshot?.pathSegments).toEqual([]);
  });

  it("does not anchor opponent or teammate coordinates as the ranker when their sample is absent", () => {
    const source = evidence({
      facts: [fact("encounter-1", 300, "encounter", "교전", 3)],
      encounters: [{ id: "encounter-1", startSeconds: 300, endSeconds: 315, opponents: ["A"], allies: ["Teammate"], teamKills: 0,
        rankerWeapons: [], firstRankerShot: null, precontactMovement: [], arrival: null, vehicle: null, actions: [],
        snapshots: [{ offsetSeconds: 0, anchorLabel: "처음 기록된 교전 행동", targetTimeSeconds: 300, missingPlayers: ["Winner"],
          points: [{ player: "Opponent", side: "opponent", directlyInvolved: true, x: 32000, y: 32000, sampleTimeSeconds: 300, ageSeconds: 0 }] }],
      }],
    });
    const scene = buildDailySceneCandidates(source).find(({ kind }) => kind === "combat");
    expect(scene?.mapSnapshot).toBeUndefined();
  });
 });

describe("daily scene selection validation", () => {
  const candidates = buildDailySceneCandidates(evidence());

  it("rejects duplicate and missing IDs, then records deterministic fallback", () => {
    const result = validateDailySceneSelection({ sceneIds: [candidates[0].id, candidates[0].id, "missing"] }, candidates);
    expect(result.usedFallback).toBe(true);
    expect(result.rejectedReasons.join(" ")).toMatch(/duplicate/i);
    expect(result.rejectedReasons.join(" ")).toMatch(/unknown|missing/i);
    expect(result.scenes.length).toBeGreaterThanOrEqual(3);
    expect(result.scenes.map((scene) => scene.kind)).toContain("opening");
    expect(result.scenes.at(-1)?.kind).toBe("finish");
  });

  it("repairs reverse chronology and missing finish without counting repairs as model success", () => {
    const opening = candidates.find(({ kind }) => kind === "opening")!;
    const combat = candidates.find(({ kind }) => kind === "combat")!;
    const recovery = candidates.find(({ kind }) => kind === "recovery")!;
    const result = validateDailySceneSelection({ sceneIds: [recovery.id, combat.id, opening.id] }, candidates);
    expect(result.usedFallback).toBe(true);
    expect(result.rejectedReasons).toContain("chronology_reordered");
    expect(result.rejectedReasons).toContain("finish_inserted");
    expect(result.scenes.map(({ kind }) => kind)).toEqual(["opening", "movement", "combat", "recovery", "finish"]);
  });

  it("returns no publishable selection when fewer than three distinct scenes exist", () => {
    const onlyTwo = candidates.filter(({ kind }) => kind === "opening" || kind === "finish");
    const result = validateDailySceneSelection({ sceneIds: onlyTwo.map(({ id }) => id) }, onlyTwo);
    expect(result.usedFallback).toBe(true);
    expect(result.scenes).toHaveLength(0);
    expect(result.rejectedReasons).toContain("insufficient_distinct_scenes");
  });
});
