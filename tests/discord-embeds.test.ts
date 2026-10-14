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
      scope: "시즌 season-42 · 경쟁전 · SQUAD 누적 통계",
      ranked: true,
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
      tradeLatency: "4.2초",
      duelWinRate: "100%",
    };

    const payload = buildRecentMatchEmbed(matchData, appUrl);
    expect(payload.embeds[0].title).toContain("#1위 · 에란겔");
    expect(payload.components[0].components[0].url).toBe(
      "https://bgms.kr/stats/steam/KangHeeSung_/matches/match-uuid-1234",
    );
  });

  it("shows the supplied aggregation scope without inventing recent 20 matches or a rank", () => {
    const payload = buildStatsEmbed({ nickname: "Player", platform: "kakao", scope: "시즌 season-42 · 일반전 · SOLO", ranked: false, matches: 0 }, appUrl);
    expect(payload.embeds[0].description).toContain("일반전 · SOLO");
    expect(payload.embeds[0].fields).toContainEqual(expect.objectContaining({ name: "집계 판수", value: "0경기" }));
    expect(JSON.stringify(payload)).not.toMatch(/최근 20|언랭크|현재 랭크/);
  });

  it("distinguishes measured zero from missing metrics and names revenge latency accurately", () => {
    const payload = buildRecentMatchEmbed({ nickname: "한 글", platform: "kakao", matchId: "valid.id-1", damageShare: "0%", duelWinRate: null, tradeLatency: "0.0초", playedAt: "2026-10-14T01:00:00Z" }, `${appUrl}/`);
    expect(payload.embeds[0].fields).toContainEqual(expect.objectContaining({ name: "팀 딜량 비중", value: "0%" }));
    expect(payload.embeds[0].fields).toContainEqual(expect.objectContaining({ name: "1:1 교전 승률", value: "미측정" }));
    expect(payload.embeds[0].fields).toContainEqual(expect.objectContaining({ name: "평균 복수 처치 시간", value: "0.0초\n아군 기절 → 복수 처치" }));
    expect(payload.embeds[0].fields).toContainEqual(expect.objectContaining({ name: "경기 시각", value: expect.stringMatching(/^<t:\d+:f>$/) }));
    expect(payload.embeds[0].fields).toContainEqual(expect.objectContaining({ name: "기록 저장 시각", value: "미확인" }));
    expect(payload.embeds[0].description).not.toContain("준비되어 있습니다");
    expect(payload.components[0].components[0].url).toBe(`${appUrl}/stats/kakao/${encodeURIComponent("한 글")}/matches/valid.id-1`);
  });

  it.each(["", "latest", ".", "..", "../other", "match/id", "id?secret", "a".repeat(129)])("rejects invalid or placeholder match id %s", (matchId) => {
    expect(() => buildRecentMatchEmbed({ nickname: "Player", platform: "steam", matchId }, appUrl)).toThrow("invalid_match_id");
  });
});
