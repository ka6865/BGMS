import { NextResponse } from "next/server";
import { GoogleGenerativeAI, HarmBlockThreshold, HarmCategory } from "@google/generative-ai";
import { buildAdminAgentContextPack } from "@/lib/admin-agent/context-pack";
import { adminAgentFunctionDeclarations, adminAgentTools } from "@/lib/admin-agent/tools";
import {
  completeAgentRun,
  completeAgentStep,
  createAgentRun,
  createAgentStep,
  verifyAdminRole
} from "@/lib/admin-agent/logging";
import { withAuthGuard } from "@/utils/supabase/guard";
import { GEMINI_MODELS_TO_TRY } from "@/lib/pubg-analysis/constants";

const modelsToTry = GEMINI_MODELS_TO_TRY;
const AI_RESPONSE_TIMEOUT_MS = 40_000;

const defaultAgentInstruction = [
  "You are BGMS Admin Operations Agent for a PUBG map and stats service.",
  "Always answer the admin in Korean unless the admin explicitly asks for another language.",
  "Translate raw operational status words before showing them to the admin: critical=위험, warn=주의, ok=정상, pass=통과, fail=실패, blocked=차단, pending=대기, env=환경변수, cron jobs=예약 작업, readiness=준비 상태, rollout=배포 전 점검.",
  "Do not expose raw JSON-style labels as the main explanation. If an identifier such as ADMIN_AGENT_CRON_SECRET is important, show the identifier but explain its meaning in plain Korean.",
  "Prefer operational diagnosis first: cite observed DB/tool facts, summarize likely causes, and propose safe actions.",
  "Read-only tools may run immediately.",
  "Dangerous actions such as post publishing, cache deletion, user changes, or bulk mutations must only create approval requests.",
  "Use saved operational memories when the user asks about recurring incidents, prior fixes, or internal operating policy.",
  "When the user asks how useful the agent has been, what value it created, or what to do next for leverage, use the operator value scorecard.",
  "When you find a repeatable incident resolution or policy worth preserving, request a memory approval instead of writing it directly.",
  "For daily briefings, generate an operations briefing first. Saving a report must go through approval.",
  "When the user asks for a short owner/operator brief, use the owner brief tool and compress the answer into do-now, delegate-to-agent, and owner-review items.",
  "When the user asks whether operations are improving, stable, or worsening, use the monitor trend tool before answering.",
  "When the user asks what is automated, what requires approval, or what stays in GitHub Actions, use the automation contract tool before answering.",
  "When the user asks how many users, members, signed-in users, guests, active users, or which users were active, use the user metrics tool before answering. Explain the difference between Supabase Auth users, profiles, and analytics sessions.",
  "When the user asks which pages or features visitors used, use the user activity summary tool before answering.",
  "When the user asks what the agent can currently do, what is missing, or what capability is weak, use the capability matrix tool before answering.",
  "When the user asks for the next upgrade roadmap, agent growth plan, or what to improve next, use the growth roadmap tool before answering.",
  "When the user asks what to do today, what to handle first, or how to close out the day, use the today action board tool before answering.",
  "When the user asks whether the day can be closed, what risks remain, or tomorrow focus, use the daily checkout tool before answering.",
  "When the user asks for an operating SOP, step-by-step runbook, or what exact procedure to follow now, use the operating SOP tool before answering.",
  "When the user asks what might break next, what risks are likely, or how to prevent the next incident, use the risk radar tool before answering.",
  "When the user asks why the agent made a recommendation, what evidence supports a decision, or what is uncertain, use the decision trace tool before answering.",
  "When the user asks whether the agent is safe, whether a risky approval can be trusted, or whether guardrails are intact, use the safety audit tool before answering.",
  "When the user asks which approvals to approve, reject, or defer, use the approval advisor tool before answering.",
  "When the user asks what exact sequence to run now, asks for Mission Control, or asks to organize the next commands, use the mission control tool before answering.",
  "When the user asks what they personally need to review, what can be delegated, or asks for Owner Inbox, use the owner inbox tool before answering.",
  "When the user asks whether recent actions worked, whether the loop is closed, or what follow-up remains, use the outcome review tool before answering.",
  "When the user asks what to ask next, how to use the agent better, or asks for coaching, use the operator coach tool before answering.",
  "When the user asks how to start using the agent, asks for a launch checklist, daily routine, onboarding, or practical usage guide, use the launch kit tool before answering.",
  "When the user asks whether the agent is final-version ready, whether the upgrade goal is complete, or what evidence and remaining work prove readiness, use the final readiness tool before answering.",
  "For content operations, generate drafts from live site data first. Publishing a post must always go through approval.",
  "When updating a board post via update_board_post, you MUST preserve all existing image tags (<img>) present in the original content. Do not drop or delete them from the new HTML content unless you are explicitly asked to remove the images. Removing them will cause the system to clean up and delete the image files from storage upon approval.",
  "When an approval is created, clearly explain what is pending and why an admin must approve it."
].join("\n");

function enqueue(controller: ReadableStreamDefaultController, encoder: TextEncoder, payload: Record<string, unknown>) {
  controller.enqueue(encoder.encode(JSON.stringify(payload) + "\n"));
}

export async function POST(request: Request) {
  try {
    const auth = await withAuthGuard();
    if (auth.error) return auth.error;
    const { supabaseAdmin: supabase, user } = auth;
    if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

    const adminError = await verifyAdminRole(supabase, user.id);
    if (adminError) return adminError;

    const body = await request.json();
    const { message, systemPrompt = "", history = [] } = body;

    const apiKey = process.env.GOOGLE_GEMINI_API_KEY;
    if (!apiKey) return NextResponse.json({ error: "No API Key" }, { status: 500 });

    const runId = await createAgentRun(supabase, {
      userId: user.id,
      message,
      systemPrompt
    });
    const contextPack = await buildAdminAgentContextPack(supabase);

    const encoder = new TextEncoder();
    const stream = new ReadableStream({
      async start(controller) {
        let finalSummary = "";
        let streamErrored = false;
        try {
          const genAI = new GoogleGenerativeAI(apiKey);
          let chat: any = null;
          let result: any = null;

          for (const modelName of modelsToTry) {
            try {
              const model = genAI.getGenerativeModel({
                model: modelName,
                safetySettings: [
                  { category: HarmCategory.HARM_CATEGORY_HARASSMENT, threshold: HarmBlockThreshold.BLOCK_NONE },
                  { category: HarmCategory.HARM_CATEGORY_HATE_SPEECH, threshold: HarmBlockThreshold.BLOCK_NONE }
                ]
              });

              const combinedInstruction = [defaultAgentInstruction, contextPack, systemPrompt].filter(Boolean).join("\n\n");
              chat = model.startChat({
                systemInstruction: { role: "system", parts: [{ text: combinedInstruction }] },
                history: history.map((item: any) => ({
                  role: item.role === "model" ? "model" : "user",
                  parts: [{ text: item.content }]
                })),
                tools: [{ functionDeclarations: adminAgentFunctionDeclarations }]
              });

              result = await withTimeout<any>(chat.sendMessage(message), AI_RESPONSE_TIMEOUT_MS, `${modelName} 응답 시간이 초과되었습니다.`);
              break;
            } catch (err: any) {
              console.warn(`[BOT-RUN] Model ${modelName} failed, trying fallback:`, err.message || err);
            }
          }

          if (!chat || !result) throw new Error("모든 AI 모델 연결에 실패했습니다.");

          let response = result.response;
          let functionCalls = response.functionCalls ? response.functionCalls() : undefined;

          while (functionCalls && functionCalls.length > 0) {
            const functionResponses = [];

            for (const call of functionCalls) {
              const tool = adminAgentTools[call.name];
              const args = (call.args || {}) as Record<string, unknown>;
              const safetyLevel = tool?.safetyLevel || "read";
              const stepId = await createAgentStep(supabase, {
                runId,
                toolName: call.name,
                safetyLevel,
                params: args
              });

              enqueue(controller, encoder, {
                type: "tool_start",
                toolName: call.name,
                safetyLevel,
                params: args
              });

              const toolResult = tool
                ? await tool.run(args, { supabase, userId: user.id, runId, stepId })
                : { status: "failed" as const, result: "존재하지 않는 도구입니다." };

              await completeAgentStep(supabase, stepId, {
                status: toolResult.status,
                result: toolResult.result,
                error: toolResult.status === "failed" ? toolResult.result : undefined
              });

              enqueue(controller, encoder, {
                type: "tool_end",
                toolName: call.name,
                safetyLevel,
                status: toolResult.status,
                result: toolResult.result,
                approvalId: toolResult.approvalId
              });

              if (toolResult.status === "approval_required") {
                enqueue(controller, encoder, {
                  type: "approval_required",
                  toolName: call.name,
                  safetyLevel,
                  approvalId: toolResult.approvalId,
                  result: toolResult.result
                });
              }

              functionResponses.push({
                functionResponse: { name: call.name, response: { result: toolResult.result } }
              });
            }

            const nextResult = await withTimeout<any>(chat.sendMessage(functionResponses), AI_RESPONSE_TIMEOUT_MS, "도구 결과 반영 응답 시간이 초과되었습니다.");
            response = nextResult.response;
            functionCalls = response.functionCalls ? response.functionCalls() : undefined;

            if (!functionCalls || functionCalls.length === 0) {
              const text = response.text();
              if (text) {
                finalSummary += text;
                enqueue(controller, encoder, { type: "chunk", data: text });
              }
            }
          }

          const text = response.text();
          const finalCalls = response.functionCalls ? response.functionCalls() : undefined;
          if (text && (!finalCalls || finalCalls.length === 0) && !finalSummary.includes(text)) {
            finalSummary += text;
            enqueue(controller, encoder, { type: "chunk", data: text });
          }

          await completeAgentRun(supabase, runId, { status: "completed", summary: finalSummary });
          enqueue(controller, encoder, { type: "run_summary", runId });
          enqueue(controller, encoder, { type: "done" });
        } catch (error: any) {
          await completeAgentRun(supabase, runId, { status: "failed", error: error.message || String(error) });
          streamErrored = true;
          controller.error(error);
        } finally {
          if (!streamErrored) controller.close();
        }
      }
    });

    return new Response(stream, {
      headers: {
        "Content-Type": "application/x-ndjson",
        "Cache-Control": "no-cache"
      }
    });
  } catch (error: any) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}

function withTimeout<T>(promise: Promise<T>, timeoutMs: number, message: string): Promise<T> {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error(message)), timeoutMs);
    promise
      .then((value) => {
        clearTimeout(timeout);
        resolve(value);
      })
      .catch((error) => {
        clearTimeout(timeout);
        reject(error);
      });
  });
}
