import { describe, it, expect } from "vitest";
import { proveLegacyAccountBinding, buildLegacyAccountBindingSql } from "../lib/pubg-analysis/legacyAccountBinding";
import { readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";

function fixture() {
  const before = { match_id: "00000000-0000-0000-0000-000000000001", platform: "steam", player_id: "binding_player",
    account_id: null, played_at: "2026-08-01T00:00:00+00:00", kills: 2, damage: 123, win_place: 5,
    map_name: "Baltic_Main", game_mode: "squad-fpp" };
  const result = { matchId: before.match_id, platform: "steam", player_id: before.player_id, createdAt: before.played_at,
    gameMode: before.game_mode, mapName: "에란겔", stats: { name: "Binding_Player", playerId: "account.synthetic",
      kills: 2, damageDealt: 123.7, winPlace: 5 } };
  const processed = { match_id: before.match_id, platform: "steam", player_id: before.player_id, data: { fullResult: result } };
  return { before, result, processed };
}

describe("legacy account binding evidence", () => {
  it("matches official map code to the established display name and preserves the snapshot", () => {
    const { before, processed } = fixture();
    const proof = proveLegacyAccountBinding(before, [processed], [before]);
    expect(proof.accountId).toBe("account.synthetic");
    expect(proof.before).toEqual(before);
    expect(before.account_id).toBeNull();
  });
  it.each(["matchId", "platform", "player_id", "createdAt", "gameMode", "mapName"])("rejects conflicting %s", field => {
    const { before, result, processed } = fixture();
    (result as any)[field] = "conflicting";
    expect(() => proveLegacyAccountBinding(before, [processed], [before])).toThrow("evidence-conflict");
  });
  it.each(["kills", "damageDealt", "winPlace"])("rejects conflicting official %s", field => {
    const { before, result, processed } = fixture();
    (result.stats as any)[field] = 99;
    expect(() => proveLegacyAccountBinding(before, [processed], [before])).toThrow("evidence-conflict");
  });
  it("rejects a contradictory secondary date and account", () => {
    const { before, result, processed } = fixture();
    (result as any).matchInfo = { date: "2026-08-02T00:00:00Z" };
    expect(() => proveLegacyAccountBinding(before, [processed], [before])).toThrow();
    delete (result as any).matchInfo;
    (result as any).accountId = "account.other";
    expect(() => proveLegacyAccountBinding(before, [processed], [before])).toThrow();
  });
  it("rejects ambiguous rows and an account linked to a different nickname in the match", () => {
    const { before, processed } = fixture();
    expect(() => proveLegacyAccountBinding(before, [processed, processed], [before])).toThrow();
    expect(() => proveLegacyAccountBinding(before, [processed], [before, { ...before, player_id: "other", account_id: "account.synthetic" }])).toThrow();
  });
  it("rejects overwriting a bound row or changing the proven account in SQL preparation", () => {
    const { before, processed } = fixture();
    expect(() => proveLegacyAccountBinding({ ...before, account_id: "account.synthetic" }, [processed], [before])).toThrow();
    const proof = proveLegacyAccountBinding(before, [processed], [before]);
    expect(() => buildLegacyAccountBindingSql([{ ...proof, accountId: "account.other" }])).toThrow();
  });
  it("rejects duplicate plan identities", () => {
    const { before, processed } = fixture();
    const proof = proveLegacyAccountBinding(before, [processed], [before]);
    expect(() => buildLegacyAccountBindingSql([proof, proof])).toThrow("scope-invalid");
  });
  it("requires the official stats.playerId and rejects normalized invalid dates", () => {
    const { before, result, processed } = fixture();
    delete (result.stats as any).playerId;
    (result as any).accountId = "account.synthetic";
    expect(() => proveLegacyAccountBinding(before, [processed], [before])).toThrow();
    result.stats.playerId = "account.synthetic";
    before.played_at = result.createdAt = "2026-02-30T00:00:00Z";
    expect(() => proveLegacyAccountBinding(before, [processed], [before])).toThrow();
  });
  it("escapes cache text and chooses an outer SQL delimiter absent from the snapshots", () => {
    const { before, processed } = fixture();
    (processed.data as any).note = "$bgms_binding$'\\; untrusted";
    const sql = buildLegacyAccountBindingSql([proveLegacyAccountBinding(before, [processed], [before])]);
    expect(sql.startsWith("DO $bgms_binding_1$")).toBe(true);
    expect(sql).toContain("E'");
  });
  it("keeps the SQL run in CI identical to the generated real repair statements", () => {
    const actual = execFileSync(process.execPath, ["--import", "tsx", "scripts/verify_legacy_account_binding_sql.ts"], { encoding: "utf8" });
    expect(actual).toBe(readFileSync("tests/fixtures/migration-check/legacy_account_binding_checks.sql", "utf8"));
  });
});
