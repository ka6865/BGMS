import { getDiscordUserLink } from "../userLinkStore";
import { handleStatsCommand } from "./stats";

export const USER_STATS_COMMAND_NAME = "전적 보기";

/**
 * 서버 멤버 우클릭 메뉴(USER 명령)로 대상의 연동 계정 전적을 조회한다.
 * 대상이 직접 연동한 계정만 조회하며 서버 별명으로 추정하지 않는다.
 * 연동 정보는 `/연동`과 같이 호출자에게만 보이도록 route에서 개인 defer한다.
 */
export async function handleUserStatsCommand(interaction: any, appUrl: string) {
  const targetId = interaction.data?.target_id;
  if (typeof targetId !== "string" || !/^\d{17,20}$/.test(targetId)) {
    return { type: 4, data: { content: "조회할 디스코드 사용자를 확인할 수 없습니다.", flags: 64 } };
  }

  let link;
  try {
    link = await getDiscordUserLink(targetId);
  } catch {
    return { type: 4, data: { content: "연동 정보를 확인하지 못했습니다. 잠시 후 다시 시도해 주세요.", flags: 64 } };
  }
  if (!link?.pubg_nickname) {
    return {
      type: 4,
      data: {
        content: "이 사용자는 배틀그라운드 계정을 연동하지 않았습니다. `/연동`으로 계정을 연동하면 우클릭 메뉴로 전적을 볼 수 있습니다.",
        flags: 64,
      },
    };
  }

  return handleStatsCommand({
    ...interaction,
    data: {
      name: "전적",
      options: [
        { name: "nickname", value: link.pubg_nickname },
        { name: "platform", value: link.pubg_platform || "steam" },
      ],
    },
  }, appUrl);
}
