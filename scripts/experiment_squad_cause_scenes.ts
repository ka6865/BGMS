import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { config } from "dotenv";
import { createClient } from "@supabase/supabase-js";
import {
  buildSquadCauseScenePrompt,
  extractSquadCauseScenes,
  SquadCauseSceneMatchInput,
  validateSquadCauseSceneAiText
} from "../lib/pubg-analysis/squadCauseScenes";
import { getValidFullResult, normalizePlatform } from "../lib/pubg-analysis/cacheIdentity";
import {
  deriveSquadRecoveryStatsFromTimeline,
  hasSquadRecoveryTimelineSignals
} from "../lib/pubg-analysis/squadRecoveryStats";
import { normalizeName } from "../lib/pubg-analysis/utils";

config({ path: ".env.local" });
config();

interface ExperimentFixture {
  squadContext: {
    nickname: string;
    groupKey: string;
    squadGrade?: string;
    matchCount?: number;
    stats?: Record<string, unknown>;
    scores?: Record<string, unknown>;
    benchmarkStats?: Record<string, unknown>;
  };
  matches: SquadCauseSceneMatchInput[];
}

interface CliOptions {
  fromDb: boolean;
  fixturePath: string;
  nickname: string;
  platform: string;
  groupKey: string;
  limit: number;
  maxScenes: number;
  withAi: boolean;
  model: string;
  fallbackModels: string[];
  aiRetries: number;
}

interface AiFailureSummary {
  model: string;
  attempt: number;
  retryable: boolean;
  status?: number;
  message: string;
}

function parseArgs(argv: string[]): CliOptions {
  const options: CliOptions = {
    fromDb: false,
    fixturePath: "tests/fixtures/squad-cause-scenes.json",
    nickname: "KangHeeSung_",
    platform: "steam",
    groupKey: "최근 스쿼드 매치",
    limit: 10,
    maxScenes: 5,
    withAi: false,
    model: "gemini-3.5-flash-lite",
    fallbackModels: [
      "gemini-3.1-flash-lite",
      "gemini-3.5-flash",
      "gemini-3.6-flash"
    ],
    aiRetries: 2
  };

  argv.forEach((arg, index) => {
    if (arg === "--from-db") options.fromDb = true;
    if (arg === "--ai") options.withAi = true;
    if (arg === "--fixture" && argv[index + 1]) options.fixturePath = argv[index + 1];
    if (arg === "--nickname" && argv[index + 1]) options.nickname = argv[index + 1];
    if (arg === "--platform" && argv[index + 1]) options.platform = argv[index + 1];
    if (arg === "--group-key" && argv[index + 1]) options.groupKey = argv[index + 1];
    if (arg === "--limit" && argv[index + 1]) options.limit = Number(argv[index + 1]);
    if (arg === "--max-scenes" && argv[index + 1]) options.maxScenes = Number(argv[index + 1]);
    if (arg === "--model" && argv[index + 1]) options.model = argv[index + 1];
    if (arg === "--fallback-models" && argv[index + 1]) {
      options.fallbackModels = argv[index + 1]
        .split(",")
        .map(model => model.trim())
        .filter(Boolean);
    }
    if (arg === "--ai-retries" && argv[index + 1]) options.aiRetries = Number(argv[index + 1]);
  });

  return options;
}

function uniqueModels(primaryModel: string, fallbackModels: string[]): string[] {
  return Array.from(new Set([primaryModel, ...fallbackModels].filter(Boolean)));
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function getErrorStatus(error: any): number | undefined {
  const rawStatus = error?.status ?? error?.response?.status ?? error?.statusCode;
  const status = Number(rawStatus);
  return Number.isFinite(status) ? status : undefined;
}

function isRetryableAiError(error: any): boolean {
  const status = getErrorStatus(error);
  if (status !== undefined) return status === 429 || status === 500 || status === 502 || status === 503 || status === 504;
  const message = String(error?.message || error || "").toLowerCase();
  return message.includes("timeout") ||
    message.includes("temporar") ||
    message.includes("high demand") ||
    message.includes("service unavailable") ||
    message.includes("fetch failed");
}

function summarizeAiError(model: string, attempt: number, error: any): AiFailureSummary {
  return {
    model,
    attempt,
    retryable: isRetryableAiError(error),
    status: getErrorStatus(error),
    message: String(error?.message || error || "unknown error")
  };
}

async function loadFixture(path: string): Promise<ExperimentFixture> {
  const filePath = resolve(process.cwd(), path);
  const raw = await readFile(filePath, "utf8");
  return JSON.parse(raw) as ExperimentFixture;
}

async function loadMatchesFromSupabase(nickname: string, limit: number, platform: string): Promise<ExperimentFixture> {
  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

  if (!supabaseUrl || !serviceRoleKey) {
    throw new Error("Supabase 환경변수 NEXT_PUBLIC_SUPABASE_URL 또는 SUPABASE_SERVICE_ROLE_KEY가 없습니다.");
  }

  const supabase = createClient(supabaseUrl, serviceRoleKey, {
    auth: {
      persistSession: false,
      autoRefreshToken: false
    }
  });

  const playerId = normalizeName(nickname);
  const cachePlatform = normalizePlatform(platform);
  const { data, error } = await supabase
    .from("processed_match_telemetry")
    .select("match_id, data, updated_at")
    .eq("platform", cachePlatform)
    .eq("player_id", playerId)
    .order("updated_at", { ascending: false })
    .limit(limit);

  if (error) {
    throw new Error(`Supabase 조회 실패: ${error.message}`);
  }

  const matches = (data || [])
    .map((row: any) => {
      const fullResult = getValidFullResult(row, playerId, cachePlatform);
      if (!fullResult || !(fullResult.gameMode || "").includes("squad")) return null;
      const mapName = fullResult.mapName || "Unknown";
      return {
        matchId: row.match_id,
        mapName,
        mapDisplayName: fullResult.matchInfo?.map || mapName,
        winPlace: fullResult.stats?.winPlace || 0,
        createdAt: fullResult.createdAt || row.updated_at,
        fullResult
      } satisfies SquadCauseSceneMatchInput;
    })
    .filter(Boolean) as SquadCauseSceneMatchInput[];

  const firstTeam = matches[0]?.fullResult.team || [];
  const teammates = firstTeam
    .map((member: any) => member?.name)
    .filter((name: string) => name && normalizeName(name) !== playerId);
  const stats = matches.reduce((acc, match) => {
    const fullResult = match.fullResult;
    const tradeStats = fullResult.tradeStats || {};
    const isolationData = fullResult.isolationData || {};
    const timeline = Array.isArray(fullResult.timeline) ? fullResult.timeline : [];
    const recoveryStats = hasSquadRecoveryTimelineSignals(timeline)
      ? deriveSquadRecoveryStatsFromTimeline(timeline)
      : null;
    acc.isolationSum += Number(isolationData.isolationIndex ?? isolationData.deathIsolation ?? 0);
    acc.isolationCount += isolationData.isolationIndex !== undefined || isolationData.deathIsolation !== undefined ? 1 : 0;
    if ((tradeStats.tradeLatencyMs || 0) > 0) {
      acc.tradeLatencySum += Number(tradeStats.tradeLatencyMs);
      acc.tradeLatencyCount += 1;
    }
    acc.totalSmokeRescues += Number(recoveryStats?.squadSmokeRescues ?? tradeStats.smokeRescues ?? 0);
    acc.totalRevives += Number(recoveryStats?.squadRevives ?? tradeStats.revCount ?? 0);
    acc.totalTeamWipes += Number(tradeStats.enemyTeamWipes || 0);
    acc.totalTeammateKnocks += Number(tradeStats.teammateKnocks || 0);
    return acc;
  }, {
    isolationSum: 0,
    isolationCount: 0,
    tradeLatencySum: 0,
    tradeLatencyCount: 0,
    totalSmokeRescues: 0,
    totalRevives: 0,
    totalTeamWipes: 0,
    totalTeammateKnocks: 0
  });

  return {
    squadContext: {
      nickname,
      groupKey: teammates.length > 0 ? teammates.join(", ") : "최근 스쿼드 매치",
      matchCount: matches.length,
      squadGrade: "실험 대상",
      stats: {
        avgIsolation: stats.isolationCount > 0 ? Number((stats.isolationSum / stats.isolationCount).toFixed(2)) : "측정 불가",
        avgTradeLatency: stats.tradeLatencyCount > 0 ? Math.round(stats.tradeLatencySum / stats.tradeLatencyCount) : "측정 불가",
        totalSmokeRescues: stats.totalSmokeRescues,
        totalRevives: stats.totalRevives,
        totalTeamWipes: stats.totalTeamWipes,
        totalTeammateKnocks: stats.totalTeammateKnocks
      },
      benchmarkStats: {
        avgTradeLatency: 12000
      }
    },
    matches
  };
}

async function runGemini(prompt: string, modelNames: string[], retries: number): Promise<{ text: string; model: string; failures: AiFailureSummary[] }> {
  const apiKey = process.env.GOOGLE_GEMINI_API_KEY;
  if (!apiKey) {
    throw new Error("GOOGLE_GEMINI_API_KEY가 없어 AI 호출을 건너뜁니다.");
  }

  const { GoogleGenerativeAI } = await import("@google/generative-ai");
  const genAI = new GoogleGenerativeAI(apiKey);
  const failures: AiFailureSummary[] = [];
  const maxAttempts = Math.max(1, retries + 1);

  for (const modelName of modelNames) {
    const model = genAI.getGenerativeModel({
      model: modelName,
      generationConfig: {
        responseMimeType: "application/json"
      }
    });

    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      console.info(`[원인 장면 실험] AI 호출 시작: ${modelName} (${attempt}/${maxAttempts})`);
      try {
        const response = await model.generateContent(prompt);
        return {
          text: response.response.text(),
          model: modelName,
          failures
        };
      } catch (error: any) {
        const failure = summarizeAiError(modelName, attempt, error);
        failures.push(failure);
        console.warn("[원인 장면 실험] AI 호출 실패:", JSON.stringify(failure));
        if (!failure.retryable || attempt >= maxAttempts) break;
        console.info(`[원인 장면 실험] ${modelName} 재시도 대기: ${attempt}초`);
        await sleep(1000 * attempt);
      }
    }

    console.info(`[원인 장면 실험] 다음 AI 모델로 전환: ${modelName} 실패`);
  }

  const lastFailure = failures[failures.length - 1];
  throw new Error(`모든 AI 모델 호출 실패: ${lastFailure?.message || "unknown error"}`);
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const fixture = options.fromDb
    ? await loadMatchesFromSupabase(options.nickname, options.limit, options.platform)
    : await loadFixture(options.fixturePath);

  const benchmarkTradeLatencyMs = Number(
    fixture.squadContext.benchmarkStats?.avgTradeLatency || 12000
  );
  const scenes = extractSquadCauseScenes(fixture.matches, {
    benchmarkTradeLatencyMs,
    maxScenes: options.maxScenes
  });
  const prompt = buildSquadCauseScenePrompt({
    ...fixture.squadContext,
    groupKey: options.fromDb ? fixture.squadContext.groupKey || options.groupKey : fixture.squadContext.groupKey,
    scenes,
    coachingStyle: "spicy"
  });

  console.info("[원인 장면 실험] 입력 매치 수:", fixture.matches.length);
  console.info("[원인 장면 실험] 추출 장면 수:", scenes.length);
  console.info(JSON.stringify({
    scenes: scenes.map(scene => ({
      id: scene.id,
      type: scene.type,
      severity: scene.severity,
      confidence: scene.confidence,
      matchId: scene.matchId,
      map: scene.mapDisplayName,
      time: scene.displayTime,
      title: scene.title,
      facts: scene.facts,
      metrics: scene.metricSnapshot
    }))
  }, null, 2));

  console.info("[원인 장면 실험] AI 프롬프트 미리보기:");
  console.info(prompt.slice(0, 4000));

  if (options.withAi) {
    const modelNames = uniqueModels(options.model, options.fallbackModels);
    console.info("[원인 장면 실험] AI 모델 후보:", modelNames.join(", "));
    try {
      const aiResult = await runGemini(prompt, modelNames, options.aiRetries);
      console.info("[원인 장면 실험] AI 응답 모델:", aiResult.model);
      if (aiResult.failures.length > 0) {
        console.info("[원인 장면 실험] AI 실패 후 성공 이력:", JSON.stringify(aiResult.failures, null, 2));
      }
      console.info("[원인 장면 실험] AI 응답:");
      console.info(aiResult.text);
      const validationIssues = validateSquadCauseSceneAiText(aiResult.text);
      if (validationIssues.length > 0) {
        console.warn("[원인 장면 실험] AI 응답 검증 경고:", JSON.stringify(validationIssues, null, 2));
      } else {
        console.info("[원인 장면 실험] AI 응답 검증 통과: 금지 표현 없음");
      }
    } catch (error: any) {
      console.error("[원인 장면 실험] AI 응답 획득 실패:", error.message || error);
      console.error("[원인 장면 실험] 장면 추출과 프롬프트 생성은 완료되었습니다. 503/429는 모델 혼잡일 수 있으니 잠시 후 재실행하거나 --model/--fallback-models를 바꿔 재시도하십시오.");
      process.exitCode = 1;
    }
  }
}

main().catch((error) => {
  console.error("[원인 장면 실험] 실패:", error);
  process.exitCode = 1;
});
