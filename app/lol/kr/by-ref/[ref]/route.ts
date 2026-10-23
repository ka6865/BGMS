import { LOL_LEGAL_ENGLISH, LOL_LEGAL_KOREAN } from "@/components/lol/LolLegalNotice";
import { NextResponse } from "next/server";
import { guardLolPublicRequest } from "@/lib/lol/publicAccess.server";
import { lolRiotIdPath } from "@/lib/lol/riotId";
import { resolveLolParticipantRef, RiotSearchError } from "@/lib/lol/riotSearch.server";

export const dynamic = "force-dynamic";

function failure(message: string, status: number) {
  const html = '<!doctype html><html lang="ko"><meta charset="utf-8">'
    + '<meta name="viewport" content="width=device-width,initial-scale=1"><title>LoL 계정 이동</title>'
    + `<body><p>${message}</p><a href="/lol/kr">검색으로 돌아가기</a><footer><p lang="en">${LOL_LEGAL_ENGLISH}</p><p>${LOL_LEGAL_KOREAN}</p></footer></body></html>`;
  return new NextResponse(html, {
    status, headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "private, no-store", "X-Robots-Tag": "noindex, nofollow" },
  });
}

export async function GET(request: Request, { params }: { params: Promise<{ ref: string }> }) {
  const denied = guardLolPublicRequest(request, "read", false);
  if (denied) return denied;
  try {
    const riotId = await resolveLolParticipantRef((await params).ref);
    const path = lolRiotIdPath(riotId, "/lol/kr");
    if (!path) return failure("계정 이름을 확인할 수 없습니다.", 502);
    return NextResponse.redirect(new URL(path, request.url), { status: 307, headers: { "Cache-Control": "private, no-store" } });
  } catch (error) {
    if (error instanceof RiotSearchError && error.kind === "invalid_request") return failure("잘못된 참가자 링크입니다. (400)", 400);
    if (error instanceof RiotSearchError && error.kind === "not_found") return failure("계정을 찾을 수 없습니다.", 404);
    return failure("계정 정보를 불러오지 못했습니다. 잠시 후 다시 시도해 주세요.", 503);
  }
}
