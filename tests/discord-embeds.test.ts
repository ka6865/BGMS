import { describe, expect, it } from "vitest";
import {
  buildLinkSuccessEmbed,
  buildStatsEmbed,
  buildRecentMatchEmbed,
} from "@/lib/discord/embeds";

describe("discord embeds builder", () => {
  const appUrl = "https://bgms.kr";

  it("builds link success embed", () => {
    const payload = buildLinkSuccessEmbed({
      nickname: "KangHeeSung_",
      platform: "steam",
    });

    expect(payload.embeds[0].title).toContain("연동 완료");
    expect(payload.embeds[0].description).toContain("KangHeeSung_");
  });

  it("builds stats summary embed with web funnel link button", () => {
    const statsData = {
      nickname: "KangHeeSung_",
      platform: "steam",
      tier: "Diamond 2",
      rp: 2450,
      kda: "2.85",
      winRate: "18.5%",
      avgDamage: 320,
      matches: 20,
    };

    const payload = buildStatsEmbed(statsData, appUrl);
    expect(payload.embeds[0].title).toContain("KangHeeSung_");
    expect(payload.embeds[0].fields).toBeDefined();
    expect(payload.components[0].components[0].type).toBe(2); // Button
    expect(payload.components[0].components[0].url).toBe("https://bgms.kr/stats/steam/KangHeeSung_");
  });

  it("builds recent match summary embed with coaching link button", () => {
    const matchData = {
      nickname: "KangHeeSung_",
      platform: "steam",
      matchId: "match-uuid-1234",
      mapName: "에란겔",
      winPlace: 1,
      kills: 6,
      damage: 640,
      damageShare: "48%",
      backupLatency: "4.2s",
      duelWinRate: "100%",
    };

    const payload = buildRecentMatchEmbed(matchData, appUrl);
    expect(payload.embeds[0].title).toContain("#1위 · 에란겔");
    expect(payload.components[0].components[0].url).toBe(
      "https://bgms.kr/stats/steam/KangHeeSung_?matchId=match-uuid-1234",
    );
  });
});
