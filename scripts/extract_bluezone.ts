import { createClient } from "@supabase/supabase-js";
import fs from "fs";
import path from "path";
import dotenv from "dotenv";
import { pathToFileURL } from "node:url";
import { hasMatchingTelemetryDefinition, parseOrdinaryTelemetryUrl, relationshipBoundTelemetryAsset } from "../lib/pubg-analysis/telemetrySource";
import { readBluezoneArchive, safeBluezoneErrorCode } from "../lib/pubg-analysis/bluezoneArchive";
import { isCanonicalMatchId, type TelemetryPlatform } from "../lib/pubg-analysis/telemetryIdentity";

dotenv.config({ path: path.resolve(process.cwd(), ".env.local") });

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!,
  { global: { fetch: (input, init) => fetch(input, {
    ...init, signal: init?.signal ? AbortSignal.any([init.signal, AbortSignal.timeout(30_000)]) : AbortSignal.timeout(30_000)
  }) } }
);

const CURRENT_LOGIC_VERSION = 2; // v1: 고도 기반, v2: isGame: 0.1 플래그 기반(공식)
const STORAGE_PATH = path.resolve(process.cwd(), "public/bluezone_data_v2.json");

const MAP_NAME_MAP: Record<string, string> = {
  "에란겔": "Baltic_Main",
  "미라마": "Desert_Main",
  "태이고": "Tiger_Main",
  "사녹": "Savage_Main",
  "비켄디": "DihorOtok_Main",
  "론도": "Neon_Main",
  "데스턴": "Kiki_Main",
  "파라모": "Range_Main",
  "카라킨": "Summerland_Main"
};

export type BluezoneOptions = { dryRun?: boolean; limit?: number };

export function parseBluezoneOptions(args: string[]): BluezoneOptions {
  if (args.some((arg, i) => arg !== "--dry-run" && arg !== "--limit" && args[i - 1] !== "--limit")) throw new Error("bluezone-invalid-options");
  const index = args.indexOf("--limit");
  const raw = index < 0 ? "150" : args[index + 1];
  if (!raw || !/^\d+$/.test(raw) || Number(raw) < 1 || Number(raw) > 150) throw new Error("bluezone-invalid-limit");
  return { dryRun: args.includes("--dry-run"), limit: Number(raw) };
}

export async function extractSimulatorData(options: BluezoneOptions = {}) {
  const PROCESS_LIMIT = options.limit ?? 150;
  if (!Number.isInteger(PROCESS_LIMIT) || PROCESS_LIMIT < 1 || PROCESS_LIMIT > 150) throw new Error("bluezone-invalid-limit");
  console.log("🚀 [Bluezone Extractor] 자기장 데이터 추출 시작...");

  let rawMatches: any[] = [];
  const outputPath = STORAGE_PATH;
  
  try {
    const { data: storageData, error: storageError } = await supabase.storage
      .from("app-data")
      .download("bluezone_data_v2.json");
    if (storageError && !["404", "not_found"].includes(String(storageError.statusCode))) {
      throw new Error("bluezone-existing-storage-read-failed");
    }

    if (storageData) {
      const text = await storageData.text();
      rawMatches = JSON.parse(text);
      console.log(`📦 스토리지에서 기존 데이터 ${rawMatches.length}건 로드 완료.`);
    } else if (fs.existsSync(outputPath)) {
      rawMatches = JSON.parse(fs.readFileSync(outputPath, "utf-8"));
    }
  } catch {
    throw new Error("bluezone-existing-data-unavailable");
  }

  const matchMap = new Map();
  rawMatches.forEach((m: any) => {
    if (m.matchId && m.mapName) {
      matchMap.set(m.matchId, m);
    }
  });
  const allMatches = Array.from(matchMap.values());
  // 기존 오염 데이터 정제 (비정상적으로 작은 좌표/반지름 제거)
  const cleanedMatches = allMatches.filter((m: any) => {
    const p1 = m.phases?.find((p: any) => p.phase === 1) || m.phases?.[0];
    // 좌표나 반지름이 너무 작으면 (예: 맵 구석 0,0 부근이거나 비정상 데이터) 제거
    if (p1 && (p1.x < 100 || p1.y < 100 || p1.radius < 100)) return false;
    return true;
  });
  
  if (allMatches.length !== cleanedMatches.length) {
    console.log(`🧹 기존 오염 데이터 ${allMatches.length - cleanedMatches.length}건을 제거했습니다.`);
  }
  const finalMatches = [...cleanedMatches];

  console.log("DB에서 매치 정보를 가져오는 중...");
  
  const { data: processedMatches, error: processedError } = await supabase
    .from("processed_match_telemetry")
    .select("match_id, platform, data->fullResult->mapName, created_at")
    .order("created_at", { ascending: false }).limit(1000);
  if (processedError) throw new Error("bluezone-match-list-read-failed");

  const matches = (processedMatches || [])
    .map(m => {
      const korName = (m as any).mapName;
      return { 
        match_id: m.match_id, 
        platform: m.platform,
        map_name: MAP_NAME_MAP[korName] || korName || '' 
      };
    })
    .filter(m => isCanonicalMatchId(m.match_id) && m.map_name !== '' && ['steam', 'kakao'].includes(m.platform));
  const uniqueMatches = [...new Map(matches.map(match => [`${match.platform}:${match.match_id}`, match])).values()];

  console.log(`총 ${uniqueMatches.length}개의 고유 매치 발견.`);

  let processedCount = 0;
  let attemptedCount = 0;
  let failedCount = 0;
  const sources = { shared: 0, legacy: 0, inline: 0, upstream: 0, notFound: 0 };
  const deadline = Date.now() + 5 * 60_000;

  const prioritizedMatches = uniqueMatches.sort((a, b) => {
    const priorityMaps = ['Baltic_Main', 'Tiger_Main'];
    const aPri = priorityMaps.includes(a.map_name) ? 0 : 1;
    const bPri = priorityMaps.includes(b.map_name) ? 0 : 1;
    return aPri - bPri;
  });

  for (const match of prioritizedMatches) {
    if (finalMatches.some(m => m.matchId === match.match_id && m.phases.length > 0)) continue;
    if (attemptedCount >= PROCESS_LIMIT || Date.now() >= deadline) break;
    attemptedCount++;

    const { data, error: telemetryError } = await supabase
      .from("match_master_telemetry")
      .select("telemetry_events, storage_path")
      .eq("match_id", match.match_id)
      .maybeSingle();
    if (telemetryError) throw new Error("bluezone-stored-telemetry-read-failed");

    let events: any[] = [];
    if (hasMatchingTelemetryDefinition(data?.telemetry_events, match.match_id, match.platform)) {
      events = data!.telemetry_events;
      sources.inline++;
    } else {
      try {
        const archived = await readBluezoneArchive(match.match_id, match.platform as TelemetryPlatform, data?.storage_path);
        events = archived.events;
        if (archived.source !== "missing") sources[archived.source]++;
      } catch (error) {
        const code = safeBluezoneErrorCode(error);
        throw new Error(code === "bluezone-unexpected-failure" ? "bluezone-archive-read-failed" : code);
      }
    }

    if (events.length === 0) {
      try {
        const apiKey = (process.env.PUBG_API_KEY || "").split(" ")[0];
        const matchRes = await fetch(`https://api.pubg.com/shards/${match.platform}/matches/${match.match_id}`, {
          headers: { Authorization: `Bearer ${apiKey}`, Accept: "application/vnd.api+json" },
          signal: AbortSignal.timeout(8_000)
        });
        if (matchRes.status === 429) throw new Error("bluezone-pubg-rate-limited");
        if (matchRes.status === 404) sources.notFound++;
        if (!matchRes.ok && matchRes.status !== 404) throw new Error("bluezone-match-fetch-failed");
        if (matchRes.ok) {
          const matchJson = await matchRes.json();
          if (matchJson.data?.id !== match.match_id) throw new Error("bluezone-match-identity-mismatch");
          const boundAsset = relationshipBoundTelemetryAsset(matchJson);
          if (!boundAsset) throw new Error("bluezone-telemetry-asset-missing");
          const asset = boundAsset.asset as { attributes?: { URL?: unknown } };
          const telemetryUrl = parseOrdinaryTelemetryUrl(asset.attributes?.URL, boundAsset.id);
          const telemetryRes = await fetch(telemetryUrl, { signal: AbortSignal.timeout(20_000), redirect: "error" });
          if (telemetryRes.status === 429) throw new Error("bluezone-pubg-rate-limited");
          if (!telemetryRes.ok) throw new Error("bluezone-telemetry-fetch-failed");
          events = await telemetryRes.json();
          if (!hasMatchingTelemetryDefinition(events, match.match_id, match.platform)) throw new Error("bluezone-telemetry-identity-mismatch");
          sources.upstream++;
        }
      } catch (error) {
        if (error instanceof Error && error.message === "bluezone-pubg-rate-limited") throw error;
        failedCount++;
        console.warn("[Bluezone] 매치 원본 조회 실패 · 기존 데이터는 유지합니다.", { errorCode: safeBluezoneErrorCode(error) });
      }
    }

    if (!events || events.length === 0) continue;

    processedCount++;
    console.log(`[${processedCount}/${PROCESS_LIMIT}] ${match.map_name} 추출 중... (${match.match_id})`);

    const airplaneLocs: any[] = [];
    const startTime = events.length > 0 ? new Date(events[0]._D || events[0].Timestamp).getTime() : 0;

    for (const e of events) {
      if ((e._T || e.Type) === "LogPlayerPosition") {
        const char = e.character || e.Character;
        const common = e.common || e.Common;
        const isGame = common?.isGame || common?.IsGame;
        const time = new Date(e._D || e.Timestamp).getTime();

        // [공식 방식] isGame: 0.1 이 비행기 탑승 상태 (부동소수점 오차 고려 0~0.2 범위 체크)
        if (char?.location && isGame > 0 && isGame < 0.2) {
          airplaneLocs.push({ x: char.location.x, y: char.location.y, time });
        }
      }
    }

    let flightPath = null;
    if (airplaneLocs.length > 20) {
      airplaneLocs.sort((a, b) => a.time - b.time);
      const pts = airplaneLocs;
      const meanX = pts.reduce((sum, p) => sum + p.x, 0) / pts.length;
      const meanY = pts.reduce((sum, p) => sum + p.y, 0) / pts.length;
      let num = 0, den = 0;
      for (const p of pts) {
        num += (p.x - meanX) * (p.y - meanY);
        den += (p.x - meanX) * (p.x - meanX);
      }
      if (den !== 0) {
        const m = num / den;
        const xStart = 0;
        const yStart = meanY + m * (xStart - meanX);
        const xEnd = 819200;
        const yEnd = meanY + m * (xEnd - meanX);

        flightPath = [
          { y: Math.round(yStart / 100), x: Math.round(xStart / 100) },
          { y: Math.round(yEnd / 100), x: Math.round(xEnd / 100) }
        ];
      }
    }

    const matchData: any = {
      matchId: match.match_id,
      mapName: match.map_name,
      v: CURRENT_LOGIC_VERSION, // 버전 관리용 (v2: isGame 공식 로직 도입)
      extractedAt: new Date().toISOString(),
      flightPath: flightPath,
      phases: []
    };

    let currentPhase = 0;
    events.forEach((e: any) => {
      const type = e._T || e.Type;
      if (type === "LogPhaseChange") currentPhase = e.phase;
      if (type === "LogGameStatePeriodic" && (e.gameState?.safetyZoneRadius ?? 0) > 0) {
        const gs = e.gameState;
        const pos = gs.safetyZonePosition;
        
        // (0,0) 좌표 필터링 (데이터 오염 방지)
        if (!pos || (pos.x === 0 && pos.y === 0)) return;

        const phaseData = {
          phase: currentPhase,
          x: Math.round(pos.x / 100),
          y: Math.round(pos.y / 100),
          radius: Math.round(gs.safetyZoneRadius / 100)
        };
        const existingIdx = matchData.phases.findIndex((p: any) => p.phase === currentPhase);
        if (existingIdx === -1) matchData.phases.push(phaseData);
        else matchData.phases[existingIdx] = phaseData;
      }
    });

    if (matchData.phases.length > 0) {
      const idx = finalMatches.findIndex(m => m.matchId === matchData.matchId);
      if (idx > -1) finalMatches[idx] = matchData;
      else finalMatches.push(matchData);
    }
  }

  const changed = processedCount > 0 || cleanedMatches.length !== allMatches.length;
  if (failedCount > 0) throw new Error("bluezone-partial-fetch-failure");
  if (!options.dryRun && changed) {
    const { error: uploadError } = await supabase.storage.from("app-data").upload("bluezone_data_v2.json", JSON.stringify(finalMatches), {
      contentType: "application/json",
      upsert: true,
    });
    if (uploadError) throw new Error("bluezone-storage-upload-failed");
    fs.writeFileSync(outputPath, JSON.stringify(finalMatches, null, 2));
  }
  console.log(`자기장 추출: 시도 ${attemptedCount} · 처리 ${processedCount} · 조회 실패 ${failedCount} (최종 데이터: ${finalMatches.length}건)`);
  const summary = { dryRun: Boolean(options.dryRun), attemptedCount, processedCount, failedCount, finalCount: finalMatches.length, changed, sources };
  console.log(JSON.stringify(summary));
  return summary;
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  void Promise.resolve().then(() => extractSimulatorData(parseBluezoneOptions(process.argv.slice(2)))).catch((error: unknown) => {
    console.error("자기장 데이터 수집 실패", { errorCode: safeBluezoneErrorCode(error) });
    process.exitCode = 1;
  });
}
