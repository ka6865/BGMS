import { resolvePlayerNickname } from "../userResolver";
import { buildStatsEmbed } from "../embeds";
import { createClient } from "@supabase/supabase-js";
import { MAP_NAMES } from "@/lib/pubg-analysis/constants";

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
  const lowerNick = nickname.toLowerCase();

  let tier = "언랭크";
  let rp = 0;
  let kda = "—";
  let winRate = "—";
  let avgDamage: string | number = "—";
  let matches = 0;

  try {
    const { data: cacheRow } = await supabaseAdmin
      .from("pubg_player_cache")
      .select("nickname, platform, season_stats_data, last_season_id")
      .eq("lower_nickname", lowerNick)
      .eq("platform", platform)
      .maybeSingle();

    if (cacheRow && cacheRow.season_stats_data) {
      const seasonId = cacheRow.last_season_id;
      const currentSeasonStats = seasonId ? cacheRow.season_stats_data[seasonId] : (Object.values(cacheRow.season_stats_data)[0] as any);
      const ranked = currentSeasonStats?.ranked;
      const normal = currentSeasonStats?.normal;

      const pickMode = (statsObj: any) => {
        if (!statsObj) return null;
        const modes = [statsObj.squad, statsObj.duo, statsObj.solo].filter(Boolean);
        return modes.sort((a, b) => (b.roundsPlayed || 0) - (a.roundsPlayed || 0))[0] || null;
      };

      const activeRanked = pickMode(ranked);
      const activeNormal = pickMode(normal);
      const activeStats = (activeRanked?.roundsPlayed || 0) >= (activeNormal?.roundsPlayed || 0) && activeRanked?.roundsPlayed
        ? activeRanked
        : activeNormal;

      if (activeStats && activeStats.roundsPlayed > 0) {
        matches = activeStats.roundsPlayed;
        if (activeStats.kda) {
          kda = Number(activeStats.kda).toFixed(2);
        } else if (typeof activeStats.kills === "number") {
          const deaths = activeStats.losses ?? activeStats.deaths ?? Math.max(1, activeStats.roundsPlayed - (activeStats.wins || 0));
          kda = (activeStats.kills / Math.max(1, deaths)).toFixed(2);
        }
        if (typeof activeStats.wins === "number") {
          winRate = `${((activeStats.wins / activeStats.roundsPlayed) * 100).toFixed(1)}%`;
        }
        if (typeof activeStats.damageDealt === "number") {
          avgDamage = Math.round(activeStats.damageDealt / activeStats.roundsPlayed);
        }
      }

      if (activeRanked?.currentTier?.tier) {
        tier = `${activeRanked.currentTier.tier} ${activeRanked.currentTier.subTier || ""}`.trim();
        rp = activeRanked.currentRankPoint ?? 0;
      }
    }

    // If cache was missing or empty, compute fallback aggregates from pubg_player_matches
    if (matches === 0) {
      const { data: matchRows } = await supabaseAdmin
        .from("pubg_player_matches")
        .select("kills, damage, win_place")
        .eq("player_id", lowerNick)
        .eq("platform", platform)
        .order("played_at", { ascending: false })
        .limit(20);

      if (Array.isArray(matchRows) && matchRows.length > 0) {
        matches = matchRows.length;
        const totalKills = matchRows.reduce((acc, m) => acc + (m.kills || 0), 0);
        const totalDamage = matchRows.reduce((acc, m) => acc + (m.damage || 0), 0);
        const totalWins = matchRows.filter((m) => m.win_place === 1).length;

        kda = (totalKills / Math.max(1, matches - totalWins)).toFixed(2);
        winRate = `${((totalWins / matches) * 100).toFixed(1)}%`;
        avgDamage = Math.round(totalDamage / matches);
      }
    }
  } catch (err) {
    console.warn("[DiscordStatsCmd] Stats calculation failed:", err);
  }

  const embedPayload = buildStatsEmbed(
    {
      nickname,
      platform,
      tier: tier !== "언랭크" ? tier : null,
      rp,
      kda,
      winRate,
      avgDamage,
      matches: matches || 20,
    },
    appUrl,
  );

  return {
    type: 4,
    data: embedPayload,
  };
}
