import { describe, expect, it } from "vitest";
import { aggregateSquadFocusFire, type SquadFocusFireObservation, SquadFocusFireCollector } from "@/lib/pubg-analysis/squadFocusFire";
import { AnalysisEngine } from "@/lib/pubg-analysis/AnalysisEngine";
import { filterTelemetryEvents } from "@/lib/pubg-analysis/telemetryContract";
const team = new Set(["account.a", "account.b", "account.c"]);
const actor = (id: string, teamId = id === "account.enemy" ? 2 : 1) => ({ accountId: id, teamId, health: 100 });
const hit = (id = "account.a", victim = "account.enemy", extra = {}) => ({ _T: "LogPlayerTakeDamage", attacker: actor(id), victim: actor(victim), damageTypeCategory: "Damage_Gun", damage: 20, ...extra });
const life = (type: string, id: string) => ({ _T: type, victim: actor(id) });
function run(events: [Record<string, any>, number][], roster = team) {
  const collector = new SquadFocusFireCollector(roster, "squad");
  collector.observe({ _T: "LogMatchStart" }, 0);
  for (const [event, ts] of events) collector.observe(event, ts);
  collector.observe({ _T: "LogMatchEnd" }, 100_000);
  return collector.result();
}
describe("squad same-target gun focus fire", () => {
  it("counts each episode once regardless of bullets or additional teammates", () => {
    expect(run([[hit(), 1000], [hit(), 1000], [hit(), 1100], [hit("account.b"), 2000], [hit("account.c"), 3000]]))
      .toMatchObject({ status: "observed", numerator: 1, denominator: 1, rate: 100, calibration: "pending" });
  });
  it("uses an inclusive window anchored at the first hit, not a sliding chain", () => {
    expect(run([[hit(), 1000], [hit(), 5000], [hit("account.b"), 6000]])).toMatchObject({ numerator: 1, denominator: 1 });
    expect(run([[hit(), 1000], [hit(), 5000], [hit("account.b"), 6001]])).toMatchObject({ numerator: 0, denominator: 2, rate: 0 });
  });
  it("separates targets and preserves measured zero", () => {
    expect(run([[hit(), 1000], [hit("account.b", "account.other", { victim: actor("account.other", 3) }), 1100]]))
      .toMatchObject({ status: "observed", numerator: 0, denominator: 2, rate: 0 });
  });
  it("excludes finishers but includes a lethal hit before the knock event", () => {
    expect(run([[hit(), 1000], [hit("account.b", "account.enemy", { victim: { ...actor("account.enemy"), health: 0 } }), 1100], [life("LogPlayerMakeGroggy", "account.enemy"), 1100], [hit("account.c"), 1200]]))
      .toMatchObject({ numerator: 1, denominator: 1 });
    expect(run([[hit(), 1000], [life("LogPlayerMakeGroggy", "account.enemy"), 1100], [hit("account.b"), 1200]]))
      .toMatchObject({ numerator: 0, denominator: 1 });
  });
  it("starts a new episode after the enemy revives", () => {
    expect(run([[hit(), 1000], [life("LogPlayerMakeGroggy", "account.enemy"), 1100], [life("LogPlayerRevive", "account.enemy"), 1500], [hit("account.b"), 1600]]))
      .toMatchObject({ numerator: 0, denominator: 2 });
  });
  it("excludes bot teammates from participants and the ready-team requirement", () => {
    const botTeam = new Set(["account.a", "account.b", "ai.teammate"]);
    expect(run([[hit(), 1000], [hit("ai.teammate"), 1100]], botTeam))
      .toMatchObject({ status: "observed", numerator: 0, denominator: 1 });
    expect(run([[hit(), 1000], [hit("ai.teammate"), 1100]], new Set(["account.a", "ai.teammate"])))
      .toMatchObject({ status: "no_opportunity", denominator: 0, rate: null });
  });
  it("requires at least two ready teammates and excludes downed attackers", () => {
    expect(run([[life("LogPlayerMakeGroggy", "account.a"), 100], [hit("account.b"), 1000], [hit(), 1100]], new Set(["account.a", "account.b"])))
      .toMatchObject({ status: "no_opportunity", denominator: 0, rate: null });
  });
  it.each([
    hit("account.a", "account.b"), hit("account.a", "ai.bot", { victim: actor("ai.bot", 2) }),
    hit("account.a", "account.enemy", { damageTypeCategory: "Damage_DBNO" }),
    hit("account.a", "account.enemy", { damageTypeCategory: "Damage_Explosion_Grenade" }),
    hit("account.a", "account.enemy", { damage: 0 }),
  ])("does not treat excluded damage as an opportunity", (event) => {
    expect(run([[event, 1000]])).toMatchObject({ status: "no_opportunity", rate: null });
  });
  it("withholds incomplete, malformed and unordered data instead of partial totals", () => {
    expect(new SquadFocusFireCollector(team, "squad").result()).toMatchObject({ status: "missing", rate: null, denominator: null });
    expect(run([[hit(), 2000], [hit("account.b"), 1000]])).toMatchObject({ status: "missing", denominator: null });
    expect(run([[hit(), 1000], [hit("account.b", "account.enemy", { victim: { accountId: "account.enemy" } }), 1100]])).toMatchObject({ status: "missing", numerator: null });
  });
  it("normalizes the same mode spellings as canonical match eligibility", () => {
    const collector = new SquadFocusFireCollector(team, " SQUAD-FPP ");
    collector.observe({ _T: "LogMatchStart" }, 0);
    collector.observe(hit(), 1000);
    collector.observe({ _T: "LogMatchEnd" }, 2000);
    expect(collector.result()).toMatchObject({ status: "observed", denominator: 1, rate: 0 });
  });
  it("marks unsupported modes without assigning a score", () => {
    expect(new SquadFocusFireCollector(team, "solo").result().status).toBe("unsupported");
  });
});


describe("canonical squad focus-fire aggregation", () => {
  const row = (numerator: number, denominator: number): SquadFocusFireObservation => ({
    version: 1, windowMs: 5000, calibration: "pending", status: denominator ? "observed" : "no_opportunity",
    numerator, denominator, rate: denominator ? numerator / denominator * 100 : null, issues: [],
  });
  it("weights by actual episodes and does not count the same match twice", () => {
    expect(aggregateSquadFocusFire([
      { matchId: "a", observation: row(1, 1) }, { matchId: "b", observation: row(0, 9) },
      { matchId: "a", observation: row(1, 1) },
    ])).toMatchObject({ numerator: 1, denominator: 10, rate: 10, calibration: "pending" });
  });
  it("distinguishes old results, missing evidence, no opportunities and measured zero", () => {
    expect(aggregateSquadFocusFire([{ matchId: "a" }]).status).toBe("unsupported");
    expect(aggregateSquadFocusFire([{ matchId: "a" }, { matchId: "b", observation: row(1, 2) }]))
      .toMatchObject({ status: "missing", rate: null, denominator: null });
    expect(aggregateSquadFocusFire([{ matchId: "a", observation: row(0, 0) }]))
      .toMatchObject({ status: "no_opportunity", rate: null, denominator: 0 });
    expect(aggregateSquadFocusFire([{ matchId: "a", observation: row(0, 2) }]))
      .toMatchObject({ status: "observed", rate: 0, denominator: 2 });
  });
  it.each([{ windowMs: 3000 }, { version: 2 }, { rate: 99 }, { numerator: -1 }, { issues: ["incomplete"] }])("withholds incompatible observations %j", (override) => {
    expect(aggregateSquadFocusFire([{ matchId: "a", observation: { ...row(1, 2), ...override } }]).status).toBe("missing");
  });
  it("rejects conflicting duplicate and absent match identity", () => {
    expect(aggregateSquadFocusFire([{ matchId: "a", observation: row(1, 2) }, { matchId: "a", observation: row(2, 2) }]).status).toBe("missing");
    expect(aggregateSquadFocusFire([{ matchId: "", observation: row(1, 2) }]).status).toBe("missing");
  });
});


describe("analysis engine focus-fire observation contract", () => {
  it("retains observations through lite projection while leaving legacy cover unavailable", () => {
    const character = (id: string, teamId: number) => ({ ...actor(id, teamId), name: id, location: { x: 100, y: 100, z: 100 } });
    const telemetry = [
      { _T: "LogMatchStart", _D: "2026-09-01T00:00:00Z" },
      { ...hit(), attacker: character("account.a", 1), victim: character("account.enemy", 2), _D: "2026-09-01T00:00:01Z" },
      { ...hit("account.b"), attacker: character("account.b", 1), victim: character("account.enemy", 2), _D: "2026-09-01T00:00:02Z" },
      { _T: "LogMatchEnd", _D: "2026-09-01T00:00:30Z", characters: [] },
    ];
    const events = filterTelemetryEvents(telemetry, { mode: "lite", teamAccountIds: team, teamNames: team });
    const engine = new AnalysisEngine("account.a", "account.a", team, team, new Set(), new Set(), "roster");
    const result = engine.run(events, { id: "match-a", gameMode: "squad" }, [], [], { damageDealt: 20, kills: 0 }, [], {});
    expect(result.squadFocusFire).toMatchObject({ status: "observed", numerator: 1, denominator: 1, rate: 100, calibration: "pending" });
    expect(result.tradeStats.coverRate).toBeNull();
    expect(result.tradeStats.coverRateSampleCount).toBe(0);
  });
});
