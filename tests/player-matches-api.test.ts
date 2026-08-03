import { describe, it, expect } from "vitest";
import { GET } from "../app/api/pubg/player/matches/route";
import { buildBasicMatchSummary } from "../lib/pubg-analysis/matchSummary";
import { NextRequest } from "next/server";

describe("GET /api/pubg/player/matches route validation", () => {
  it("requires nickname and platform parameters", async () => {
    const req = new NextRequest("http://localhost/api/pubg/player/matches");
    const res = await GET(req);
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toContain("닉네임");
  });
});

describe("buildBasicMatchSummary helper", () => {
  it("constructs valid summary data from pubg_player_matches row", () => {
    const summary = buildBasicMatchSummary({
      match_id: "match-999",
      player_id: "testuser",
      platform: "steam",
      kills: 3,
      damage: 250,
      win_place: 2,
    });
    expect(summary.matchId).toBe("match-999");
    expect(summary.stats.kills).toBe(3);
    expect(summary.stats.winPlace).toBe(2);
  });
});
