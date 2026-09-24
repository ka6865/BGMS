import { existsSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { buildDailyEvidence } from "@/lib/learn/dailyEvidence";

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
    wrongMode.data.attributes.gameMode = "duo";
    expect(() => buildDailyEvidence({ ...input, match: wrongMode })).toThrow(/solo\/squad/);
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
