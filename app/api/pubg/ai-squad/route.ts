import { NextResponse } from "next/server";
import { GoogleGenerativeAI, SchemaType, HarmCategory, HarmBlockThreshold } from "@google/generative-ai";
import { jsonrepair } from "jsonrepair";
import { withAuthGuard } from "@/utils/supabase/guard";
import { trackAiFailure, trackAiUsage } from "@/lib/pubg-analysis/aiUsageTracker";
import { AI_CACHE_VERSION, GEMINI_MODELS_TO_TRY } from "@/lib/pubg-analysis/constants";
import { normalizeName } from "@/lib/pubg-analysis/utils";
import { normalizePlatform } from "@/lib/pubg-analysis/cacheIdentity";
import crypto from "crypto";
import { getSquadAnalysisData } from "@/lib/pubg-analysis/squadAnalysis";
import { buildSquadAiCoachingPrompt } from "@/lib/pubg-analysis/squadAiCoachingPrompt";
import { sanitizeAiCoachingLanguage } from "@/lib/pubg-analysis/aiCoachingQuality";

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

const AI_SQUAD_TOTAL_TIMEOUT_MS = 22000;
const AI_SQUAD_MODEL_TIMEOUT_MS = 8000;

class SquadModelTimeoutError extends Error {
  constructor() {
    super("Squad Gemini model timed out");
    this.name = "SquadModelTimeoutError";
  }
}

class SquadRequestAbortedError extends Error {
  constructor() {
    super("Squad AI request was aborted");
    this.name = "SquadRequestAbortedError";
  }
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

function canonicalSquadIdentity(data: any): unknown {
  return {
    groupKey: data.groupKey,
    matchCount: data.matchCount,
    latestMatchCount: data.latestMatchCount,
    bestMatchCount: data.bestMatchCount,
    matchesSummary: Array.isArray(data.matchesSummary) ? data.matchesSummary : [],
    selectedMatchIds: Array.isArray(data.selectedMatchIds) ? data.selectedMatchIds : [],
    stats: data.stats,
    scores: data.scores,
    roleProfiles: data.roleProfiles,
    squadGrade: data.squadGrade,
    benchmarkStats: data.benchmarkStats,
  };
}

export async function POST(request: Request) {
  let body: any = {};
  const requestId = crypto.randomUUID();
  const startedAt = Date.now();
  let authenticatedUserId: string | undefined;
  let requestedPlatform = "steam";
  try {
    if (request.signal.aborted) throw new SquadRequestAbortedError();

    // 🔒 [Security] JWT Authentication Guard - Only logged-in users can call AI coaching
    const auth = await withAuthGuard();
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

    const apiKey = process.env.GOOGLE_GEMINI_API_KEY;
    if (!apiKey) {
      trackAiFailure(authenticatedUserId, "squad", "Missing Gemini API Key Configuration", { errorCode: "configuration", durationMs: Date.now() - startedAt, requestId, platform: requestedPlatform });
      return NextResponse.json({ error: "Missing Gemini API Key Configuration" }, { status: 500 });
    }

    if (typeof groupKey !== "string" || !groupKey.trim() || !nickname || !playerId) {
      trackAiFailure(authenticatedUserId, "squad", "Missing required squad parameters", { errorCode: "invalid_input", durationMs: Date.now() - startedAt, requestId, platform: requestedPlatform });
      return NextResponse.json({ error: "Missing required squad parameters" }, { status: 400 });
    }
    if (request.signal.aborted) throw new SquadRequestAbortedError();

    // All numeric evidence is recomputed server-side.  The request contributes
    // only identity/control fields; forged stats/scores/roles/benchmarks are
    // intentionally ignored rather than compared or merged.
    const squadData = await getSquadAnalysisData(nickname, cachePlatform, groupKey);
    if (request.signal.aborted) throw new SquadRequestAbortedError();
    if (!squadData || !("matchesSummary" in squadData) || !Array.isArray(squadData.matchesSummary)
      || !squadData.stats || !squadData.scores || !Array.isArray(squadData.roleProfiles)
      || !squadData.benchmarkStats || !squadData.matchCount
      || typeof squadData.squadGrade !== "string" || !squadData.squadGrade.trim()) {
      return NextResponse.json({
        error: "canonical squad analysis is not ready",
        errorCode: "PUBG_AI_SQUAD_CANONICAL_NOT_READY",
        retryable: true,
      }, { status: 409 });
    }
    const canonical = canonicalSquadIdentity(squadData);
    const matchIdsHash = hashParts(["canonical-squad", playerId, cachePlatform, canonical]);
    const canonicalStats = squadData.stats;
    const canonicalScores = squadData.scores;
    const canonicalRoleProfiles = squadData.roleProfiles;
    const canonicalGrade = squadData.squadGrade;
    const canonicalBenchmarkStats = squadData.benchmarkStats;
    const canonicalMatchCount = squadData.matchCount;

    // 2. Perform DB Cache Lookup
    if (request.signal.aborted) throw new SquadRequestAbortedError();
    try {
      const { data: cached, error: cacheErr } = await supabase
        .from("squad_ai_coaching_cache")
        .select("ai_result")
        .eq("player_id", playerId)
        .eq("platform", cachePlatform)
        .eq("group_key", groupKey)
        .eq("match_ids_hash", matchIdsHash)
        .eq("coaching_style", coachingStyle)
        .eq("prompt_version", AI_CACHE_VERSION)
        .abortSignal(request.signal)
        .maybeSingle();

      if (request.signal.aborted) throw new SquadRequestAbortedError();

      if (!cacheErr && cached && cached.ai_result) {
        trackAiUsage(authenticatedUserId, "gemini-cache", 0, 0, "squad", {
          durationMs: Date.now() - startedAt,
          requestId,
          platform: requestedPlatform,
        });
        return NextResponse.json(sanitizeAiCoachingLanguage(cached.ai_result));
      }
    } catch (dbErr) {
      if (request.signal.aborted) throw new SquadRequestAbortedError();
      console.warn("[AI-SQUAD] Cache lookup failed:", dbErr);
    }

    if (request.signal.aborted) throw new SquadRequestAbortedError();

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
    });

    // 3. Try multiple Gemini models sequentially
    if (request.signal.aborted) throw new SquadRequestAbortedError();
    const genAI = new GoogleGenerativeAI(apiKey);
    const modelsToTry = GEMINI_MODELS_TO_TRY;

    const safetySettings = [
      { category: HarmCategory.HARM_CATEGORY_HARASSMENT, threshold: HarmBlockThreshold.BLOCK_NONE },
      { category: HarmCategory.HARM_CATEGORY_HATE_SPEECH, threshold: HarmBlockThreshold.BLOCK_NONE },
      { category: HarmCategory.HARM_CATEGORY_SEXUALLY_EXPLICIT, threshold: HarmBlockThreshold.BLOCK_NONE },
      { category: HarmCategory.HARM_CATEGORY_DANGEROUS_CONTENT, threshold: HarmBlockThreshold.BLOCK_NONE }
    ];

    let responseText = "";
    let selectedModelName = "";
    let usageMetadata: any = null;

    const generationStartedAt = Date.now();
    const routeGenerationController = new AbortController();
    const routeGenerationTimer = setTimeout(() => routeGenerationController.abort(), AI_SQUAD_TOTAL_TIMEOUT_MS);
    const routeGenerationSignal = routeGenerationController.signal;
    let requestAborted = false;
    const onRequestAbort = () => {
      requestAborted = true;
      routeGenerationController.abort();
    };
    if (request.signal.aborted) {
      onRequestAbort();
    } else {
      request.signal.addEventListener("abort", onRequestAbort, { once: true });
      // Abort can race listener registration; re-check immediately so an
      // already-aborted request cannot enter model selection.
      if (request.signal.aborted) onRequestAbort();
    }
    let timedOut = false;
    let modelTimeoutObserved = false;
    const overallSignal = routeGenerationSignal;
    const timeoutTimers = new Set<ReturnType<typeof setTimeout>>();
    try {
      for (const modelName of modelsToTry) {
        if (requestAborted || overallSignal.aborted) break;
        const attemptController = new AbortController();
        let attemptTimedOut = false;
        try {
          const remainingMs = AI_SQUAD_TOTAL_TIMEOUT_MS - (Date.now() - generationStartedAt);
          if (remainingMs <= 0) break;

          if (requestAborted || overallSignal.aborted) break;
          const model = genAI.getGenerativeModel({
          model: modelName,
          systemInstruction: systemInstruction,
          generationConfig: {
            responseMimeType: "application/json",
            responseSchema: {
              type: SchemaType.OBJECT,
              properties: {
                squadGrade: { type: SchemaType.STRING, description: `Must be exactly "${canonicalGrade}" (GIVEN overall grade)` },
                summary: { type: SchemaType.STRING, description: "One-line tactical summary of this squad" },
                strength: { type: SchemaType.STRING, description: "Key strength of squad collaboration" },
                weakness: { type: SchemaType.STRING, description: "Major vulnerability/weakness of the squad" },
                coaching: { type: SchemaType.STRING, description: "Practical coaching advice to improve squad synergy" },
                memberFeedbacks: {
                  type: SchemaType.ARRAY,
                  description: "Individual tactical feedback for each and every squad member in roleProfiles",
                  items: {
                    type: SchemaType.OBJECT,
                    properties: {
                      name: { type: SchemaType.STRING, description: "Nickname of the squad member" },
                      praise: { type: SchemaType.STRING, description: "Detailed positive actions, strengths or what they did well (칭찬할 점)" },
                      fault: { type: SchemaType.STRING, description: "Detailed vulnerabilities, mistakes, or what they did poorly (못한 점)" },
                      advice: { type: SchemaType.STRING, description: "Detailed improvement points and tactical advice (피드백)" }
                    },
                    required: ["name", "praise", "fault", "advice"]
                  }
                },
                overallOpinion: { type: SchemaType.STRING, description: "Overall coaching review and warning/encouragement addressed to the entire team (팀원 모두에게 한마디씩 총평)" }
              },
              required: ["squadGrade", "summary", "strength", "weakness", "coaching", "memberFeedbacks", "overallOpinion"]
            }
          },
          safetySettings
        });

          const abortAttempt = () => attemptController.abort();
          routeGenerationSignal.addEventListener("abort", abortAttempt, { once: true });
          const attemptSignal = attemptController.signal;
          const timer = setTimeout(() => {
            attemptTimedOut = true;
            modelTimeoutObserved = true;
            attemptController.abort();
          }, Math.min(AI_SQUAD_MODEL_TIMEOUT_MS, remainingMs));
          timeoutTimers.add(timer);
          let response: any;
          try {
            response = await awaitWithSignal(model.generateContent({
              contents: [{ role: "user", parts: [{ text: prompt }] }]
            }, { signal: attemptSignal, timeout: Math.min(AI_SQUAD_MODEL_TIMEOUT_MS, remainingMs) }), attemptSignal);
            if (overallSignal.aborted || request.signal.aborted) break;
            if (attemptTimedOut) continue;
          } finally {
            clearTimeout(timer);
            timeoutTimers.delete(timer);
            routeGenerationSignal.removeEventListener("abort", abortAttempt);
          }

          if (response && response.response) {
            responseText = response.response.text();
            selectedModelName = modelName;
            usageMetadata = response.response.usageMetadata;
            break;
          }
        } catch (err: any) {
          if (requestAborted || overallSignal.aborted || request.signal.aborted) {
            if (!requestAborted && !request.signal.aborted) timedOut = true;
            break;
          }
          if (attemptTimedOut) {
            console.warn(`[AI-SQUAD] Model ${modelName} timed out; trying next...`);
            continue;
          }
          console.warn(`[AI-SQUAD] Model ${modelName} failed (${err.message || err}), trying next...`);
        }
      }
    } finally {
      clearTimeout(routeGenerationTimer);
      request.signal.removeEventListener("abort", onRequestAbort);
      timeoutTimers.forEach(clearTimeout);
    }

    if (requestAborted) throw new SquadRequestAbortedError();
    if (timedOut || (modelTimeoutObserved && !responseText)) throw new SquadModelTimeoutError();
    if (!responseText) {
      throw new Error("All Gemini models failed to respond or timed out.");
    }

    const validJsonString = extractValidJson(responseText);
    const resultJson = sanitizeAiCoachingLanguage(JSON.parse(validJsonString));

    // 3. Write to DB Cache
    if (request.signal.aborted) throw new SquadRequestAbortedError();
    try {
      const { error: saveErr } = await supabase
        .from("squad_ai_coaching_cache")
        .upsert({
          player_id: playerId,
          platform: cachePlatform,
          group_key: groupKey,
          match_ids_hash: matchIdsHash,
          coaching_style: coachingStyle,
          prompt_version: AI_CACHE_VERSION,
          ai_result: resultJson,
          updated_at: new Date().toISOString()
        }, { onConflict: "player_id,platform,group_key,match_ids_hash,coaching_style,prompt_version" });
      if (saveErr) throw saveErr;
    } catch (saveErr: any) {
      console.warn("[AI-SQUAD] Failed to write cache to DB:", saveErr.message || saveErr);
    }

    // Track usage stats
    if (selectedModelName && usageMetadata) {
      try {
        const promptTokens = usageMetadata.promptTokenCount || 0;
        const completionTokens = usageMetadata.candidatesTokenCount || 0;

        trackAiUsage(
          auth.user.id,
          selectedModelName,
          promptTokens,
          completionTokens,
          "squad",
          { durationMs: Date.now() - startedAt, requestId, platform: requestedPlatform },
        );
      } catch (e) {
        console.warn("AI Usage tracking failed:", e);
      }
    }

    return NextResponse.json(resultJson);

  } catch (error) {
    console.error("[AI-SQUAD-ERROR]", error);
    trackAiFailure(authenticatedUserId, "squad", error, {
      durationMs: Date.now() - startedAt,
      requestId,
      platform: requestedPlatform,
    });
    const requestAborted = request.signal.aborted || error instanceof SquadRequestAbortedError;
    const status = error instanceof SquadModelTimeoutError && !requestAborted ? 504 : 503;
    const errorCode = error instanceof SquadModelTimeoutError && !requestAborted
      ? "PUBG_AI_SQUAD_TIMEOUT"
      : requestAborted
        ? "PUBG_AI_SQUAD_ABORTED"
        : "PUBG_AI_SQUAD_PROVIDER_ERROR";
    return NextResponse.json(
      {
        error: "스쿼드 AI 분석을 완료하지 못했습니다. 잠시 후 다시 시도해 주세요.",
        errorCode,
        retryable: true,
      },
      { status },
    );
  }
}
