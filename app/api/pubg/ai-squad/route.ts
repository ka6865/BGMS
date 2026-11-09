import { NextResponse } from "next/server";
import { Output, streamText, type Schema } from "ai";
import { createGoogleGenerativeAI } from "@ai-sdk/google";
import { jsonrepair } from "jsonrepair";
import { withAuthGuard } from "@/utils/supabase/guard";
import { trackAiFailure, trackAiUsage } from "@/lib/pubg-analysis/aiUsageTracker";
import { AI_SQUAD_CACHE_VERSION, GEMINI_MODELS_TO_TRY } from "@/lib/pubg-analysis/constants";
import { normalizeName } from "@/lib/pubg-analysis/utils";
import { normalizePlatform } from "@/lib/pubg-analysis/cacheIdentity";
import crypto from "crypto";
import { getSquadAnalysisData } from "@/lib/pubg-analysis/squadAnalysis";
import { blockPrivatePlayer } from "@/lib/pubg/privatePlayerGuard";
import { buildSquadAiCoachingPrompt } from "@/lib/pubg-analysis/squadAiCoachingPrompt";
import { sanitizeAiCoachingLanguage } from "@/lib/pubg-analysis/aiCoachingQuality";
import { sanitizeSquadAbilityClaims } from "@/lib/pubg-analysis/squadAiPolicy";
import { buildSquadOutputSchema, isCompleteSquadOutput, type SquadAiRawOutput } from "@/lib/pubg-analysis/squadAiSchema";
import {
  SQUAD_AI_FACTS_ONLY_ERROR_CODE,
  SQUAD_AI_MIN_MATCH_COUNT,
  SQUAD_AI_TOO_FEW_MATCHES_ERROR_CODE,
} from "@/lib/pubg-analysis/squadAiContract";

import { applySquadEvidencePolicy, hasSquadObservations, listReplacedSquadFields } from "@/lib/pubg-analysis/squadAiEvidence";
import { expiredMatchDetailResponse, isMatchDetailExpired } from "@/lib/pubg-analysis/matchRetention.server";

// 응답 기준 전체 예산(요약 route의 50초 route deadline과 같은 여유를 둔다).
export const maxDuration = 60;

const AI_SQUAD_ROUTE_TIMEOUT_MS = 50_000;
// 모든 모델의 생성 전체 예산. 스트림으로 바뀌어 응답 본문이 길어도 끝까지 받을 수 있게 둔다.
const AI_SQUAD_TOTAL_TIMEOUT_MS = 30_000;
// 모델별 제한은 응답 시작(첫 파트)까지만 적용한다. 시작 뒤에는 전체 예산이 관리한다.
const AI_SQUAD_MODEL_TIMEOUT_MS = 8_000;
const AI_SQUAD_FACTS_ONLY_MESSAGE = "AI 해석을 완료하지 못했습니다. 계산된 팀 지표는 그대로 확인할 수 있습니다. 잠시 후 다시 시도해 주세요.";

const SQUAD_SAFETY_SETTINGS: Array<{ category: string; threshold: string }> = [
  { category: "HARM_CATEGORY_HARASSMENT", threshold: "BLOCK_NONE" },
  { category: "HARM_CATEGORY_HATE_SPEECH", threshold: "BLOCK_NONE" },
  { category: "HARM_CATEGORY_SEXUALLY_EXPLICIT", threshold: "BLOCK_NONE" },
  { category: "HARM_CATEGORY_DANGEROUS_CONTENT", threshold: "BLOCK_NONE" },
];

class SquadRequestAbortedError extends Error {
  constructor() {
    super("Squad AI request was aborted");
    this.name = "SquadRequestAbortedError";
  }
}

type SquadFailureReason = "timeout" | "provider" | "aborted";
type SquadTokenUsage = { inputTokens?: number; outputTokens?: number };
type SquadAttempt = { model: string; outcome: "selected" | "timeout" | "error" | "aborted"; ms: number };
type SquadGeneration =
  | {
    ok: true;
    text: string;
    modelName: string;
    usage: SquadTokenUsage | null;
    firstPartMs: number;
    totalMs: number;
    attempts: SquadAttempt[];
  }
  | {
    ok: false;
    reason: SquadFailureReason;
    firstPartMs: number | null;
    totalMs: number;
    attempts: SquadAttempt[];
  };

type SquadRouteTiming = {
  requestId: string;
  outcome?: "blocked" | "cache_hit" | "generated" | "facts_only" | "aborted" | "error";
  stages: {
    auth: number | null;
    dataLoad: number | null;
    cacheLookup: number | null;
    geminiFirstPart: number | null;
    geminiTotal: number | null;
    persist: number | null;
    total: number | null;
  };
  attempts: SquadAttempt[];
};

function extractValidJson(text: string): string {
  try {
    const cleaned = text.trim().replace(/```json|```/g, "").trim();
    const firstBrace = cleaned.indexOf('{');
    if (firstBrace === -1) return cleaned;
    const target = cleaned.substring(firstBrace);
    return jsonrepair(target);
  } catch (err) {
    console.warn("[AI-SQUAD] jsonrepair failed, falling back to manual extraction", err);
    const firstBrace = text.indexOf('{');
    if (firstBrace === -1) return text;
    let braceCount = 0;
    let inString = false;
    for (let i = firstBrace; i < text.length; i++) {
      const char = text[i];
      if (char === '"' && (i === 0 || text[i - 1] !== '\\')) {
        inString = !inString;
        continue;
      }
      if (!inString) {
        if (char === '{') braceCount++;
        if (char === '}') braceCount--;
        if (braceCount === 0) return text.substring(firstBrace, i + 1);
      }
    }
    return text;
  }
}

function hashParts(parts: unknown[]): string {
  return crypto
    .createHash("sha256")
    .update(JSON.stringify(parts))
    .digest("hex");
}

function createAbortError(): Error {
  const error = new Error("The operation was aborted.");
  error.name = "AbortError";
  return error;
}

function awaitWithSignal<T>(promise: PromiseLike<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(createAbortError());
  return new Promise<T>((resolve, reject) => {
    let settled = false;
    const finish = (callback: () => void) => {
      if (settled) return;
      settled = true;
      signal.removeEventListener("abort", onAbort);
      callback();
    };
    const onAbort = () => finish(() => reject(createAbortError()));
    signal.addEventListener("abort", onAbort, { once: true });
    Promise.resolve(promise).then(
      (value) => finish(() => resolve(value)),
      (error) => finish(() => reject(error)),
    );
  });
}

const SQUAD_USAGE_SETTLE_MS = 1_000;

async function settleSquadUsage(usage: PromiseLike<SquadTokenUsage | undefined>): Promise<SquadTokenUsage | null> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const settled = await Promise.race([
      Promise.resolve(usage).catch(() => null),
      new Promise<null>((resolve) => {
        timer = setTimeout(() => resolve(null), SQUAD_USAGE_SETTLE_MS);
      }),
    ]);
    return settled ?? null;
  } finally {
    clearTimeout(timer);
  }
}

function errorMessageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function closeStreamIterator(iterator: AsyncIterator<unknown> | null) {
  try {
    const pending = iterator?.return?.();
    if (pending && typeof (pending as Promise<unknown>).catch === "function") {
      (pending as Promise<unknown>).catch(() => undefined);
    }
  } catch {
    // 스트림 정리는 best effort다. 실패해도 응답 결정에는 영향을 주지 않는다.
  }
}

function canonicalSquadIdentity(data: any): unknown {
  return {
    groupKey: data.groupKey,
    matchCount: data.matchCount,
    latestMatchCount: data.latestMatchCount,
    bestMatchCount: data.bestMatchCount,
    matchesSummary: Array.isArray(data.matchesSummary) ? data.matchesSummary : [],
    recordedSummary: data.recordedSummary ?? null,
    selectedMatchIds: Array.isArray(data.selectedMatchIds) ? data.selectedMatchIds : [],
    stats: data.stats,
    scores: data.scores,
    roleProfiles: data.roleProfiles,
    squadGrade: data.squadGrade,
    benchmarkStats: data.benchmarkStats,
    teamMode: data.teamMode,
  };
}

/**
 * 모델을 순서대로 시도한다. 응답 시작(첫 파트) 전의 오류·시간 초과만 다음 모델로 넘긴다.
 * 시작 뒤에는 그 모델로 확정해 끝까지 읽고, 중간 오류는 실패로 돌려준다.
 */
async function generateSquadCoaching(input: {
  provider: ReturnType<typeof createGoogleGenerativeAI>;
  system: string;
  prompt: string;
  schema: Schema<SquadAiRawOutput>;
  requestSignal: AbortSignal;
  budgetMs: number;
}): Promise<SquadGeneration> {
  const startedAt = Date.now();
  const deadlineController = new AbortController();
  const deadlineTimer = setTimeout(() => deadlineController.abort(), input.budgetMs);
  const overallSignal = AbortSignal.any([input.requestSignal, deadlineController.signal]);
  const attempts: SquadAttempt[] = [];
  let firstPartMs: number | null = null;
  let timeoutObserved = false;
  try {
    for (const modelName of GEMINI_MODELS_TO_TRY) {
      if (overallSignal.aborted) break;
      const remainingMs = input.budgetMs - (Date.now() - startedAt);
      if (remainingMs <= 0) {
        timeoutObserved = true;
        break;
      }

      const attemptStartedAt = Date.now();
      const attemptController = new AbortController();
      let attemptTimedOut = false;
      const firstPartTimer = setTimeout(() => {
        attemptTimedOut = true;
        attemptController.abort();
      }, Math.min(AI_SQUAD_MODEL_TIMEOUT_MS, remainingMs));
      const attemptSignal = AbortSignal.any([overallSignal, attemptController.signal]);
      let committed = false;
      let iterator: AsyncIterator<any> | null = null;
      try {
        const aiResult = streamText({
          model: input.provider(modelName),
          system: input.system,
          prompt: input.prompt,
          output: Output.object({ schema: input.schema }),
          // 실패 시 같은 모델을 재시도하지 않고 바로 다음 모델로 넘긴다.
          maxRetries: 0,
          abortSignal: attemptSignal,
          providerOptions: { google: { safetySettings: SQUAD_SAFETY_SETTINGS } },
        });
        iterator = aiResult.fullStream[Symbol.asyncIterator]();

        let text = "";
        while (true) {
          const next = await awaitWithSignal(iterator.next(), attemptSignal);
          if (next.done) throw new Error("AI SDK stream ended before a response");
          const part = next.value;
          if (part?.type === "error") throw part.error ?? new Error("Squad provider stream failed");
          if (part?.type === "start-step" || part?.type === "text-delta") {
            if (part.type === "text-delta") text += String(part.text ?? "");
            break;
          }
        }
        clearTimeout(firstPartTimer);
        committed = true;
        firstPartMs = Date.now() - startedAt;

        while (true) {
          const next = await awaitWithSignal(iterator.next(), overallSignal);
          if (next.done) break;
          const part = next.value;
          if (part?.type === "error") throw part.error ?? new Error("Squad provider stream failed");
          if (part?.type === "text-delta" && typeof part.text === "string") text += part.text;
        }
        // 사용량은 summary route와 같은 usage 정산 값을 쓴다. 정산이 늦어도 응답을 붙잡지 않는다.
        const usage = await settleSquadUsage(aiResult.usage);
        attempts.push({ model: modelName, outcome: "selected", ms: Date.now() - attemptStartedAt });
        return {
          ok: true,
          text,
          modelName,
          usage,
          firstPartMs,
          totalMs: Date.now() - startedAt,
          attempts,
        };
      } catch (error) {
        clearTimeout(firstPartTimer);
        closeStreamIterator(iterator);
        const ms = Date.now() - attemptStartedAt;
        if (input.requestSignal.aborted) {
          attempts.push({ model: modelName, outcome: "aborted", ms });
          return { ok: false, reason: "aborted", firstPartMs, totalMs: Date.now() - startedAt, attempts };
        }
        if (deadlineController.signal.aborted) {
          attempts.push({ model: modelName, outcome: "timeout", ms });
          timeoutObserved = true;
          break;
        }
        if (committed) {
          attempts.push({ model: modelName, outcome: "error", ms });
          console.warn(`[AI-SQUAD] Model ${modelName} failed after the response started: ${errorMessageOf(error)}`);
          return { ok: false, reason: "provider", firstPartMs, totalMs: Date.now() - startedAt, attempts };
        }
        if (attemptTimedOut) {
          attempts.push({ model: modelName, outcome: "timeout", ms });
          timeoutObserved = true;
          console.warn(`[AI-SQUAD] Model ${modelName} timed out before its response started; trying next...`);
          continue;
        }
        attempts.push({ model: modelName, outcome: "error", ms });
        console.warn(`[AI-SQUAD] Model ${modelName} failed before its response started (${errorMessageOf(error)}), trying next...`);
      } finally {
        clearTimeout(firstPartTimer);
      }
    }
    if (input.requestSignal.aborted) {
      return { ok: false, reason: "aborted", firstPartMs, totalMs: Date.now() - startedAt, attempts };
    }
    return {
      ok: false,
      reason: timeoutObserved || deadlineController.signal.aborted ? "timeout" : "provider",
      firstPartMs,
      totalMs: Date.now() - startedAt,
      attempts,
    };
  } finally {
    clearTimeout(deadlineTimer);
  }
}

function logSquadRouteTiming(timing: SquadRouteTiming) {
  // 식별자·닉네임·원문은 남기지 않는다. 요청 ID와 단계 시간, 모델 시도 결과만 남긴다.
  console.info(JSON.stringify({
    kind: "ai-route-timing",
    route: "squad",
    requestId: timing.requestId,
    stages: timing.stages,
    attempts: timing.attempts,
    outcome: timing.outcome ?? "error",
  }));
}

export async function POST(request: Request) {
  const requestId = crypto.randomUUID();
  const timing: SquadRouteTiming = {
    requestId,
    stages: { auth: null, dataLoad: null, cacheLookup: null, geminiFirstPart: null, geminiTotal: null, persist: null, total: null },
    attempts: [],
  };
  const startedAt = Date.now();
  let response: Response;
  try {
    response = await runSquadRoute(request, requestId, startedAt, timing);
  } finally {
    timing.stages.total = Date.now() - startedAt;
    logSquadRouteTiming(timing);
  }
  return response;
}

async function runSquadRoute(request: Request, requestId: string, startedAt: number, timing: SquadRouteTiming): Promise<Response> {
  let body: any = {};
  let authenticatedUserId: string | undefined;
  let requestedPlatform = "steam";
  try {
    if (request.signal.aborted) throw new SquadRequestAbortedError();

    // 🔒 [Security] JWT Authentication Guard - Only logged-in users can call AI coaching
    const auth = await withAuthGuard();
    timing.stages.auth = Date.now() - startedAt;
    if (auth.error) return auth.error;
    const { supabaseAdmin: supabase } = auth;
    authenticatedUserId = auth.user?.id;

    if (request.signal.aborted) throw new SquadRequestAbortedError();
    body = await request.json();
    const {
      groupKey,
      nickname,
      platform = "steam",
      coachingStyle = "spicy",
    } = body;
    requestedPlatform = String(platform || "steam");
    const playerId = normalizeName(nickname);
    const cachePlatform = normalizePlatform(platform);

    // 단일 경기 분석과 같이 허용 스타일만 받는다. 다른 값이 캐시 키와 프롬프트에 섞이지 않게 한다.
    if (coachingStyle !== "mild" && coachingStyle !== "spicy") {
      return NextResponse.json({ error: "invalid coaching style", errorCode: "PUBG_AI_INVALID_COACHING_STYLE" }, { status: 400 });
    }

    if (typeof groupKey !== "string" || !groupKey.trim() || !nickname || !playerId) {
      trackAiFailure(authenticatedUserId, "squad", "Missing required squad parameters", { errorCode: "invalid_input", durationMs: Date.now() - startedAt, requestId, platform: requestedPlatform });
      return NextResponse.json({ error: "Missing required squad parameters" }, { status: 400 });
    }
    const privateResponse = await blockPrivatePlayer(cachePlatform, nickname, undefined, { lookupUpstream: true });
    if (privateResponse) return privateResponse;
    if (request.signal.aborted) throw new SquadRequestAbortedError();

    // All numeric evidence is recomputed server-side.  The request contributes
    // only identity/control fields; forged stats/scores/roles/benchmarks are
    // intentionally ignored rather than compared or merged.
    const dataLoadStartedAt = Date.now();
    const squadData = await getSquadAnalysisData(nickname, cachePlatform, groupKey);
    timing.stages.dataLoad = Date.now() - dataLoadStartedAt;
    if (request.signal.aborted) throw new SquadRequestAbortedError();
    // AI 호출 전에 막는 경우도 원인을 사용 기록에 남긴다. 기록이 없으면 운영에서 실패 이유를 찾을 수 없다.
    const trackBlocked = (reason: string, errorCode: string) => trackAiFailure(authenticatedUserId, "squad", reason, {
      errorCode, durationMs: Date.now() - startedAt, requestId, platform: requestedPlatform,
    });
    if (squadData && "analysisAvailability" in squadData && squadData.analysisAvailability === "basic_only") {
      trackBlocked("squad calculation upgrade required", "calculation_upgrade");
      return NextResponse.json({error: "전술 지표를 다시 계산한 뒤 AI 코칭을 이용할 수 있습니다.", errorCode: "PUBG_CALCULATION_UPGRADE_REQUIRED", retryable: false}, {status: 409});
    }
    if (squadData && "errorCode" in squadData && squadData.errorCode === "PUBG_CALCULATION_UPGRADE_REQUIRED") {
      trackBlocked("squad calculation upgrade required", "calculation_upgrade");
      return NextResponse.json(squadData, { status: 409 });
    }
    if (squadData && Array.isArray(squadData.selectedMatchIds) && Array.isArray(squadData.matchesSummary)) {
      const selectedIds = new Set(squadData.selectedMatchIds);
      const expiredSelected = squadData.matchesSummary.filter((match: any) => selectedIds.has(match?.matchId)
        && isMatchDetailExpired(match?.createdAt));
      if (expiredSelected.length > 0) {
        trackBlocked("selected squad match detail expired", "detail_expired");
        return expiredMatchDetailResponse(expiredSelected[0].createdAt);
      }
    }
    if (!squadData || !("matchesSummary" in squadData) || !Array.isArray(squadData.matchesSummary)
      || !squadData.stats || !squadData.scores || !Array.isArray(squadData.roleProfiles)
      || !squadData.benchmarkStats || !Number.isInteger(squadData.matchCount) || squadData.matchCount <= 0
      || !hasSquadObservations(squadData.stats)) {
      trackBlocked("no squad team observations in selected matches", "squad_not_ready");
      return NextResponse.json({
        error: "팀 분석 데이터가 있는 최근 경기가 없습니다. 이 팀과 함께한 최근 경기를 상세 분석하면 AI 코칭을 이용할 수 있습니다.",
        errorCode: "PUBG_AI_SQUAD_CANONICAL_NOT_READY",
        retryable: false,
      }, { status: 409 });
    }
    // 경기 수가 적으면 한두 판의 우연을 팀 특성처럼 말하게 되므로 모델을 호출하지 않는다.
    if (squadData.matchCount < SQUAD_AI_MIN_MATCH_COUNT) {
      trackBlocked("squad matches below the AI minimum", "too_few_matches");
      return NextResponse.json({
        error: `${SQUAD_AI_MIN_MATCH_COUNT}경기 이상 함께 플레이하면 AI 코칭을 이용할 수 있습니다.`,
        errorCode: SQUAD_AI_TOO_FEW_MATCHES_ERROR_CODE,
        retryable: false,
        minMatchCount: SQUAD_AI_MIN_MATCH_COUNT,
        matchCount: squadData.matchCount,
      }, { status: 409 });
    }
    const canonical = canonicalSquadIdentity(squadData);
    const matchIdsHash = hashParts(["canonical-squad", playerId, cachePlatform, canonical]);
    const canonicalStats = squadData.stats;
    const canonicalScores = squadData.scores;
    const canonicalRoleProfiles = squadData.roleProfiles;
    const canonicalGrade = typeof squadData.squadGrade === "string" && squadData.squadGrade.trim() ? squadData.squadGrade : null;
    const canonicalBenchmarkStats = squadData.benchmarkStats;
    const canonicalMatchCount = squadData.matchCount;
    // 우승·순위 재료는 상세 분석 여부와 무관한 전적 기록(같은 조합, 최근 14일)을 우선한다. 기록이 부족하면 분석된 경기로 대신한다.
    const recordedPlacements = (squadData.recordedSummary?.matches ?? []).filter((match: { winPlace: number }) => match.winPlace > 0);
    const canonicalMatchesSummary = recordedPlacements.length >= SQUAD_AI_MIN_MATCH_COUNT
      ? recordedPlacements.map((match: { matchId: string; winPlace: number }) => ({ matchId: match.matchId, winPlace: match.winPlace }))
      : squadData.matchesSummary;
    // 보류 문구 치환 스타일. 입력은 위에서 mild/spicy로 검증했다.
    const policyCoachingStyle: "mild" | "spicy" = coachingStyle;

    // 계산된 팀 지표만 담은 사실 응답. AI 해석이 없음을 명시하고 캐시에는 저장하지 않는다.
    const factsOnlyResponse = (reason: "timeout" | "provider" | "disabled") => {
      timing.outcome = "facts_only";
      return NextResponse.json({
        mode: "facts_only",
        aiInterpretation: false,
        errorCode: SQUAD_AI_FACTS_ONLY_ERROR_CODE,
        reason,
        message: AI_SQUAD_FACTS_ONLY_MESSAGE,
        retryable: true,
        squadGrade: canonicalGrade,
        facts: {
          groupKey: squadData.groupKey,
          teamMode: squadData.teamMode,
          matchCount: canonicalMatchCount,
          squadGrade: canonicalGrade,
          stats: canonicalStats,
          scores: canonicalScores,
          benchmarkStats: canonicalBenchmarkStats,
        },
      }, { headers: { "Cache-Control": "no-store" } });
    };

    // 2. Perform DB Cache Lookup
    if (request.signal.aborted) throw new SquadRequestAbortedError();
    const cacheLookupStartedAt = Date.now();
    try {
      const { data: cached, error: cacheErr } = await supabase
        .from("squad_ai_coaching_cache")
        .select("ai_result")
        .eq("player_id", playerId)
        .eq("platform", cachePlatform)
        .eq("group_key", groupKey)
        .eq("match_ids_hash", matchIdsHash)
        .eq("coaching_style", coachingStyle)
        .eq("prompt_version", AI_SQUAD_CACHE_VERSION)
        .abortSignal(request.signal)
        .maybeSingle();

      if (request.signal.aborted) throw new SquadRequestAbortedError();

      if (!cacheErr && cached && cached.ai_result) {
        timing.stages.cacheLookup = Date.now() - cacheLookupStartedAt;
        trackAiUsage(authenticatedUserId, "gemini-cache", 0, 0, "squad", {
          durationMs: Date.now() - startedAt,
          requestId,
          platform: requestedPlatform,
        });
        timing.outcome = "cache_hit";
        return NextResponse.json(applySquadEvidencePolicy(
          sanitizeSquadAbilityClaims(sanitizeAiCoachingLanguage(cached.ai_result), policyCoachingStyle),
          canonicalStats,
          canonicalGrade,
          canonicalScores,
          canonicalRoleProfiles,
          { coachingStyle: policyCoachingStyle, benchmarkStats: canonicalBenchmarkStats },
        ));
      }
    } catch (dbErr) {
      if (request.signal.aborted) throw new SquadRequestAbortedError();
      console.warn("[AI-SQUAD] Cache lookup failed:", dbErr);
    }
    timing.stages.cacheLookup = Date.now() - cacheLookupStartedAt;

    if (request.signal.aborted) throw new SquadRequestAbortedError();

    // 운영 차단 스위치. 캐시 적중은 위에서 이미 반환했고, 여기서는 모델 호출만 막는다.
    if (process.env.PUBG_AI_GENERATION_DISABLED === "true") {
      trackAiFailure(authenticatedUserId, "squad", "AI generation is disabled by operator switch", {
        errorCode: "generation_disabled", durationMs: Date.now() - startedAt, requestId, platform: requestedPlatform,
      });
      return factsOnlyResponse("disabled");
    }

    const apiKey = process.env.GOOGLE_GEMINI_API_KEY;
    if (!apiKey) {
      trackAiFailure(authenticatedUserId, "squad", "Missing Gemini API Key Configuration", { errorCode: "configuration", durationMs: Date.now() - startedAt, requestId, platform: requestedPlatform });
      return NextResponse.json({ error: "Missing Gemini API Key Configuration" }, { status: 500 });
    }

    const { prompt, systemInstruction } = buildSquadAiCoachingPrompt({
      groupKey,
      stats: canonicalStats,
      scores: canonicalScores,
      roleProfiles: canonicalRoleProfiles,
      nickname,
      coachingStyle,
      squadGrade: canonicalGrade,
      benchmarkStats: canonicalBenchmarkStats,
      matchCount: canonicalMatchCount,
      matchesSummary: canonicalMatchesSummary,
      teamMode: squadData.teamMode,
    });

    // 3. Try multiple Gemini models in order (first-part failures move to the next model)
    if (request.signal.aborted) throw new SquadRequestAbortedError();
    const generation = await generateSquadCoaching({
      // 기본 provider는 GOOGLE_GENERATIVE_AI_API_KEY를 읽으므로 이 route의 키를 명시적으로 넘긴다.
      provider: createGoogleGenerativeAI({ apiKey }),
      system: systemInstruction,
      prompt,
      schema: buildSquadOutputSchema(canonicalGrade),
      requestSignal: request.signal,
      // 라우트 전체 예산(POST 시작 기준)을 넘지 않도록 생성 예산을 남은 시간으로 자른다.
      budgetMs: Math.min(AI_SQUAD_TOTAL_TIMEOUT_MS, Math.max(0, AI_SQUAD_ROUTE_TIMEOUT_MS - (Date.now() - startedAt))),
    });
    timing.attempts = generation.attempts;
    timing.stages.geminiFirstPart = generation.firstPartMs;
    timing.stages.geminiTotal = generation.totalMs;

    if (!generation.ok) {
      if (generation.reason === "aborted") throw new SquadRequestAbortedError();
      const timedOut = generation.reason === "timeout";
      trackAiFailure(authenticatedUserId, "squad", timedOut ? "Squad Gemini models timed out" : "All Gemini models failed to respond", {
        errorCode: timedOut ? "timeout" : "model",
        modelName: generation.attempts.find(attempt => attempt.outcome === "error" || attempt.outcome === "timeout")?.model,
        durationMs: Date.now() - startedAt,
        requestId,
        platform: requestedPlatform,
      });
      return factsOnlyResponse(timedOut ? "timeout" : "provider");
    }

    if (generation.usage) {
      trackAiUsage(
        authenticatedUserId,
        generation.modelName,
        generation.usage.inputTokens ?? 0,
        generation.usage.outputTokens ?? 0,
        "squad",
        { durationMs: Date.now() - startedAt, requestId, platform: requestedPlatform },
      );
    }

    let resultJson: unknown;
    try {
      const validJsonString = extractValidJson(generation.text);
      const rawResult = JSON.parse(validJsonString);
      if (!isCompleteSquadOutput(rawResult)) throw new Error("incomplete squad output");
      resultJson = applySquadEvidencePolicy(
        sanitizeSquadAbilityClaims(sanitizeAiCoachingLanguage(structuredClone(rawResult)), policyCoachingStyle),
        canonicalStats,
        canonicalGrade,
        canonicalScores,
        canonicalRoleProfiles,
        { coachingStyle: policyCoachingStyle, benchmarkStats: canonicalBenchmarkStats },
      );
      // 정책이 모델 문장을 바꾼 칸 수를 남긴다. 문장 내용은 남기지 않는다. 보류가 얼마나 잦은지 운영에서 볼 수 있게 한다.
      const replacedFields = listReplacedSquadFields(rawResult, resultJson);
      if (replacedFields.length > 0) console.info(`[AI-SQUAD] evidence policy replaced ${replacedFields.length} field(s): ${replacedFields.join(", ")}`);
    } catch {
      // 파싱 오류 문구에는 모델 원문 일부가 들어갈 수 있어 길이만 남긴다.
      console.warn(`[AI-SQUAD] Generated response could not be parsed (length=${generation.text.length})`);
      trackAiFailure(authenticatedUserId, "squad", "Squad AI response JSON invalid", {
        errorCode: "parse", durationMs: Date.now() - startedAt, requestId, platform: requestedPlatform,
      });
      return factsOnlyResponse("provider");
    }

    // 3. Write to DB Cache
    if (request.signal.aborted) throw new SquadRequestAbortedError();
    const persistStartedAt = Date.now();
    try {
      const { error: saveErr } = await supabase
        .from("squad_ai_coaching_cache")
        .upsert({
          player_id: playerId,
          platform: cachePlatform,
          group_key: groupKey,
          match_ids_hash: matchIdsHash,
          coaching_style: coachingStyle,
          prompt_version: AI_SQUAD_CACHE_VERSION,
          ai_result: resultJson,
          updated_at: new Date().toISOString()
        }, { onConflict: "player_id,platform,group_key,match_ids_hash,coaching_style,prompt_version" });
      if (saveErr) throw saveErr;
    } catch (saveErr: any) {
      console.warn("[AI-SQUAD] Failed to write cache to DB:", saveErr.message || saveErr);
    }
    timing.stages.persist = Date.now() - persistStartedAt;

    timing.outcome = "generated";
    return NextResponse.json(resultJson);

  } catch (error) {
    console.error("[AI-SQUAD-ERROR]", error);
    trackAiFailure(authenticatedUserId, "squad", error, {
      durationMs: Date.now() - startedAt,
      requestId,
      platform: requestedPlatform,
    });
    const requestAborted = request.signal.aborted || error instanceof SquadRequestAbortedError;
    timing.outcome = requestAborted ? "aborted" : "error";
    const errorCode = requestAborted ? "PUBG_AI_SQUAD_ABORTED" : "PUBG_AI_SQUAD_PROVIDER_ERROR";
    return NextResponse.json(
      {
        error: "스쿼드 AI 분석을 완료하지 못했습니다. 잠시 후 다시 시도해 주세요.",
        errorCode,
        retryable: true,
      },
      { status: 503 },
    );
  }
}
