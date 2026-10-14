import { resolvePlayerNickname } from "../userResolver";
import { buildRecentMatchEmbed } from "../embeds";
import { createClient } from "@supabase/supabase-js";
import { MAP_NAMES } from "@/lib/pubg-analysis/constants";
import { isPlayerPrivate } from "@/lib/pubg/privatePlayers";
import { resolvePrivatePlayerAccountId } from "@/lib/pubg/privatePlayerIdentity";
import { getLegacyFullResultForHistory } from "@/lib/pubg-analysis/cacheIdentity";

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
  try {
    const accountId = await resolvePrivatePlayerAccountId(platform, nickname);
    if (await isPlayerPrivate(platform, nickname, accountId ?? undefined)) {
      return { type: 4, data: { content: "비공개 플레이어의 전적은 Discord에서 제공하지 않습니다.", flags: 64 } };
    }
  } catch {
    return { type: 4, data: { content: "공개 범위를 확인하지 못했습니다. 잠시 후 다시 시도해 주세요.", flags: 64 } };
  }
  const lowerNick = nickname.toLowerCase();

  try {
    const { data: latestMatch, error: matchError } = await supabaseAdmin
      .from("pubg_player_matches")
      .select("match_id, map_name, kills, damage, win_place, played_at, created_at")
      .eq("player_id", lowerNick)
      .eq("platform", platform)
      .order("played_at", { ascending: false })
      .limit(1)
      .maybeSingle();
    if (matchError) throw matchError;
    if (!latestMatch) {
      return { type: 4, data: { content: "저장된 경기 기록이 없습니다. 웹 전적 페이지에서 기록을 갱신한 뒤 다시 확인해 주세요.", flags: 64 } };
    }
    const matchId = latestMatch.match_id;
    if (typeof matchId !== "string" || !/^[A-Za-z0-9_.-]{1,128}$/.test(matchId) || ["latest", ".", ".."].includes(matchId)) {
      throw new Error("invalid_stored_match_id");
    }

    const { data: telemetryRow, error: telemetryError } = await supabaseAdmin
      .from("processed_match_telemetry")
      .select("data, updated_at")
      .eq("match_id", matchId)
      .eq("platform", platform)
      .eq("player_id", lowerNick)
      .maybeSingle();
    if (telemetryError) throw telemetryError;

    const analysis = getLegacyFullResultForHistory(telemetryRow, lowerNick, platform);
    const measured = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value) && value >= 0;
    const share = analysis?.teamImpact?.teamDamageShare;
    const latency = analysis?.tradeStats?.tradeLatencyMs;
    const duel = analysis?.duelStats?.duelWinRate;

    const embedPayload = buildRecentMatchEmbed(
      {
        nickname,
        platform,
        matchId,
        mapName: MAP_NAMES[latestMatch.map_name] || latestMatch.map_name || null,
        winPlace: latestMatch.win_place,
        kills: latestMatch.kills,
        damage: latestMatch.damage,
        playedAt: latestMatch.played_at,
        storedAt: latestMatch.created_at,
        analysisUpdatedAt: analysis ? telemetryRow?.updated_at : null,
        damageShare: measured(share) && share <= 100 ? `${share}%` : null,
        tradeLatency: measured(latency) ? `${(latency / 1000).toFixed(1)}초` : null,
        duelWinRate: measured(duel) && duel <= 100 ? `${Math.round(duel * 10) / 10}%` : null,
      },
      appUrl,
    );

    return { type: 4, data: { ...embedPayload, flags: 0 } };
  } catch {
    return { type: 4, data: { content: "저장된 경기 기록을 조회하지 못했습니다. 잠시 후 다시 시도해 주세요.", flags: 64 } };
  }
}
