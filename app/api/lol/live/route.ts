import { NextResponse } from "next/server";
import { guardLolPublicRequest } from "@/lib/lol/publicAccess.server";
import { handleLolLive } from "@/lib/lol/liveRoutes.server";
import { isLolLiveEnabled } from "@/lib/lol/liveGame";

export const dynamic = "force-dynamic";

// 플래그가 꺼져 있으면 호출 제한에 기록하지 않고 바로 404를 돌려준다.
export async function POST(request: Request) {
  if (!isLolLiveEnabled()) {
    return NextResponse.json({ error: "요청한 페이지를 찾을 수 없습니다." }, {
      status: 404,
      headers: { "Cache-Control": "private, no-store", "X-Robots-Tag": "noindex, nofollow" },
    });
  }
  const denied = await guardLolPublicRequest(request, "search");
  if (denied) return denied;
  return handleLolLive(request);
}
