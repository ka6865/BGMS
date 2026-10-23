import { NextResponse } from "next/server";
import { requireLolDevAdmin } from "@/lib/lol/access.server";
import { LolPersistenceError } from "@/lib/lol/persistence.server";
import { getLolMatchDetails, RiotSearchError } from "@/lib/lol/riotSearch.server";

export const dynamic = "force-dynamic";

export async function GET(_request: Request, { params }: { params: Promise<{ matchId: string }> }): Promise<NextResponse> {
  const access = await requireLolDevAdmin();
  if (!access.ok) return access.error;
  const { matchId } = await params;
  if (matchId.length > 24 || !/^KR_\d{1,20}$/.test(matchId)) {
    return NextResponse.json({ error: "경기 ID 형식이 올바르지 않습니다." }, { status: 400, headers: { "Cache-Control": "private, no-store" } });
  }
  try {
    return NextResponse.json(await getLolMatchDetails(matchId), { headers: { "Cache-Control": "private, no-store" } });
  } catch (error) {
    if (error instanceof LolPersistenceError || (error instanceof RiotSearchError && error.kind === "persistence")) {
      return NextResponse.json({ error: "LoL 저장소를 사용할 수 없습니다." }, { status: 503, headers: { "Cache-Control": "private, no-store" } });
    }
    const status = error instanceof RiotSearchError
      ? error.kind === "invalid_request" ? 400
        : error.kind === "not_found" ? 404
          : error.kind === "key_or_permission" || error.kind === "restricted_match" ? 403
            : error.kind === "rate_limited" ? 429
              : error.kind === "timeout" ? 504
                : error.kind === "unconfigured" || error.kind === "busy" ? 503 : 502
      : 502;
    const message = error instanceof RiotSearchError && error.kind === "busy"
      ? "BGMS에서 경기 처리가 진행 중입니다. 잠시 후 다시 시도해 주세요."
      : status === 404 ? "경기를 찾을 수 없습니다."
        : error instanceof RiotSearchError && error.kind === "restricted_match"
          ? "이 경기 유형의 상세 정보는 표시할 수 없습니다."
          : error instanceof RiotSearchError && error.kind === "rate_limited"
            ? "Riot API 요청 한도에 도달했습니다. 잠시 후 다시 시도해 주세요."
            : "경기 상세를 불러오지 못했습니다.";
    return NextResponse.json({ error: message }, {
      status,
      headers: { "Cache-Control": "private, no-store", ...(error instanceof RiotSearchError && error.kind === "rate_limited" ? { "Retry-After": String(error.retryAfterSeconds ?? 1) } : {}) },
    });
  }
}
