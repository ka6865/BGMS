import { NextResponse } from "next/server";
import { GoogleGenerativeAI, HarmCategory, HarmBlockThreshold } from "@google/generative-ai";
import { withAuthGuard } from "@/utils/supabase/guard";
import { trackAiFailure, trackAiUsage } from "@/lib/pubg-analysis/aiUsageTracker";
import { AI_CACHE_VERSION, GEMINI_MODELS_TO_TRY, RESULT_VERSION } from "@/lib/pubg-analysis/constants";
import { normalizeName } from "@/lib/pubg-analysis/utils";
import { getValidFullResultForMatch, normalizePlatform } from "@/lib/pubg-analysis/cacheIdentity";
import { normalizeMatchId } from "@/lib/pubg-analysis/recentMatchSelection";
import { sanitizeBackupCoachingText } from "@/lib/pubg-analysis/backupCoaching";
import { buildMatchAiCoachingPrompt } from "@/lib/pubg-analysis/matchAiCoachingPrompt";
import { sanitizeAiCoachingLanguageText } from "@/lib/pubg-analysis/aiCoachingQuality";
import crypto from "crypto";

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

    const apiKey = process.env.GOOGLE_GEMINI_API_KEY;
    if (!apiKey) {
      trackAiFailure(authenticatedUserId, "analyze", "No API Key", { errorCode: "configuration", durationMs: Date.now() - startedAt, requestId, platform: requestedPlatform });
      return NextResponse.json({ error: "No API Key" }, { status: 500 });
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

    const canonicalFullResult = getValidFullResultForMatch(canonicalRow, {
      matchId,
      playerId,
      platform: cachePlatform,
      minResultVersion: RESULT_VERSION,
      requirePopulationEvidence: true,
      requireExactResultVersion: true,
    });
    if (!canonicalFullResult) {
      return NextResponse.json({
        error: "canonical match analysis is not ready",
        errorCode: "PUBG_AI_CANONICAL_NOT_READY",
        retryable: true,
      }, { status: 409 });
    }

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
        .eq("prompt_version", AI_CACHE_VERSION)
        .abortSignal(routeSignal.signal)
        .maybeSingle(), routeSignal.signal);

      if (!cacheErr && cached && cached.ai_result) {
        trackAiUsage(authenticatedUserId, "gemini-cache", 0, 0, "analyze", {
          durationMs: Date.now() - startedAt,
          requestId,
          platform: requestedPlatform,
        });
        const cachedData = cached.ai_result as any;
        const cachedText = sanitizeAiCoachingLanguageText(String(cachedData.text || ""));
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
    let modelTimedOut = false;

    for (const modelName of modelsToTry) {
      if (isRouteAborted()) break;
      const modelTimeoutController = new AbortController();
      let modelAttemptTimedOut = false;
      const modelTimeoutTimer = setTimeout(
        () => {
          modelAttemptTimedOut = true;
          modelTimedOut = true;
          modelTimeoutController.abort();
        },
        AI_ANALYZE_MODEL_TIMEOUT_MS,
      );
      const modelSignal = composeAbortSignals([routeSignal.signal, modelTimeoutController.signal]);
      let preserveModelSignal = false;
      try {
        const model = genAI.getGenerativeModel({ model: modelName, safetySettings });
        try {
          streamResult = await awaitWithAbort(model.generateContentStream(fullPrompt, {
            signal: modelSignal.signal,
            timeout: AI_ANALYZE_MODEL_TIMEOUT_MS,
          }), modelSignal.signal);
          if (streamResult) {
            selectedModelName = modelName;
            preserveModelSignal = true;
            selectedModelSignalCleanup = modelSignal.cleanup;
            break;
          }
        } catch (streamErr: any) {
          if (modelAttemptTimedOut || modelSignal.signal.aborted || isRouteAborted()) break;
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
        if (modelAttemptTimedOut || modelSignal.signal.aborted || isRouteAborted()) break;
        console.error(`[AI-ANALYZE] Model ${modelName} initialization failed:`, err.message || err);
        continue; 
      } finally {
        clearTimeout(modelTimeoutTimer);
        if (!preserveModelSignal) modelSignal.cleanup();
      }
    }

    if (modelTimedOut && !request.signal.aborted) {
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
            const sanitizedText = sanitizeAiCoachingLanguageText(sanitizeBackupCoachingText(aiResponseText, backupContext));
            aiResponseText = sanitizedText;
            controller.enqueue(encoder.encode(JSON.stringify({ type: "chunk", data: sanitizedText }) + "\n"));

            // 비동기로 사용량 메타데이터 획득 후 로깅
            streamResult.response.then((res: any) => {
              if (res.usageMetadata && !isRouteAborted()) {
                trackAiUsage(
                  auth.user?.id,
                  selectedModelName,
                  res.usageMetadata.promptTokenCount,
                  res.usageMetadata.candidatesTokenCount,
                  "analyze",
                  { durationMs: Date.now() - startedAt, requestId, platform: requestedPlatform },
                );
              }
            }).catch((err: any) => console.error("[AI-ANALYZE] Usage fetch error:", err));

          } else if (fallbackText) { 
            aiResponseText = sanitizeAiCoachingLanguageText(sanitizeBackupCoachingText(fallbackText, backupContext));
            controller.enqueue(encoder.encode(JSON.stringify({ type: "chunk", data: aiResponseText }) + "\n"));
            
            if (nonStreamRes?.response?.usageMetadata) {
              trackAiUsage(
                auth.user?.id,
                selectedModelName,
                nonStreamRes.response.usageMetadata.promptTokenCount,
                nonStreamRes.response.usageMetadata.candidatesTokenCount,
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
                  prompt_version: AI_CACHE_VERSION,
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
          if (isStreamCancelled() || isRouteAborted()) return;
          trackAiFailure(authenticatedUserId, "analyze", e, {
            durationMs: Date.now() - startedAt,
            requestId,
            platform: requestedPlatform,
          });
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
    return NextResponse.json({ error: error.message }, { status: 500 });
  } finally {
    if (!routeCleanupOwnedByStream) cleanupRoute();
  }
}
