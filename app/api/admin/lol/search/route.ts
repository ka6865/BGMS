import { isSameOriginLolRequest } from "@/lib/lol/http.server";
import { NextResponse } from "next/server";
import { requireLolDevAdmin } from "@/lib/lol/access.server";
import { LolPersistenceError } from "@/lib/lol/persistence.server";
import { RiotSearchError, searchLolRiotId } from "@/lib/lol/riotSearch.server";

export const dynamic = "force-dynamic";

function response(body: unknown, status = 200, extraHeaders?: HeadersInit) {
  return NextResponse.json(body, {
    status,
    headers: { "Cache-Control": "private, no-store", ...Object.fromEntries(new Headers(extraHeaders)) },
  });
}


export async function POST(request: Request): Promise<NextResponse> {
  const startedAt = Date.now();
  const access = await requireLolDevAdmin();
  if (!access.ok) return access.error;
  if (!isSameOriginLolRequest(request)) return response({ error: "요청 출처를 확인할 수 없습니다." }, 403);
  if (Number(request.headers.get("content-length")) > 2048) return response({ error: "요청이 너무 큽니다." }, 413);

  let body: unknown;
  try {
    const raw = await request.text();
    if (new TextEncoder().encode(raw).byteLength > 2048) return response({ error: "요청이 너무 큽니다." }, 413);
    body = JSON.parse(raw);
  } catch {
    return response({ error: "Riot ID를 확인해 주세요." }, 400);
  }
  const riotId = body && typeof body === "object" ? (body as { riotId?: unknown }).riotId : null;
  const refresh = body && typeof body === "object" ? (body as { refresh?: unknown }).refresh ?? false : false;
  if (typeof riotId !== "string") return response({ error: "Riot ID를 확인해 주세요." }, 400);
  if (typeof refresh !== "boolean") return response({ error: "갱신 요청을 확인해 주세요." }, 400);

  try {
    return response(await searchLolRiotId(riotId, { refresh }));
  } catch (error) {
    if (error instanceof LolPersistenceError || (error instanceof RiotSearchError && error.kind === "persistence")) {
      return response({ error: "LoL 저장소를 사용할 수 없습니다." }, 503);
    }
    if (!(error instanceof RiotSearchError) || (error.kind === "upstream" && !error.diagnostic)) {
      console.error("[lol-search] request_failed", JSON.stringify({
        endpoint: "search",
        stage: "service",
        type: error instanceof RiotSearchError ? error.kind : "unexpected",
        reasonCode: "service_contract_failure",
        status: 502,
        durationMs: Date.now() - startedAt,
      }));
    }
    if (!(error instanceof RiotSearchError)) return response({ error: "Riot API 요청에 실패했습니다." }, 502);
    switch (error.kind) {
      case "invalid_request": return response({ error: "Riot ID 형식은 게임 이름#태그입니다." }, 400);
      case "not_found": return response({ error: "Riot ID를 찾을 수 없습니다. 이름과 태그를 확인해 주세요." }, 404);
      case "key_or_permission": return response({ error: "Riot API 키 또는 API 권한을 확인해 주세요." }, 403);
      case "rate_limited": return response({ error: "Riot API 요청 한도에 도달했습니다. 잠시 후 다시 시도해 주세요." }, 429, {
        "Retry-After": String(error.retryAfterSeconds ?? 1),
      });
      case "timeout": return response({ error: "Riot API 응답 시간이 초과되었습니다." }, 504);
      case "unconfigured": return response({ error: "Riot API 키가 설정되지 않았습니다." }, 503);
      case "busy": return response({ error: "BGMS에서 같은 계정의 데이터 처리가 진행 중입니다. 잠시 후 다시 시도해 주세요." }, 503, { "Retry-After": String(error.retryAfterSeconds ?? 2) });
      case "persistence": return response({ error: "LoL 저장소를 사용할 수 없습니다." }, 503);
      default: return response({ error: "Riot API에 일시적인 문제가 있습니다." }, 502);
    }
  }
}
