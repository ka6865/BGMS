import { setDiscordUserLink } from "../userLinkStore";
import { buildLinkSuccessEmbed } from "../embeds";

export async function handleLinkCommand(interaction: any) {
  const options = interaction.data?.options || [];
  const nicknameOption = options.find((opt: any) => opt.name === "nickname" || opt.name === "배그닉네임");
  const platformOption = options.find((opt: any) => opt.name === "platform" || opt.name === "플랫폼");

  const nickname = String(nicknameOption?.value || "").trim();
  const platform = String(platformOption?.value || "steam").trim();
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

  try {
    const saved = await setDiscordUserLink(discordUserId, nickname, platform);
    const embedPayload = buildLinkSuccessEmbed({
      nickname: saved.pubg_nickname,
      platform: saved.pubg_platform,
    });

    return {
      type: 4, // ChannelMessageWithSource
      data: embedPayload,
    };
  } catch (err: any) {
    return {
      type: 4,
      data: { content: `계정 연동 중 오류가 발생했습니다: ${err?.message || err}`, flags: 64 },
    };
  }
}

