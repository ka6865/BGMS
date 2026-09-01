// scripts/scrape_elite.ts
import axios from 'axios';
import dotenv from 'dotenv';
import { createClient } from '@supabase/supabase-js';
import { POPULATION_EVIDENCE_VERSION, RESULT_VERSION } from '../lib/pubg-analysis/constants';
import { BENCHMARK_FILTER_VERSION, BENCHMARK_POPULATION_EVIDENCE_VERSION } from '../lib/pubg-analysis/benchmarkLookup';
import { getValidFullResult } from '../lib/pubg-analysis/cacheIdentity';
import { normalizeName } from '../lib/pubg-analysis/utils';
import { describeScraperRequestFailure, type ScraperRequestStage } from '../lib/pubg-analysis/scraperDiagnostics';
import { appendFileSync } from 'node:fs';

// .env 및 .env.local 파일의 환경변수 로드
dotenv.config({ path: '.env.local' });
dotenv.config();

const PUBG_API_KEY = process.env.PUBG_API_KEY;
const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
const PUBG_SCRAPER_INTERNAL_TOKEN = process.env.PUBG_SCRAPER_INTERNAL_TOKEN;
const ADMIN_REVALIDATE_TOKEN = process.env.ADMIN_REVALIDATE_TOKEN;

const BASE_URL = "https://api.pubg.com/shards/steam";
const PLATFORM = "steam";
const APP_URL = process.env.APP_URL || "http://localhost:3000";
const MATCH_API_URL = `${APP_URL}/api/pubg/match`;

const HEADERS = {
  Authorization: `Bearer ${PUBG_API_KEY}`,
  Accept: "application/vnd.api+json",
};

const MATCH_API_HEADERS = {
  Authorization: `Bearer ${PUBG_SCRAPER_INTERNAL_TOKEN}`,
};

const supabase = SUPABASE_URL?.trim() && SUPABASE_KEY?.trim()
  ? createClient(SUPABASE_URL, SUPABASE_KEY)
  : null;

export function hasTrustedScraperCache(fullResult: unknown): boolean {
  if (!fullResult || typeof fullResult !== "object" || Array.isArray(fullResult)) return false;
  const candidate = fullResult as Record<string, unknown>;
  return typeof candidate.v === "number"
    && Number.isFinite(candidate.v)
    && candidate.v >= RESULT_VERSION
    && candidate.populationEvidenceVersion === POPULATION_EVIDENCE_VERSION;
}

export function hasTrustedScraperBenchmark(benchmark: unknown): boolean {
  if (!benchmark || typeof benchmark !== "object" || Array.isArray(benchmark)) return false;
  const candidate = benchmark as Record<string, unknown>;
  const matchType = typeof candidate.match_type === "string"
    ? candidate.match_type.trim().toLowerCase()
    : "";
  return Number(candidate.filter_version) === BENCHMARK_FILTER_VERSION
    && Number(candidate.population_evidence_version) === BENCHMARK_POPULATION_EVIDENCE_VERSION
    && (matchType === "official" || matchType === "competitive");
}

export function shouldSkipScraperMatch(input: {
  fullResult: unknown;
  benchmark: unknown;
}): boolean {
  return hasTrustedScraperCache(input.fullResult) && hasTrustedScraperBenchmark(input.benchmark);
}

async function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

type ScraperCounters = {
  succeeded: number;
  skipped: number;
  failed: number;
};

function logRequestFailure(stage: ScraperRequestStage, error: unknown, counters: ScraperCounters) {
  counters.failed += 1;
  console.error("⚠️ 스크래퍼 요청 실패", JSON.stringify(describeScraperRequestFailure(stage, error)));
}

function writeGithubOutput(counters: ScraperCounters) {
  const outputPath = process.env.GITHUB_OUTPUT;
  if (!outputPath) return;
  appendFileSync(outputPath, [
    `succeeded=${counters.succeeded}`,
    `skipped=${counters.skipped}`,
    `failed=${counters.failed}`,
  ].join("\n") + "\n");
}

export async function scrapeEliteData() {
  console.log("🚀 [BGMS Smart Scraper] 작업을 시작합니다...");
  const counters: ScraperCounters = { succeeded: 0, skipped: 0, failed: 0 };

  if (
    !PUBG_API_KEY?.trim()
    || !SUPABASE_URL?.trim()
    || !SUPABASE_KEY?.trim()
    || !PUBG_SCRAPER_INTERNAL_TOKEN?.trim()
    || !ADMIN_REVALIDATE_TOKEN?.trim()
    || !supabase
  ) {
    console.error("필수 환경변수가 설정되어 있지 않습니다.");
    counters.failed += 1;
    process.exitCode = 1;
    writeGithubOutput(counters);
    return;
  }

  // [설정] 실행 모드에 따른 제한값 (기본값은 데이터 정밀도를 위해 샘플링 활성화)
  const PLAYER_LIMIT = parseInt(process.env.ELITE_PLAYER_LIMIT || '5');
  const MATCH_LIMIT = parseInt(process.env.ELITE_MATCH_LIMIT || '3');
  const ENABLE_SAMPLING = process.env.ENABLE_SAMPLING !== 'false'; // 명시적으로 false가 아니면 true

  console.log(`📊 실행 모드: ${process.env.ELITE_PLAYER_LIMIT ? 'DAILY (Light)' : 'MANUAL (Full)'}`);
  console.log(`👥 인원: ${PLAYER_LIMIT}, 🎮 매치: ${MATCH_LIMIT}, 🧪 샘플링: ${ENABLE_SAMPLING}`);

  try {
    let seasonRes;
    try {
      seasonRes = await axios.get(`${BASE_URL}/seasons`, { headers: HEADERS });
    } catch (error) {
      logRequestFailure("season", error, counters);
      throw error;
    }
    const currentSeason = seasonRes.data.data.find((s: any) => s.attributes.isCurrentSeason);
    if (!currentSeason) {
      counters.failed += 1;
      throw new Error("scraper-current-season-missing");
    }
    
    const seasonId = currentSeason.id;
    console.log(`✅ 현재 시즌: ${seasonId}`);

    const gameModes = ["squad", "squad-fpp", "solo", "solo-fpp", "duo", "duo-fpp"]; 
    const playerPool = new Map<string, string>();
    
    // [V36.5] 일반 및 경쟁전 리더보드 통합 수집
    for (const mode of gameModes) {
      console.log(`📡 [${mode}] 리더보드 조회 중...`);
      try {
        // 1. 일반 리더보드
        const leaderboardRes = await axios.get(`https://api.pubg.com/shards/pc-as/leaderboards/${seasonId}/${mode}`, { headers: HEADERS });
        const modePlayers = leaderboardRes.data.included?.filter((i: any) => i.type === "player").slice(0, PLAYER_LIMIT) || [];
        modePlayers.forEach((p: any) => playerPool.set(p.id, p.attributes.name));
        
        // 2. 경쟁전 리더보드 (일부 모드만 지원)
        if (mode.includes("squad")) {
          // 경쟁전은 보통 동일 시즌 ID를 공유하거나 약간의 딜레이가 있을 수 있음
          // pc-as 샤드의 경우 리더보드에서 경쟁전 데이터가 별도로 존재함
        }
      } catch (error) {
        logRequestFailure("leaderboard", error, counters);
      }
    }

    console.log(`🎯 총 ${playerPool.size}명의 타겟 플레이어 확보.`);

    for (const [accountId, nickname] of playerPool.entries()) {
      console.log("\n플레이어 매치 스캔 중...");
      await sleep(3000); // 플레이어 간 간격

      let matchIds: string[] = [];
      try {
        const pDetails = await axios.get(`${BASE_URL}/players/${accountId}`, { headers: HEADERS });
        matchIds = pDetails.data.data.relationships.matches.data.slice(0, MATCH_LIMIT).map((m: any) => m.id);
      } catch (error) {
        logRequestFailure("player", error, counters);
        counters.skipped += 1;
        continue;
      }

      for (const matchId of matchIds) {
        const playerId = normalizeName(nickname);
        // [Step 1] processed_match_telemetry 분석 캐시 최신 여부 확인
        const { data: existing } = await supabase
          .from("processed_match_telemetry")
          .select("data")
          .eq("match_id", matchId)
          .eq("platform", PLATFORM)
          .eq("player_id", playerId)
          .maybeSingle();

        const existingFullResult = getValidFullResult(existing, playerId, PLATFORM);

        let benchmark: unknown = null;
        const cacheIsTrusted = hasTrustedScraperCache(existingFullResult);

        // 구버전/무표시 캐시 → 무조건 재분석
        if (existingFullResult && !cacheIsTrusted) {
          console.log(`   - 구버전 캐시 발견 -> V${RESULT_VERSION} 재분석 시작...`);
        } else if (existingFullResult) {
          // [Step 2] 최신 캐시가 있는 경우 → global_benchmarks 교차 검증
          // (벤치마크 초기화 이후 스킵 방지)
          const { data } = await supabase
            .from("global_benchmarks")
            .select("id, filter_version, population_evidence_version, match_type")
            .eq("match_id", matchId)
            .eq("platform", PLATFORM)
            .eq("player_id", playerId)
            .maybeSingle();
          benchmark = data;

          if (shouldSkipScraperMatch({ fullResult: existingFullResult, benchmark })) {
            // 캐시도 있고 벤치마크도 있으면 완전히 Skip
            console.log("   - 최신 캐시 + 벤치마크 존재 (Skip)");
            counters.skipped += 1;
            continue;
          } else {
            // 캐시는 있지만 벤치마크가 비어있음 → force 재분석 필요
            console.log("   - 캐시 OK, 벤치마크 누락 → 강제 재분석(force=true) 요청");
          }
        } else {
          console.log("   - 신규 수집 시작...");
        }

        // 벤치마크 누락 여부에 따라 force 파라미터 결정
        const forceReanalysis = Boolean(existingFullResult && !shouldSkipScraperMatch({
          fullResult: existingFullResult,
          benchmark,
        }));
        const forceParam = forceReanalysis
          ? '&force=true'
          : '';
        const matchApiHeaders = forceReanalysis
          ? { ...MATCH_API_HEADERS, 'X-BGMS-Admin-Token': ADMIN_REVALIDATE_TOKEN }
          : MATCH_API_HEADERS;

        try {
          // [Step 3] 로컬/원격 서버 API 호출 (동기적으로 대기)
          const res = await axios.get(
            `${MATCH_API_URL}?matchId=${matchId}&nickname=${encodeURIComponent(nickname.trim())}&platform=steam&source=scraper${forceParam}`,
            { headers: matchApiHeaders },
          );
          
          if (res.status === 200) {
            const d = res.data;
            console.log(`     ✅ 성공: (딜량: ${Math.round(d.stats.damageDealt)}, 생존: ${d.deathPhase}Ph)`);
            counters.succeeded += 1;

            // [Phase 4] 매치 참가자 샘플링 추가 (API에서 반환된 랜덤 샘플 활용)
            const samples = d.sampleParticipants || [];

            if (ENABLE_SAMPLING && samples.length > 0) {
              for (const sampleName of samples) {
                console.log("       -> 샘플링 분석 요청 중...");
                try {
                  await sleep(5000); // 샘플 참가자 분석 시 매치당 sleep 적용
                  await axios.get(
                    `${MATCH_API_URL}?matchId=${matchId}&nickname=${encodeURIComponent(sampleName)}&platform=steam&source=scraper`,
                    { headers: MATCH_API_HEADERS },
                  );
                  console.log(`         ✅ 샘플링 완료`);
                  counters.succeeded += 1;
                } catch (error) {
                  logRequestFailure("sample", error, counters);
                  counters.skipped += 1;
                  console.log("         샘플링 처리 스킵");
                }
              }
            }
          }
        } catch (error) {
          logRequestFailure("match", error, counters);
          counters.skipped += 1;
          console.log("     매치 처리 스킵");
        }
        
        // [최적화 3] DB 부하 분산을 위한 확실한 휴식 (매치당 5초)
        await sleep(5000);
      }
    }
  } catch {
    console.error("스크래퍼 작업 실패: season 단계 또는 필수 초기화 단계");
    process.exitCode = 1;
  } finally {
    console.log("📊 스크래퍼 실행 요약", JSON.stringify(counters));
    writeGithubOutput(counters);
    console.log("\n✨ 모든 작업이 완료되었습니다.");
  }
}

if (process.argv[1]?.endsWith("scrape_elite.ts")) {
  scrapeEliteData();
}
