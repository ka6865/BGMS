import { describe, expect, it, vi } from "vitest";
import {
  getDiscordUserLink,
  setDiscordUserLink,
  type DiscordUserLink,
} from "@/lib/discord/userLinkStore";

describe("discord user link store", () => {
  it("fetches an existing discord user link", async () => {
    const mockRow: DiscordUserLink = {
      discord_user_id: "123456789",
      pubg_nickname: "TestPlayer",
      pubg_platform: "steam",
      created_at: "2026-08-20T00:00:00.000Z",
      updated_at: "2026-08-20T00:00:00.000Z",
    };

    const mockClient = {
      from: vi.fn(() => ({
        select: vi.fn(() => ({
          eq: vi.fn(() => ({
            maybeSingle: vi.fn().mockResolvedValue({ data: mockRow, error: null }),
          })),
        })),
      })),
    };

    const link = await getDiscordUserLink("123456789", mockClient as any);
    expect(link).toEqual(mockRow);
    expect(mockClient.from).toHaveBeenCalledWith("discord_user_links");
  });

  it("returns null when user link is not found", async () => {
    const mockClient = {
      from: vi.fn(() => ({
        select: vi.fn(() => ({
          eq: vi.fn(() => ({
            maybeSingle: vi.fn().mockResolvedValue({ data: null, error: null }),
          })),
        })),
      })),
    };

    const link = await getDiscordUserLink("not_found", mockClient as any);
    expect(link).toBeNull();
  });

  it("upserts a discord user link with canonical platform and trimmed nickname", async () => {
    const mockSaved: DiscordUserLink = {
      discord_user_id: "123456789",
      pubg_nickname: "MyNickname",
      pubg_platform: "kakao",
      created_at: "2026-08-20T00:00:00.000Z",
      updated_at: "2026-08-20T00:00:00.000Z",
    };

    const mockClient = {
      from: vi.fn(() => ({
        upsert: vi.fn(() => ({
          select: vi.fn(() => ({
            single: vi.fn().mockResolvedValue({ data: mockSaved, error: null }),
          })),
        })),
      })),
    };

    const result = await setDiscordUserLink("123456789", "  MyNickname  ", "KAKAO", mockClient as any);
    expect(result).toEqual(mockSaved);
    expect(mockClient.from).toHaveBeenCalledWith("discord_user_links");
  });
});

