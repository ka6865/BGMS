import { NextResponse } from "next/server";
import { GoogleGenerativeAI, HarmCategory, HarmBlockThreshold } from "@google/generative-ai";
import { withAuthGuard } from "@/utils/supabase/guard";
import { trackAiFailure, trackAiUsage } from "@/lib/pubg-analysis/aiUsageTracker";
import { AI_CACHE_VERSION, GEMINI_MODELS_TO_TRY } from "@/lib/pubg-analysis/constants";
import { normalizeName } from "@/lib/pubg-analysis/utils";
import { normalizePlatform } from "@/lib/pubg-analysis/cacheIdentity";
import { sanitizeBackupCoachingText } from "@/lib/pubg-analysis/backupCoaching";
import { buildMatchAiCoachingPrompt } from "@/lib/pubg-analysis/matchAiCoachingPrompt";
import { sanitizeAiCoachingLanguageText } from "@/lib/pubg-analysis/aiCoachingQuality";
import crypto from "crypto";

export async function POST(request: Request) {
  const requestId = crypto.randomUUID();
  const startedAt = Date.now();
  let authenticatedUserId: string | undefined;
  let requestedPlatform = "steam";
  try {
    // 🔒 [보안] JWT 인증 가드 — 로그인된 사용자만 AI 분석 실행 허용 (Gemini API 비용 방어)
    const auth = await withAuthGuard();
    if (auth.error) return auth.error;
    const { supabaseAdmin: supabase } = auth;
    authenticatedUserId = auth.user?.id;

    const body = await request.json();
    const { matchData, nickname, platform = "steam", coachingStyle = "spicy" } = body;
    requestedPlatform = String(platform || "steam");

    const apiKey = process.env.GOOGLE_GEMINI_API_KEY;
    if (!apiKey) {
      trackAiFailure(authenticatedUserId, "analyze", "No API Key", { errorCode: "configuration", durationMs: Date.now() - startedAt, requestId, platform: requestedPlatform });
      return NextResponse.json({ error: "No API Key" }, { status: 500 });
    }
    if (!matchData || !nickname) {
      trackAiFailure(authenticatedUserId, "analyze", "Missing data", { errorCode: "invalid_input", durationMs: Date.now() - startedAt, requestId, platform: requestedPlatform });
      return NextResponse.json({ error: "Missing data" }, { status: 400 });
    }

    const matchId = matchData.matchId || matchData.match_id || matchData.id;
    if (!matchId) {
      trackAiFailure(authenticatedUserId, "analyze", "Missing matchId", { errorCode: "invalid_input", durationMs: Date.now() - startedAt, requestId, platform: requestedPlatform });
      return NextResponse.json({ error: "Missing matchId" }, { status: 400 });
    }
    const playerId = normalizeName(nickname);
    const cachePlatform = normalizePlatform(platform);

    // 1. DB Cache Lookup
    try {
      const { data: cached, error: cacheErr } = await supabase
        .from("match_ai_coaching_cache")
        .select("ai_result")
        .eq("match_id", matchId)
        .eq("platform", cachePlatform)
        .eq("player_id", playerId)
        .eq("coaching_style", coachingStyle)
        .eq("prompt_version", AI_CACHE_VERSION)
        .maybeSingle();

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
      console.warn("[AI-ANALYZE] Cache lookup failed:", dbErr);
    }

    const { fullPrompt, backupContext } = buildMatchAiCoachingPrompt({ matchData, coachingStyle });

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

    for (const modelName of modelsToTry) {
      try {
        const model = genAI.getGenerativeModel({ model: modelName, safetySettings });
        try {
          streamResult = await model.generateContentStream(fullPrompt);
          if (streamResult) {
            selectedModelName = modelName;
            break;
          }
        } catch (streamErr: any) {
          console.error(`[AI-ANALYZE] Stream failed for ${modelName}, trying non-stream fallback:`, streamErr.message || streamErr);
          nonStreamRes = await model.generateContent(fullPrompt);
          fallbackText = nonStreamRes.response.text();
          if (fallbackText) {
            selectedModelName = modelName;
            break;
          }
        }
      } catch (err: any) { 
        console.error(`[AI-ANALYZE] Model ${modelName} initialization failed:`, err.message || err);
        continue; 
      }
    }

    if (!streamResult && !fallbackText) throw new Error("모든 AI 모델이 응답에 실패했습니다.");

    const encoder = new TextEncoder();
    const stream = new ReadableStream({
      async start(controller) {
        try {
          let aiResponseText = "";
          if (streamResult) {
            for await (const chunk of streamResult.stream) {
              if (request.signal.aborted) {
                break;
              }
              const chunkText = chunk.text();
              aiResponseText += chunkText;
            }
            const sanitizedText = sanitizeAiCoachingLanguageText(sanitizeBackupCoachingText(aiResponseText, backupContext));
            aiResponseText = sanitizedText;
            controller.enqueue(encoder.encode(JSON.stringify({ type: "chunk", data: sanitizedText }) + "\n"));

            // 비동기로 사용량 메타데이터 획득 후 로깅
            streamResult.response.then((res: any) => {
              if (res.usageMetadata) {
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
              const { error: saveErr } = await supabase
                .from("match_ai_coaching_cache")
                .upsert({
                  match_id: matchId,
                  platform: cachePlatform,
                  player_id: playerId,
                  coaching_style: coachingStyle,
                  prompt_version: AI_CACHE_VERSION,
                  ai_result: { text: aiResponseText },
                  updated_at: new Date().toISOString()
                }, { onConflict: "match_id,platform,player_id,coaching_style,prompt_version" });
              if (saveErr) throw saveErr;
            } catch (saveErr: any) {
              console.warn("[AI-ANALYZE] Failed to write cache to DB:", saveErr.message || saveErr);
            }
          }

          controller.enqueue(encoder.encode(JSON.stringify({ type: "done" }) + "\n"));
        } catch (e) {
          trackAiFailure(authenticatedUserId, "analyze", e, {
            durationMs: Date.now() - startedAt,
            requestId,
            platform: requestedPlatform,
          });
          controller.error(e);
        } finally { controller.close(); }
      }
    });

    return new Response(stream, { headers: { "Content-Type": "application/x-ndjson", "Cache-Control": "no-cache" } });
  } catch (error: any) {
    trackAiFailure(authenticatedUserId, "analyze", error, {
      durationMs: Date.now() - startedAt,
      requestId,
      platform: requestedPlatform,
    });
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}
