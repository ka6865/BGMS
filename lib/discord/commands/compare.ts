import { createClient } from "@supabase/supabase-js";
import { buildCompareEmbed, type ComparePlayer } from "../embeds";
import { isDiscordTargetPrivate } from "../playerIdentity";
import { parseNicknameOption } from "../nicknameOption";
import {
  seasonAvailability,
  selectCachedSeason,
  summarizeSeasonBucket,
  type SeasonMode,
  type SeasonQueue,
  playedSeasonModes,
} from "../seasonStats";
import { canonicalizeLinkedPlayerPlatform } from "@/lib/pubg/linkedPlayerSync";

const supabaseAdmin = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL || "https://placeholder.supabase.co",
  process.env.SUPABASE_SERVICE_ROLE_KEY || "placeholder-key",
);

const MODES = new Set<SeasonMode>(["solo", "duo", "squad"]);

function optionValue(options: any[], name: string): unknown {
  return options.find((opt) => opt?.name === name)?.value;
}

async function loadComparePlayer(
  nickname: string,
  platform: string,
  queue: SeasonQueue,
  mode: SeasonMode,
): Promise<ComparePlayer> {
  const { data: row, error } = await supabaseAdmin
    .from("pubg_player_cache")
    .select("nickname, season_stats_data, last_season_id, updated_at")
    .eq("lower_nickname", nickname.toLowerCase())
    .eq("platform", platform)
    .maybeSingle();
  if (error) throw error;

  const displayName = typeof row?.nickname === "string" && row.nickname.trim() ? row.nickname.trim() : nickname;
  const season = selectCachedSeason(row);
  if (!row || !season) return { nickname: displayName, platform, seasonId: null, summary: null, updatedAt: null, stale: false };

  const bucket = playedSeasonModes(season.stats, queue).find(([played]) => played === mode)?.[1];
  const availability = seasonAvailability(season.stats, queue, row);
  return {
    nickname: displayName,
    platform,
    seasonId: season.seasonId,
    summary: bucket ? summarizeSeasonBucket(bucket, queue) : null,
    updatedAt: availability.updatedAt,
    stale: availability.stale,
  };
}

/**
 * 두 플레이어의 저장 시즌 통계를 같은 경기 유형·모드로 비교한다.
 * 저장 캐시만 읽으며, 두 대상 모두 비공개 확인을 통과해야 결과를 공개한다.
 */
export async function handleCompareCommand(interaction: any, appUrl: string) {
  const options: any[] = Array.isArray(interaction.data?.options) ? interaction.data.options : [];
  const first = parseNicknameOption(optionValue(options, "nickname1"));
  const second = parseNicknameOption(optionValue(options, "nickname2"));
  if (!first.nickname || !second.nickname) {
    return { type: 4, data: { content: "비교할 두 플레이어의 닉네임을 입력해 주세요.", flags: 64 } };
  }

  const platformOption = optionValue(options, "platform");
  const modeOption = optionValue(options, "mode");
  const queue: SeasonQueue = optionValue(options, "type") === "ranked" ? "ranked" : "normal";
  const mode: SeasonMode = typeof modeOption === "string" && MODES.has(modeOption as SeasonMode) ? modeOption as SeasonMode : "squad";

  let platforms: [string, string];
  try {
    // 플랫폼 옵션이 두 닉네임에 우선하고, 없으면 자동완성 선택값의 플랫폼, 그다음 steam을 쓴다.
    const explicit = typeof platformOption === "string" && platformOption ? canonicalizeLinkedPlayerPlatform(platformOption) : null;
    platforms = [
      explicit ?? first.platform ?? "steam",
      explicit ?? second.platform ?? "steam",
    ];
  } catch {
    return { type: 4, data: { content: "지원하지 않는 플랫폼입니다. steam 또는 kakao를 선택해 주세요.", flags: 64 } };
  }

  if (first.nickname.toLowerCase() === second.nickname.toLowerCase() && platforms[0] === platforms[1]) {
    return { type: 4, data: { content: "서로 다른 두 플레이어를 입력해 주세요.", flags: 64 } };
  }

  try {
    const privacy = await Promise.all([
      isDiscordTargetPrivate(platforms[0], first.nickname),
      isDiscordTargetPrivate(platforms[1], second.nickname),
    ]);
    if (privacy.some(Boolean)) {
      return { type: 4, data: { content: "비공개 플레이어가 포함되어 있어 Discord에서 비교할 수 없습니다.", flags: 64 } };
    }
  } catch {
    return { type: 4, data: { content: "공개 범위를 확인하지 못했습니다. 잠시 후 다시 시도해 주세요.", flags: 64 } };
  }

  try {
    const players = await Promise.all([
      loadComparePlayer(first.nickname, platforms[0], queue, mode),
      loadComparePlayer(second.nickname, platforms[1], queue, mode),
    ]);
    const payload = buildCompareEmbed({ players, queue, mode }, appUrl);
    // 둘 다 기록이 없으면 비교 결과 대신 웹 갱신 링크만 호출자에게 보여 준다.
    const flags = players.some((player) => player.summary) ? 0 : 64;
    return { type: 4, data: { ...payload, flags } };
  } catch {
    return { type: 4, data: { content: "저장된 전적을 조회하지 못했습니다. 잠시 후 다시 시도해 주세요.", flags: 64 } };
  }
}
