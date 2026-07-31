import { NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";
import { TELEMETRY_VERSION } from "@/lib/pubg-analysis/constants";
import { normalizeName } from "@/lib/pubg-analysis/utils";
import {
  downloadFromR2,
  getPresignedUrlFromR2,
  isR2Configured,
  uploadToR2,
} from "@/lib/pubg-analysis/r2Service";
import {
  buildTelemetryPublicIdentity,
  pseudonymizeTelemetryAccountIds,
  pseudonymizeTelemetryTeammates,
} from "@/lib/pubg-analysis/telemetryCacheKey.server";
import {
  claimOrWaitForTelemetryMapCache,
  releaseTelemetryMapCacheRow,
  writeTelemetryMapCache,
  type TelemetryMapCacheDependencies,
} from "@/lib/pubg-analysis/telemetryMapCache";
import {
  claimTelemetryMapCacheReservation,
  finalizeTelemetryMapCacheLifecycle,
  releaseTelemetryMapCacheReservation,
} from "@/lib/pubg-analysis/telemetryRegistry.server";
import {
  createTelemetryIdentity,
  parseTelemetryMode,
  parseTelemetryPlatform,
  type TelemetryMode,
  type TelemetryPlatform,
} from "@/lib/pubg-analysis/telemetryIdentity";
import { createTelemetryPayload } from "@/lib/pubg-analysis/telemetryPayload";
import { reportPubgApiError } from "@/lib/pubg/apiHelper";

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!,
);

const MATCH_ID = /^[A-Za-z0-9._-]{1,160}$/;
const MAX_NICKNAME_LENGTH = 64;

function invalidRequest(message: string) {
  return NextResponse.json({ error: message }, { status: 400 });
}

export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const matchId = searchParams.get("matchId");
  const nickname = searchParams.get("nickname");
  const mapName = searchParams.get("mapName") || "Erangel";

  if (!matchId || !MATCH_ID.test(matchId)) {
    return invalidRequest("유효한 matchId 파라미터가 필요합니다.");
  }
  if (!nickname || nickname.trim().length === 0 || nickname.length > MAX_NICKNAME_LENGTH) {
    return invalidRequest("유효한 nickname 파라미터가 필요합니다.");
  }

  let platform: TelemetryPlatform;
  let mode: TelemetryMode;
  try {
    platform = parseTelemetryPlatform(searchParams.get("platform"));
    mode = parseTelemetryMode(searchParams.get("mode"));
  } catch {
    return invalidRequest("지원하지 않는 telemetry platform 또는 mode입니다.");
  }

  if (!isR2Configured()) {
    return NextResponse.json(
      { error: "텔레메트리 캐시 저장소를 사용할 수 없습니다." },
      { status: 503 },
    );
  }

  const lowerNickname = normalizeName(nickname);
  const apiKey = (process.env.PUBG_API_KEY || "").split(" ")[0];
  const headers = {
    Authorization: `Bearer ${apiKey}`,
    Accept: "application/vnd.api+json",
  };

  try {
    const matchRes = await fetch(
      `https://api.pubg.com/shards/${platform}/matches/${matchId}`,
      { headers, next: { revalidate: 3600 } },
    );
    if (matchRes.status === 404) {
      return NextResponse.json({ error: "매치를 찾을 수 없습니다." }, { status: 404 });
    }
    if (!matchRes.ok) throw new Error("PUBG match request failed");
    const matchData = await matchRes.json();

    const participants = matchData.included.filter((item: any) => item.type === "participant");
    const rosters = matchData.included.filter((item: any) => item.type === "roster");
    const asset = matchData.included.find((item: any) => item.type === "asset");
    if (!asset?.attributes?.URL) {
      return NextResponse.json({ error: "텔레메트리 데이터를 찾을 수 없습니다." }, { status: 404 });
    }

    const myInfo = participants.find(
      (p: any) => normalizeName(p.attributes.stats.name) === lowerNickname,
    );
    if (!myInfo) {
      return NextResponse.json({ error: "플레이어를 매치에서 찾을 수 없습니다." }, { status: 404 });
    }

    const canonicalNickname = myInfo.attributes.stats.name;
    const playerId = myInfo.attributes.stats.playerId || myInfo.attributes.accountId;
    if (!playerId) {
      return NextResponse.json({ error: "플레이어 식별자를 찾을 수 없습니다." }, { status: 404 });
    }

    const identity = createTelemetryIdentity({
      matchId,
      platform,
      playerId,
      mode,
      telemetryVersion: TELEMETRY_VERSION,
    });
    const deps: TelemetryMapCacheDependencies = {
      isConfigured: isR2Configured,
      download: downloadFromR2,
      upload: uploadToR2,
      sign: getPresignedUrlFromR2,
      claim: (row) => claimTelemetryMapCacheReservation(supabase, row),
      release: (row) => releaseTelemetryMapCacheReservation(supabase, row),
      finalize: (row) => finalizeTelemetryMapCacheLifecycle(supabase, {
        row,
        mapName: matchData.data.attributes.mapId || mapName,
        gameMode: matchData.data.attributes.gameMode || "unknown",
      }),
      now: () => new Date(),
      sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
      random: Math.random,
    };
    const cacheAccess = await claimOrWaitForTelemetryMapCache(identity, deps);
    if (cacheAccess.kind === "hit") {
      return NextResponse.json(
        {
          downloadUrl: cacheAccess.cache.downloadUrl,
          identity: cacheAccess.cache.payload.identity,
        },
        { headers: { "Cache-Control": "no-store" } },
      );
    }

    if (cacheAccess.kind === "pending") {
      return NextResponse.json(
        { error: "텔레메트리 생성이 진행 중입니다. 잠시 후 다시 시도해 주세요." },
        { status: 503, headers: { "Retry-After": "2" } },
      );
    }

    const reservedRow = cacheAccess.row;

    try {
      const telemetryRes = await fetch(asset.attributes.URL, { cache: "no-store" });
      if (!telemetryRes.ok) throw new Error("PUBG telemetry request failed");
      const events = await telemetryRes.json();

      const { AnalysisEngine } = await import("@/lib/pubg-analysis/AnalysisEngine");
      const engine = new AnalysisEngine(
        canonicalNickname,
        playerId,
        new Set(),
        new Set(),
        new Set(),
        new Set(),
        "",
        mode,
      );
      const result = engine.run(
        events,
        matchData.data.attributes,
        rosters,
        participants,
        myInfo.attributes.stats,
        [],
        { avg_damage: 200 },
      );
      const payload = createTelemetryPayload({
        identity: buildTelemetryPublicIdentity(identity),
        startTime: matchData.data.attributes.createdAt,
        teammates: pseudonymizeTelemetryTeammates(result.mapData?.teammates || []),
        teamNames: result.mapData?.teamNames || [canonicalNickname],
        events: pseudonymizeTelemetryAccountIds(result.mapData?.events || []),
        zoneEvents: pseudonymizeTelemetryAccountIds(result.mapData?.zoneEvents || []),
        mapName: result.mapName || matchData.data.attributes.mapName || mapName,
      });
      const cachedResult = await writeTelemetryMapCache(identity, payload, deps, { reservedRow });

      return NextResponse.json(
        { downloadUrl: cachedResult.downloadUrl, identity: cachedResult.payload.identity },
        { headers: { "Cache-Control": "no-store" } },
      );
    } catch (error) {
      await releaseTelemetryMapCacheRow(reservedRow, deps).catch(() => undefined);
      throw error;
    }
  } catch {
    await reportPubgApiError({
      route: "/api/pubg/telemetry",
      status: 500,
      message: "Telemetry request failed",
      detail: "Sanitized route error",
    });
    return NextResponse.json(
      { error: "텔레메트리를 처리할 수 없습니다." },
      { status: 500 },
    );
  }
}
