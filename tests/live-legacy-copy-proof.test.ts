import { describe, expect, it } from "vitest";
import { parseLegacyCopyTargets, proveLegacyCopy } from "../lib/pubg-analysis/liveLegacyCopyProof";

const matchId = "12345678-1234-4234-8234-123456789abc";
const keys: [string, string] = [`${matchId}_alice_v60_analyze.json`, `${matchId}_bob_v60_analyze.json`];
const records = ["alice", "bob"].map((name, i) => ({ player_id: name, match_id: matchId, platform: "steam", account_id: `account.${name}`,
  played_at: "2026-07-01T00:00:00Z", game_mode: "squad", map_name: "Baltic_Main", kills: i, damage: i * 100, win_place: 3, match_type: "official" }));
function proof(events: unknown[], overrides = {}) {
  const body = Buffer.from(JSON.stringify(events));
  return proveLegacyCopy({ target: { originalKeys: keys }, bodies: [body, body], records, referenced: false, activeLease: false, secret: "a".repeat(32), ...overrides });
}
describe("live legacy copy eligibility", () => {
  it("keeps equal bytes without a verified official match definition", () => {
    const result = proof([{ _T: "LogMatchStart", mapName: "Baltic_Main" }]);
    expect(result.equalBytes).toBe(true);
    expect(result.blockers).toContain("official-match-definition-missing-or-conflicting");
    expect(result.manifest).toBeUndefined();
  });
  it("rejects alias input outside the bounded legacy key scope", () => {
    expect(() => parseLegacyCopyTargets({ format: 1, pairs: [{ originalKeys: [keys[0], "backups/abc.json"] }] })).toThrow();
    expect(() => parseLegacyCopyTargets({ format: 1, pairs: Array(21).fill({ originalKeys: keys }) })).toThrow();
    expect(() => parseLegacyCopyTargets({ format: 1, pairs: [{ originalKeys: keys }, { originalKeys: keys }] })).toThrow();
    expect(parseLegacyCopyTargets({ format: 1, pairs: [{ originalKeys: keys }] })).toHaveLength(1);
  });
  it("blocks direct references, active leases, copied envelopes and changed body hashes", () => {
    expect(proof([], { referenced: true }).blockers).toContain("original-key-still-referenced");
    expect(proof([], { activeLease: true }).blockers).toContain("active-match-lease");
    const body = Buffer.from('{"projection":"full"}');
    expect(proof([], { bodies: [body, body] }).blockers).toContain("legacy-array-unproven");
    expect(proof([], { target: { originalKeys: keys, expectedSha256: "a".repeat(64) } }).blockers).toContain("prior-body-changed");
  });
  it("requires unique matching identities and both account-name bindings", () => {
    const events = [{ _T: "LogMatchDefinition", MatchId: `match.bro.official.pc-2018.steam.as.${matchId}` },
      { _T: "LogMatchStart", mapName: "Baltic_Main" },
      ...records.map(record => ({ _T: "LogPlayerPosition", character: { accountId: record.account_id, name: record.player_id } }))];
    expect(proof(events).manifest?.records).toEqual(records);
    expect(proof(events, { records: [...records, records[0]] }).manifest).toBeUndefined();
    expect(proof(events, { records: records.map(record => ({ ...record, account_id: "account.other" })) }).manifest).toBeUndefined();
    expect(proof(events, { now: Date.parse("2026-07-02T00:00:00Z") }).manifest).toBeUndefined();
  });
});
