import { beforeEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";

const mocks = vi.hoisted(() => ({
  from: vi.fn(),
  identity: vi.fn(),
  cachedAccountId: vi.fn(),
  private: vi.fn(),
  privateList: vi.fn(),
  getLink: vi.fn(),
  stats: vi.fn(),
}));
vi.mock("@supabase/supabase-js", () => ({ createClient: () => ({ from: mocks.from }) }));
vi.mock("@/lib/pubg/privatePlayerIdentity", () => ({ resolvePubgPlayerIdentity: mocks.identity }));
vi.mock("@/lib/pubg/privatePlayerCache", () => ({ resolveCachedPlayerAccountId: mocks.cachedAccountId }));
vi.mock("@/lib/pubg/privatePlayers", async () => {
  const actual = await vi.importActual<typeof import("@/lib/pubg/privatePlayers")>("@/lib/pubg/privatePlayers");
  return { isPlayerPrivate: mocks.private, getPrivatePlayersList: mocks.privateList, matchesPrivatePlayer: actual.matchesPrivatePlayer };
});
vi.mock("@/lib/discord/userLinkStore", () => ({ getDiscordUserLink: mocks.getLink }));
vi.mock("@/lib/discord/commands/stats", () => ({ handleStatsCommand: mocks.stats }));

import { handleNicknameAutocomplete } from "@/lib/discord/commands/autocomplete";
import { handleCompareCommand } from "@/lib/discord/commands/compare";
import { handleUserStatsCommand } from "@/lib/discord/commands/userStats";
import { clearDiscordPlayerIdentityCache } from "@/lib/discord/playerIdentity";
import { parseNicknameOption } from "@/lib/discord/nicknameOption";

const appUrl = "https://bgms.kr";
const bucket = { roundsPlayed: 40, kills: 80, assists: 20, wins: 4, damageDealt: 12000, dBNOs: 0, deaths: 36 };

function query(data: unknown, error: unknown = null) {
  const result = { data, error };
  const chain: any = {
    select: vi.fn().mockReturnThis(), eq: vi.fn().mockReturnThis(), like: vi.fn().mockReturnThis(),
    abortSignal: vi.fn().mockReturnThis(), limit: vi.fn().mockReturnThis(),
    maybeSingle: vi.fn().mockResolvedValue(result),
    then: (resolve: (value: unknown) => unknown, reject?: (reason: unknown) => unknown) => Promise.resolve(result).then(resolve, reject),
  };
  mocks.from.mockReturnValueOnce(chain);
  return chain;
}

function autocomplete(options: unknown[]) {
  return handleNicknameAutocomplete({ type: 4, data: { name: "전적", options } });
}

function compare(options: unknown[]) {
  return handleCompareCommand({ data: { name: "비교", options } }, appUrl);
}

beforeEach(() => {
  vi.resetAllMocks();
  clearDiscordPlayerIdentityCache();
  mocks.private.mockResolvedValue(false);
  mocks.cachedAccountId.mockResolvedValue("account.cached");
  mocks.privateList.mockResolvedValue([]);
});

describe("nickname option parsing", () => {
  it.each([
    ["steam:Player_1", { nickname: "Player_1", platform: "steam" }],
    ["kakao:카카오닉", { nickname: "카카오닉", platform: "kakao" }],
    [" Player ", { nickname: "Player", platform: null }],
    ["xbox:Player", { nickname: "xbox:Player", platform: null }],
    [undefined, { nickname: "", platform: null }],
  ])("parses %s", (value, expected) => {
    expect(parseNicknameOption(value)).toEqual(expected);
  });
});

describe("nickname autocomplete", () => {
  it("suggests cached players with their platform encoded in the value", async () => {
    const lookup = query([
      { id: "account.a", nickname: "Player_A", platform: "steam" },
      { id: "account.b", nickname: "PlayerB", platform: "kakao" },
    ]);
    const response = await autocomplete([{ name: "nickname", value: "pla", focused: true }]);
    expect(response).toEqual({ type: 8, data: { choices: [
      { name: "Player_A (STEAM)", value: "steam:Player_A" },
      { name: "PlayerB (KAKAO)", value: "kakao:PlayerB" },
    ] } });
    expect(lookup.like).toHaveBeenCalledWith("lower_nickname", "pla%");
    expect(lookup.eq).not.toHaveBeenCalled();
    expect(mocks.identity).not.toHaveBeenCalled();
  });

  it("escapes LIKE wildcards and narrows to an explicit platform", async () => {
    const lookup = query([]);
    await autocomplete([{ name: "platform", value: "kakao" }, { name: "nickname", value: "a_b%", focused: true }]);
    expect(lookup.like).toHaveBeenCalledWith("lower_nickname", "a\\_b\\%%");
    expect(lookup.eq).toHaveBeenCalledWith("platform", "kakao");
  });

  it("hides private players by nickname or account id", async () => {
    mocks.privateList.mockResolvedValue([
      { platform: "steam", nickname: "Hidden", lower_nickname: "hidden", created_at: "" },
      { platform: "all", nickname: "Old", lower_nickname: "old", account_id: "account.renamed", created_at: "" },
    ]);
    query([
      { id: "account.h", nickname: "Hidden", platform: "steam" },
      { id: "account.renamed", nickname: "NewName", platform: "kakao" },
      { id: "account.v", nickname: "Visible", platform: "steam" },
    ]);
    const response = await autocomplete([{ name: "nickname", value: "xx", focused: true }]);
    expect(response.data.choices).toEqual([{ name: "Visible (STEAM)", value: "steam:Visible" }]);
  });

  it.each(["", "a"])("does not query for short input %j", async (value) => {
    expect(await autocomplete([{ name: "nickname", value, focused: true }])).toEqual({ type: 8, data: { choices: [] } });
    expect(mocks.from).not.toHaveBeenCalled();
  });

  it("returns no choices when the private registry or cache lookup fails", async () => {
    query([{ id: "account.v", nickname: "Visible", platform: "steam" }]);
    mocks.privateList.mockRejectedValue(new Error("registry secret"));
    expect(await autocomplete([{ name: "nickname", value: "vis", focused: true }])).toEqual({ type: 8, data: { choices: [] } });
    query(null, { message: "db secret" });
    mocks.privateList.mockResolvedValue([]);
    expect(await autocomplete([{ name: "nickname", value: "vis", focused: true }])).toEqual({ type: 8, data: { choices: [] } });
  });

  it("ignores non-nickname focused options", async () => {
    expect(await autocomplete([{ name: "platform", value: "st", focused: true }])).toEqual({ type: 8, data: { choices: [] } });
    expect(mocks.from).not.toHaveBeenCalled();
  });
});

describe("/비교", () => {
  const season = (normal: unknown, extra: Record<string, unknown> = {}) => ({
    nickname: "Cached", last_season_id: "division.bro.official.pc-2018-36",
    season_stats_data: { "division.bro.official.pc-2018-36": { normal, ...extra } }, updated_at: "2026-10-14T00:00:00Z",
  });

  it("compares the same queue and mode, publicly, with links to both stats pages", async () => {
    query({ ...season({ squad: bucket }), nickname: "Alpha_1" });
    query({ ...season({ squad: { ...bucket, kills: 40, wins: 8, damageDealt: 8000 }, duo: { ...bucket, roundsPlayed: 500 } }), nickname: "Bravo" });
    const result = await compare([{ name: "nickname1", value: "steam:alpha_1" }, { name: "nickname2", value: "kakao:bravo" }]);
    const data = result.data as any;
    expect(data.flags).toBe(0);
    expect(data.embeds[0].title).toBe("⚔️ Alpha\\_1 vs Bravo");
    expect(data.embeds[0].description).toContain("시즌 36 · 일반전 · SQUAD 시즌 누적 비교");
    expect(data.embeds[0].fields).toContainEqual({ name: "K/D", value: "🔵 **2.22**\n🔴 1.11", inline: true });
    expect(data.embeds[0].fields).toContainEqual({ name: "승률", value: "🔵 10.0%\n🔴 **20.0%**", inline: true });
    expect(data.embeds[0].fields).toContainEqual({ name: "판수", value: "🔵 40경기\n🔴 40경기", inline: true });
    expect(data.components[0].components.map((button: any) => button.url)).toEqual([
      "https://bgms.kr/stats/steam/Alpha_1",
      "https://bgms.kr/stats/kakao/Bravo",
    ]);
    expect(mocks.identity).not.toHaveBeenCalled();
  });

  it("uses ranked KDA and ranks when requested", async () => {
    const rankedBucket = { ...bucket, currentTier: { tier: "Gold", subTier: 2 }, currentRankPoint: 2100 };
    query({ ...season(null, { ranked: { duo: rankedBucket } }) });
    query({ ...season(null, { ranked: { duo: { ...rankedBucket, currentTier: undefined } } }) });
    const result = await compare([
      { name: "nickname1", value: "A" }, { name: "nickname2", value: "B" },
      { name: "mode", value: "duo" }, { name: "type", value: "ranked" },
    ]);
    const fields = (result.data as any).embeds[0].fields;
    expect(fields).toContainEqual({ name: "KDA", value: "🔵 2.78\n🔴 2.78", inline: true });
    expect(fields).toContainEqual({ name: "경쟁전 랭크", value: "🔵 Gold 2 (2100 RP)\n🔴 미확인", inline: true });
  });

  it("marks a player without records and keeps the comparison public when the other has records", async () => {
    query(season({ squad: bucket }));
    query(null);
    const data = (await compare([{ name: "nickname1", value: "A" }, { name: "nickname2", value: "Nobody" }])).data as any;
    expect(data.flags).toBe(0);
    expect(data.embeds[0].fields[0].value).toBe("🔵 40경기\n🔴 기록 없음");
    expect(data.embeds[0].description).toContain("웹 전적 페이지에서 갱신");
    expect(data.components[0].components[1].url).toBe("https://bgms.kr/stats/steam/Nobody");
  });

  it("answers privately when neither player has records", async () => {
    query(null); query(null);
    expect(((await compare([{ name: "nickname1", value: "A" }, { name: "nickname2", value: "B" }])).data as any).flags).toBe(64);
  });

  it("refuses to compare when either player is private without reading stats", async () => {
    mocks.private.mockImplementation(async (_platform: string, nickname: string) => nickname === "Hidden");
    const result = await compare([{ name: "nickname1", value: "A" }, { name: "nickname2", value: "Hidden" }]);
    expect(result.data).toEqual({ content: expect.stringContaining("비공개 플레이어가 포함"), flags: 64 });
    expect(mocks.from).not.toHaveBeenCalled();
  });

  it("fails closed when a privacy lookup fails", async () => {
    mocks.private.mockRejectedValue(new Error("registry secret"));
    const result = await compare([{ name: "nickname1", value: "A" }, { name: "nickname2", value: "B" }]);
    expect(result.data).toEqual({ content: expect.stringContaining("공개 범위를 확인하지 못했습니다"), flags: 64 });
  });

  it("rejects comparing a player with themselves", async () => {
    const result = await compare([{ name: "nickname1", value: "steam:Player" }, { name: "nickname2", value: "player" }]);
    expect(result.data).toEqual({ content: "서로 다른 두 플레이어를 입력해 주세요.", flags: 64 });
  });

  it("lets the platform option override autocomplete prefixes", async () => {
    const first = query(null);
    query(season({ squad: bucket }));
    await compare([{ name: "nickname1", value: "kakao:A" }, { name: "nickname2", value: "B" }, { name: "platform", value: "steam" }]);
    expect(first.eq).toHaveBeenCalledWith("platform", "steam");
  });

  it("hides database errors", async () => {
    query(null, { message: "db secret" });
    query(null);
    const result = await compare([{ name: "nickname1", value: "A" }, { name: "nickname2", value: "B" }]);
    expect(result.data).toEqual({ content: expect.stringContaining("조회하지 못했습니다"), flags: 64 });
    expect(JSON.stringify(result)).not.toContain("secret");
  });
});

describe("user context menu stats", () => {
  const menu = (targetId: unknown = "1486900099266248826") => handleUserStatsCommand(
    { type: 2, user: { id: "1486900099266248825" }, data: { type: 2, name: "전적 보기", target_id: targetId } },
    appUrl,
  );

  it("looks up only the target's linked account", async () => {
    mocks.getLink.mockResolvedValue({ pubg_nickname: "Linked", pubg_platform: "kakao" });
    mocks.stats.mockResolvedValue({ type: 4, data: { embeds: [], flags: 0 } });
    await menu();
    expect(mocks.getLink).toHaveBeenCalledWith("1486900099266248826");
    expect(mocks.stats.mock.calls[0][0].data.options).toEqual([
      { name: "nickname", value: "Linked" },
      { name: "platform", value: "kakao" },
    ]);
  });

  it("does not guess an account for an unlinked target", async () => {
    mocks.getLink.mockResolvedValue(null);
    expect((await menu()).data).toEqual({ content: expect.stringContaining("연동하지 않았습니다"), flags: 64 });
    expect(mocks.stats).not.toHaveBeenCalled();
  });

  it.each([null, "not-a-snowflake"])("rejects an invalid target %s", async (target) => {
    expect((await menu(target)).data).toMatchObject({ flags: 64 });
    expect(mocks.getLink).not.toHaveBeenCalled();
  });

  it("hides link lookup errors", async () => {
    mocks.getLink.mockRejectedValue(new Error("db secret"));
    const result = await menu();
    expect(result.data).toEqual({ content: expect.stringContaining("연동 정보를 확인하지 못했습니다"), flags: 64 });
  });
});

describe("command registration", () => {
  const source = readFileSync(new URL("../scripts/register_discord_commands.ts", import.meta.url), "utf8");

  it("enables autocomplete on every nickname option and registers the new commands", () => {
    expect(source.match(/autocomplete: true/g)).toHaveLength(5);
    expect(source).toContain('name: "비교"');
    expect(source).toMatch(/name: "전적 보기",\s*type: 2,/);
  });
});
