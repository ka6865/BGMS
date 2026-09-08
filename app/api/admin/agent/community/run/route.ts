import { NextResponse } from "next/server";
import { createCommunityStore, resolveCommunityActor } from "@/lib/community-agent/auth";
import { executeAction, type RunAction } from "@/lib/community-agent/service";
import type { Stage } from "@/lib/community-agent/types";

export const maxDuration = 60;

const MAX_BODY_BYTES = 16 * 1024;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const STAGES = new Set<Stage>(["dc", "naver", "youtube", "select", "draft", "verify"]);

function badRequest(code = "invalid_request") {
  return NextResponse.json({ code }, { status: 400 });
}

function exactKeys(value: Record<string, unknown>, keys: string[]): boolean {
  const actual = Object.keys(value).sort();
  return actual.length === keys.length && actual.every((key, index) => key === [...keys].sort()[index]);
}

async function readBody(request: Request): Promise<unknown> {
  if (request.headers.get("content-type")?.split(";", 1)[0].trim().toLowerCase() !== "application/json") {
    throw new Error("invalid_content_type");
  }
  if (!request.body) throw new Error("invalid_body");
  const reader = request.body.getReader();
  const decoder = new TextDecoder();
  let size = 0;
  let body = "";
  try {
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) break;
      size += chunk.value.byteLength;
      if (size > MAX_BODY_BYTES) {
        await reader.cancel();
        throw new Error("body_too_large");
      }
      body += decoder.decode(chunk.value, { stream: true });
    }
    return JSON.parse(body + decoder.decode()) as unknown;
  } finally {
    reader.releaseLock();
  }
}

function parseAction(value: unknown): RunAction | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const body = value as Record<string, unknown>;
  if (body.action === "start" && exactKeys(body, ["action", "dryRun"]) && typeof body.dryRun === "boolean") {
    return { action: "start", dryRun: body.dryRun };
  }
  if (body.action === "step" && exactKeys(body, ["action", "runId", "stage"])
    && typeof body.runId === "string" && UUID.test(body.runId)
    && typeof body.stage === "string" && STAGES.has(body.stage as Stage)) {
    return { action: "step", runId: body.runId, stage: body.stage as Stage };
  }
  if (body.action === "publish" && exactKeys(body, ["action", "runId"])
    && typeof body.runId === "string" && UUID.test(body.runId)) {
    return { action: "publish", runId: body.runId };
  }
  return null;
}

function failure(error: unknown): NextResponse {
  const message = error instanceof Error ? error.message : "";
  if (/community_(?:agent_disabled|agent_dry_run_requires_publish_paused|stage_lease_mismatch|worker_dry_run_forbidden)/.test(message)) {
    return NextResponse.json({ code: "execution_conflict" }, { status: 409 });
  }
  return NextResponse.json({ code: "storage_unavailable" }, { status: 503 });
}

export async function GET(request: Request) {
  const url = new URL(request.url);
  const entries = [...url.searchParams.entries()];
  if (entries.length !== 1 || entries[0][0] !== "runId" || !UUID.test(entries[0][1])) return badRequest();
  const actor = await resolveCommunityActor(request);
  if (actor instanceof Response) return actor;
  try {
    const { store } = createCommunityStore();
    return NextResponse.json({ run: await store.getRun(entries[0][1]) });
  } catch (error) {
    return failure(error);
  }
}

export async function POST(request: Request) {
  let action: RunAction | null;
  try {
    action = parseAction(await readBody(request));
  } catch {
    return badRequest();
  }
  if (!action) return badRequest();

  const actor = await resolveCommunityActor(request);
  if (actor instanceof Response) return actor;
  if (actor.kind === "worker" && action.action === "start" && action.dryRun) {
    return NextResponse.json({ code: "worker_scope_forbidden" }, { status: 403 });
  }
  try {
    const { store } = createCommunityStore();
    return NextResponse.json({ result: await executeAction(action, actor, store) });
  } catch (error) {
    return failure(error);
  }
}
