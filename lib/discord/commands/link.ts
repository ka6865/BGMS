import { deleteDiscordUserLink, setDiscordUserLink } from "../userLinkStore";
import { buildLinkSuccessEmbed, escapeDiscordMarkdown } from "../embeds";
import { resolveDiscordLinkTarget } from "../playerIdentity";
import { canonicalizeLinkedPlayerPlatform } from "@/lib/pubg/linkedPlayerSync";

export async function handleLinkCommand(interaction: any) {
  const options = interaction.data?.options || [];
  const nicknameOption = options.find((opt: any) => opt.name === "nickname" || opt.name === "배그닉네임");
  const platformOption = options.find((opt: any) => opt.name === "platform" || opt.name === "플랫폼");

  const nickname = String(nicknameOption?.value || "").trim();
  const discordUserId = interaction.member?.user?.id || interaction.user?.id;

  if (!discordUserId) {
    return {
      type: 4,
      data: { content: "디스코드 사용자 정보를 확인할 수 없습니다.", flags: 64 },
    };
  }

  if (!nickname) {
    return {
      type: 4,
      data: { content: "연동할 배틀그라운드 닉네임을 입력해 주세요. (예: `/연동 nickname:홍길동`)", flags: 64 },
    };
  }

  let platform: string;
  try {
    platform = canonicalizeLinkedPlayerPlatform(String(platformOption?.value || "steam"));
  } catch {
    return { type: 4, data: { content: "지원하지 않는 플랫폼입니다. steam 또는 kakao를 선택해 주세요.", flags: 64 } };
  }

  // PUBG 계정 확인이 실패하면 연동을 저장하지 않는다.
  let verifiedNickname: string | null;
  try {
    verifiedNickname = await resolveDiscordLinkTarget(platform, nickname);
  } catch {
    return { type: 4, data: { content: "PUBG 계정을 확인하지 못해 연동하지 않았습니다. 잠시 후 다시 시도해 주세요.", flags: 64 } };
  }
  if (!verifiedNickname) {
    return {
      type: 4,
      data: {
        content: `${platform.toUpperCase()}에서 **${escapeDiscordMarkdown(nickname)}** 닉네임을 찾지 못해 연동하지 않았습니다. 플랫폼과 닉네임을 확인해 주세요.`,
        flags: 64,
      },
    };
  }

  try {
    const saved = await setDiscordUserLink(discordUserId, verifiedNickname, platform);
    const embedPayload = buildLinkSuccessEmbed({
      nickname: saved.pubg_nickname,
      platform: saved.pubg_platform,
    });

    return {
      type: 4, // ChannelMessageWithSource
      data: { ...embedPayload, flags: 64 },
    };
  } catch {
    return {
      type: 4,
      data: { content: "계정을 연동하지 못했습니다. 잠시 후 다시 시도해 주세요.", flags: 64 },
    };
  }
}

export async function handleUnlinkCommand(interaction: any) {
  const discordUserId = interaction.member?.user?.id || interaction.user?.id;
  if (!discordUserId) {
    return { type: 4, data: { content: "디스코드 사용자 정보를 확인할 수 없습니다.", flags: 64 } };
  }

  try {
    const removed = await deleteDiscordUserLink(discordUserId);
    if (!removed) {
      return { type: 4, data: { content: "연동된 배틀그라운드 계정이 없습니다.", flags: 64 } };
    }
    return {
      type: 4,
      data: {
        content: `**${escapeDiscordMarkdown(removed.pubg_nickname)}** (${String(removed.pubg_platform).toUpperCase()}) 계정 연동을 해제했습니다.`,
        flags: 64,
      },
    };
  } catch {
    return { type: 4, data: { content: "연동을 해제하지 못했습니다. 잠시 후 다시 시도해 주세요.", flags: 64 } };
  }
}
