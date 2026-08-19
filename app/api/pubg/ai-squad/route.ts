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

export async function POST(request: Request) {
  let body: any = {};
  const requestId = crypto.randomUUID();
  const startedAt = Date.now();
  let authenticatedUserId: string | undefined;
  let requestedPlatform = "steam";
  try {
    // 🔒 [Security] JWT Authentication Guard - Only logged-in users can call AI coaching
    const auth = await withAuthGuard();
    if (auth.error) return auth.error;
    const { supabaseAdmin: supabase } = auth;
    authenticatedUserId = auth.user?.id;

    body = await request.json();
    const { groupKey, stats, scores, roleProfiles, nickname, platform = "steam", coachingStyle = "spicy", squadGrade = "B", benchmarkStats } = body;
    requestedPlatform = String(platform || "steam");
    const playerId = normalizeName(nickname);
    const cachePlatform = normalizePlatform(platform);

    const apiKey = process.env.GOOGLE_GEMINI_API_KEY;
    if (!apiKey) {
      trackAiFailure(authenticatedUserId, "squad", "Missing Gemini API Key Configuration", { errorCode: "configuration", durationMs: Date.now() - startedAt, requestId, platform: requestedPlatform });
      return NextResponse.json({ error: "Missing Gemini API Key Configuration" }, { status: 500 });
    }

    if (!groupKey || !stats || !scores || !Array.isArray(roleProfiles) || !nickname) {
      trackAiFailure(authenticatedUserId, "squad", "Missing required squad parameters", { errorCode: "invalid_input", durationMs: Date.now() - startedAt, requestId, platform: requestedPlatform });
      return NextResponse.json({ error: "Missing required squad parameters" }, { status: 400 });
    }

    // 1. Calculate matchIdsHash based on the current squad matches in DB
    const requestMatchIds = Array.isArray(body.matchIds) ? body.matchIds.filter(Boolean) : [];
    const roleProfileNames = Array.isArray(roleProfiles)
      ? roleProfiles.map((p: any) => p?.name).filter(Boolean).sort()
      : [];
    let matchIdsHash = requestMatchIds.length > 0
      ? hashParts(["matches", requestMatchIds.map(String).sort()])
      : hashParts(["body", playerId, cachePlatform, groupKey, body.matchCount || 1, stats, scores, roleProfileNames]);
    try {
      const squadData = await getSquadAnalysisData(nickname, cachePlatform, groupKey);
      if (squadData && "matchesSummary" in squadData && Array.isArray(squadData.matchesSummary)) {
        const matchIds = squadData.matchesSummary.map((m: any) => m.matchId || m.match_id).filter(Boolean);
        if (matchIds.length > 0) {
          matchIdsHash = hashParts(["matches", matchIds.map(String).sort()]);
        }
      }
    } catch (hashErr) {
      console.warn("[AI-SQUAD] Failed to compute DB matchIdsHash, using request hash:", hashErr);
    }

    // 2. Perform DB Cache Lookup
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
        .maybeSingle();

      if (!cacheErr && cached && cached.ai_result) {
        trackAiUsage(authenticatedUserId, "gemini-cache", 0, 0, "squad", {
          durationMs: Date.now() - startedAt,
          requestId,
          platform: requestedPlatform,
        });
        return NextResponse.json(sanitizeAiCoachingLanguage(cached.ai_result));
      }
    } catch (dbErr) {
      console.warn("[AI-SQUAD] Cache lookup failed:", dbErr);
    }

    const { prompt, systemInstruction } = buildSquadAiCoachingPrompt({
      groupKey,
      stats,
      scores,
      roleProfiles,
      nickname,
      coachingStyle,
      squadGrade,
      benchmarkStats,
      matchCount: body.matchCount || 1,
    });

    // 3. Try multiple Gemini models sequentially
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
    for (const modelName of modelsToTry) {
      try {
        const remainingMs = AI_SQUAD_TOTAL_TIMEOUT_MS - (Date.now() - generationStartedAt);
        if (remainingMs <= 0) break;

        const model = genAI.getGenerativeModel({
          model: modelName,
          systemInstruction: systemInstruction,
          generationConfig: {
            responseMimeType: "application/json",
            responseSchema: {
              type: SchemaType.OBJECT,
              properties: {
                squadGrade: { type: SchemaType.STRING, description: `Must be exactly "${squadGrade}" (GIVEN overall grade)` },
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

        const timeoutPromise = new Promise((_, reject) =>
          setTimeout(() => reject(new Error("Timeout")), Math.min(AI_SQUAD_MODEL_TIMEOUT_MS, remainingMs))
        );

        const response = await Promise.race([
          model.generateContent({
            contents: [{ role: "user", parts: [{ text: prompt }] }]
          }),
          timeoutPromise
        ]) as any;

        if (response && response.response) {
          responseText = response.response.text();
          selectedModelName = modelName;
          usageMetadata = response.response.usageMetadata;
          break;
        }
      } catch (err: any) {
        console.warn(`[AI-SQUAD] Model ${modelName} failed (${err.message || err}), trying next...`);
      }
    }

    if (!responseText) {
      throw new Error("All Gemini models failed to respond or timed out.");
    }

    const validJsonString = extractValidJson(responseText);
    const resultJson = sanitizeAiCoachingLanguage(JSON.parse(validJsonString));

    // 3. Write to DB Cache
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
    return NextResponse.json(
      { error: "스쿼드 AI 분석을 완료하지 못했습니다. 잠시 후 다시 시도해 주세요." },
      { status: 503 },
    );
  }
}
