import { describe, expect, it } from "vitest";
import {
  calculatePerformance,
  preparePerformanceMatch,
  type PerformanceJob,
} from "../lib/pubg/performanceCalculation";
import { ANALYSIS_CALCULATION_VERSION, RESULT_VERSION } from "../lib/pubg-analysis/constants";

const job: PerformanceJob = {
  platform: "steam",
  account_id: "account.target",
  match_id: "performance-match",
  player_id: "target",
  calculation_version: ANALYSIS_CALCULATION_VERSION,
  result_version: RESULT_VERSION,
  lease_token: "00000000-0000-0000-0000-000000000000",
};

function matchFixture() {
  return {
    data: {
      id: job.match_id,
      attributes: {
        createdAt: "2026-09-12T00:00:00.000Z",
        gameMode: "squad",
        matchType: "official",
        mapName: "Baltic_Main",
      },
    },
    included: [
      { type: "participant", id: "p-target", attributes: { stats: { playerId: "account.target", name: "Target", damageDealt: 100 } } },
      { type: "participant", id: "p-alpha", attributes: { stats: { playerId: "account.alpha", name: "Alpha", damageDealt: 200 } } },
      { type: "participant", id: "p-npc", attributes: { stats: { playerId: "npc.target", name: "NPC", damageDealt: 50 } } },
      { type: "participant", id: "p-bot", attributes: { stats: { playerId: "ai.bot", name: "Bot", damageDealt: 9999 } } },
      { type: "roster", id: "r-target", relationships: { participants: { data: [{ id: "p-target" }] } } },
    ],
  };
}

describe("PUBG performance calculation boundaries", () => {
  it("uses the same benchmark lookup population as the detailed match route", () => {
    const prepared = preparePerformanceMatch(job, matchFixture());
    expect(prepared.tier).toBe("C");
    expect(prepared.members).toHaveLength(1);
    expect(prepared.stats.playerId).toBe(job.account_id);
  });

  it("matches route percentile for bot-shaped records and damage ties", () => {
    const fixture = matchFixture();
    (fixture.included[0] as any).attributes.stats.damageDealt = 200;
    const participants = fixture.included.filter(p => p.type === "participant") as any[];
    const human = participants.filter(p => !p.attributes.accountId?.startsWith("ai."));
    const sorted = [...human].map(p => p.attributes.stats).sort((a, b) => b.damageDealt - a.damageDealt);
    const percentile = (sorted.findIndex(p => p.name.toLowerCase() === job.player_id) + 1) / human.length;
    const expected = percentile <= 0.1 ? "S" : percentile <= 0.3 ? "A" : percentile <= 0.6 ? "B" : "C";
    expect(preparePerformanceMatch(job, fixture).tier).toBe(expected);
  });

  it("fails closed for malformed job identity and copied player rows", () => {
    expect(() => preparePerformanceMatch({ ...job, account_id: "target" }, matchFixture())).toThrow("account_identity_invalid");
    expect(() => preparePerformanceMatch({ ...job, player_id: "Target" }, matchFixture())).toThrow("job_identity_invalid");
    const copied = matchFixture();
    (copied.included[0] as any).attributes.stats.name = "Other";
    expect(() => preparePerformanceMatch(job, copied)).toThrow("player_identity_invalid");
  });

  it("rejects stale calculation versions and telemetry without an exact official identity", () => {
    expect(() => calculatePerformance({ ...job, calculation_version: ANALYSIS_CALCULATION_VERSION - 1 }, matchFixture(), [], { sampleCount: 0 }))
      .toThrow("version_changed");
    const definition = { _T: "LogMatchDefinition", MatchId: `match.steam.official.${job.match_id}` };
    expect(() => calculatePerformance(job, matchFixture(), [definition, { _T: "LogMatchStart" }, { _T: "LogMatchEnd" }], { sampleCount: 0 }))
      .toThrow("telemetry_identity_incomplete");
  });
});
