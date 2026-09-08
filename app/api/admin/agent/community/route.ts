import { NextResponse } from "next/server";
import {
  createCommunityStore,
  prepareCommunityBot,
  resolveCommunityActor,
} from "@/lib/community-agent/auth";
import type { CommunityAgentStatus, Policy } from "@/lib/community-agent/types";

export const maxDuration = 60;

const MAX_BODY_BYTES = 16 * 1024;
const CATEGORIES = new Set(["배그 소식", "자유"]);
const SOURCES = ["dc", "naver", "youtube"] as const;
const STATUS_ENV = [
  "NEXT_PUBLIC_SUPABASE_URL",
  "SUPABASE_SERVICE_ROLE_KEY",
  "COMMUNITY_AGENT_WORKER_SECRET",
  "GOOGLE_GEMINI_API_KEY",
  "NAVER_SEARCH_CLIENT_ID",
  "NAVER_SEARCH_CLIENT_SECRET",
  "YOUTUBE_DATA_API_KEY",
] as const;

function exactKeys(value: Record<string, unknown>, allowed: readonly string[]): boolean {
  const keys = Object.keys(value);
  return keys.length === allowed.length && keys.every((key) => allowed.includes(key));
}

async function readBody(request: Request): Promise<unknown> {
  if (request.headers.get("content-type")?.split(";", 1)[0].trim().toLowerCase() !== "application/json" || !request.body) {
    throw new Error("invalid_body");
  }
  const reader = request.body.getReader();
  const decoder = new TextDecoder();
  let size = 0;
  let text = "";
  try {
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) break;
      size += chunk.value.byteLength;
      if (size > MAX_BODY_BYTES) {
        await reader.cancel();
        throw new Error("body_too_large");
      }
      text += decoder.decode(chunk.value, { stream: true });
    }
    return JSON.parse(text + decoder.decode()) as unknown;
  } finally {
    reader.releaseLock();
  }
}

function parsePolicyPatch(value: unknown): Partial<Policy> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const patch = value as Record<string, unknown>;
  const allowed = ["enabled", "publishingEnabled", "categories", "dailyPostLimit", "sourceEnabled"];
  if (Object.keys(patch).length === 0 || Object.keys(patch).some((key) => !allowed.includes(key))) return null;
  const result: Partial<Policy> = {};
  if ("enabled" in patch) {
    if (typeof patch.enabled !== "boolean") return null;
    result.enabled = patch.enabled;
  }
  if ("publishingEnabled" in patch) {
    if (typeof patch.publishingEnabled !== "boolean") return null;
    result.publishingEnabled = patch.publishingEnabled;
  }
  if ("dailyPostLimit" in patch) {
    if (patch.dailyPostLimit !== 0 && patch.dailyPostLimit !== 1) return null;
    result.dailyPostLimit = patch.dailyPostLimit;
  }
  if ("categories" in patch) {
    if (!Array.isArray(patch.categories) || patch.categories.length < 1 || patch.categories.length > 2
      || patch.categories.some((category) => typeof category !== "string" || !CATEGORIES.has(category))
      || new Set(patch.categories).size !== patch.categories.length) return null;
    result.categories = patch.categories as Policy["categories"];
  }
  if ("sourceEnabled" in patch) {
    if (!patch.sourceEnabled || typeof patch.sourceEnabled !== "object" || Array.isArray(patch.sourceEnabled)) return null;
    const sources = patch.sourceEnabled as Record<string, unknown>;
    if (!exactKeys(sources, SOURCES) || SOURCES.some((source) => typeof sources[source] !== "boolean")) return null;
    result.sourceEnabled = sources as Policy["sourceEnabled"];
  }
  return result;
}

function usageFromRuns(runs: CommunityAgentStatus["runs"]): CommunityAgentStatus["usage"] {
  let promptTokens = 0;
  let completionTokens = 0;
  for (const run of runs) {
    for (const stage of Object.values(run.stages)) {
      const usage = stage?.result?.usage;
      if (!usage || typeof usage !== "object" || Array.isArray(usage)) continue;
      const row = usage as Record<string, unknown>;
      if (typeof row.promptTokens === "number" && Number.isSafeInteger(row.promptTokens) && row.promptTokens >= 0) promptTokens += row.promptTokens;
      if (typeof row.completionTokens === "number" && Number.isSafeInteger(row.completionTokens) && row.completionTokens >= 0) completionTokens += row.completionTokens;
    }
  }
  return { promptTokens, completionTokens, totalTokens: promptTokens + completionTokens };
}

function failure() {
  return NextResponse.json({ code: "storage_unavailable" }, { status: 503 });
}

export async function GET(request: Request) {
  const actor = await resolveCommunityActor(request);
  if (actor instanceof Response) return actor;
  if (actor.kind !== "admin") return NextResponse.json({ code: "worker_scope_forbidden" }, { status: 403 });
  try {
    const { store } = createCommunityStore();
    const [policy, sources, runs] = await Promise.all([store.getPolicy(), store.getSources(), store.recentRuns(7)]);
    const status: CommunityAgentStatus = {
      generatedAt: new Date().toISOString(),
      policy,
      sources,
      runs,
      usage: usageFromRuns(runs),
      missingEnv: STATUS_ENV.filter((name) => !process.env[name]?.trim()),
    };
    return NextResponse.json({ status });
  } catch {
    return failure();
  }
}

export async function POST(request: Request) {
  let body: unknown;
  try { body = await readBody(request); } catch { return NextResponse.json({ code: "invalid_request" }, { status: 400 }); }
  if (!body || typeof body !== "object" || Array.isArray(body)) return NextResponse.json({ code: "invalid_request" }, { status: 400 });
  const value = body as Record<string, unknown>;
  const configure = value.action === "configure" && exactKeys(value, ["action", "patch"])
    ? parsePolicyPatch(value.patch) : null;
  const prepare = value.action === "prepare_bot" && exactKeys(value, ["action"]);
  if (!configure && !prepare) return NextResponse.json({ code: "invalid_request" }, { status: 400 });

  const actor = await resolveCommunityActor(request);
  if (actor instanceof Response) return actor;
  if (actor.kind !== "admin") return NextResponse.json({ code: "worker_scope_forbidden" }, { status: 403 });
  try {
    const { client, store } = createCommunityStore();
    if (configure) return NextResponse.json({ policy: await store.updatePolicy(configure) });
    const result = await prepareCommunityBot(client, store);
    return NextResponse.json({ result }, { status: result.code === "conflict" ? 409 : 200 });
  } catch {
    return failure();
  }
}
