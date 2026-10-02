import { existsSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { buildDailyEvidence } from "@/lib/learn/dailyEvidence";
import { buildDailyModelInput } from "@/lib/learn/dailyAi";
import { buildStoredStory } from "@/scripts/publish_daily_ranker_story";
import regressions from "./fixtures/learn/daily-regressions.json";

const matchFile = "tmp/ranker-content-probe/match-cdd3a704-a14c-4ef9-9cbe-01ededea7319.json";
const telemetryFile = "tmp/ranker-content-probe/solo-telemetry.json";
const hasLocalFixture = existsSync(matchFile) && existsSync(telemetryFile);
const match = hasLocalFixture ? JSON.parse(readFileSync(matchFile, "utf8")) : null;
const events = hasLocalFixture ? JSON.parse(readFileSync(telemetryFile, "utf8")) : null;
const candidate = {
  accountId: "account.b3cdfc9cc1f043d39523ff3af7fb5c62",
  nickname: "VIE_TanVuu284",
  rank: 16,
};
const input = { match, events, candidate, dayKst: "2026-09-22" };

describe.skipIf(!hasLocalFixture)("buildDailyEvidence against local PUBG fixture", () => {
  it("extracts verified evidence from the local solo win without prose inference", () => {
    const result = buildDailyEvidence(input);
    expect(result).toMatchObject({
      dayKst: "2026-09-22",
      matchId: "cdd3a704-a14c-4ef9-9cbe-01ededea7319",
      nickname: candidate.nickname,
      mode: "solo",
      mapName: "미라마",
      leaderboardRank: 16,
      kills: 11,
      teamKills: 11,
    });
    expect(result.killEvents).toHaveLength(11);
    expect(result.weapons).toEqual(expect.arrayContaining([
      { name: "M416", kills: 4 },
      { name: "수류탄", kills: 2 },
      { name: "링스 AMR", kills: 2 },
    ]));
    expect(result.zones.length).toBeGreaterThan(0);
    expect(result.facts).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: "kill", timeSeconds: expect.any(Number) }),
      expect.objectContaining({ kind: "zone" }),
    ]));
    expect(result.limitations.length).toBeGreaterThan(0);
  });

  it("rejects a different KST day, mode, or account identity", () => {
    expect(() => buildDailyEvidence({ ...input, dayKst: "2026-09-21" })).toThrow(/KST day/);
    const wrongMode = structuredClone(match);
    wrongMode.data.attributes.gameMode = "fpp";
    expect(() => buildDailyEvidence({ ...input, match: wrongMode })).toThrow(/solo\/duo\/squad/);
    expect(() => buildDailyEvidence({ ...input, candidate: { ...candidate, accountId: "account.wrong" } })).toThrow(/identity/);
  });

  it("rejects telemetry whose killer events disagree with the PUBG API kill count", () => {
    const mismatched = events.filter((event: { _T?: string; killer?: { accountId?: string } }) =>
      !(event._T === "LogPlayerKillV2" && event.killer?.accountId === candidate.accountId));
    expect(() => buildDailyEvidence({ ...input, events: mismatched })).toThrow(/kill count mismatch/);
    const altered = structuredClone(events);
    const victimKill = altered.find((event: { _T?: string; killer?: { accountId?: string } }) =>
      event._T === "LogPlayerKillV2" && event.killer?.accountId === candidate.accountId);
    victimKill.killer.accountId = "account.other";
    expect(() => buildDailyEvidence({ ...input, events: altered })).toThrow(/kill count mismatch/);
  });
});

const squadMatchFile = "tmp/ranker-content-probe/daily-2026-09-23-match.json";
const squadTelemetryFile = "tmp/ranker-content-probe/daily-2026-09-23-telemetry.json";
describe.skipIf(!existsSync(squadMatchFile) || !existsSync(squadTelemetryFile))("daily squad raw telemetry", () => {
  it("separates the first shot from pickup, team kill attribution and crate weapon origin", () => {
    const squad = buildDailyEvidence({
      match: JSON.parse(readFileSync(squadMatchFile, "utf8")),
      events: JSON.parse(readFileSync(squadTelemetryFile, "utf8")),
      candidate: { accountId: "account.15ba57e483694cac85c5248bf69ed3be", nickname: "You1Shuo1-_-", rank: 10 },
      dayKst: "2026-09-23",
    });
    expect(squad).toMatchObject({ mode: "squad", kills: 3, teamKills: 15 });
    expect(squad.facts.some((fact) => fact.kind === "aircraft" && fact.text === "비행기 탑승")).toBe(true);
    expect(squad.facts.some((fact) => fact.kind === "vehicle" && fact.timeSeconds < 2)).toBe(false);
    expect(squad.encounters?.[0]).toMatchObject({ teamKills: 3, rankerWeapons: ["M416"],
      firstRankerShot: { weapon: "M416" } });
    expect(squad.encounters?.[0].precontactMovement).toHaveLength(4);
    expect(squad.weaponFinds).toEqual(expect.arrayContaining([
      expect.objectContaining({ player: "You1Shuo1-_-", weapon: "UMP45", source: "ground" }),
      expect.objectContaining({ player: "Emmm_XiaoXiao", weapon: "MG3", source: "lootbox", owner: "Kumbayawooo" }),
      expect.objectContaining({ player: "You1Shuo1-_-", weapon: "그로자", source: "carepackage" }),
    ]));
    expect(squad.teamKillEvents.slice(-2).map((kill) => [kill.killer, kill.weapon])).toEqual([
      ["Emmm_XiaoXiao", "수류탄"], ["Emmm_XiaoXiao", "MG3"],
    ]);
  });
});

describe("buildDailyEvidence required input", () => {
  it("separates squad finish, linked throwable damage, revive and sampled movement", () => {
    const target = "account.target";
    const teammate = "account.teammate";
    const opponent = "account.opponent";
    const at = (seconds: number) => new Date(Date.parse("2026-09-22T15:00:00Z") + seconds * 1000).toISOString();
    const character = (accountId: string, name: string, x = 250000, y = 140000) => ({ accountId, name, location: { x, y }, zone: ["lacobreria"] });
    const match = { data: { id: "squad-1", attributes: { shardId: "steam", gameMode: "squad", matchType: "competitive",
      isCustomMatch: false, createdAt: at(0), mapName: "Desert_Main" } }, included: [
      { type: "participant", attributes: { stats: { playerId: target, name: "Target", winPlace: 1, kills: 0, damageDealt: 10 } } },
      { type: "participant", attributes: { stats: { playerId: teammate, name: "Teammate", winPlace: 1, kills: 1, damageDealt: 110 } } },
    ] };
    const events = [
      { _T: "LogMatchDefinition", MatchId: "match.bro.competitive.steam.squad.squad-1", _D: at(0) },
      { _T: "LogMatchStart", _D: at(0) },
      { _T: "LogPlayerPosition", _D: at(10), character: character(target, "Target", 100000, 100000), vehicle: { vehicleId: "DummyTransportAircraft_C" } },
      { _T: "LogParachuteLanding", _D: at(60), character: character(target, "Target") },
      { _T: "LogParachuteLanding", _D: at(61), character: character(teammate, "Teammate", 251000) },
      { _T: "LogPlayerPosition", _D: at(70), character: character(target, "Target") },
      { _T: "LogPlayerPosition", _D: at(70), character: character(teammate, "Teammate", 251000) },
      { _T: "LogPlayerMakeGroggy", _D: at(100), attacker: character(opponent, "Opponent"), victim: character(teammate, "Teammate") },
      { _T: "LogPlayerRevive", _D: at(110), reviver: character(target, "Target"), victim: character(teammate, "Teammate") },
      { _T: "LogPlayerUseThrowable", _D: at(200), attacker: character(teammate, "Teammate"), attackId: 42, weapon: { itemId: "Item_Weapon_Grenade_C" } },
      { _T: "LogPlayerTakeDamage", _D: at(202), attacker: character(teammate, "Teammate"), victim: character(opponent, "Opponent"), attackId: 42, damage: 80 },
      { _T: "LogPlayerKillV2", _D: at(208), killer: character(teammate, "Teammate"), victim: character(opponent, "Opponent"), killerDamageInfo: { damageCauserName: "ProjGrenade_C" }, attackId: -1 },
      { _T: "LogPlayerPosition", _D: at(210), character: character(target, "Target", 300000, 200000) },
      { _T: "LogPlayerPosition", _D: at(210), character: character(teammate, "Teammate", 301000, 200000) },
    ];
    const result = buildDailyEvidence({ match, events, candidate: { accountId: target, nickname: "Target", rank: 1 }, dayKst: "2026-09-23" });
    expect(result.killEvents).toEqual([]);
    expect(result.teamKillEvents).toEqual([{ timeSeconds: 208, killer: "Teammate", victim: "Opponent", weapon: "수류탄", attackId: -1, distanceMeters: 0 }]);
    expect(result.aircraft).toHaveLength(1);
    expect(result.route.length).toBeGreaterThanOrEqual(1);
    expect(result.facts).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: "revive", text: expect.stringContaining("소생") }),
      expect.objectContaining({ kind: "throwable", text: expect.stringContaining("상대 1명에게 총 약 80 피해") }),
      expect.objectContaining({ kind: "teammate_kill", text: expect.stringContaining("수류탄") }),
    ]));
  });

  it("rejects a competitive match without the same leaderboard account", () => {
    const minimal = { data: { id: "match-1", attributes: {
      shardId: "steam", gameMode: "solo", matchType: "competitive", isCustomMatch: false,
      createdAt: "2026-09-22T15:00:00Z",
    } }, included: [{ type: "participant", attributes: { stats: {
      playerId: "account.other", name: "Other", winPlace: 1, kills: 0, damageDealt: 0,
    } } }] };
    const definition = [{ _T: "LogMatchDefinition", MatchId: "match.bro.competitive.steam.solo.match-1" }];
    expect(() => buildDailyEvidence({ match: minimal, events: definition, candidate, dayKst: "2026-09-23" })).toThrow(/identity/);
  });

  it("builds a small verified winner story without the ignored local fixture", () => {
    const accountId = candidate.accountId;
    const matchId = "match-1";
    const match = { data: { id: matchId, attributes: {
      shardId: "steam", gameMode: "solo", matchType: "competitive", isCustomMatch: false,
      createdAt: "2026-09-22T15:00:00Z", mapName: "Desert_Main",
    } }, included: [{ type: "participant", attributes: { stats: {
      playerId: accountId, name: candidate.nickname, winPlace: 1, kills: 1, damageDealt: 100,
    } } }] };
    const events = [
      { _T: "LogMatchDefinition", MatchId: "match.bro.competitive.steam.solo.match-1", _D: "2026-09-22T15:00:00Z" },
      { _T: "LogMatchStart", _D: "2026-09-22T15:00:00Z" },
      { _T: "LogParachuteLanding", _D: "2026-09-22T15:01:00Z", character: { accountId, location: { x: 294700, y: 450400 } } },
      { _T: "LogPlayerKillV2", _D: "2026-09-22T15:06:00Z", killer: { accountId }, finisher: { accountId: "account.other" }, victim: { name: "Opponent", accountId: "account.opponent" }, killerDamageInfo: { damageCauserName: "WeapHK416_C" }, finishDamageInfo: { damageCauserName: "WeapBerylM762_C" } },
    ];
    const story = buildDailyEvidence({ match, events, candidate, dayKst: "2026-09-23" });
    expect(story.killEvents).toEqual([{ timeSeconds: 360, victim: "Opponent", weapon: "M416" }]);
    expect(story.facts).toEqual(expect.arrayContaining([expect.objectContaining({ id: "landing", timeSeconds: 60 })]));
    expect(story.teamKills).toBe(1);
  });
});

describe("daily regression evidence", () => {
  it("adds only a verified second-place blue-zone death in the match ending window", () => {
    const start = Date.parse("2026-09-29T13:21:42Z");
    const at = (seconds: number) => new Date(start + seconds * 1000).toISOString();
    const second = { accountId: "second", name: "Second", teamId: 15, ranking: 2 };
    const events = [
      { _T: "LogMatchDefinition", MatchId: "match.bro.competitive.steam.squad.terminal" },
      { _T: "LogMatchStart", _D: at(0) },
      { _T: "LogPlayerKillV2", _D: at(1187.6), victim: { ...second, location: { x: 234500, y: 456700 } },
        finishDamageInfo: { damageTypeCategory: "Damage_BlueZone" }, victimGameResult: { rank: 2 } },
      { _T: "LogMatchEnd", _D: at(1191.1), characters: [
        { character: { accountId: candidate.accountId, name: candidate.nickname, teamId: 16, ranking: 1 } },
        { character: second },
      ] },
    ];
    const match = { data: { id: "terminal", attributes: { shardId: "steam", gameMode: "squad", matchType: "competitive",
      isCustomMatch: false, createdAt: at(0), mapName: "Tiger_Main" } }, included: [
      { type: "participant", attributes: { stats: { playerId: candidate.accountId, name: candidate.nickname, winPlace: 1, kills: 0, damageDealt: 0 } } },
      { type: "participant", attributes: { stats: { playerId: "second", name: "Second", winPlace: 2, kills: 0, damageDealt: 0 } } },
    ] };
    const evidence = buildDailyEvidence({ match, events, candidate: { ...candidate, rank: 1 }, dayKst: "2026-09-29" });
    expect(evidence.facts.find(({ kind }) => kind === "terminal_opponent_death")).toMatchObject({
      timeSeconds: 1187.6, victimId: "second", victimTeamId: 15, deathCause: "blue_zone",
      position: { x: 2345, y: 4567 }, positionTimeSeconds: 1187.6,
      sourceIndices: [2, 3], eventType: "LogPlayerKillV2",
    });
    const unverified = buildDailyEvidence({ ...{ match, candidate: { ...candidate, rank: 1 }, dayKst: "2026-09-29" },
      events: events.map((event, index) => index === 2 ? { ...event, victimGameResult: { rank: 3 } } : event) });
    expect(unverified.facts.some(({ kind }) => kind === "terminal_opponent_death")).toBe(false);
  });

  it("keeps event kinds, original indices, actors/teams, end result, and zone geometry", () => {
    const startMs = Date.parse("2026-09-23T08:05:55.497Z");
    const events = [
      { _T: "LogMatchDefinition", MatchId: "match.bro.competitive.steam.duo.regression" },
      { _T: "LogMatchStart", _D: new Date(startMs).toISOString() },
      ...regressions.events,
      { _T: "LogPhaseChange", _D: new Date(startMs + 90_000).toISOString(), phase: 1 },
      { _T: "LogGameStatePeriodic", _D: new Date(startMs + 100_000).toISOString(), gameState: {
        poisonGasWarningPosition: { x: 100_000, y: 200_000 }, poisonGasWarningRadius: 80_000,
      } },
      { _T: "LogMatchEnd", _D: new Date(startMs + 850_000).toISOString(), characters: [
        { character: { accountId: "ranker", teamId: 11, ranking: 1 } },
      ] },
      ...[40, 400].map(seconds => ({ _T: "LogParachuteLanding", _D: new Date(startMs + seconds * 1000).toISOString(),
        character: { accountId: "ranker", name: "Ranker", teamId: 11, location: { x: 10000, y: 20000 } } })),
    ];
    const evidence = buildDailyEvidence({
      match: { data: { id: "regression", attributes: { shardId: "steam", gameMode: "duo", matchType: "competitive",
        isCustomMatch: false, createdAt: "2026-09-23T08:05:55.497Z", mapName: "Desert_Main" } }, included: [
        { type: "participant", attributes: { stats: { playerId: "ranker", name: "Ranker", winPlace: 1, kills: 1, damageDealt: 0 } } },
        { type: "participant", attributes: { stats: { playerId: "ally", name: "Ally", winPlace: 1, kills: 0, damageDealt: 0 } } },
      ] }, events, candidate: { accountId: "ranker", nickname: "Ranker", rank: 1 }, dayKst: "2026-09-23",
    });
    const fixtureIndex = (originalIndex: number) => regressions.originalSourceIndices.indexOf(originalIndex);
    const factAt = (originalIndex: number) => {
      const index = fixtureIndex(originalIndex);
      return evidence.facts.find((fact) => fact.sourceIndices?.includes(index + 2)
        && fact.eventType === regressions.events[index]._T);
    };

    expect(evidence.mode).toBe("duo");
    expect(factAt(regressions.expected.firstDamage.sourceIndex)).toMatchObject({ kind: "damage", timeSeconds: 96.598,
      sourceIndices: [2],
      actorTeamId: 2, victimTeamId: 11, weapon: "VSS", eventType: "LogPlayerTakeDamage" });
    expect(factAt(regressions.expected.knockBeforeKill.knockSourceIndex)).toMatchObject({ kind: "knock", weapon: "UMP45", victimTeamId: 2 });
    expect(factAt(regressions.expected.knockBeforeKill.killSourceIndex)).toMatchObject({ kind: "kill", weapon: "M416", victimTeamId: 2 });
    expect(factAt(regressions.expected.shot.sourceIndex)).toMatchObject({ kind: "shot", timeSeconds: 177.624,
      actorId: "ranker", actorTeamId: 11, weapon: "UMP45" });
    expect(factAt(regressions.expected.mg3.sourceIndex)).toMatchObject({ kind: "damage", actorTeamId: 4,
      victimTeamId: 11, weapon: "MG3" });
    expect(factAt(regressions.expected.revive.sourceIndex)).toMatchObject({ kind: "revive", timeSeconds: 818.225,
      actorId: "ranker", victimId: "ally", actorTeamId: 11, victimTeamId: 11 });
    expect(evidence.facts.find((fact) => fact.kind === "finish")).toMatchObject({ eventType: "LogMatchEnd",
      sourceIndices: [11], actorId: "ranker" });
    expect(evidence.zones[0]).toMatchObject({ center: { x: 1000, y: 2000 }, radius: 800, sourceIndices: expect.arrayContaining([10]), shrinkObservedSeconds: null });
    expect(evidence.facts.every((fact) => fact.sourceIndices?.length)).toBe(true);
    expect(new Set(evidence.facts.map(fact => fact.id)).size).toBe(evidence.facts.length);
    expect(evidence.facts.filter(fact => fact.kind === "landing")).toHaveLength(2);
    expect(factAt(regressions.expected.revive.sourceIndex)).toMatchObject({ position: expect.objectContaining({ x: expect.any(Number), y: expect.any(Number) }),
      positionTimeSeconds: 818.225 });
  });

  it("uses same-phase live-radius decreases and preserves landing, vehicle, and sampled-position provenance", () => {
    const accountId = "ranker";
    const start = Date.parse("2026-09-23T08:05:55.497Z");
    const at = (seconds: number) => new Date(start + seconds * 1000).toISOString();
    const character = (seconds: number, x = seconds * 100, y = 20000, zone: string[] = []) => ({
      _T: "LogPlayerPosition", _D: at(seconds), character: { accountId, name: "Ranker", teamId: 7, location: { x, y }, zone },
    });
    const state = (seconds: number, targetRadius: number, liveRadius?: number) => ({
      _T: "LogGameStatePeriodic", _D: at(seconds), gameState: {
        poisonGasWarningPosition: { x: 100000, y: 200000 }, poisonGasWarningRadius: targetRadius,
        ...(liveRadius === undefined ? {} : { safetyZoneRadius: liveRadius }),
      },
    });
    const events = [
      { _T: "LogMatchDefinition", MatchId: "match.bro.competitive.steam.solo.zone-1", _D: at(0) },
      { _T: "LogMatchStart", _D: at(0) },
      { _T: "LogVehicleRide", _D: at(5), character: { accountId, name: "Ranker", teamId: 7, location: { x: 1000, y: 2000 } }, vehicle: { vehicleId: "DummyTransportAircraft_C" } },
      { _T: "LogPhaseChange", _D: at(10), phase: 1 },
      state(10, 90000, 100000), character(10),
      { _T: "LogParachuteLanding", _D: at(20), character: { accountId, name: "Ranker", teamId: 7, location: { x: 12345, y: 23456 }, zone: [] } },
      { _T: "LogParachuteLanding", _D: at(21), character: { accountId, name: "Ranker", teamId: 7, location: { x: 12345, y: 23456 }, zone: ["school", "unmapped-place"] } },
      { _T: "LogVehicleRide", _D: at(25), character: { accountId, name: "Ranker", teamId: 7, location: { x: 2500, y: 3000 } }, vehicle: { vehicleId: "BuggyVehicle_C" } },
      state(100, 90000, 90000), character(100, 100000, 200000, ["lacobreria"]),
      { _T: "LogPhaseChange", _D: at(200), phase: 2 },
      state(200, 80000, 80000), character(200),
      { _T: "LogPhaseChange", _D: at(205), phase: 2 },
      state(210, 80000, 80000), character(210), character(220),
      state(280, 80000, 70000), character(280),
      { _T: "LogPhaseChange", _D: at(300), phase: 3 },
      state(300, 70000, 70000), character(300),
      state(310, 70000, 70000), character(310),
      { _T: "LogMatchEnd", _D: at(350), characters: [{ character: { accountId, teamId: 7, ranking: 1 } }] },
    ];
    const evidence = buildDailyEvidence({
      match: { data: { id: "zone-1", attributes: { shardId: "steam", gameMode: "solo", matchType: "competitive",
        isCustomMatch: false, createdAt: at(0), mapName: "Desert_Main" } }, included: [
        { type: "participant", attributes: { stats: { playerId: accountId, name: "Ranker", winPlace: 1, kills: 0, damageDealt: 0 } } },
      ] }, events, candidate: { accountId, nickname: "Ranker", rank: 1 }, dayKst: "2026-09-23",
    });
    const zonesByPhase = new Map(evidence.zones.map(zone => [zone.phase, zone]));
    expect(zonesByPhase.get(1)).toMatchObject({ shrinkObservedSeconds: 100 });
    expect(zonesByPhase.get(2)).toMatchObject({ observedSeconds: 200, shrinkObservedSeconds: 280 });
    expect(zonesByPhase.get(3)).toMatchObject({ shrinkObservedSeconds: null });
    expect(zonesByPhase.get(2)!.positions?.every(position => position.timeSeconds < 300)).toBe(true);
    expect(zonesByPhase.get(2)!.positions?.[0]).toMatchObject({ timeSeconds: 200, sourceIndices: expect.any(Array) });
    expect(evidence.facts.find(fact => fact.kind === "landing")).toMatchObject({
      position: { x: 123.45, y: 234.56 }, positionTimeSeconds: 20, place: null,
    });
    expect(evidence.facts.find(fact => fact.kind === "landing" && fact.timeSeconds === 21)).toMatchObject({ place: "학교, unmapped-place" });
    expect(evidence.facts.find(fact => fact.id === "aircraft-board")).toMatchObject({
      actorId: accountId, actorTeamId: 7, vehicleName: "비행기", positionTimeSeconds: 5,
    });
    expect(evidence.facts.find(fact => fact.kind === "vehicle")).toMatchObject({
      actorId: accountId, actorTeamId: 7, vehicleName: "버기", position: { x: 25, y: 30 }, positionTimeSeconds: 25,
    });
  });

  it("stores bounded, ordered live blue-zone observations without adding them to model input", () => {
    const start = Date.parse("2026-09-22T15:00:00Z");
    const at = (seconds: number) => new Date(start + seconds * 1000).toISOString();
    const match = { data: { id: "blue-1", attributes: { shardId: "steam", gameMode: "duo", matchType: "competitive",
      isCustomMatch: false, createdAt: at(0), mapName: "Desert_Main" } }, included: [
      { type: "participant", attributes: { stats: { playerId: "ranker", name: "Ranker", winPlace: 1, kills: 0, damageDealt: 0 } } },
      { type: "participant", attributes: { stats: { playerId: "ally", name: "Ally", winPlace: 1, kills: 0, damageDealt: 0 } } },
    ] };
    const events = [
      { _T: "LogMatchDefinition", MatchId: "match.bro.competitive.steam.duo.blue-1", _D: at(0) },
      { _T: "LogMatchStart", _D: at(0) },
      { _T: "LogMatchEnd", _D: at(350), characters: [{ character: { accountId: "ranker", ranking: 1 } }] },
      ...Array.from({ length: 270 }, (_, index) => {
        const seconds = 300 - index;
        return { _T: "LogGameStatePeriodic", _D: at(seconds), gameState: {
          safetyZonePosition: { x: seconds * 100, y: 20_000 }, safetyZoneRadius: 100_000,
        } };
      }),
      { _T: "LogGameStatePeriodic", _D: at(20), gameState: { safetyZonePosition: { x: 100, y: 200 }, safetyZoneRadius: 0 } },
      { _T: "LogGameStatePeriodic", _D: at(21), gameState: { safetyZonePosition: { x: NaN, y: 200 }, safetyZoneRadius: 100_000 } },
      { _T: "LogGameStatePeriodic", _D: at(351), gameState: { safetyZonePosition: { x: 100, y: 200 }, safetyZoneRadius: 100_000 } },
    ];
    const input = { match, events, candidate: { accountId: "ranker", nickname: "Ranker", rank: 1 }, dayKst: "2026-09-23" };
    const evidence = buildDailyEvidence(input);
    const samples = evidence.blueZoneSamples!;
    expect(samples).toHaveLength(256);
    expect(samples[0]).toEqual({ timeSeconds: 31, center: { x: 31, y: 200 }, radius: 1000, sourceIndex: 272 });
    expect(samples.at(-1)).toEqual({ timeSeconds: 300, center: { x: 300, y: 200 }, radius: 1000, sourceIndex: 3 });
    expect(samples.every((sample, index) => index === 0 || sample.timeSeconds > samples[index - 1].timeSeconds)).toBe(true);
    expect(buildDailyModelInput(evidence)).not.toHaveProperty("blueZoneSamples");
    expect(buildStoredStory({ headline: "", conclusion: "", points: [] }, evidence, {
      leaderboardObservedAt: at(0), leaderboardSeason: "test", leaderboardSource: "test",
    }).blueZoneSamples).toEqual(samples);

    const afterDeath = buildDailyEvidence({ ...input, events: [...events, {
      _T: "LogPlayerKillV2", _D: at(150), killer: { accountId: "opponent" }, victim: { accountId: "ranker" },
    }] });
    expect(afterDeath.blueZoneSamples?.at(-1)?.timeSeconds).toBe(300);
  });

  it("keeps map clocks through match end while ranker positions follow death-return-death lives", () => {
    const accountId = "ranker";
    const teammateId = "ally";
    const start = Date.parse("2026-09-23T08:05:55.497Z");
    const at = (seconds: number) => new Date(start + seconds * 1000).toISOString();
    const person = (id: string, name: string, x: number, health?: number) => ({ accountId: id, name, teamId: 11,
      ...(health === undefined ? {} : { health }), location: { x, y: 100000 } });
    const periodic = (seconds: number) => ({ _T: "LogGameStatePeriodic", _D: at(seconds), gameState: {
      safetyZonePosition: { x: 100000, y: 100000 }, safetyZoneRadius: 80000,
      poisonGasWarningPosition: { x: 100000, y: 100000 }, poisonGasWarningRadius: 50000,
    } });
    const events = [
      { _T: "LogMatchDefinition", MatchId: "match.bro.competitive.steam.squad.life-clock" },
      { _T: "LogMatchStart", _D: at(0) },
      { _T: "LogPhaseChange", _D: at(50), phase: 1 },
      periodic(40), periodic(50), periodic(140), periodic(240), periodic(340),
      { _T: "LogPlayerPosition", _D: at(60), character: person(accountId, "Ranker", 120000, 100) },
      { _T: "LogPlayerPosition", _D: at(90), character: person(accountId, "Ranker", 125000, 0) },
      { _T: "LogPlayerKillV2", _D: at(100), killer: person("enemy", "Enemy", 150000), victim: person(accountId, "Ranker", 125000, 0) },
      { _T: "LogPlayerPosition", _D: at(160), character: person(teammateId, "Ally", 130000, 100) },
      { _T: "LogPlayerCreate", _D: at(150), character: person(accountId, "Ranker", 130000) },
      { _T: "LogPlayerPosition", _D: at(160), character: person(accountId, "Ranker", 130000, 100) },
      { _T: "LogPlayerPosition", _D: at(170), character: person(accountId, "Ranker", 135000, 0) },
      { _T: "LogPlayerKillV2", _D: at(200), killer: person("enemy", "Enemy", 150000), victim: person(accountId, "Ranker", 135000, 0) },
      { _T: "LogPlayerPosition", _D: at(220), character: person(accountId, "Ranker", 140000, 0) },
      { _T: "LogMatchEnd", _D: at(350), characters: [{ character: { accountId, name: "Ranker", teamId: 11, ranking: 1 } }] },
    ];
    const match = { data: { id: "life-clock", attributes: { shardId: "steam", gameMode: "squad", matchType: "competitive",
      isCustomMatch: false, createdAt: at(0), mapName: "Desert_Main" } }, included: [
      { type: "participant", attributes: { stats: { playerId: accountId, name: "Ranker", winPlace: 1, kills: 0, damageDealt: 0 } } },
      { type: "participant", attributes: { stats: { playerId: teammateId, name: "Ally", winPlace: 1, kills: 0, damageDealt: 0 } } },
    ] };
    const evidence = buildDailyEvidence({ match, events, candidate: { accountId, nickname: "Ranker", rank: 1 }, dayKst: "2026-09-23" });
    const index = (type: string, seconds: number) => events.findIndex((event) => event._T === type && event._D === at(seconds));

    expect(evidence.route.map(({ timeSeconds }) => timeSeconds)).toEqual([60, 170]);
    expect(evidence.route[1].players).toEqual(expect.arrayContaining([expect.objectContaining({ name: "Ally" })]));
    expect(evidence.route.some(({ timeSeconds }) => timeSeconds === 220)).toBe(false);
    expect(evidence.facts).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: "player_death", victimId: accountId, victimTeamId: 11, timeSeconds: 100,
        sourceIndices: [index("LogPlayerKillV2", 100)] }),
      expect.objectContaining({ kind: "player_return", actorId: accountId, actorTeamId: 11, timeSeconds: 150,
        sourceIndices: [index("LogPlayerCreate", 150)] }),
      expect.objectContaining({ kind: "player_death", victimId: accountId, timeSeconds: 200,
        sourceIndices: [index("LogPlayerKillV2", 200)] }),
    ]));
    expect(evidence.zones).toHaveLength(1);
    expect(evidence.zones[0]).toMatchObject({ observedSeconds: 50, firstInsideSeconds: 60 });
    expect(evidence.zones[0].positions?.map(({ timeSeconds }) => timeSeconds)).toEqual([60, 90, 160, 170]);
    expect(evidence.blueZoneSamples?.at(-1)?.timeSeconds).toBe(340);
  });
});
