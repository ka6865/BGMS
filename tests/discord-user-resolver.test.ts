import { describe, expect, it, vi } from "vitest";
import { resolvePlayerNickname } from "@/lib/discord/userResolver";

describe("discord player nickname resolver", () => {
  it("resolves explicit nickname argument first (priority 1)", async () => {
    const result = await resolvePlayerNickname({
      explicitNickname: "ProGamer_1",
      explicitPlatform: "kakao",
      discordUserId: "user_123",
      guildNickname: "DiscordGuildNick",
      discordUsername: "DiscordGlobalUser",
    });

    expect(result).toEqual({
      nickname: "ProGamer_1",
      platform: "kakao",
      source: "explicit",
    });
  });

  it("resolves database linked nickname second (priority 2)", async () => {
    const mockLinkStore = vi.fn().mockResolvedValue({
      discord_user_id: "user_123",
      pubg_nickname: "LinkedPlayer",
      pubg_platform: "steam",
    });

    const result = await resolvePlayerNickname({
      discordUserId: "user_123",
      guildNickname: "DiscordGuildNick",
      discordUsername: "DiscordGlobalUser",
      getLinkFn: mockLinkStore as any,
    });

    expect(result).toEqual({
      nickname: "LinkedPlayer",
      platform: "steam",
      source: "link",
    });
    expect(mockLinkStore).toHaveBeenCalledWith("user_123");
  });

  it("resolves discord guild nickname third (priority 3)", async () => {
    const mockLinkStore = vi.fn().mockResolvedValue(null);

    const result = await resolvePlayerNickname({
      discordUserId: "user_123",
      guildNickname: "ServerNickname",
      discordUsername: "GlobalUsername",
      getLinkFn: mockLinkStore as any,
    });

    expect(result).toEqual({
      nickname: "ServerNickname",
      platform: "steam",
      source: "guild_nickname",
    });
  });

  it("resolves discord global username as fallback if no guild nickname", async () => {
    const mockLinkStore = vi.fn().mockResolvedValue(null);

    const result = await resolvePlayerNickname({
      discordUserId: "user_123",
      guildNickname: null,
      discordUsername: "GlobalUsername",
      getLinkFn: mockLinkStore as any,
    });

    expect(result).toEqual({
      nickname: "GlobalUsername",
      platform: "steam",
      source: "guild_nickname",
    });
  });

  it("returns null when no identifier is available", async () => {
    const mockLinkStore = vi.fn().mockResolvedValue(null);

    const result = await resolvePlayerNickname({
      discordUserId: "user_123",
      guildNickname: "",
      discordUsername: "",
      getLinkFn: mockLinkStore as any,
    });

    expect(result).toBeNull();
  });

  it("uses an explicit platform with the linked nickname before the linked platform", async () => {
    const getLinkFn = vi.fn().mockResolvedValue({ pubg_nickname: "LinkedPlayer", pubg_platform: "kakao" });
    expect(await resolvePlayerNickname({ discordUserId: "user_123", explicitPlatform: " STEAM ", getLinkFn })).toEqual({ nickname: "LinkedPlayer", platform: "steam", source: "link" });
  });

  it("uses an explicit platform for the guild nickname fallback", async () => {
    expect(await resolvePlayerNickname({ discordUserId: "user_123", explicitPlatform: "kakao", guildNickname: "GuildPlayer", getLinkFn: vi.fn().mockResolvedValue(null) })).toMatchObject({ platform: "kakao", source: "guild_nickname" });
  });

  it.each(["xbox", "psn"])("rejects unsupported platform %s before reading a linked account", async (explicitPlatform) => {
    const getLinkFn = vi.fn();
    await expect(resolvePlayerNickname({ discordUserId: "user_123", explicitPlatform, getLinkFn })).rejects.toThrow();
    expect(getLinkFn).not.toHaveBeenCalled();
  });
});

