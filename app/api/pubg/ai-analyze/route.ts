import { applyMatchAiEvidencePolicy } from "@/lib/pubg-analysis/matchAiEvidence";
import { applyMatchAiSceneRefs } from "@/lib/pubg-analysis/matchAiScenes";
import { applyMatchSpicyJab } from "@/lib/pubg-analysis/spicyPunchlines";
import { NextResponse } from "next/server";
import { GoogleGenerativeAI, HarmCategory, HarmBlockThreshold } from "@google/generative-ai";
import { withAuthGuard } from "@/utils/supabase/guard";
import { trackAiFailure, trackAiUsage } from "@/lib/pubg-analysis/aiUsageTracker";
import { AI_GENERATION_DISABLED_ERROR_CODE, AI_GENERATION_DISABLED_MESSAGE, isAiGenerationDisabled } from "@/lib/pubg-analysis/aiGenerationSwitch";
import { AI_MATCH_PROMPT_VERSION, isSupportedAnalysisCalculationVersion, GEMINI_MODELS_TO_TRY, RESULT_VERSION } from "@/lib/pubg-analysis/constants";
import { normalizeName } from "@/lib/pubg-analysis/utils";
import { getValidFullResultForMatch, normalizePlatform } from "@/lib/pubg-analysis/cacheIdentity";
import { normalizeMatchId } from "@/lib/pubg-analysis/recentMatchSelection";
import { sanitizeBackupCoachingText } from "@/lib/pubg-analysis/backupCoaching";
import { buildMatchAiCoachingPrompt } from "@/lib/pubg-analysis/matchAiCoachingPrompt";
import { sanitizeAiCoachingLanguageText } from "@/lib/pubg-analysis/aiCoachingQuality";
import crypto from "crypto";
import { blockPrivatePlayer } from "@/lib/pubg/privatePlayerGuard";
import { canonicalMatchPlayedAt, expiredMatchDetailResponse, isMatchDetailExpired, lookupMatchPlayedAt, resolveTrustedMatchPlayedAt } from "@/lib/pubg-analysis/matchRetention.server";

// 매운맛은 근거 정책을 거친 응답 끝에 서버 한마디를 붙인다. 캐시 응답에 다시 적용해도 한 번만 붙는다.
function withStyleJab(text: string, match: unknown, coachingStyle: string): string {
  return coachingStyle === "spicy" ? applyMatchSpicyJab(text, match) : text;
}

// 근거 정책 뒤에 장면 ID를 이 경기 장면 목록으로 검증하고, 정책이 바꾼 문장의 장면 ID는 버린다.
// 새 응답과 캐시 응답에 같은 순서로 적용한다. 정책이 재적용에 안정적이라 이미 처리된 캐시 텍스트는 그대로 남는다.
function finalizeMatchAiText(text: string, match: unknown, coachingStyle: string): string {
  return withStyleJab(applyMatchAiSceneRefs(applyMatchAiEvidencePolicy(text, match), match, text), match, coachingStyle);
}

const CANONICAL_MATCH_ID = /^[A-Za-z0-9._-]{1,160}$/;
const AI_ANALYZE_ROUTE_TIMEOUT_MS = 40_000;
const AI_ANALYZE_MODEL_TIMEOUT_MS = 25_000;

type ComposedAbortSignal = {
  signal: AbortSignal;
  cleanup: () => void;
};

function composeAbortSignals(signals: readonly AbortSignal[]): ComposedAbortSignal {
  if (signals.length === 1) return { signal: signals[0], cleanup: () => undefined };
  if (typeof AbortSignal.any === "function") {
    return { signal: AbortSignal.any(Array.from(signals)), cleanup: () => undefined };
  }

  const controller = new AbortController();
  const abort = () => controller.abort();
  signals.forEach((signal) => {
    if (signal.aborted) controller.abort();
    else signal.addEventListener("abort", abort, { once: true });
  });
  return {
    signal: controller.signal,
    cleanup: () => signals.forEach((signal) => signal.removeEventListener("abort", abort)),
  };
}

function createAbortPromise(signal: AbortSignal): { promise: Promise<never>; cleanup: () => void } {
  let onAbort: (() => void) | null = null;
  const promise = new Promise<never>((_, reject) => {
    onAbort = () => {
      const abortError = new Error("The operation was aborted.");
      abortError.name = "AbortError";
      reject(abortError);
    };
    if (signal.aborted) onAbort();
    else signal.addEventListener("abort", onAbort, { once: true });
  });
  return {
    promise,
    cleanup: () => {
      if (onAbort) signal.removeEventListener("abort", onAbort);
    },
  };
}

async function awaitWithAbort<T>(promise: PromiseLike<T>, signal: AbortSignal): Promise<T> {
  const abortPromise = createAbortPromise(signal);
  try {
    return await Promise.race([Promise.resolve(promise), abortPromise.promise]);
  } finally {
    abortPromise.cleanup();
  }
}

export async function POST(request: Request) {
  const requestId = crypto.randomUUID();
  const startedAt = Date.now();
  const routeDeadlineController = new AbortController();
  const routeDeadlineTimer = setTimeout(
    () => routeDeadlineController.abort(),
    AI_ANALYZE_ROUTE_TIMEOUT_MS,
  );
  const streamAbortController = new AbortController();
  let selectedModelSignalCleanup: (() => void) | null = null;
  const routeSignal = composeAbortSignals([
    request.signal,
    routeDeadlineController.signal,
    streamAbortController.signal,
  ]);
  let routeCleanupOwnedByStream = false;
  let routeCleaned = false;
  const cleanupRoute = () => {
    if (routeCleaned) return;
    routeCleaned = true;
    clearTimeout(routeDeadlineTimer);
    routeSignal.cleanup();
    selectedModelSignalCleanup?.();
    selectedModelSignalCleanup = null;
  };
  const isRouteAborted = () => routeSignal.signal.aborted;
  const isStreamCancelled = () => streamAbortController.signal.aborted;
  let authenticatedUserId: string | undefined;
  let requestedPlatform = "steam";
  try {
    if (isRouteAborted()) throw new DOMException("The operation was aborted.", "AbortError");
    // 🔒 [보안] JWT 인증 가드 — 로그인된 사용자만 AI 분석 실행 허용 (Gemini API 비용 방어)
    const auth = await awaitWithAbort(withAuthGuard(), routeSignal.signal);
    if (auth.error) return auth.error;
    if (isRouteAborted()) throw new DOMException("The operation was aborted.", "AbortError");
    const { supabaseAdmin: supabase } = auth;
    authenticatedUserId = auth.user?.id;

    const body = await awaitWithAbort(request.json(), routeSignal.signal);
    const { matchData, nickname, platform = "steam" } = body ?? {};
    const requestedCoachingStyle: unknown = body?.coachingStyle;
    const coachingStyle = requestedCoachingStyle === undefined ? "spicy" : requestedCoachingStyle;
    requestedPlatform = String(platform || "steam");

    if (coachingStyle !== "mild" && coachingStyle !== "spicy") {
      return NextResponse.json({
        error: "invalid coaching style",
        errorCode: "PUBG_AI_INVALID_COACHING_STYLE",
      }, { status: 400 });
    }

    if (!matchData || typeof nickname !== "string" || !nickname.trim()) {
      trackAiFailure(authenticatedUserId, "analyze", "Missing data", { errorCode: "invalid_input", durationMs: Date.now() - startedAt, requestId, platform: requestedPlatform });
      return NextResponse.json({ error: "Missing data" }, { status: 400 });
    }

    const matchDataRecord = typeof matchData === "object" && matchData !== null && !Array.isArray(matchData)
      ? matchData as Record<string, unknown>
      : null;
    const rawMatchIds = matchDataRecord
      ? (["matchId", "match_id", "id"] as const)
        .filter((key) => key in matchDataRecord && matchDataRecord[key] !== undefined && matchDataRecord[key] !== null)
        .map((key) => typeof matchDataRecord[key] === "string" ? normalizeMatchId(matchDataRecord[key]) : null)
      : [];
    const matchId = rawMatchIds.length > 0 && rawMatchIds.every((id) => id && id === rawMatchIds[0] && CANONICAL_MATCH_ID.test(id))
      ? rawMatchIds[0]
      : null;
    if (!matchId) {
      trackAiFailure(authenticatedUserId, "analyze", "Missing matchId", { errorCode: "invalid_input", durationMs: Date.now() - startedAt, requestId, platform: requestedPlatform });
      return NextResponse.json({ error: "Missing matchId" }, { status: 400 });
    }
    const playerId = normalizeName(nickname);
    const cachePlatform = normalizePlatform(platform);
    const privateResponse = await blockPrivatePlayer(cachePlatform, nickname, undefined, { lookupUpstream: true });
    if (privateResponse) return privateResponse;

    let canonicalRow: unknown = null;
    try {
      const { data, error } = await awaitWithAbort(supabase
        .from("processed_match_telemetry")
        .select("match_id,player_id,platform,data")
        .eq("match_id", matchId)
        .eq("player_id", playerId)
        .eq("platform", cachePlatform)
        .abortSignal(routeSignal.signal)
        .maybeSingle(), routeSignal.signal);
      if (!error) canonicalRow = data;
      else console.warn("[AI-ANALYZE] Canonical telemetry lookup failed:", error);
    } catch (canonicalLookupError) {
      if (isRouteAborted()) throw canonicalLookupError;
      console.warn("[AI-ANALYZE] Canonical telemetry lookup failed:", canonicalLookupError);
    }
    if (isRouteAborted()) throw new DOMException("The operation was aborted.", "AbortError");

    let historyPlayedAt: string | null;
    try {
      historyPlayedAt = await awaitWithAbort(lookupMatchPlayedAt(supabase, {
        matchId, platform: cachePlatform, playerId, signal: routeSignal.signal,
      }), routeSignal.signal);
    } catch (error) {
      if (isRouteAborted()) throw error;
      console.error("[AI-ANALYZE] Match retention date lookup failed");
      return NextResponse.json({
        error: "경기 상세 제공 기간을 확인할 수 없습니다.",
        errorCode: "PUBG_MATCH_DETAIL_RETENTION_UNAVAILABLE",
        retryable: true,
      }, { status: 503, headers: { "Cache-Control": "no-store" } });
    }
    const retentionResult = getValidFullResultForMatch(canonicalRow, {
      matchId, playerId, platform: cachePlatform, minResultVersion: 0,
    });
    const playedAt = resolveTrustedMatchPlayedAt(historyPlayedAt, canonicalMatchPlayedAt(retentionResult));
    if (isMatchDetailExpired(playedAt)) return expiredMatchDetailResponse(playedAt);

    const canonicalFullResult = getValidFullResultForMatch(canonicalRow, {
      matchId,
      playerId,
      platform: cachePlatform,
      minResultVersion: RESULT_VERSION,
      requirePopulationEvidence: true,
      requireExactResultVersion: true,
      requirePromptSafeStats: true,
      requireSupportedCalculation: true,
    });
    if (!canonicalFullResult) {
      const previous = getValidFullResultForMatch(canonicalRow, {
        matchId, playerId, platform: cachePlatform, minResultVersion: RESULT_VERSION,
        requireExactResultVersion: true, requirePopulationEvidence: true, requirePromptSafeStats: true,
      });
      if (previous && !isSupportedAnalysisCalculationVersion(previous.calculationVersion)) {
        return NextResponse.json({error: "새 계산 기준으로 다시 계산이 필요합니다. 기본 전적은 계속 이용할 수 있습니다.", errorCode: "PUBG_CALCULATION_UPGRADE_REQUIRED", retryable: false}, {status:409});
      }
      return NextResponse.json({
        error: "canonical match analysis is not ready",
        errorCode: "PUBG_AI_CANONICAL_NOT_READY",
        retryable: true,
      }, { status: 409 });
    }

    const cachePromptVersion = `${AI_MATCH_PROMPT_VERSION}.calc${canonicalFullResult.calculationVersion}`;

    // Cache compatibility is checked only after the current marked canonical
    // telemetry row has been proven.  This prevents a pre-marker cache entry
    // from bypassing the v73/population-evidence contract.
    try {
      const { data: cached, error: cacheErr } = await awaitWithAbort(supabase
        .from("match_ai_coaching_cache")
        .select("ai_result")
        .eq("match_id", matchId)
        .eq("platform", cachePlatform)
        .eq("player_id", playerId)
        .eq("coaching_style", coachingStyle)
        .eq("prompt_version", cachePromptVersion)
        .abortSignal(routeSignal.signal)
        .maybeSingle(), routeSignal.signal);

      if (!cacheErr && cached && cached.ai_result) {
        trackAiUsage(authenticatedUserId, "gemini-cache", 0, 0, "analyze", {
          durationMs: Date.now() - startedAt,
          requestId,
          platform: requestedPlatform,
        });
        const cachedData = cached.ai_result as any;
        const cachedText = finalizeMatchAiText(sanitizeAiCoachingLanguageText(String(cachedData.text || "")), canonicalFullResult, coachingStyle);
        const encoder = new TextEncoder();
        const stream = new ReadableStream({
          start(controller) {
            controller.enqueue(encoder.encode(JSON.stringify({ type: "chunk", data: cachedText }) + "\n"));
            controller.enqueue(encoder.encode(JSON.stringify({ type: "done" }) + "\n"));
            controller.close();
          }
        });
        return new Response(stream, { headers: { "Content-Type": "application/x-ndjson", "Cache-Control": "no-cache" } });
      }
    } catch (dbErr) {
      if (isRouteAborted()) throw dbErr;
      console.warn("[AI-ANALYZE] Cache lookup failed:", dbErr);
    }
    if (isRouteAborted()) throw new DOMException("The operation was aborted.", "AbortError");

    // 차단 스위치는 캐시 적중 뒤에 둔다. 적중한 분석은 계속 돌려주고, 새 생성만 막는다.
    if (isAiGenerationDisabled()) {
      trackAiFailure(authenticatedUserId, "analyze", AI_GENERATION_DISABLED_ERROR_CODE, { errorCode: AI_GENERATION_DISABLED_ERROR_CODE, durationMs: Date.now() - startedAt, requestId, platform: requestedPlatform });
      return NextResponse.json({ error: AI_GENERATION_DISABLED_MESSAGE, errorCode: AI_GENERATION_DISABLED_ERROR_CODE, retryable: false }, { status: 503 });
    }

    const apiKey = process.env.GOOGLE_GEMINI_API_KEY;
    if (!apiKey) {
      trackAiFailure(authenticatedUserId, "analyze", "No API Key", { errorCode: "configuration", durationMs: Date.now() - startedAt, requestId, platform: requestedPlatform });
      return NextResponse.json({ error: "No API Key" }, { status: 500 });
    }

    const { fullPrompt, backupContext } = buildMatchAiCoachingPrompt({
      matchData: canonicalFullResult,
      coachingStyle,
    });

    const genAI = new GoogleGenerativeAI(apiKey);
    const modelsToTry = GEMINI_MODELS_TO_TRY;
    const safetySettings = [
      { category: HarmCategory.HARM_CATEGORY_HARASSMENT, threshold: HarmBlockThreshold.BLOCK_NONE },
      { category: HarmCategory.HARM_CATEGORY_HATE_SPEECH, threshold: HarmBlockThreshold.BLOCK_NONE }
    ];

    let streamResult = null;
    let fallbackText = null;
    let selectedModelName = "";
    let nonStreamRes: any = null;
    let modelTimeoutObserved = false;
    const overallSignal = routeSignal.signal;

    for (const modelName of modelsToTry) {
      if (overallSignal.aborted || request.signal.aborted) break;
      const modelTimeoutController = new AbortController();
      let modelAttemptTimedOut = false;
      const modelTimeoutTimer = setTimeout(
        () => {
          modelAttemptTimedOut = true;
          modelTimeoutObserved = true;
          modelTimeoutController.abort();
        },
        AI_ANALYZE_MODEL_TIMEOUT_MS,
      );
      const modelSignal = composeAbortSignals([overallSignal, modelTimeoutController.signal]);
      let preserveModelSignal = false;
      try {
        const model = genAI.getGenerativeModel({ model: modelName, safetySettings });
        try {
          streamResult = await awaitWithAbort(model.generateContentStream(fullPrompt, {
            signal: modelSignal.signal,
            timeout: AI_ANALYZE_MODEL_TIMEOUT_MS,
          }), modelSignal.signal);
          if (overallSignal.aborted || request.signal.aborted) break;
          if (modelAttemptTimedOut) continue;
          if (streamResult) {
            selectedModelName = modelName;
            preserveModelSignal = true;
            selectedModelSignalCleanup = modelSignal.cleanup;
            break;
          }
        } catch (streamErr: any) {
          if (overallSignal.aborted || request.signal.aborted) break;
          if (modelAttemptTimedOut) throw streamErr;
          console.error(`[AI-ANALYZE] Stream failed for ${modelName}, trying non-stream fallback:`, streamErr.message || streamErr);
          nonStreamRes = await awaitWithAbort(model.generateContent(fullPrompt, {
            signal: modelSignal.signal,
            timeout: AI_ANALYZE_MODEL_TIMEOUT_MS,
          }), modelSignal.signal);
          fallbackText = nonStreamRes.response.text();
          if (fallbackText) {
            selectedModelName = modelName;
            break;
          }
        }
      } catch (err: any) { 
        if (overallSignal.aborted || request.signal.aborted) break;
        if (modelAttemptTimedOut) {
          console.warn(`[AI-ANALYZE] Model ${modelName} timed out; trying next...`);
          continue;
        }
        console.error(`[AI-ANALYZE] Model ${modelName} initialization failed:`, err.message || err);
        continue; 
      } finally {
        clearTimeout(modelTimeoutTimer);
        if (!preserveModelSignal) modelSignal.cleanup();
      }
    }

    if (modelTimeoutObserved && !streamResult && !fallbackText && !request.signal.aborted && !overallSignal.aborted) {
      trackAiFailure(authenticatedUserId, "analyze", "first_part: all models timed out", {
        errorCode: "PUBG_AI_ROUTE_TIMEOUT",
        durationMs: Date.now() - startedAt,
        requestId,
        platform: requestedPlatform,
      });
      return NextResponse.json({
        error: "AI analysis request timed out",
        errorCode: "PUBG_AI_ROUTE_TIMEOUT",
        retryable: true,
      }, { status: 504 });
    }
    if (isRouteAborted()) throw new DOMException("The operation was aborted.", "AbortError");
    if (!streamResult && !fallbackText) throw new Error("모든 AI 모델이 응답에 실패했습니다.");

    const encoder = new TextEncoder();
    const stream = new ReadableStream({
      cancel(reason) {
        if (!streamAbortController.signal.aborted) streamAbortController.abort(reason);
      },
      async start(controller) {
        try {
          let aiResponseText = "";
          if (streamResult) {
            const iterator = streamResult.stream[Symbol.asyncIterator]();
            try {
              while (true) {
                if (isRouteAborted()) throw new DOMException("The operation was aborted.", "AbortError");
                const nextPromise = iterator.next();
                nextPromise.catch(() => undefined);
                const nextResult = await awaitWithAbort(nextPromise, routeSignal.signal);
                if (nextResult.done) break;
                aiResponseText += nextResult.value?.text?.() || "";
              }
            } finally {
              if (isRouteAborted()) {
                try {
                  const returnPromise = iterator.return?.(undefined);
                  returnPromise?.catch(() => undefined);
                } catch {
                  // Iterator cleanup is best effort after cancellation.
                }
              }
            }
            if (isRouteAborted()) throw new DOMException("The operation was aborted.", "AbortError");
            const sanitizedText = finalizeMatchAiText(sanitizeAiCoachingLanguageText(sanitizeBackupCoachingText(aiResponseText, backupContext)), canonicalFullResult, coachingStyle);
            aiResponseText = sanitizedText;
            controller.enqueue(encoder.encode(JSON.stringify({ type: "chunk", data: sanitizedText }) + "\n"));

            // 비동기로 사용량 메타데이터 획득 후 로깅
            streamResult.response.then((res: any) => {
              if (res.usageMetadata && !isRouteAborted()) {
                trackAiUsage(
                  auth.user?.id,
                  selectedModelName,
                  res.usageMetadata.promptTokenCount,
                  (res.usageMetadata.candidatesTokenCount || 0) + (res.usageMetadata.thoughtsTokenCount || 0),
                  "analyze",
                  { durationMs: Date.now() - startedAt, requestId, platform: requestedPlatform },
                );
              }
            }).catch((err: any) => console.error("[AI-ANALYZE] Usage fetch error:", err));

          } else if (fallbackText) { 
            aiResponseText = finalizeMatchAiText(sanitizeAiCoachingLanguageText(sanitizeBackupCoachingText(fallbackText, backupContext)), canonicalFullResult, coachingStyle);
            controller.enqueue(encoder.encode(JSON.stringify({ type: "chunk", data: aiResponseText }) + "\n"));
            
            if (nonStreamRes?.response?.usageMetadata) {
              trackAiUsage(
                auth.user?.id,
                selectedModelName,
                nonStreamRes.response.usageMetadata.promptTokenCount,
                (nonStreamRes.response.usageMetadata.candidatesTokenCount || 0) + (nonStreamRes.response.usageMetadata.thoughtsTokenCount || 0),
                "analyze",
                { durationMs: Date.now() - startedAt, requestId, platform: requestedPlatform },
              );
            }
          }

          // 3. Write to DB Cache
          if (aiResponseText) {
            try {
              if (isRouteAborted()) throw new DOMException("The operation was aborted.", "AbortError");
              const { error: saveErr } = await awaitWithAbort(supabase
                .from("match_ai_coaching_cache")
                .upsert({
                  match_id: matchId,
                  platform: cachePlatform,
                  player_id: playerId,
                  coaching_style: coachingStyle,
                  prompt_version: cachePromptVersion,
                  ai_result: { text: aiResponseText },
                  updated_at: new Date().toISOString()
                }, { onConflict: "match_id,platform,player_id,coaching_style,prompt_version" })
                .abortSignal(routeSignal.signal), routeSignal.signal);
              if (saveErr) throw saveErr;
            } catch (saveErr: any) {
              if (isRouteAborted()) throw saveErr;
              console.warn("[AI-ANALYZE] Failed to write cache to DB:", saveErr.message || saveErr);
            }
          }

          if (isRouteAborted()) throw new DOMException("The operation was aborted.", "AbortError");
          controller.enqueue(encoder.encode(JSON.stringify({ type: "done" }) + "\n"));
        } catch (e) {
          if (isStreamCancelled() || request.signal.aborted) return;
          // 응답 도중 route 시간 제한에 걸린 경우도 실패로 남긴다.
          trackAiFailure(authenticatedUserId, "analyze", e, {
            errorCode: isRouteAborted() ? "PUBG_AI_ROUTE_TIMEOUT" : undefined,
            modelName: selectedModelName,
            durationMs: Date.now() - startedAt,
            requestId,
            platform: requestedPlatform,
          });
          if (isRouteAborted()) return;
          controller.error(e);
        } finally {
          cleanupRoute();
          if (!isStreamCancelled()) {
            try {
              controller.close();
            } catch {
              // The response may have been closed by the consumer.
            }
          }
        }
      }
    });

    routeCleanupOwnedByStream = true;
    return new Response(stream, { headers: { "Content-Type": "application/x-ndjson", "Cache-Control": "no-cache" } });
  } catch (error: any) {
    if (isRouteAborted()) {
      if (!request.signal.aborted && !isStreamCancelled()) {
        trackAiFailure(authenticatedUserId, "analyze", "AI analysis request timed out", {
          errorCode: "PUBG_AI_ROUTE_TIMEOUT",
          durationMs: Date.now() - startedAt,
          requestId,
          platform: requestedPlatform,
        });
      }
      return NextResponse.json({
        error: request.signal.aborted
          ? "canonical match analysis is not ready"
          : "AI analysis request timed out",
        errorCode: request.signal.aborted
          ? "PUBG_AI_CANONICAL_NOT_READY"
          : "PUBG_AI_ROUTE_TIMEOUT",
        retryable: true,
      }, { status: request.signal.aborted ? 409 : 504 });
    }
    trackAiFailure(authenticatedUserId, "analyze", error, {
      durationMs: Date.now() - startedAt,
      requestId,
      platform: requestedPlatform,
    });
    console.error("[AI-ANALYZE] request failed", error);
    return NextResponse.json({ error: "AI 분석을 완료하지 못했습니다. 잠시 후 다시 시도해 주세요." }, { status: 500 });
  } finally {
    if (!routeCleanupOwnedByStream) cleanupRoute();
  }
}
