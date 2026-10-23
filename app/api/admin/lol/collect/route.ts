import { NextResponse } from "next/server";
import { requireLolDevAdmin } from "@/lib/lol/access.server";
import { isSameOriginLolRequest } from "@/lib/lol/http.server";
import { collectLolMatches, RiotSearchError } from "@/lib/lol/riotSearch.server";

export const dynamic = "force-dynamic";
export const maxDuration = 120;

function response(body: unknown, status = 200, retryAfter?: number) {
  return NextResponse.json(body, { status, headers: {
    "Cache-Control": "private, no-store", ...(retryAfter ? { "Retry-After": String(retryAfter) } : {}),
  } });
}

export async function POST(request: Request) {
  const access = await requireLolDevAdmin();
  if (!access.ok) return access.error;
  if (!isSameOriginLolRequest(request)) return response({ error: "요청 출처를 확인할 수 없습니다." }, 403);
  if (process.env.LOL_PERSISTENCE_ENABLED !== "true") return response({ error: "LoL 영속 저장이 비활성화되어 있습니다." }, 503);
  if (Number(request.headers.get("content-length")) > 2048) return response({ error: "요청이 너무 큽니다." }, 413);
  let body: { riotId?: unknown; count?: unknown; startOffset?: unknown; confirm?: unknown };
  try {
    const raw = await request.text();
    if (new TextEncoder().encode(raw).byteLength > 2048) return response({ error: "요청이 너무 큽니다." }, 413);
    body = JSON.parse(raw);
    if (!body || typeof body !== "object" || Array.isArray(body)) throw new Error("invalid body");
  } catch { return response({ error: "수집 요청을 확인해 주세요." }, 400); }
  const count = body.count ?? 20;
  const startOffset = body.startOffset ?? 0;
  if (body.confirm !== true || typeof body.riotId !== "string" || body.riotId.length > 81
    || /[\u0000-\u001f\u007f]/.test(body.riotId) || body.riotId.split("#").length !== 2
    || !body.riotId.split("#").every((part) => part.trim()) || body.riotId.split("#")[0].trim().length > 64
    || body.riotId.split("#")[1].trim().length > 16 || typeof count !== "number" || !Number.isInteger(count) || count < 1 || count > 100
    || typeof startOffset !== "number" || !Number.isSafeInteger(startOffset) || startOffset < 0) {
    return response({ error: "Riot ID, 목표 경기 수(1~100), 시작 위치와 수집 확인을 점검해 주세요." }, 400);
  }
  try {
    const result = await collectLolMatches({ riotId: body.riotId, count, startOffset });
    const status = result.stopped === "rate_limited" ? 429 : result.stopped === "key_or_permission" ? 403 : result.stopped ? 503 : 200;
    return response(result, status, result.retryAfter);
  } catch (error) {
    if (error instanceof RiotSearchError) {
      if (error.kind === "busy") return response({ error: "같은 계정 수집이 진행 중입니다.", retryAfter: error.retryAfterSeconds }, 503, error.retryAfterSeconds);
      if (error.kind === "not_found") return response({ error: "계정을 찾을 수 없습니다." }, 404);
      if (error.kind === "invalid_request") return response({ error: "Riot ID를 확인해 주세요." }, 400);
    }
    return response({ error: "경기 수집을 완료하지 못했습니다. 저장소와 API 상태를 확인해 주세요." }, 503);
  }
}
