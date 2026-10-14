import { beforeEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";

const mocks = vi.hoisted(() => ({
  from: vi.fn(),
  resolve: vi.fn(),
  accountId: vi.fn(),
  private: vi.fn(),
  saveLink: vi.fn(),
}));
vi.mock("@supabase/supabase-js", () => ({ createClient: () => ({ from: mocks.from }) }));
vi.mock("@/lib/discord/userResolver", () => ({ resolvePlayerNickname: mocks.resolve }));
vi.mock("@/lib/pubg/privatePlayerIdentity", () => ({ resolvePrivatePlayerAccountId: mocks.accountId }));
vi.mock("@/lib/pubg/privatePlayers", () => ({ isPlayerPrivate: mocks.private }));
vi.mock("@/lib/discord/userLinkStore", () => ({ setDiscordUserLink: mocks.saveLink }));

import { handleStatsCommand } from "@/lib/discord/commands/stats";
import { handleRecentMatchCommand } from "@/lib/discord/commands/recentMatch";
import { handleLinkCommand } from "@/lib/discord/commands/link";

const appUrl = "https://bgms.kr";
const interaction = { data: { options: [{ name: "nickname", value: "Player" }] }, user: { id: "1486900099266248825" } };
const match = { match_id: "match-1234", map_name: "Baltic_Main", kills: 0, damage: 0, win_place: 8, played_at: "2026-10-14T01:00:00Z", created_at: "2026-10-15T01:00:00Z" };
const bucket = { roundsPlayed: 30, kills: 60, assists: 10, wins: 0, damageDealt: 9000, dBNOs: 0, deaths: 30 };

function query(data: unknown, error: unknown = null) {
  const result = { data, error };
  const chain: any = {
    select: vi.fn().mockReturnThis(), eq: vi.fn().mockReturnThis(),
    order: vi.fn().mockReturnThis(), limit: vi.fn().mockReturnThis(),
    maybeSingle: vi.fn().mockResolvedValue(result),
    then: (resolve: (value: unknown) => unknown) => Promise.resolve(result).then(resolve),
  };
  mocks.from.mockReturnValueOnce(chain);
  return chain;
}

beforeEach(() => {
  vi.resetAllMocks();
  mocks.resolve.mockResolvedValue({ nickname: "Player", platform: "steam" });
  mocks.accountId.mockResolvedValue("account.player");
  mocks.private.mockResolvedValue(false);
});

describe.each([
  ["전적", handleStatsCommand], ["방금판", handleRecentMatchCommand],
] as const)("/%s privacy", (_name, handler) => {
  it("does not read stats or emit a link for private players, including a renamed account", async () => {
    mocks.private.mockResolvedValue(true);
    const result = await handler(interaction, appUrl);
    expect(mocks.private).toHaveBeenCalledWith("steam", "Player", "account.player");
    expect(result.data).toEqual({ content: expect.stringContaining("비공개"), flags: 64 });
    expect(mocks.from).not.toHaveBeenCalled();
  });

  it.each(["identity", "privacy"])("fails closed when %s lookup fails", async (stage) => {
    (stage === "identity" ? mocks.accountId : mocks.private).mockRejectedValue(new Error("secret upstream error"));
    const result = await handler(interaction, appUrl);
    expect(result.data).toEqual({ content: expect.stringContaining("공개 범위를 확인하지 못했습니다"), flags: 64 });
    expect(mocks.from).not.toHaveBeenCalled();
    expect(JSON.stringify(result)).not.toContain("secret");
  });
});

describe("/방금판 saved records", () => {
  it("returns no record without inventing a match or falling back to an ID without stats", async () => {
    query(null);
    const result = await handleRecentMatchCommand(interaction, appUrl);
    expect(result.data).toEqual({ content: expect.stringContaining("저장된 경기 기록이 없습니다"), flags: 64 });
    expect(mocks.from).toHaveBeenCalledExactlyOnceWith("pubg_player_matches");
    expect(JSON.stringify(result)).not.toMatch(/에란겔|latest|0킬/);
  });

  it.each(["match", "telemetry"])("returns a safe failure for %s DB errors", async (stage) => {
    query(stage === "match" ? null : match, stage === "match" ? { message: "db secret" } : null);
    if (stage === "telemetry") query(null, { message: "db secret" });
    const result = await handleRecentMatchCommand(interaction, appUrl);
    expect(result.data).toEqual({ content: expect.stringContaining("조회하지 못했습니다"), flags: 64 });
    expect(JSON.stringify(result)).not.toContain("db secret");
  });

  it("handles a thrown DB transport failure", async () => {
    mocks.from.mockImplementation(() => { throw new Error("transport secret"); });
    expect((await handleRecentMatchCommand(interaction, appUrl)).data).toMatchObject({ content: expect.stringContaining("조회하지 못했습니다") });
  });

  it("shows saved basic stats and dates while leaving missing analysis unmeasured", async () => {
    const basic = query(match);
    const telemetry = query(null);
    const result = await handleRecentMatchCommand(interaction, appUrl);
    const payload = result.data as any;
    expect(payload.flags).toBe(0);
    expect(payload.embeds[0].title).toContain("#8위");
    expect(payload.embeds[0].fields).toContainEqual(expect.objectContaining({ name: "전투 성적", value: "0킬 / 딜량 0" }));
    expect(payload.embeds[0].fields).toContainEqual(expect.objectContaining({ name: "팀 딜량 비중", value: "미측정" }));
    expect(payload.embeds[0].fields).toContainEqual(expect.objectContaining({ name: "기록 저장 시각", value: expect.stringMatching(/^<t:/) }));
    expect(payload.components[0].components[0].url).toBe(`${appUrl}/stats/steam/Player/matches/match-1234`);
    expect(basic.eq.mock.calls).toEqual([["player_id", "player"], ["platform", "steam"]]);
    expect(telemetry.eq.mock.calls).toEqual([["match_id", "match-1234"], ["platform", "steam"], ["player_id", "player"]]);
  });

  it.each([0, null, -1])("distinguishes zero, unmeasured and invalid analysis values (%s)", async (value) => {
    query(match);
    query({ data: { fullResult: { stats: { name: "Player" }, player_id: "player", platform: "steam", teamImpact: { teamDamageShare: value }, tradeStats: { tradeLatencyMs: value }, duelStats: { duelWinRate: value } } } });
    const payload = (await handleRecentMatchCommand(interaction, appUrl)).data as any;
    expect(payload.embeds[0].fields).toContainEqual(expect.objectContaining({ name: "팀 딜량 비중", value: value === 0 ? "0%" : "미측정" }));
    expect(payload.embeds[0].fields).toContainEqual(expect.objectContaining({ name: "1:1 교전 승률", value: value === 0 ? "0%" : "미측정" }));
    expect(payload.embeds[0].fields).toContainEqual(expect.objectContaining({ name: "평균 복수 처치 시간", value: `${value === 0 ? "0.0초" : "미측정"}\n아군 기절 → 복수 처치` }));
  });

  it.each([[2 / 3 * 100, "66.7%"], [1 / 3 * 100, "33.3%"]])("rounds measured duel win rates to one decimal (%s)", async (duelWinRate, expected) => {
    query(match);
    query({ data: { fullResult: { stats: { name: "Player" }, duelStats: { duelWinRate } } } });
    const payload = (await handleRecentMatchCommand(interaction, appUrl)).data as any;
    expect(payload.embeds[0].fields).toContainEqual(expect.objectContaining({ name: "1:1 교전 승률", value: expected }));
  });

  it("does not show copied telemetry for another player", async () => {
    query(match);
    query({ data: { fullResult: { stats: { name: "OtherPlayer" }, teamImpact: { teamDamageShare: 99 } } } });
    const payload = (await handleRecentMatchCommand(interaction, appUrl)).data as any;
    expect(payload.embeds[0].fields).toContainEqual(expect.objectContaining({ name: "팀 딜량 비중", value: "미측정" }));
  });

  it.each(["latest", ".", ".."])("does not build a link for an invalid saved match ID (%s)", async (matchId) => {
    query({ ...match, match_id: matchId });
    expect((await handleRecentMatchCommand(interaction, appUrl)).data).toMatchObject({ content: expect.stringContaining("조회하지 못했습니다") });
    expect(mocks.from).toHaveBeenCalledTimes(1);
  });
});

describe("/전적 aggregation", () => {
  it("does not invent 20 matches for empty cache and history", async () => {
    query(null); query([]);
    expect((await handleStatsCommand(interaction, appUrl)).data).toEqual({ content: expect.stringContaining("기록이 없습니다"), flags: 64 });
  });

  it.each(["cache", "history"])("checks %s Supabase errors without exposing their messages", async (stage) => {
    query(null, stage === "cache" ? { message: "db secret" } : null);
    if (stage === "history") query([], { message: "db secret" });
    const result = await handleStatsCommand(interaction, appUrl);
    expect(result.data).toMatchObject({ content: expect.stringContaining("조회하지 못했습니다"), flags: 64 });
    expect(JSON.stringify(result)).not.toContain("db secret");
  });

  it("labels season normal stats without borrowing a competitive rank", async () => {
    query({ last_season_id: "season-42", season_stats_data: { "season-42": {
      normal: { squad: bucket }, ranked: { squad: { ...bucket, roundsPlayed: 10, currentTier: { tier: "Diamond", subTier: 2 }, currentRankPoint: 2450 } },
    } } });
    const payload = (await handleStatsCommand(interaction, appUrl)).data as any;
    expect(payload.flags).toBe(0);
    expect(payload.embeds[0].description).toContain("시즌 season-42 · 일반전 · SQUAD");
    expect(payload.embeds[0].fields).toContainEqual(expect.objectContaining({ name: "집계 판수", value: "30경기" }));
    expect(payload.embeds[0].fields).toContainEqual(expect.objectContaining({ name: "승률", value: "0.0%" }));
    expect(JSON.stringify(payload)).not.toMatch(/최근 20|Diamond|경쟁전 랭크/);
    expect(mocks.from).toHaveBeenCalledTimes(1);
  });

  it("keeps competitive rank, mode, season and stats together, including stale provenance", async () => {
    query({ last_season_id: "season-42", season_stats_data: { "season-42": {
      ranked: { duo: { ...bucket, currentTier: { tier: "Gold", subTier: 0 }, currentRankPoint: 0 } },
      statsAvailability: { ranked: { status: "stale", updatedAt: "2026-10-13T01:00:00Z" } },
    } } });
    const payload = (await handleStatsCommand(interaction, appUrl)).data as any;
    expect(payload.embeds[0].description).toContain("시즌 season-42 · 경쟁전 · DUO");
    expect(payload.embeds[0].description).toContain("이전 저장 통계");
    expect(payload.embeds[0].fields).toContainEqual(expect.objectContaining({ name: "경쟁전 랭크 (집계 모드)", value: "Gold 0 (0 RP)" }));
    expect(payload.embeds[0].fields).toContainEqual(expect.objectContaining({ name: "경쟁전 KDA", value: "2.33" }));
  });

  it("uses the actual season key when last_season_id is missing", async () => {
    query({ season_stats_data: { "season-41": { normal: { solo: bucket } } } });
    expect(((await handleStatsCommand(interaction, appUrl)).data as any).embeds[0].description).toContain("시즌 season-41 · 일반전 · SOLO");
  });

  it("does not invent a ratio when season death counts are unmeasured", async () => {
    query({ season_stats_data: { "season-42": { normal: { solo: { ...bucket, deaths: undefined } } } } });
    const payload = (await handleStatsCommand(interaction, appUrl)).data as any;
    expect(payload.embeds[0].fields).toContainEqual(expect.objectContaining({ name: "K/D", value: "—" }));
  });

  it("labels the limited saved history fallback separately with its real count and modes", async () => {
    query(null);
    const history = query([{ ...match, game_mode: "squad-fpp", match_type: "competitive" }, { ...match, game_mode: "solo", match_type: "official" }]);
    const payload = (await handleStatsCommand(interaction, appUrl)).data as any;
    expect(history.limit).toHaveBeenCalledWith(20);
    expect(payload.embeds[0].description).toContain("최근 저장 2경기(최대 20건)");
    expect(payload.embeds[0].description).toContain("squad-fpp, solo");
    expect(payload.embeds[0].description).toContain("competitive, official");
    expect(payload.embeds[0].fields).toContainEqual(expect.objectContaining({ name: "집계 판수", value: "2경기" }));
    expect(payload.embeds[0].fields).toContainEqual(expect.objectContaining({ name: "K/D", value: "0.00" }));
  });
});

describe("/연동 and registration", () => {
  it("allows linked identity confirmation to be public", async () => {
    mocks.saveLink.mockResolvedValue({ pubg_nickname: "Player", pubg_platform: "steam" });
    expect((await handleLinkCommand(interaction)).data).toMatchObject({ embeds: expect.any(Array), flags: 0 });
    expect(mocks.saveLink).toHaveBeenCalledWith(interaction.user.id, "Player", "steam");
  });

  it("does not expose a link storage error", async () => {
    mocks.saveLink.mockRejectedValue(new Error("service role secret"));
    const result = await handleLinkCommand(interaction);
    expect(result.data).toMatchObject({ content: expect.stringContaining("연동하지 못했습니다"), flags: 64 });
    expect(JSON.stringify(result)).not.toContain("secret");
  });

  it("declares only supported choices without executing registration", () => {
    const source = readFileSync(new URL("../scripts/register_discord_commands.ts", import.meta.url), "utf8");
    expect(source.match(/value: "steam"/g)).toHaveLength(3);
    expect(source.match(/value: "kakao"/g)).toHaveLength(3);
    expect(source).not.toMatch(/value: "(?:xbox|psn)"|최근 20경기 전적/);
  });
});
