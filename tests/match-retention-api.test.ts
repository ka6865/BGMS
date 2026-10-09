import { describe, expect, it, vi } from "vitest";
import {
  canonicalMatchPlayedAt,
  expiredMatchDetailResponse,
  getMatchDetailPresignTtlSeconds,
  isMatchDetailExpired,
  lookupMatchPlayedAt,
  resolveTrustedMatchPlayedAt,
  unavailableMatchDetailResponse,
} from "../lib/pubg-analysis/matchRetention.server";
import { getMatchDetailRetention, MATCH_DETAIL_RETENTION_DAYS } from "../lib/pubg-analysis/matchRetention";

vi.mock("server-only", () => ({}));

const NOW = Date.parse("2026-10-06T12:00:00.000Z");

describe("match detail retention API contract", () => {
  it("expires at the exact 14-day boundary and leaves unknown dates undecided", () => {
    const playedAt = new Date(NOW - MATCH_DETAIL_RETENTION_DAYS * 86_400_000).toISOString();
    expect(getMatchDetailRetention(playedAt, NOW)).toEqual({ status: "expired", expiresAt: new Date(NOW).toISOString() });
    expect(getMatchDetailRetention("invalid-date", NOW)).toEqual({ status: "unknown", expiresAt: null });
    expect(isMatchDetailExpired("invalid-date", NOW)).toBe(false);
    expect(getMatchDetailPresignTtlSeconds(new Date(NOW - MATCH_DETAIL_RETENTION_DAYS * 86_400_000 + 400_000).toISOString(), NOW)).toBe(400);
    expect(getMatchDetailPresignTtlSeconds(new Date(NOW - MATCH_DETAIL_RETENTION_DAYS * 86_400_000 - 1).toISOString(), NOW)).toBeNull();
  });

  it("reads only the requested player, platform, and match history date", async () => {
    const query: any = {};
    for (const method of ["select", "eq"]) query[method] = vi.fn(() => query);
    query.maybeSingle = vi.fn().mockResolvedValue({ data: { played_at: "2026-10-01T00:00:00Z" }, error: null });
    const db = { from: vi.fn(() => query) };

    await expect(lookupMatchPlayedAt(db, {
      matchId: "match-a", platform: "steam", playerId: "player-a",
    })).resolves.toBe("2026-10-01T00:00:00Z");
    expect(db.from).toHaveBeenCalledWith("pubg_player_matches");
    expect(query.select).toHaveBeenCalledWith("played_at");
    expect(query.eq.mock.calls).toEqual([
      ["match_id", "match-a"], ["platform", "steam"], ["player_id", "player-a"],
    ]);
    query.maybeSingle.mockResolvedValue({ data: { played_at: "2027-10-01T00:00:00Z" }, error: null });
    await expect(lookupMatchPlayedAt(db, {
      matchId: "match-a", platform: "steam", playerId: "player-a",
    })).resolves.toBeNull();
  });

  it("uses only canonical result dates and does not trust a top-level request date", () => {
    expect(canonicalMatchPlayedAt({ createdAt: "1999-01-01T00:00:00Z", matchInfo: { date: "2026-10-02T00:00:00Z" } }))
      .toBe("2026-10-02T00:00:00Z");
    expect(canonicalMatchPlayedAt({ date: "1999-01-01T00:00:00Z" })).toBeNull();
    expect(resolveTrustedMatchPlayedAt("2027-01-01T00:00:00Z", "2026-09-01T00:00:00Z", NOW)).toBe("2026-09-01T00:00:00Z");
    expect(resolveTrustedMatchPlayedAt("2026-09-20T00:00:00Z", "2026-09-01T00:00:00Z", NOW)).toBe("2026-09-01T00:00:00Z");
  });

  it("returns distinct no-store responses for expired details and missing R2 files", async () => {
    const expired = expiredMatchDetailResponse("2026-09-01T00:00:00Z", NOW);
    expect(expired.status).toBe(410);
    expect(expired.headers.get("cache-control")).toBe("no-store");
    expect(await expired.json()).toEqual(expect.objectContaining({
      errorCode: "PUBG_MATCH_DETAIL_EXPIRED", retryable: false,
    }));

    const unavailable = unavailableMatchDetailResponse();
    expect(unavailable.status).toBe(404);
    expect(unavailable.headers.get("cache-control")).toBe("no-store");
    expect(await unavailable.json()).toEqual(expect.objectContaining({
      errorCode: "PUBG_MATCH_DETAIL_UNAVAILABLE", retryable: false,
    }));
  });
});
