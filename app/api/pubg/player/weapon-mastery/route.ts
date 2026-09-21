import { NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";
import { reportPubgApiError } from "@/lib/pubg/apiHelper";
import { normalizeWeaponMasteryItems, parseWeaponMasteryResponse } from "@/lib/pubg/weaponMastery";
import { trackPubgRateLimit } from "@/lib/pubg-analysis/pubgApiTracker";
import { isPlayerPrivate } from "@/lib/pubg/privatePlayers";

const MASTERY_CACHE_TTL_MS = 3 * 60 * 60 * 1000;

const supabaseAdmin = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
);

export async function POST(request: Request) {
  let nickname = "";
  let platform = "steam";

  try {
    const body = await request.json().catch(() => ({}));
    nickname = String(body.nickname || "").trim();
    platform = String(body.platform || "steam").trim() || "steam";

    if (!nickname) {
      return NextResponse.json({ success: false, error: "닉네임이 필요합니다." }, { status: 400 });
    }
    if (!["steam", "kakao"].includes(platform)) {
      return NextResponse.json({ success: false, error: "지원하지 않는 플랫폼입니다." }, { status: 400 });
    }

    const { data: cacheData, error: cacheError } = await supabaseAdmin
      .from("pubg_player_cache")
      .select("id, nickname, platform, weapon_mastery_data, mastery_updated_at")
      .eq("lower_nickname", nickname.toLowerCase())
      .eq("platform", platform)
      .maybeSingle();

    if (cacheError) throw cacheError;

    if (!cacheData?.id) {
      return NextResponse.json(
        {
          success: false,
          error: "전적 검색을 먼저 한 번 해주세요. 무기 숙련도 갱신에는 캐시된 PUBG accountId가 필요합니다.",
          code: "PLAYER_CACHE_REQUIRED"
        },
        { status: 409 }
      );
    }
    if (await isPlayerPrivate(platform, nickname, cacheData.id)) {
      return NextResponse.json({ success: false, error: "비공개 플레이어입니다.", code: "PLAYER_PRIVATE" }, { status: 403 });
    }

    const cachedAt = cacheData.mastery_updated_at ? new Date(cacheData.mastery_updated_at).getTime() : 0;
    const cachedWeapons = normalizeWeaponMasteryItems(
      Array.isArray(cacheData.weapon_mastery_data) ? cacheData.weapon_mastery_data : []
    );
    if (cachedAt > 0 && Date.now() - cachedAt < MASTERY_CACHE_TTL_MS) {
      return NextResponse.json({
        success: true,
        nickname: cacheData.nickname || nickname,
        platform,
        weaponMastery: cachedWeapons,
        masteryUpdatedAt: cacheData.mastery_updated_at,
        source: "cache"
      });
    }

    const apiKey = (process.env.PUBG_API_KEY || "").split(" ")[0];
    const masteryRes = await fetch(
      `https://api.pubg.com/shards/${platform}/players/${cacheData.id}/weapon_mastery`,
      {
        headers: {
          Authorization: `Bearer ${apiKey}`,
          Accept: "application/vnd.api+json"
        },
        cache: "no-store",
        signal: AbortSignal.timeout(8000)
      }
    );
    trackPubgRateLimit(masteryRes.headers);

    if (!masteryRes.ok) {
      const message = masteryRes.status === 429
        ? "PUBG API 호출 한도가 일시적으로 초과되었습니다. 약 1분 후 다시 시도해 주세요."
        : `무기 숙련도 정보를 불러오지 못했습니다. (HTTP ${masteryRes.status})`;
      await reportPubgApiError({
        route: "/api/pubg/player/weapon-mastery",
        status: masteryRes.status,
        message,
        detail: "weapon_mastery upstream response failed",
      });
      return NextResponse.json({ success: false, error: message }, { status: masteryRes.status });
    }

    const masteryJson = await safeJsonParse(masteryRes);
    const weaponMastery = parseWeaponMasteryResponse(masteryJson);
    const masteryUpdatedAt = new Date().toISOString();

    const { error: updateError } = await supabaseAdmin
      .from("pubg_player_cache")
      .update({
        weapon_mastery_data: weaponMastery,
        mastery_updated_at: masteryUpdatedAt
      })
      .eq("id", cacheData.id)
      .eq("platform", platform);

    if (updateError) throw updateError;

    return NextResponse.json({
      success: true,
      nickname: cacheData.nickname || nickname,
      platform,
      weaponMastery,
      masteryUpdatedAt,
      source: "api"
    });
  } catch (error: any) {
    const isRateLimit = error.message?.includes("429") || error.status === 429;
    const status = isRateLimit ? 429 : 500;
    const errorMsg = isRateLimit
      ? "PUBG API 호출 한도가 일시적으로 초과되었습니다. 약 1분 후 다시 시도해 주세요."
      : (error.message || "무기 숙련도 갱신 중 오류가 발생했습니다.");

    await reportPubgApiError({
      route: "/api/pubg/player/weapon-mastery",
      status,
      message: errorMsg,
      detail: error.stack || error.message,
    });

    return NextResponse.json({ success: false, error: errorMsg }, { status });
  }
}

async function safeJsonParse(res: Response): Promise<any> {
  const contentType = res.headers.get("content-type") || "";
  if (!contentType.includes("json")) {
    throw new Error(`PUBG API 응답이 JSON 형식이 아닙니다. (Content-Type: ${contentType}, Status: ${res.status})`);
  }
  return res.json();
}
