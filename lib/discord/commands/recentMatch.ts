import { resolvePlayerNickname } from "../userResolver";
import { buildRecentMatchEmbed } from "../embeds";
import { createClient } from "@supabase/supabase-js";
import { MAP_NAMES } from "@/lib/pubg-analysis/constants";

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

  let matchId = "";
  let mapName = "에란겔";
  let winPlace = 1;
  let kills = 0;
  let damage = 0;
  let damageShare: string | null = null;
  let backupLatency: string | null = null;
  let duelWinRate: string | null = null;

  try {
    // 1. Fetch the latest match from pubg_player_matches
    const { data: latestMatch } = await supabaseAdmin
      .from("pubg_player_matches")
      .select("match_id, map_name, kills, damage, win_place")
      .eq("player_id", lowerNick)
      .eq("platform", platform)
      .order("played_at", { ascending: false })
      .limit(1)
      .maybeSingle();

    if (latestMatch) {
      matchId = latestMatch.match_id;
      mapName = MAP_NAMES[latestMatch.map_name] || latestMatch.map_name || "에란겔";
      winPlace = latestMatch.win_place;
      kills = latestMatch.kills ?? 0;
      damage = latestMatch.damage ?? 0;
    } else {
      // Fallback to pubg_player_cache recent_match_ids
      const { data: cacheRow } = await supabaseAdmin
        .from("pubg_player_cache")
        .select("recent_match_ids")
        .eq("lower_nickname", lowerNick)
        .eq("platform", platform)
        .maybeSingle();

      if (Array.isArray(cacheRow?.recent_match_ids) && cacheRow.recent_match_ids.length > 0) {
        matchId = String(cacheRow.recent_match_ids[0]);
      }
    }

    // 2. Fetch detailed processed telemetry stats if available
    if (matchId) {
      const { data: telemetryRow } = await supabaseAdmin
        .from("processed_match_telemetry")
        .select("data")
        .eq("match_id", matchId)
        .eq("platform", platform)
        .eq("player_id", lowerNick)
        .maybeSingle();

      const analysis = telemetryRow?.data?.fullResult || telemetryRow?.data || {};
      if (analysis.teamImpact?.teamDamageShare) {
        damageShare = `${analysis.teamImpact.teamDamageShare}%`;
      }
      if (analysis.tradeStats?.tradeLatencyMs) {
        backupLatency = `${(analysis.tradeStats.tradeLatencyMs / 1000).toFixed(1)}s`;
      }
      if (analysis.duelStats?.duelWinRate) {
        duelWinRate = `${analysis.duelStats.duelWinRate}%`;
      }
    }
  } catch (err) {
    console.warn("[DiscordRecentMatchCmd] Recent match lookup failed:", err);
  }

  const embedPayload = buildRecentMatchEmbed(
    {
      nickname,
      platform,
      matchId: matchId || "latest",
      mapName,
      winPlace,
      kills,
      damage,
      damageShare,
      backupLatency,
      duelWinRate,
    },
    appUrl,
  );

  return {
    type: 4,
    data: embedPayload,
  };
}

