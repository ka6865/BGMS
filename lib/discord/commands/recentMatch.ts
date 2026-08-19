import { resolvePlayerNickname } from "../userResolver";
import { buildRecentMatchEmbed } from "../embeds";
import { createClient } from "@supabase/supabase-js";
import { buildPlayerCacheKey } from "@/lib/pubg/responseCache";

const supabaseAdmin = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL || "https://placeholder.supabase.co",
  process.env.SUPABASE_SERVICE_ROLE_KEY || "placeholder-key",
);

export async function handleRecentMatchCommand(interaction: any, appUrl: string) {
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
        content: "조회할 닉네임을 찾을 수 없습니다. `/방금판 nickname:닉네임`으로 검색하거나, `/연동 nickname:닉네임`으로 계정을 먼저 연동해 주세요.",
        flags: 64,
      },
    };
  }

  const { nickname, platform } = resolved;
  const lowerNick = nickname.toLowerCase();
  const cacheKey = buildPlayerCacheKey(platform, lowerNick, null);

  let matchId = "";
  let recentMatchData: any = null;

  try {
    const { data: cacheRow } = await supabaseAdmin
      .from("pubg_player_cache")
      .select("payload")
      .eq("cache_key", cacheKey)
      .maybeSingle();

    const matches = cacheRow?.payload?.player?.data?.[0]?.relationships?.matches?.data;
    if (Array.isArray(matches) && matches.length > 0) {
      matchId = String(matches[0]?.id || "");
    }
  } catch (err) {
    console.warn("[DiscordRecentMatchCmd] Player cache lookup failed:", err);
  }

  if (matchId) {
    try {
      const { data: matchRow } = await supabaseAdmin
        .from("pubg_player_matches")
        .select("raw_stats, analysis_data")
        .eq("match_id", matchId)
        .maybeSingle();

      if (matchRow) {
        recentMatchData = matchRow;
      }
    } catch (err) {
      console.warn("[DiscordRecentMatchCmd] Match lookup failed:", err);
    }
  }

  const rawStats = recentMatchData?.raw_stats || {};
  const analysis = recentMatchData?.analysis_data || {};

  const embedPayload = buildRecentMatchEmbed(
    {
      nickname,
      platform,
      matchId: matchId || "latest",
      mapName: rawStats.mapName || "에란겔",
      winPlace: rawStats.winPlace || 1,
      kills: rawStats.kills ?? 0,
      damage: Math.round(rawStats.damageDealt || 0),
      damageShare: analysis.teamImpact?.teamDamageShare ? `${analysis.teamImpact.teamDamageShare}%` : "—",
      backupLatency: analysis.tradeStats?.tradeLatencyMs ? `${(analysis.tradeStats.tradeLatencyMs / 1000).toFixed(1)}s` : "—",
      duelWinRate: analysis.duelStats?.duelWinRate ? `${analysis.duelStats.duelWinRate}%` : "—",
    },
    appUrl,
  );

  return {
    type: 4,
    data: embedPayload,
  };
}
