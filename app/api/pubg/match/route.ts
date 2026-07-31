import { createHash, timingSafeEqual } from "node:crypto";
import { after, NextRequest, NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";
import { unstable_cache } from "next/cache"; // [ISR V1.0] Next.js 16 캐싱 API
import { AnalysisEngine } from "@/lib/pubg-analysis/AnalysisEngine";
import { RESULT_VERSION, TELEMETRY_VERSION } from "@/lib/pubg-analysis/constants";
import { normalizeName } from "@/lib/pubg-analysis/utils";
import { adaptBenchmark } from "@/lib/pubg-analysis/benchmarkAdapter";
import { fetchTierBenchmarkStats } from "@/lib/pubg-analysis/benchmarkLookup";
import { buildProcessedTelemetryUpsert, getValidFullResult, normalizePlatform } from "@/lib/pubg-analysis/cacheIdentity";
import {
  downloadFromR2,
  getPresignedUrlFromR2,
  isR2Configured,
  uploadToR2,
} from "@/lib/pubg-analysis/r2Service";
import {
  claimOrWaitForTelemetryMapCache,
  claimTelemetryMapCacheRow,
  releaseTelemetryMapCacheRow,
  writeTelemetryMapCache,
  type TelemetryMapCacheRegistryRow,
} from "@/lib/pubg-analysis/telemetryMapCache";
import {
  claimTelemetryMapCacheReservation,
  finalizeTelemetryMapCacheLifecycle,
  releaseTelemetryMapCacheReservation,
  TelemetryRegistryError,
} from "@/lib/pubg-analysis/telemetryRegistry.server";
import { createTelemetryIdentity } from "@/lib/pubg-analysis/telemetryIdentity";
import {
  buildTelemetryPublicIdentity,
  pseudonymizeTelemetryAccountIds,
  pseudonymizeTelemetryTeammates,
} from "@/lib/pubg-analysis/telemetryCacheKey.server";
import { createTelemetryPayload } from "@/lib/pubg-analysis/telemetryPayload";
import { trackPubgRateLimit } from "@/lib/pubg-analysis/pubgApiTracker";
import {
  persistMatchAnalysis,
  type AnalysisSource,
  type PubgPlatform,
} from "@/lib/pubg-analysis/persistMatchAnalysis";
import {
  reportPubgApiError,
  type PubgApiErrorContext,
} from "@/lib/pubg/apiHelper";
import {
  classifyClientKind,
  classifyPubgMatchError,
  createPubgIdentifierFingerprint,
  type PubgAnalysisStep,
  type PubgErrorStage,
} from "@/lib/pubg/apiErrorContext";

// [ISR V1.0] force-dynamic 유지: PUBG API 호출, R2 업로드, DB Upsert 등 부수효과 보호
// unstable_cache는 DB 읽기(캐시 조회) 전용 프록시로만 사용
export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
);

async function safeJsonParse(res: Response): Promise<any> {
  const contentType = res.headers.get("content-type") || "";
  if (!contentType.includes("json")) {
    throw new Error(`PUBG API 응답이 JSON 형식이 아닙니다 (Content-Type: ${contentType}, Status: ${res.status}). API 호출 한도 초과 또는 일시적인 장애일 수 있습니다.`);
  }
  try {
    return await res.json();
  } catch (err: any) {
    throw new Error(`JSON 파싱 실패: ${err.message}`);
  }
}

const MAP_NAMES: Record<string, string> = {
  "Baltic_Main": "에란겔", "Savage_Main": "사녹", "Desert_Main": "미라마",
  "Summerland_Main": "카라킨", "Chimera_Main": "파라모", "Tiger_Main": "태이고",
  "Kiki_Main": "데스턴", "Neon_Main": "론도", "DihorOtok_Main": "비켄디"
};

/**
 * [ISR V1.0] Supabase DB 조회를 Next.js 16 unstable_cache로 래핑
 * - Cache Hit 시: DB 커넥션 0건, 메모리/Edge 캐시에서 즉시 반환
 * - Cache Miss 시: DB 1회 조회 후 결과를 캐시에 자동 적재
 * - revalidateTag('match-analysis') 호출 시: 모든 캐시 엔트리 즉각 만료
 */
const getCachedMatchTelemetry = unstable_cache(
  async (matchId: string, lowerNickname: string, platform: string) => {
    const { data: cachedResult, error } = await supabase
      .from("processed_match_telemetry")
      .select("data")
      .eq("match_id", matchId)
      .eq("platform", normalizePlatform(platform))
      .eq("player_id", lowerNickname)
      .maybeSingle();

    if (error) {
      return null;
    }
    return cachedResult || null;
  },
  ["match-telemetry"], // 캐시 네임스페이스 키
  {
    tags: ["match-analysis"], // revalidateTag('match-analysis')로 무효화
    revalidate: 604800 // 7일간 캐시 보존 (배포 시 revalidateTag로 즉시 소각)
  }
);

const MAP_IDS: Record<string, string> = {
  "Baltic_Main": "erangel", "Savage_Main": "sanhok", "Desert_Main": "miramar",
  "Summerland_Main": "karakin", "Chimera_Main": "paramo", "Tiger_Main": "taego",
  "Kiki_Main": "deston", "Neon_Main": "rondo", "DihorOtok_Main": "vikendi"
};

function getConfiguredToken(name: "PUBG_SCRAPER_INTERNAL_TOKEN" | "ADMIN_REVALIDATE_TOKEN") {
  const token = process.env[name];
  return token && token.trim().length > 0 ? token : null;
}

function matchesToken(providedToken: string | null, expectedToken: string): boolean {
  if (!providedToken) return false;

  const providedDigest = createHash("sha256").update(providedToken).digest();
  const expectedDigest = createHash("sha256").update(expectedToken).digest();
  return timingSafeEqual(providedDigest, expectedDigest);
}

function getBearerToken(request: NextRequest): string | null {
  const authorization = request.headers.get("Authorization");
  if (!authorization?.startsWith("Bearer ")) return null;
  return authorization.slice("Bearer ".length) || null;
}

async function reportBackgroundReanalysisFailure(): Promise<void> {
  try {
    await reportPubgApiError({
      route: "/api/pubg/match/revalidate",
      status: 500,
      message: "Background match reanalysis failed",
      detail: "Sanitized background error",
    });
  } catch {
    console.error("[MATCH] 백그라운드 오류 기록 실패");
  }
}

function createTacticalResponse(result: any) {
  const tacticalResult = { ...result };
  delete tacticalResult.mapData;
  return pseudonymizeTelemetryAccountIds(tacticalResult);
}

function serializeTelemetryCacheFailure(
  error: unknown,
  startedAt: number,
): string {
  const registryError = error instanceof TelemetryRegistryError ? error : null;
  return JSON.stringify({
    operation: registryError?.operation ?? "unknown",
    code: registryError?.code ?? null,
    status: registryError?.status ?? null,
    retryCount: registryError?.retryCount ?? 0,
    elapsedMs: Date.now() - startedAt,
  });
}

async function reportTelemetryCachePersistenceFailure(
  error: unknown,
  startedAt: number,
  requestContext: PubgApiErrorContext,
): Promise<void> {
  const analysisStep: PubgAnalysisStep = "telemetry_cache_persistence";
  const errorCode = "PUBG_MATCH_ANALYSIS_TELEMETRY_CACHE_PERSISTENCE";
  try {
    await reportPubgApiError({
      route: "/api/pubg/match",
      status: 503,
      message: errorCode,
      detail: serializeTelemetryCacheFailure(error, startedAt),
      notify: true,
      context: {
        ...requestContext,
        failureStage: `analysis:${analysisStep}`,
        errorCode,
        durationMs: Date.now() - startedAt,
      },
    });
  } catch {
    return;
  }
}

export async function GET(request: NextRequest) {
  const startedAt = Date.now();
  let failureStage: PubgErrorStage = "cache_lookup";
  let analysisStep: PubgAnalysisStep | null = null;
  let upstreamStatus: number | null = null;
  const { searchParams } = request.nextUrl;
  const matchId = searchParams.get("matchId");
  const nickname = searchParams.get("nickname");
  const platformValue = searchParams.get("platform");
  if (!platformValue) {
    return NextResponse.json({ error: "Invalid platform" }, { status: 400 });
  }
  const platformParam = normalizePlatform(platformValue);
  const lowerNickname = normalizeName(nickname || "");
  const force = searchParams.get("force") === "true";
  const sourceParam = searchParams.get("source") || "user";

  if (platformParam !== "steam" && platformParam !== "kakao") {
    return NextResponse.json({ error: "Invalid platform" }, { status: 400 });
  }
  const platform: PubgPlatform = platformParam;

  if (sourceParam !== "user" && sourceParam !== "scraper") {
    return NextResponse.json({ error: "Invalid source" }, { status: 400 });
  }
  const source: AnalysisSource = sourceParam;
  const requestContext: PubgApiErrorContext = {
    platform,
    source,
    clientKind: classifyClientKind(request.headers.get("user-agent")),
    requestId: request.headers.get("x-vercel-id"),
    matchFingerprint: createPubgIdentifierFingerprint(matchId),
    nicknameFingerprint: createPubgIdentifierFingerprint(nickname),
  };

  if (source === "scraper") {
    const scraperToken = getConfiguredToken("PUBG_SCRAPER_INTERNAL_TOKEN");
    if (!scraperToken) {
      return NextResponse.json({ error: "Scraper authentication unavailable" }, { status: 503 });
    }
    if (!matchesToken(getBearerToken(request), scraperToken)) {
      return NextResponse.json({ error: "Forbidden" }, { status: 403 });
    }
  }

  if (force) {
    const adminToken = getConfiguredToken("ADMIN_REVALIDATE_TOKEN");
    if (!adminToken) {
      return NextResponse.json({ error: "Admin authentication unavailable" }, { status: 503 });
    }
    if (!matchesToken(request.headers.get("X-BGMS-Admin-Token"), adminToken)) {
      return NextResponse.json({ error: "Forbidden" }, { status: 403 });
    }
  }

  // [MOCK] 로컬 DB 장애 및 시뮬레이션을 위한 골드 매치 모킹
  if (matchId === "match-gold-simulation-1234") {
    try {
      const fs = await import("fs");
      const path = await import("path");
      const filePath = path.join(process.cwd(), "scratch", "mock_gold_match_data.json");
      if (fs.existsSync(filePath)) {
        const data = fs.readFileSync(filePath, "utf-8");
        return NextResponse.json(JSON.parse(data));
      }
    } catch {
    }
  }

  if (!matchId || !nickname) {
    return NextResponse.json({ error: "Missing required parameters" }, { status: 400 });
  }

  try {
    const shouldForce = force;
    let cachedFullResult: any = null;

    if (!shouldForce) {
      const cachedData = await getCachedMatchTelemetry(matchId, lowerNickname, platform) as any;
      cachedFullResult = getValidFullResult(cachedData, lowerNickname, platform);
      if (cachedFullResult && (
        (cachedFullResult.v || 0) >= RESULT_VERSION
        || !isR2Configured()
      )) {
        return NextResponse.json(createTacticalResponse(cachedFullResult));
      }
    }

    if (!isR2Configured()) {
      return NextResponse.json(
        { error: "텔레메트리 캐시 저장소를 사용할 수 없습니다." },
        { status: 503 },
      );
    }

    const apiKey = (process.env.PUBG_API_KEY || "").split(" ")[0];
    failureStage = "match_fetch";
    const res = await fetch(`https://api.pubg.com/shards/${platform}/matches/${matchId}`, {
      headers: { Authorization: `Bearer ${apiKey}`, Accept: "application/vnd.api+json" },
      cache: "no-store",
      signal: AbortSignal.timeout(15000)
    });
    upstreamStatus = res.status;
    trackPubgRateLimit(res.headers);

    if (!res.ok) {
      throw new Error(`PUBG API Match Load Failed: ${res.status}`);
    }
    failureStage = "match_parse";
    const matchData = await safeJsonParse(res);
    const matchAttr = matchData.data.attributes;

    const participants = matchData.included.filter((it: any) => it.type === "participant");
    const rosters = matchData.included.filter((it: any) => it.type === "roster");

    failureStage = "participant_lookup";
    const myParticipant = participants.find((p: any) => normalizeName(p.attributes.stats.name) === lowerNickname);
    if (!myParticipant) throw new Error(`Player ${nickname} not found in match participants`);

    const myAccountId = myParticipant.attributes.stats.playerId || myParticipant.attributes.accountId;
    if (!myAccountId) {
      return NextResponse.json({ error: "Player account identifier is unavailable" }, { status: 404 });
    }
    const canonicalNickname = myParticipant.attributes.stats.name;

    // [V55.0] 닉네임 캐시 최적화: 분석 대상 플레이어 1명만 즉시 업데이트 (데드락 방지)
    const myCacheEntry = {
      id: myAccountId,
      platform,
      nickname: myParticipant.attributes.stats.name,
      lower_nickname: myParticipant.attributes.stats.name.toLowerCase(),
      updated_at: new Date().toISOString()
    };

    supabase.from('pubg_player_cache').upsert(myCacheEntry, { onConflict: 'id' })
      .then(() => undefined);

    const myRoster = rosters.find((r: any) => r.relationships.participants.data.some((p: any) => p.id === myParticipant.id));
    const myRosterId = myRoster?.id || "";

    const teamStats = myRoster 
      ? myRoster.relationships.participants.data.map((pRef: any) => participants.find((p: any) => p.id === pRef.id)?.attributes.stats).filter(Boolean)
      : [myParticipant.attributes.stats];

    const teamNames = new Set<string>(teamStats.map((m: any) => normalizeName(m.name)));
    const teamAccountIds = new Set<string>(teamStats.map((m: any) => (m.playerId || m.accountId) as string).filter(Boolean));

    const humanParticipants = participants.filter((p: any) => !p.attributes.accountId?.startsWith("ai."));
    const sortedByDamage = [...humanParticipants].map(p => p.attributes.stats).sort((a, b) => b.damageDealt - a.damageDealt);
    const myDamageRank = sortedByDamage.findIndex((s: any) => normalizeName(s.name) === lowerNickname) + 1;
    const rankPct = humanParticipants.length > 0 ? myDamageRank / humanParticipants.length : 1;

    if (!shouldForce && cachedFullResult) {
      const cachedVersion = cachedFullResult.v || 0;
        
      // [Stale-While-Revalidate] 캐시 데이터 버전이 낮으면 백그라운드 재분석 기동
      if (cachedVersion < RESULT_VERSION) {
        after(async () => {
          try {
            await reanalyzeAndSave(
              matchId, canonicalNickname, platform, lowerNickname, matchData, teamNames, teamAccountIds,
              myRosterId, myParticipant, myAccountId, teamStats, rankPct, matchAttr, rosters, participants,
              true, source, startedAt, requestContext,
            );
          } catch {
            await reportBackgroundReanalysisFailure();
          }
        });
      }

      // 샘플 참가자 추출 (기존 response 형식 호환)
      const allParticipantNames = participants
        .filter((p: any) => !p.attributes.stats.playerId?.startsWith("ai."))
        .map((p: any) => p.attributes.stats.name)
        .filter((name: string) => normalizeName(name) !== lowerNickname);
      const sampleParticipants = allParticipantNames
        .sort(() => 0.5 - Math.random())
        .slice(0, 5);

      return NextResponse.json({
        ...createTacticalResponse(cachedFullResult),
        sampleParticipants
      });
    }

    // 캐시가 없거나 강제 업데이트가 필요한 경우 동기식 분석 실행
    failureStage = "analysis";
    const finalResponse = await reanalyzeAndSave(
      matchId, canonicalNickname, platform, lowerNickname, matchData, teamNames, teamAccountIds,
      myRosterId, myParticipant, myAccountId, teamStats, rankPct, matchAttr, rosters, participants,
      shouldForce, source, startedAt, requestContext, (step) => {
        analysisStep = step;
      }
    );

    return NextResponse.json(finalResponse);

  } catch (err: unknown) {
    const classification = classifyPubgMatchError({
      stage: failureStage,
      analysisStep,
      upstreamStatus,
      error: err,
    });
    const errorMsg = classification.responseStatus === 404
      ? "매치 데이터를 찾을 수 없습니다. 최근 14일 내 매치인지 확인해 주세요."
      : classification.responseStatus === 429
        ? "PUBG API 호출 한도가 일시적으로 초과되었습니다. 약 1분 후 다시 시도해 주세요."
        : "매치 데이터를 처리할 수 없습니다.";

    await reportPubgApiError({
      route: "/api/pubg/match",
      status: classification.responseStatus,
      message: classification.errorCode,
      detail: "Sanitized route error",
      notify: classification.responseStatus >= 500 || classification.responseStatus === 429,
      context: {
        failureStage: analysisStep ? `analysis:${analysisStep}` : failureStage,
        errorCode: classification.errorCode,
        upstreamStatus,
        durationMs: Date.now() - startedAt,
        platform,
        source,
        clientKind: classifyClientKind(request.headers.get("user-agent")),
        requestId: request.headers.get("x-vercel-id"),
        matchFingerprint: createPubgIdentifierFingerprint(matchId),
        nicknameFingerprint: createPubgIdentifierFingerprint(nickname),
      },
    });

    return NextResponse.json({ error: errorMsg }, { status: classification.responseStatus });
  }
}

/**
 * 텔레메트리를 분석하고 분석 데이터를 R2 스토리지 및 DB에 저장하는 중추 로직
 */
async function reanalyzeAndSave(
  matchId: string,
  canonicalNickname: string,
  platform: PubgPlatform,
  lowerNickname: string,
  matchData: any,
  teamNames: Set<string>,
  teamAccountIds: Set<string>,
  myRosterId: string,
  myParticipant: any,
  myAccountId: string,
  teamStats: any[],
  rankPct: number,
  matchAttr: any,
  rosters: any[],
  participants: any[],
  force: boolean,
  source: AnalysisSource,
  startedAt: number,
  requestContext: PubgApiErrorContext,
  onAnalysisStep?: (step: PubgAnalysisStep) => void,
) {
  const markAnalysisStep = (step: PubgAnalysisStep) => onAnalysisStep?.(step);
  markAnalysisStep("telemetry_cache_reserve");
  const telemetryIdentity = createTelemetryIdentity({
    matchId,
    platform,
    playerId: myAccountId,
    mode: "lite",
    telemetryVersion: TELEMETRY_VERSION,
  });
  const cacheDeps = {
    isConfigured: isR2Configured,
    download: downloadFromR2,
    upload: uploadToR2,
    sign: getPresignedUrlFromR2,
    claim: (row: TelemetryMapCacheRegistryRow) => claimTelemetryMapCacheReservation(supabase, row),
    release: (row: TelemetryMapCacheRegistryRow) => releaseTelemetryMapCacheReservation(supabase, row),
    finalize: (row: TelemetryMapCacheRegistryRow) => finalizeTelemetryMapCacheLifecycle(supabase, {
      row,
      mapName: matchAttr.mapName || matchAttr.mapId || "unknown",
      gameMode: matchAttr.gameMode || "unknown",
    }),
    now: () => new Date(),
    sleep: (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)),
    random: Math.random,
  };
  const cacheAccess = await claimOrWaitForTelemetryMapCache(telemetryIdentity, cacheDeps);
  let reservedRow: TelemetryMapCacheRegistryRow | undefined;

  if (cacheAccess.kind === "hit") {
    const { data, error } = await supabase
      .from("processed_match_telemetry")
      .select("data")
      .eq("match_id", matchId)
      .eq("platform", normalizePlatform(platform))
      .eq("player_id", lowerNickname)
      .maybeSingle();
    const cachedFullResult = error ? null : getValidFullResult(data, lowerNickname, platform);
    if (cachedFullResult) {
      const sampleParticipants = participants
        .filter((p: any) => !p.attributes.stats.playerId?.startsWith("ai."))
        .map((p: any) => p.attributes.stats.name)
        .filter((name: string) => normalizeName(name) !== lowerNickname)
        .sort(() => 0.5 - Math.random())
        .slice(0, 5);
      return {
        ...createTacticalResponse(cachedFullResult),
        sampleParticipants,
      };
    }
    reservedRow = await claimTelemetryMapCacheRow(telemetryIdentity, cacheDeps) ?? undefined;
  } else if (cacheAccess.kind === "claimed") {
    reservedRow = cacheAccess.row;
  }

  if (!reservedRow) {
    throw new Error("telemetry-map-cache-write-in-progress");
  }

  try {
  const telemetryAsset = matchData.included.find((it: any) => it.type === "asset");
  let telData: any[] = [];

  if (telemetryAsset) {
    const analyzePath = `${matchId}_${lowerNickname}_v${TELEMETRY_VERSION}_analyze.json`;
    markAnalysisStep("telemetry_r2_read");
    const fileText = force ? null : await downloadFromR2(analyzePath);

    let needsProcessing = !fileText;
    if (fileText) {
      const parsed = JSON.parse(fileText);
      const isHealthy = parsed.length > 0 && parsed.some((ev: any) => ev.attacker?.accountId || ev.victim?.accountId);
      if (isHealthy) {
        telData = parsed;
      } else {
        needsProcessing = true;
      }
    }

    if (needsProcessing) {
      markAnalysisStep("telemetry_download");
      const telRes = await fetch(telemetryAsset.attributes.URL);
      markAnalysisStep("telemetry_parse");
      const rawTel = await safeJsonParse(telRes);

      let posCount = 0;
      markAnalysisStep("telemetry_filter");
      telData = rawTel.filter((e: any) => {
        if (e._T === "LogPlayerPosition") {
          const pName = normalizeName(e.character?.name || "");
          if (teamNames.has(pName)) return true;
          return (++posCount) % 10 === 0;
        }
        return [
          "LogMatchStart", "LogPlayerCreate", "LogPlayerKill", "LogPlayerKillV2",
          "LogPlayerMakeGroggy", "LogPlayerRevive", "LogPlayerRecall",
          "LogPlayerRecallShip", "LogPlayerRedeploy", "LogPlayerRedeployBRStart",
          "LogPlayerTakeDamage", "LogItemUse", "LogPlayerUseThrowable",
          "LogThrowableUse", "LogProjectileHit", "LogGameStatePeriodic",
          "LogPhaseChange", "LogParachuteLanding", "LogMatchEnd"
        ].includes(e._T);
      }).map((e: any) => {
        const slim: any = { _T: e._T, _D: e._D };
        const normLoc = (loc: any) => {
          if (!loc) return null;
          return { x: Math.round(loc.x), y: Math.round(loc.y), z: Math.round(loc.z || 0) };
        };

        if (e._T === "LogGameStatePeriodic") {
          const gs = e.gameState;
          slim.gameState = {
            safetyZonePosition: normLoc(gs.safetyZonePosition),
            safetyZoneRadius: Math.round(gs.safetyZoneRadius),
            poisonGasWarningPosition: normLoc(gs.poisonGasWarningPosition),
            poisonGasWarningRadius: gs.poisonGasWarningRadius != null ? Math.round(gs.poisonGasWarningRadius) : null
          };
          return slim;
        }

        const actors = ["attacker", "victim", "killer", "maker", "dBNOMaker", "finisher", "character", "recaller", "reviver", "item", "recallingPlayer", "recalledPlayer"];
        actors.forEach(key => {
          if (e[key]) {
            const char = e[key];
            slim[key] = {
              name: (typeof char === 'string' ? char : (char.name || char.characterName || char.itemId)),
              accountId: char.accountId || char.playerId,
              teamId: char.teamId,
              location: normLoc(char.location),
              vehicle: char.vehicle
            };
          }
        });

        if (e.recalledPlayers && Array.isArray(e.recalledPlayers)) {
          slim.recalledPlayers = e.recalledPlayers.map((p: any) => ({
            name: p.name || p.characterName,
            accountId: p.accountId || p.playerId,
            teamId: p.teamId,
            location: normLoc(p.location)
          }));
        }

        const keepFields = ["damage", "damageReason", "damageTypeCategory", "damageCauserName", "damageCauser", "distance", "weapon", "weaponId", "dBNOId", "phase", "isGame", "attackId", "killerDamageInfo", "finishDamageInfo", "dBNODamageInfo", "reviveType", "vehicle"];
        keepFields.forEach(f => { if (e[f] !== undefined) slim[f] = e[f]; });

        if (e.common?.isGame !== undefined) slim.common = { isGame: e.common.isGame };
        else if (e.Common?.IsGame !== undefined) slim.Common = { IsGame: e.Common.IsGame };

        if (e._T === "LogMatchEnd") {
          if (e.allWeaponStats !== undefined) slim.allWeaponStats = e.allWeaponStats;
          if (e.characters !== undefined) slim.characters = e.characters;
        }

        return slim;
      });

      markAnalysisStep("telemetry_r2_upload");
      await uploadToR2(analyzePath, JSON.stringify(telData), 'application/json');
    }
  }

  const getMatchTier = (pct: number) => {
    if (pct <= 0.1) return 'S';
    if (pct <= 0.3) return 'A';
    if (pct <= 0.6) return 'B';
    return 'C';
  };
  const matchTier = getMatchTier(rankPct);

  markAnalysisStep("benchmark_lookup");
  const tierStats = await fetchTierBenchmarkStats(supabase, {
    gameMode: matchAttr.gameMode,
    matchType: matchAttr.matchType,
    tier: matchTier
  });

  const bench = adaptBenchmark(tierStats);

  const engine = new AnalysisEngine(
    canonicalNickname, myAccountId, teamNames, teamAccountIds,
    new Set<string>(), new Set<string>(),
    myRosterId
  );

  markAnalysisStep("analysis_engine");
  const result = engine.run(
    telData,
    matchAttr,
    rosters,
    participants,
    myParticipant.attributes.stats,
    teamStats,
    bench
  );

  const defaultBenchmark = {
    avg_damage: 200,
    breakdown: { combat: 20, tactical: 20, survival: 20 }
  };

  const fullResult = {
    ...result,
    v: RESULT_VERSION,
    matchId,
    player_id: lowerNickname,
    platform,
    matchInfo: {
      map: MAP_NAMES[matchAttr.mapId] || matchAttr.mapId,
      mapId: MAP_IDS[matchAttr.mapId] || 'erangel',
      date: matchAttr.createdAt,
      mode: matchAttr.gameMode,
      duration: matchAttr.duration,
      rankPct,
      tier: matchTier
    },
    benchmark: {
      ...defaultBenchmark,
      ...bench,
      ...(result.benchmark || {})
    }
  };

  const { mapData, ...tacticalResult } = fullResult;
  markAnalysisStep("telemetry_payload");
  const telemetryPayload = createTelemetryPayload({
    identity: buildTelemetryPublicIdentity(telemetryIdentity),
    startTime: matchAttr.createdAt,
    teammates: pseudonymizeTelemetryTeammates(mapData?.teammates || []),
    teamNames: mapData?.teamNames || [myParticipant.attributes.stats.name],
    events: pseudonymizeTelemetryAccountIds(mapData?.events || []),
    zoneEvents: pseudonymizeTelemetryAccountIds(mapData?.zoneEvents || []),
    mapName: result.mapName || matchAttr.mapName || matchAttr.mapId,
  });
  const processedTelemetryRecord = buildProcessedTelemetryUpsert(
    matchId,
    lowerNickname,
    platform,
    tacticalResult,
  );
  markAnalysisStep("telemetry_cache_finalize");
  try {
    await writeTelemetryMapCache(telemetryIdentity, telemetryPayload, {
      ...cacheDeps,
      finalize: (row) => finalizeTelemetryMapCacheLifecycle(supabase, {
        row,
        mapName: matchAttr.mapName || matchAttr.mapId || "unknown",
        gameMode: matchAttr.gameMode || "unknown",
        processed: {
          playerId: processedTelemetryRecord.player_id,
          platform: processedTelemetryRecord.platform,
          data: processedTelemetryRecord.data,
          updatedAt: processedTelemetryRecord.updated_at,
        },
      }),
    }, { reservedRow });
  } catch (error) {
    markAnalysisStep("telemetry_cache_persistence");
    await reportTelemetryCachePersistenceFailure(error, startedAt, requestContext);
    await releaseTelemetryMapCacheRow(reservedRow, cacheDeps).catch(() => undefined);
  }

  try {
    const persistenceResult = await persistMatchAnalysis(supabase, {
      matchId,
      playerNickname: lowerNickname,
      platform: platform === "kakao" ? "kakao" : "steam",
      finalResult: {
        ...tacticalResult,
        stats: { ...tacticalResult.stats },
        tradeStats: { ...tacticalResult.tradeStats },
        killContribution: { ...tacticalResult.killContribution },
        isolationData: { ...tacticalResult.isolationData },
        combatPressure: {
          ...tacticalResult.combatPressure,
          utilityStats: { ...tacticalResult.combatPressure.utilityStats },
        },
        itemUseSummary: { ...tacticalResult.itemUseSummary },
        duelStats: { ...tacticalResult.duelStats },
        itemUseStats: { ...tacticalResult.itemUseStats },
        benchmark: tacticalResult.benchmark
          ? {
              ...tacticalResult.benchmark,
              breakdown: { ...tacticalResult.benchmark.breakdown },
            }
          : undefined,
      },
      matchAttr,
      rawParticipants: participants,
      source: source === "scraper" ? "scraper" : "user",
      forceBenchmark: false,
    });

    if (persistenceResult.failures.length > 0) {
      console.error(
        "[MATCH] 파생 통계 저장 실패:",
        persistenceResult.failures.map(({ taskName }) => taskName),
      );
    }
  } catch {
    console.error("[MATCH] 파생 통계 저장 중 예외 발생");
  }

  const allParticipantNames = participants
    .filter((p: any) => !p.attributes.stats.playerId?.startsWith("ai."))
    .map((p: any) => p.attributes.stats.name)
    .filter((name: string) => normalizeName(name) !== lowerNickname);

  const sampleParticipants = allParticipantNames
    .sort(() => 0.5 - Math.random())
    .slice(0, 5);

  return {
    ...createTacticalResponse(tacticalResult),
    sampleParticipants
  };
  } catch (error) {
    await releaseTelemetryMapCacheRow(reservedRow, cacheDeps).catch(() => undefined);
    throw error;
  }
}
