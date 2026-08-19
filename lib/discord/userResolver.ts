import { getDiscordUserLink, type DiscordUserLink } from "./userLinkStore";
import { canonicalizeLinkedPlayerPlatform } from "@/lib/pubg/linkedPlayerSync";

export interface ResolvePlayerNicknameParams {
  explicitNickname?: string | null;
  explicitPlatform?: string | null;
  discordUserId: string;
  guildNickname?: string | null;
  discordUsername?: string | null;
  getLinkFn?: (discordUserId: string) => Promise<DiscordUserLink | null>;
}

export interface ResolvedPlayerIdentity {
  nickname: string;
  platform: string;
  source: "explicit" | "link" | "guild_nickname";
}

/**
 * Resolves the PUBG player nickname and platform using a 3-tier fallback strategy:
 * 1. Explicit command argument (highest priority)
 * 2. Database linked account (discord_user_links)
 * 3. Discord Guild Nickname or Global Username
 */
export async function resolvePlayerNickname({
  explicitNickname,
  explicitPlatform,
  discordUserId,
  guildNickname,
  discordUsername,
  getLinkFn = getDiscordUserLink,
}: ResolvePlayerNicknameParams): Promise<ResolvedPlayerIdentity | null> {
  const trimmedExplicit = explicitNickname?.trim();
  if (trimmedExplicit) {
    return {
      nickname: trimmedExplicit,
      platform: canonicalizeLinkedPlayerPlatform(explicitPlatform || "steam"),
      source: "explicit",
    };
  }

  // Priority 2: Check database link
  try {
    const link = await getLinkFn(discordUserId);
    if (link && link.pubg_nickname) {
      return {
        nickname: link.pubg_nickname,
        platform: canonicalizeLinkedPlayerPlatform(link.pubg_platform || "steam"),
        source: "link",
      };
    }
  } catch (err) {
    console.warn("[DiscordUserResolver] Failed to fetch user link:", err);
  }

  // Priority 3: Guild nickname or Discord username
  const fallbackNick = guildNickname?.trim() || discordUsername?.trim();
  if (fallbackNick) {
    return {
      nickname: fallbackNick,
      platform: canonicalizeLinkedPlayerPlatform(explicitPlatform || "steam"),
      source: "guild_nickname",
    };
  }

  return null;
}

