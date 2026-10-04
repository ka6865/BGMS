import { NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";
import { TELEMETRY_VERSION } from "@/lib/pubg-analysis/constants";
import { normalizeName } from "@/lib/pubg-analysis/utils";
import { filterTelemetryEvents, sampleReplayPositions } from "@/lib/pubg-analysis/telemetryContract";
import {
  containsTelemetryAccountEvidence,
  hasMatchingTelemetryDefinition,
  parseOrdinaryTelemetryUrl,
  relationshipBoundTelemetryAsset,
} from "@/lib/pubg-analysis/telemetrySource";
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
  readTelemetryMapCache,
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
  hasMatchingUpstreamMatchId,
  isCanonicalMatchId,
  parseTelemetryMode,
  parseTelemetryPlatform,
  type TelemetryMode,
  type TelemetryPlatform,
} from "@/lib/pubg-analysis/telemetryIdentity";
import { createTelemetryPayload } from "@/lib/pubg-analysis/telemetryPayload";
import {
  historicalMapIdentity,
  resolveHistoricalAccountId,
  selectHistoricalMapCacheCandidates,
} from "@/lib/pubg-analysis/historicalTelemetryMap";
import { readSharedTelemetrySource, writeSharedTelemetrySource } from "@/lib/pubg-analysis/sharedTelemetrySource";
import { reportPubgApiError } from "@/lib/pubg/apiHelper";
import { blockPrivatePlayer } from "@/lib/pubg/privatePlayerGuard";

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!,
);

const MAX_NICKNAME_LENGTH = 64;
const HISTORICAL_MAP_CANDIDATE_LIMIT = 8;
const HISTORICAL_LOOKUP_TIMEOUT_MS = 3_000;

function invalidRequest(message: string, errorCode = "PUBG_TELEMETRY_INVALID_REQUEST") {
  return NextResponse.json({ error: message, errorCode, retryable: false }, { status: 400 });
}

function upstreamIdentityMismatch() {
  return NextResponse.json({
    error: "PUBG 응답 매치 식별자가 요청과 일치하지 않습니다.",
    errorCode: "PUBG_MATCH_UPSTREAM_IDENTITY_MISMATCH",
    retryable: false,
  }, { status: 400 });
}

function notFound(message: string) {
  return NextResponse.json({ error: message }, { status: 404 });
}

async function readHistoricalAccountId(
  matchId: string,
  platform: TelemetryPlatform,
  playerId: string,
): Promise<ReturnType<typeof resolveHistoricalAccountId>> {
  const signal = AbortSignal.timeout(HISTORICAL_LOOKUP_TIMEOUT_MS);
  const [playerMatchesResult, processedResult] = await Promise.all([
    supabase.from("pubg_player_matches")
      .select("player_id, platform, account_id, match_id")
      .eq("match_id", matchId).eq("platform", platform).eq("player_id", playerId)
      .limit(4).abortSignal(signal),
    supabase.from("processed_match_telemetry")
      .select("player_id, platform, match_id, data")
      .eq("match_id", matchId).eq("platform", platform).eq("player_id", playerId)
      .limit(4).abortSignal(signal),
  ]);
  if (playerMatchesResult.error) throw playerMatchesResult.error;
  if (processedResult.error) throw processedResult.error;
  return resolveHistoricalAccountId({
    matchId,
    platform,
    playerId,
    playerMatchRows: playerMatchesResult.data,
    processedRows: processedResult.data,
  });
}

function getParticipantsAndRosters(matchData: any) {
  const included = Array.isArray(matchData?.included) ? matchData.included : [];
  return {
    participants: included.filter((item: any) => item?.type === "participant"),
    rosters: included.filter((item: any) => item?.type === "roster"),
  };
}

function findRequestedParticipant(
  participants: any[],
  nickname: string,
  expectedAccountId?: string,
) {
  const matches = participants.filter((participant) => {
    const stats = participant.attributes?.stats;
    const accountId = stats?.playerId || stats?.accountId || participant.attributes?.accountId;
    return normalizeName(stats?.name) === nickname
      && (!expectedAccountId || accountId === expectedAccountId)
      && typeof accountId === "string" && isSupportedParticipantAccountId(accountId);
  });
  return matches.length === 1 ? matches[0] : null;
}

function isSupportedParticipantAccountId(accountId: string): boolean {
  try {
    createTelemetryIdentity({
      matchId: "participant-validation",
      platform: "steam",
      playerId: accountId,
      mode: "lite",
      telemetryVersion: TELEMETRY_VERSION,
    });
    return true;
  } catch {
    return false;
  }
}

function responseFromCache(cache: { downloadUrl: string; payload: { identity: unknown } }) {
  return NextResponse.json(
    { downloadUrl: cache.downloadUrl, identity: cache.payload.identity },
    { headers: { "Cache-Control": "no-store" } },
  );
}

export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const matchId = searchParams.get("matchId");
  const nickname = searchParams.get("nickname");
  const mapName = searchParams.get("mapName") || "Erangel";

  if (!isCanonicalMatchId(matchId)) {
    return invalidRequest("유효한 matchId 파라미터가 필요합니다.", "PUBG_MATCH_INVALID_ID");
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

  const lowerNickname = normalizeName(nickname);
  try {
    const privateResponse = await blockPrivatePlayer(platform, nickname);
    if (privateResponse) return privateResponse;
    if (!isR2Configured()) {
      return NextResponse.json({ error: "텔레메트리 캐시 저장소를 사용할 수 없습니다." }, { status: 503 });
    }

    // Historical identity authorizes offline saved-map lookup. Its absence
    // leaves the ordinary authoritative shared/upstream participant flow intact.
    const historicalIdentity = await readHistoricalAccountId(matchId, platform, lowerNickname);
    if (historicalIdentity.status === "conflict") {
      return notFound("저장된 매치의 플레이어 식별자가 일치하지 않습니다.");
    }
    const historicalPlayerId = historicalIdentity.status === "resolved" ? historicalIdentity.accountId : null;

    const cacheDeps: TelemetryMapCacheDependencies = {
      isConfigured: isR2Configured,
      download: downloadFromR2,
      upload: uploadToR2,
      sign: getPresignedUrlFromR2,
      claim: (row) => claimTelemetryMapCacheReservation(supabase, row),
      release: (row) => releaseTelemetryMapCacheReservation(supabase, row),
      finalize: (row) => finalizeTelemetryMapCacheLifecycle(supabase, {
        row,
        mapName: "unknown",
        gameMode: "unknown",
      }),
      now: () => new Date(),
      sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
      random: Math.random,
    };
    const readOldMap = async (playerId: string) => {
      const baseIdentity = historicalMapIdentity(matchId, platform, playerId, mode);
      const { data: cacheRows, error: cacheRowsError } = await supabase
        .from("telemetry_map_cache_entries")
        .select("match_id, platform, player_id, mode, telemetry_version, storage_path, status")
        .eq("match_id", matchId).eq("platform", platform).eq("player_id", playerId)
        .eq("mode", mode).eq("status", "ready")
        .lte("telemetry_version", TELEMETRY_VERSION)
        .order("telemetry_version", { ascending: false })
        .limit(HISTORICAL_MAP_CANDIDATE_LIMIT)
        .abortSignal(AbortSignal.timeout(HISTORICAL_LOOKUP_TIMEOUT_MS));
      if (cacheRowsError) throw cacheRowsError;
      const candidates = selectHistoricalMapCacheCandidates(cacheRows, baseIdentity, TELEMETRY_VERSION, HISTORICAL_MAP_CANDIDATE_LIMIT);
      for (const candidate of candidates) {
        try {
          const cached = await readTelemetryMapCache(candidate.identity, cacheDeps);
          if (cached && cached.storagePath === candidate.storagePath) return responseFromCache(cached);
        } catch {
          // A stale or unreadable legacy object is a miss for this identity.
        }
      }
      return null;
    };

    if (historicalPlayerId) {
      const privateAccountResponse = await blockPrivatePlayer(platform, nickname, historicalPlayerId);
      if (privateAccountResponse) return privateAccountResponse;
      const oldMapResponse = await readOldMap(historicalPlayerId);
      if (oldMapResponse) return oldMapResponse;
    }

    let sharedSource = null;
    try {
      sharedSource = await readSharedTelemetrySource(matchId, platform);
    } catch {
      // Shared storage is an optimization; a transient read failure keeps the
      // established official match/telemetry fetch path available.
    }
    let matchData: any;
    let participants: any[];
    let rosters: any[];
    let myInfo: any;
    let telemetryEvents: unknown[] | null = null;
    let telemetryUrl: string | null = null;

    if (sharedSource) {
      matchData = sharedSource.matchData;
      if (!hasMatchingUpstreamMatchId(matchData, matchId)) return upstreamIdentityMismatch();
      ({ participants, rosters } = getParticipantsAndRosters(matchData));
      myInfo = findRequestedParticipant(participants, lowerNickname, historicalPlayerId || undefined);
      if (!myInfo) return notFound("플레이어를 매치에서 찾을 수 없습니다.");
      telemetryEvents = sharedSource.events;
    } else {
      const apiKey = (process.env.PUBG_API_KEY || "").split(" ")[0];
      const headers = {
        Authorization: `Bearer ${apiKey}`,
        Accept: "application/vnd.api+json",
      };
      const matchRes = await fetch(
        `https://api.pubg.com/shards/${platform}/matches/${matchId}`,
        { headers, next: { revalidate: 3600 } },
      );
      if (matchRes.status === 404) return notFound("매치를 찾을 수 없습니다.");
      if (!matchRes.ok) throw new Error("PUBG match request failed");
      matchData = await matchRes.json();
      if (!hasMatchingUpstreamMatchId(matchData, matchId)) return upstreamIdentityMismatch();
      ({ participants, rosters } = getParticipantsAndRosters(matchData));
      myInfo = findRequestedParticipant(participants, lowerNickname, historicalPlayerId || undefined);
      if (!myInfo) return notFound("플레이어를 매치에서 찾을 수 없습니다.");
      const assetBinding = relationshipBoundTelemetryAsset(matchData);
      const asset = assetBinding?.asset as { attributes?: { URL?: string } } | undefined;
      if (!asset?.attributes?.URL || !assetBinding) return notFound("텔레메트리 데이터를 찾을 수 없습니다.");
      telemetryUrl = parseOrdinaryTelemetryUrl(asset.attributes.URL, assetBinding.id);
    }

    const participantAccountId = myInfo.attributes.stats.playerId
      || myInfo.attributes.stats.accountId
      || myInfo.attributes.accountId;
    if (historicalPlayerId && participantAccountId !== historicalPlayerId) return notFound("플레이어를 매치에서 찾을 수 없습니다.");
    const playerId = historicalPlayerId || participantAccountId;
    const accountPrivateResponse = await blockPrivatePlayer(platform, myInfo.attributes.stats.name, playerId);
    if (accountPrivateResponse) return accountPrivateResponse;

    if (!historicalPlayerId) {
      const oldMapResponse = await readOldMap(playerId);
      if (oldMapResponse) return oldMapResponse;
    }

    const canonicalNickname = myInfo.attributes.stats.name;
    const myRoster = rosters.find((roster: any) =>
      roster.relationships?.participants?.data?.some((ref: any) => ref.id === myInfo.id),
    );
    const teamParticipants = myRoster
      ? myRoster.relationships.participants.data
        .map((ref: any) => participants.find((participant: any) => participant.id === ref.id))
        .filter(Boolean)
      : [myInfo];
    const teamStats = teamParticipants
      .map((participant: any) => participant.attributes?.stats)
      .filter(Boolean);
    const teamNames = new Set<string>(teamStats
      .map((stats: any) => normalizeName(stats.name))
      .filter((name: string) => name.length > 0));
    const teamAccountIds = new Set<string>(teamParticipants
      .map((participant: any) => participant.attributes?.stats?.playerId
        || participant.attributes?.stats?.accountId || participant.attributes?.accountId)
      .filter((id: unknown): id is string => typeof id === "string" && id.length > 0));

    const identity = createTelemetryIdentity({
      matchId, platform, playerId, mode, telemetryVersion: TELEMETRY_VERSION,
    });
    const deps: TelemetryMapCacheDependencies = {
      ...cacheDeps,
      finalize: (row) => finalizeTelemetryMapCacheLifecycle(supabase, {
        row,
        mapName: matchData.data.attributes.mapId || mapName,
        gameMode: matchData.data.attributes.gameMode || "unknown",
      }),
    };
    const cacheAccess = await claimOrWaitForTelemetryMapCache(identity, deps);
    if (cacheAccess.kind === "hit") return responseFromCache(cacheAccess.cache);
    if (cacheAccess.kind === "pending") {
      return NextResponse.json(
        { error: "텔레메트리 생성이 진행 중입니다. 잠시 후 다시 시도해 주세요." },
        { status: 503, headers: { "Retry-After": "2" } },
      );
    }

    const reservedRow = cacheAccess.row;
    try {
      if (!telemetryEvents) {
        const telemetryRes = await fetch(telemetryUrl!, {
          cache: "no-store", redirect: "error", signal: AbortSignal.timeout(15_000),
        });
        if (!telemetryRes.ok) throw new Error("PUBG telemetry request failed");
        if (telemetryRes.url !== telemetryUrl) throw new Error("PUBG telemetry source changed");
        const rawTelemetry = await telemetryRes.json();
        if (!hasMatchingTelemetryDefinition(rawTelemetry, matchId, platform)) {
          await releaseTelemetryMapCacheRow(reservedRow, deps);
          return upstreamIdentityMismatch();
        }
        const fullEvents = filterTelemetryEvents(rawTelemetry, {
          mode: "full", teamNames: new Set(), teamAccountIds: new Set(),
        });
        if (!fullEvents.length || !containsTelemetryAccountEvidence(fullEvents, playerId)) {
          await releaseTelemetryMapCacheRow(reservedRow, deps);
          return upstreamIdentityMismatch();
        }
        await writeSharedTelemetrySource(matchData, platform, fullEvents).catch(() => {
          console.warn("[PUBG shared source] retention failed", { route: "/api/pubg/telemetry", platform, matchId });
        });
        telemetryEvents = fullEvents;
      }

      if (!telemetryEvents.length || !containsTelemetryAccountEvidence(telemetryEvents, playerId)) {
        await releaseTelemetryMapCacheRow(reservedRow, deps);
        return upstreamIdentityMismatch();
      }
      const events = filterTelemetryEvents(telemetryEvents, { mode: "full", teamNames, teamAccountIds });
      if (!events.length || !containsTelemetryAccountEvidence(events, playerId)) {
        await releaseTelemetryMapCacheRow(reservedRow, deps);
        return upstreamIdentityMismatch();
      }

      const { AnalysisEngine } = await import("@/lib/pubg-analysis/AnalysisEngine");
      const engine = new AnalysisEngine(
        canonicalNickname, playerId, teamNames, teamAccountIds, new Set(), new Set(), myRoster?.id || "", mode,
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
        events: pseudonymizeTelemetryAccountIds(sampleReplayPositions(result.mapData?.events || [], mode)),
        zoneEvents: pseudonymizeTelemetryAccountIds(result.mapData?.zoneEvents || []),
        mapName: result.mapName || matchData.data.attributes.mapName || mapName,
      });
      const cachedResult = await writeTelemetryMapCache(identity, payload, deps, { reservedRow });
      return responseFromCache(cachedResult);
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
