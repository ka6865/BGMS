import "server-only";
import { NextResponse } from "next/server";
import { isSameOriginLolRequest } from "./http.server";
import { getLolLiveGame } from "./liveGame.server";
import { RiotSearchError } from "./riotSearch.server";
import { LOL_KEY_RENEWAL_MESSAGE, LOL_KEY_RENEWAL_ENGLISH, LOL_KEY_RENEWAL_CODE } from "./keyNotice";

const keyNotice = { error: LOL_KEY_RENEWAL_MESSAGE, reasonCode: LOL_KEY_RENEWAL_CODE, detail: LOL_KEY_RENEWAL_ENGLISH };

function liveResponse(body: unknown, status = 200, extraHeaders?: HeadersInit) {
  return NextResponse.json(body, {
    status,
    headers: { "Cache-Control": "private, no-store", ...Object.fromEntries(new Headers(extraHeaders)) },
  });
}

// 공개·관리자 경로가 함께 쓴다. 호출 제한(guardLolPublicRequest)과 플래그 확인은 호출자가 맡는다.
export async function handleLolLive(request: Request): Promise<NextResponse> {
  if (!isSameOriginLolRequest(request)) return liveResponse({ error: "요청 출처를 확인할 수 없습니다." }, 403);
  if (Number(request.headers.get("content-length")) > 2048) return liveResponse({ error: "요청이 너무 큽니다." }, 413);

  let body: unknown;
  try {
    const raw = await request.text();
    if (new TextEncoder().encode(raw).byteLength > 2048) return liveResponse({ error: "요청이 너무 큽니다." }, 413);
    body = JSON.parse(raw);
  } catch {
    return liveResponse({ error: "Riot ID를 확인해 주세요." }, 400);
  }
  const riotId = body && typeof body === "object" ? (body as { riotId?: unknown }).riotId : undefined;
  const tier = body && typeof body === "object" ? (body as { tier?: unknown }).tier : undefined;
  if (typeof riotId !== "string") return liveResponse({ error: "Riot ID를 확인해 주세요." }, 400);

  try {
    return liveResponse(await getLolLiveGame({ riotId, tier }));
  } catch (error) {
    if (!(error instanceof RiotSearchError)) return liveResponse({ error: "진행 중 경기를 불러오지 못했습니다." }, 502);
    switch (error.kind) {
      case "invalid_request": return liveResponse({ error: "Riot ID 형식은 게임 이름#태그입니다." }, 400);
      case "not_found": return liveResponse({ error: "Riot ID를 찾을 수 없습니다. 이름과 태그를 확인해 주세요." }, 404);
      case "key_or_permission": return liveResponse(keyNotice, 503);
      case "unconfigured": return liveResponse(keyNotice, 503);
      case "rate_limited": return liveResponse({ error: "일시적으로 요청이 많습니다. 잠시 후 다시 시도해 주세요." }, 429, {
        "Retry-After": String(error.retryAfterSeconds ?? 1),
      });
      case "congested":
      case "busy": return liveResponse({ error: "요청이 많아 잠시 후 다시 시도해 주세요." }, 503, { "Retry-After": String(error.retryAfterSeconds ?? 2) });
      case "timeout": return liveResponse({ error: "Riot API 응답 시간이 초과되었습니다." }, 504);
      case "persistence": return liveResponse({ error: "LoL 저장소를 사용할 수 없습니다." }, 503);
      default: return liveResponse({ error: "Riot API에 일시적인 문제가 있습니다." }, 502);
    }
  }
}
