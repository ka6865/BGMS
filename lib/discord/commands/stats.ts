import { resolvePlayerNickname } from "../userResolver";
import { buildStatsEmbed } from "../embeds";
import { createClient } from "@supabase/supabase-js";
import { buildPlayerCacheKey } from "@/lib/pubg/responseCache";

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
  const cacheKey = buildPlayerCacheKey(platform, lowerNick, null);

  // Read from DB player cache first
  let cachedPlayer: any = null;
  try {
    const { data } = await supabaseAdmin
      .from("pubg_player_cache")
      .select("payload")
      .eq("cache_key", cacheKey)
      .maybeSingle();

    if (data?.payload) {
      cachedPlayer = data.payload;
    }
  } catch (err) {
    console.warn("[DiscordStatsCmd] DB cache lookup failed:", err);
  }

  // Format stats from cached data or fallback to basic summary
  const ranked = cachedPlayer?.rankedStats?.data?.attributes?.rankedSeasonStats;
  const squadStats = ranked?.squad || ranked?.["squad-fpp"] || ranked?.solo || ranked?.duo;

  const kda = squadStats?.kda ? Number(squadStats.kda).toFixed(2) : (squadStats?.kills && squadStats?.deaths ? (squadStats.kills / Math.max(1, squadStats.deaths)).toFixed(2) : "—");
  const winRate = squadStats?.roundsPlayed ? `${((squadStats.wins / Math.max(1, squadStats.roundsPlayed)) * 100).toFixed(1)}%` : "—";
  const avgDamage = squadStats?.roundsPlayed ? Math.round((squadStats.damageDealt || 0) / squadStats.roundsPlayed) : "—";
  const tier = squadStats?.currentTier?.tier ? `${squadStats.currentTier.tier} ${squadStats.currentTier.subTier || ""}`.trim() : (cachedPlayer?.tier || "언랭크");
  const rp = squadStats?.currentRankPoint ?? cachedPlayer?.rp ?? 0;

  const embedPayload = buildStatsEmbed(
    {
      nickname,
      platform,
      tier,
      rp,
      kda,
      winRate,
      avgDamage,
      matches: squadStats?.roundsPlayed || 20,
    },
    appUrl,
  );

  return {
    type: 4,
    data: embedPayload,
  };
}
