import { isSameOriginLolRequest } from "@/lib/lol/http.server";
import { NextResponse } from "next/server";
import { requireLolDevAdmin } from "@/lib/lol/access.server";
import { LolPersistenceError } from "@/lib/lol/persistence.server";
import { getMoreLolMatches, RiotSearchError } from "@/lib/lol/riotSearch.server";

export const dynamic = "force-dynamic";

function response(body: unknown, status = 200, extraHeaders?: HeadersInit) {
  return NextResponse.json(body, {
    status,
    headers: { "Cache-Control": "private, no-store", ...Object.fromEntries(new Headers(extraHeaders)) },
  });
}


export async function POST(request: Request): Promise<NextResponse> {
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
    return response({ error: "요청 내용을 확인해 주세요." }, 400);
  }
  if (!body || typeof body !== "object" || Array.isArray(body)) return response({ error: "요청 내용을 확인해 주세요." }, 400);
  const { riotId, offset, matchIds } = body as { riotId?: unknown; offset?: unknown; matchIds?: unknown };
  if (typeof riotId !== "string" || !Number.isSafeInteger(offset) || (offset as number) < 0
    || (matchIds !== undefined && (!Array.isArray(matchIds) || matchIds.length < 1 || matchIds.length > 5 || matchIds.some((id) => typeof id !== "string" || !/^KR_\d{1,20}$/.test(id))))) {
    return response({ error: "Riot ID 또는 경기 목록 위치를 확인해 주세요." }, 400);
  }
  try {
    return response(await getMoreLolMatches({ riotId, offset: offset as number, matchIds: matchIds as string[] | undefined }));
  } catch (error) {
    if (error instanceof LolPersistenceError || (error instanceof RiotSearchError && error.kind === "persistence"))
      return response({ error: "LoL 저장소를 사용할 수 없습니다." }, 503);
    if (!(error instanceof RiotSearchError)) return response({ error: "경기 목록을 불러오지 못했습니다." }, 502);
    switch (error.kind) {
      case "invalid_request": return response({ error: "요청 형식을 확인해 주세요." }, 400);
      case "not_found": return response({ error: "먼저 검색한 Riot ID만 경기 목록을 불러올 수 있습니다." }, 404);
      case "rate_limited": return response({ error: "Riot API 요청 한도에 도달했습니다. 잠시 후 다시 시도해 주세요." }, 429, { "Retry-After": String(error.retryAfterSeconds ?? 1) });
      case "busy": return response({ error: "BGMS에서 같은 계정의 데이터 처리가 진행 중입니다. 잠시 후 다시 시도해 주세요." }, 503, { "Retry-After": String(error.retryAfterSeconds ?? 2) });
      case "unconfigured": return response({ error: "Riot API 키가 설정되지 않았습니다." }, 503);
      case "timeout": return response({ error: "Riot API 응답 시간이 초과되었습니다." }, 504);
      case "key_or_permission": return response({ error: "Riot API 키 또는 API 권한을 확인해 주세요." }, 403);
      default: return response({ error: "경기 목록을 불러오지 못했습니다." }, 502);
    }
  }
}
