import { resolvePlayerNickname } from "../userResolver";
import { buildEmptyRecordMessage, buildStatsEmbed, discordTime } from "../embeds";
import { createClient } from "@supabase/supabase-js";
import { isDiscordTargetPrivate } from "../playerIdentity";
import { playedSeasonModes, seasonAvailability, seasonLabel, selectCachedSeason, summarizeSeasonBucket } from "../seasonStats";

const supabaseAdmin = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL || "https://placeholder.supabase.co",
  process.env.SUPABASE_SERVICE_ROLE_KEY || "placeholder-key",
);

export async function handleStatsCommand(interaction: any, appUrl: string) {
  const options = interaction.data?.options || [];
  const nicknameOption = options.find((opt: any) => opt.name === "nickname" || opt.name === "닉네임");
  const platformOption = options.find((opt: any) => opt.name === "platform" || opt.name === "플랫폼");

  const discordUserId = interaction.member?.user?.id || interaction.user?.id || "";
  const guildNickname = interaction.member?.nick || null;
  const discordUsername = interaction.member?.user?.username || interaction.user?.username || null;

  const resolved = await resolvePlayerNickname({
    explicitNickname: nicknameOption?.value ? String(nicknameOption.value) : null,
    explicitPlatform: platformOption?.value ? String(platformOption.value) : null,
    discordUserId,
    guildNickname,
    discordUsername,
  });

  if (!resolved) {
    return {
      type: 4,
      data: {
        content: "조회할 닉네임을 찾을 수 없습니다. `/전적 nickname:닉네임`으로 검색하거나, `/연동 nickname:닉네임`으로 계정을 먼저 연동해 주세요.",
        flags: 64,
      },
    };
  }

  const { nickname, platform } = resolved;
  try {
    if (await isDiscordTargetPrivate(platform, nickname)) {
      return { type: 4, data: { content: "비공개 플레이어의 전적은 Discord에서 제공하지 않습니다.", flags: 64 } };
    }
  } catch {
    return { type: 4, data: { content: "공개 범위를 확인하지 못했습니다. 잠시 후 다시 시도해 주세요.", flags: 64 } };
  }
  const lowerNick = nickname.toLowerCase();

  let tier: string | null = null;
  let rp: number | null = null;
  let kda = "—";
  let winRate = "—";
  let avgDamage: string | number = "—";
  let matches = 0;
  let scope = "";
  let ranked = false;
  let updatedAt: string | null = null;

  try {
    const { data: cacheRow, error: cacheError } = await supabaseAdmin
      .from("pubg_player_cache")
      .select("season_stats_data, last_season_id, updated_at")
      .eq("lower_nickname", lowerNick)
      .eq("platform", platform)
      .maybeSingle();
    if (cacheError) throw cacheError;

    const season = selectCachedSeason(cacheRow);
    if (cacheRow && season) {
      const activeRanked = playedSeasonModes(season.stats, "ranked")[0];
      const activeNormal = playedSeasonModes(season.stats, "normal")[0];
      ranked = Boolean(activeRanked && activeRanked[1].roundsPlayed >= (activeNormal?.[1].roundsPlayed ?? 0));
      const selected = ranked ? activeRanked : activeNormal;

      if (selected) {
        const [mode, activeStats] = selected;
        const summary = summarizeSeasonBucket(activeStats, ranked ? "ranked" : "normal");
        matches = summary.matches;
        if (summary.ratio) kda = summary.ratio;
        winRate = summary.winRate;
        avgDamage = summary.avgDamage;
        tier = summary.tier;
        rp = summary.rp;
        const availability = seasonAvailability(season.stats, ranked ? "ranked" : "normal", cacheRow);
        updatedAt = availability.updatedAt;
        scope = `${seasonLabel(season.seasonId)} · ${ranked ? "경쟁전" : "일반전"} · ${mode.toUpperCase()}\n시즌 캐시에서 판수가 가장 많은 모드의 ${matches}경기 누적 통계입니다. 시점(FPP/TPP)은 저장 캐시에서 구분할 수 없습니다.`;
        if (availability.stale) scope += "\n최근 갱신에 실패한 이전 저장 통계입니다.";
      }
    }

    if (matches === 0) {
      const { data: matchRows, error: matchError } = await supabaseAdmin
        .from("pubg_player_matches")
        .select("kills, damage, win_place, played_at, game_mode, match_type")
        .eq("player_id", lowerNick)
        .eq("platform", platform)
        .order("played_at", { ascending: false })
        .limit(20);
      if (matchError) throw matchError;

      if (Array.isArray(matchRows) && matchRows.length > 0) {
        matches = matchRows.length;
        const totalKills = matchRows.reduce((acc, m) => acc + m.kills, 0);
        const totalDamage = matchRows.reduce((acc, m) => acc + m.damage, 0);
        const totalWins = matchRows.filter((m) => m.win_place === 1).length;

        kda = (totalKills / Math.max(1, matches - totalWins)).toFixed(2);
        winRate = `${((totalWins / matches) * 100).toFixed(1)}%`;
        avgDamage = Math.round(totalDamage / matches);
        const modes = [...new Set(matchRows.map((m) => m.game_mode || "미확인"))].join(", ");
        const types = [...new Set(matchRows.map((m) => m.match_type || "미확인"))].join(", ");
        scope = `시즌 통계 대신 최근 저장 ${matches}경기(최대 20건)를 집계했습니다.\n모드: ${modes} · 경기 유형: ${types}\n경기 시각: ${discordTime(matchRows.at(-1)?.played_at)} ~ ${discordTime(matchRows[0].played_at)}\n저장 기록만 포함하며 시즌·일반전·경쟁전을 분리한 통계가 아닙니다. K/D는 킬 ÷ (경기 수 − 1위 경기 수), 최소 분모 1로 계산한 근사값입니다.`;
      }
    }

    if (matches === 0) {
      return {
        type: 4,
        data: {
          ...buildEmptyRecordMessage("저장된 시즌 전적이나 경기 기록이 없습니다. 웹 전적 페이지에서 기록을 갱신한 뒤 다시 확인해 주세요.", nickname, platform, appUrl),
          flags: 64,
        },
      };
    }
    const embedPayload = buildStatsEmbed(
      { nickname, platform, tier, rp, kda, winRate, avgDamage, matches, scope, ranked, updatedAt },
      appUrl,
    );

    return { type: 4, data: { ...embedPayload, flags: 0 } };
  } catch {
    return { type: 4, data: { content: "저장된 전적을 조회하지 못했습니다. 잠시 후 다시 시도해 주세요.", flags: 64 } };
  }
}
