import "server-only";
import { NextResponse } from "next/server";
import { isSameOriginLolRequest } from "./http.server";
import { LolPersistenceError, LolLeaseExpiredError } from "./persistence.server";
import { searchLolRiotId, getMoreLolMatches, getLolMatchDetails, getLolMatchBuild, RiotSearchError } from "./riotSearch.server";

import { LOL_KEY_RENEWAL_MESSAGE, LOL_KEY_RENEWAL_ENGLISH, LOL_KEY_RENEWAL_CODE } from "./keyNotice";

const keyNotice = { error: LOL_KEY_RENEWAL_MESSAGE, reasonCode: LOL_KEY_RENEWAL_CODE, detail: LOL_KEY_RENEWAL_ENGLISH };

function searchResponse(body: unknown, status = 200, extraHeaders?: HeadersInit) {
  return NextResponse.json(body, {
    status,
    headers: { "Cache-Control": "private, no-store", ...Object.fromEntries(new Headers(extraHeaders)) },
  });
}


export async function handleLolSearch(request: Request): Promise<NextResponse> {
  const startedAt = Date.now();
  if (!isSameOriginLolRequest(request)) return searchResponse({ error: "요청 출처를 확인할 수 없습니다." }, 403);
  if (Number(request.headers.get("content-length")) > 2048) return searchResponse({ error: "요청이 너무 큽니다." }, 413);

  let body: unknown;
  try {
    const raw = await request.text();
    if (new TextEncoder().encode(raw).byteLength > 2048) return searchResponse({ error: "요청이 너무 큽니다." }, 413);
    body = JSON.parse(raw);
  } catch {
    return searchResponse({ error: "Riot ID를 확인해 주세요." }, 400);
  }
  const riotId = body && typeof body === "object" ? (body as { riotId?: unknown }).riotId : null;
  const refresh = body && typeof body === "object" ? (body as { refresh?: unknown }).refresh ?? false : false;
  if (typeof riotId !== "string") return searchResponse({ error: "Riot ID를 확인해 주세요." }, 400);
  if (typeof refresh !== "boolean") return searchResponse({ error: "갱신 요청을 확인해 주세요." }, 400);

  try {
    return searchResponse(await searchLolRiotId(riotId, { refresh }));
  } catch (error) {
    if (error instanceof LolLeaseExpiredError) return searchResponse({ error: "처리 시간이 초과되었습니다. 다시 시도해 주세요." }, 503);
    if (error instanceof LolPersistenceError || (error instanceof RiotSearchError && error.kind === "persistence")) {
      return searchResponse({ error: "LoL 저장소를 사용할 수 없습니다." }, 503);
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
    if (!(error instanceof RiotSearchError)) return searchResponse({ error: "Riot API 요청에 실패했습니다." }, 502);
    switch (error.kind) {
      case "invalid_request": return searchResponse({ error: "Riot ID 형식은 게임 이름#태그입니다." }, 400);
      case "not_found": return searchResponse({ error: "Riot ID를 찾을 수 없습니다. 이름과 태그를 확인해 주세요." }, 404);
      case "key_or_permission": return searchResponse(keyNotice, 503);
      case "rate_limited": return searchResponse({ error: "일시적으로 요청이 많습니다. 잠시 후 다시 시도해 주세요." }, 429, {
        "Retry-After": String(error.retryAfterSeconds ?? 1),
      });
      case "timeout": return searchResponse({ error: "Riot API 응답 시간이 초과되었습니다." }, 504);
      case "unconfigured": return searchResponse(keyNotice, 503);
      case "congested": return searchResponse({ error: "요청이 많아 잠시 후 다시 시도해 주세요." }, 503, { "Retry-After": String(error.retryAfterSeconds ?? 2) });
      case "busy": return searchResponse({ error: "BGMS에서 같은 계정의 데이터 처리가 진행 중입니다. 잠시 후 다시 시도해 주세요." }, 503, { "Retry-After": String(error.retryAfterSeconds ?? 2) });
      case "persistence": return searchResponse({ error: "LoL 저장소를 사용할 수 없습니다." }, 503);
      default: return searchResponse({ error: "Riot API에 일시적인 문제가 있습니다." }, 502);
    }
  }
}

function moreResponse(body: unknown, status = 200, extraHeaders?: HeadersInit) {
  return NextResponse.json(body, {
    status,
    headers: { "Cache-Control": "private, no-store", ...Object.fromEntries(new Headers(extraHeaders)) },
  });
}


export async function handleLolMore(request: Request, publicView = false): Promise<NextResponse> {
  if (!isSameOriginLolRequest(request)) return moreResponse({ error: "요청 출처를 확인할 수 없습니다." }, 403);
  if (Number(request.headers.get("content-length")) > 2048) return moreResponse({ error: "요청이 너무 큽니다." }, 413);
  let body: unknown;
  try {
    const raw = await request.text();
    if (new TextEncoder().encode(raw).byteLength > 2048) return moreResponse({ error: "요청이 너무 큽니다." }, 413);
    body = JSON.parse(raw);
  } catch {
    return moreResponse({ error: "요청 내용을 확인해 주세요." }, 400);
  }
  if (!body || typeof body !== "object" || Array.isArray(body)) return moreResponse({ error: "요청 내용을 확인해 주세요." }, 400);
  const { riotId, offset, matchIds } = body as { riotId?: unknown; offset?: unknown; matchIds?: unknown };
  if (typeof riotId !== "string" || !Number.isSafeInteger(offset) || (offset as number) < 0
    || (matchIds !== undefined && (!Array.isArray(matchIds) || matchIds.length < 1 || matchIds.length > 5 || matchIds.some((id) => typeof id !== "string" || !/^KR_\d{1,20}$/.test(id))))) {
    return moreResponse({ error: "Riot ID 또는 경기 목록 위치를 확인해 주세요." }, 400);
  }
  try {
    return moreResponse(await getMoreLolMatches({ riotId, offset: offset as number, matchIds: matchIds as string[] | undefined, ...(publicView ? { validateMatchIds: true } : {}) }));
  } catch (error) {
    if (error instanceof LolLeaseExpiredError) return searchResponse({ error: "처리 시간이 초과되었습니다. 다시 시도해 주세요." }, 503);
    if (error instanceof LolPersistenceError || (error instanceof RiotSearchError && error.kind === "persistence"))
      return moreResponse({ error: "LoL 저장소를 사용할 수 없습니다." }, 503);
    if (!(error instanceof RiotSearchError)) return moreResponse({ error: "경기 목록을 불러오지 못했습니다." }, 502);
    switch (error.kind) {
      case "invalid_request": return moreResponse({ error: "요청 형식을 확인해 주세요." }, 400);
      case "not_found": return moreResponse({ error: "먼저 검색한 Riot ID만 경기 목록을 불러올 수 있습니다." }, 404);
      case "rate_limited": return moreResponse({ error: "일시적으로 요청이 많습니다. 잠시 후 다시 시도해 주세요." }, 429, { "Retry-After": String(error.retryAfterSeconds ?? 1) });
      case "congested": return moreResponse({ error: "요청이 많아 잠시 후 다시 시도해 주세요." }, 503, { "Retry-After": String(error.retryAfterSeconds ?? 2) });
      case "busy": return moreResponse({ error: "BGMS에서 같은 계정의 데이터 처리가 진행 중입니다. 잠시 후 다시 시도해 주세요." }, 503, { "Retry-After": String(error.retryAfterSeconds ?? 2) });
      case "unconfigured": return moreResponse(keyNotice, 503);
      case "timeout": return moreResponse({ error: "Riot API 응답 시간이 초과되었습니다." }, 504);
      case "key_or_permission": return moreResponse(keyNotice, 503);
      default: return moreResponse({ error: "경기 목록을 불러오지 못했습니다." }, 502);
    }
  }
}

export async function handleLolBuild(request: Request, context: { params: Promise<{ matchId: string }> }, publicView = false): Promise<NextResponse> {
  return handleLolDetail(request, context, publicView, getLolMatchBuild);
}

export async function handleLolDetail(_request: Request, { params }: { params: Promise<{ matchId: string }> }, publicView = false,
  load: (matchId: string, storedOnly: boolean) => Promise<unknown> = getLolMatchDetails): Promise<NextResponse> {
  const { matchId } = await params;
  if (matchId.length > 24 || !/^KR_\d{1,20}$/.test(matchId)) {
    return NextResponse.json({ error: "경기 ID 형식이 올바르지 않습니다." }, { status: 400, headers: { "Cache-Control": "private, no-store" } });
  }
  try {
    return NextResponse.json(await load(matchId, publicView), { headers: { "Cache-Control": "private, no-store" } });
  } catch (error) {
    if (error instanceof LolLeaseExpiredError) return searchResponse({ error: "처리 시간이 초과되었습니다. 다시 시도해 주세요." }, 503);
    if (error instanceof LolPersistenceError || (error instanceof RiotSearchError && error.kind === "persistence")) {
      return NextResponse.json({ error: "LoL 저장소를 사용할 수 없습니다." }, { status: 503, headers: { "Cache-Control": "private, no-store" } });
    }
    if (error instanceof RiotSearchError && ["key_or_permission", "unconfigured"].includes(error.kind)) {
      return NextResponse.json(keyNotice, { status: 503, headers: { "Cache-Control": "private, no-store" } });
    }
    const status = error instanceof RiotSearchError
      ? error.kind === "invalid_request" ? 400
        : error.kind === "not_found" ? 404
          : error.kind === "key_or_permission" || error.kind === "restricted_match" ? 403
            : error.kind === "rate_limited" ? 429
              : error.kind === "timeout" ? 504
                : error.kind === "unconfigured" || error.kind === "busy" || error.kind === "congested" ? 503 : 502
      : 502;
    const message = error instanceof RiotSearchError && error.kind === "congested"
      ? "요청이 많아 잠시 후 다시 시도해 주세요."
      : error instanceof RiotSearchError && error.kind === "busy"
      ? "BGMS에서 경기 처리가 진행 중입니다. 잠시 후 다시 시도해 주세요."
      : status === 404 ? "경기를 찾을 수 없습니다."
        : error instanceof RiotSearchError && error.kind === "restricted_match"
          ? "이 경기 유형의 상세 정보는 표시할 수 없습니다."
          : error instanceof RiotSearchError && error.kind === "rate_limited"
            ? "일시적으로 요청이 많습니다. 잠시 후 다시 시도해 주세요."
            : "경기 상세를 불러오지 못했습니다.";
    return NextResponse.json({ error: message }, {
      status,
      headers: { "Cache-Control": "private, no-store", ...(error instanceof RiotSearchError && error.kind === "rate_limited" ? { "Retry-After": String(error.retryAfterSeconds ?? 1) } : {}) },
    });
  }
}
