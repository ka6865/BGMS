import { NextResponse } from "next/server";
import { isPlayerPrivate } from "@/lib/pubg/privatePlayers";

/**
 * Public PUBG routes must fail closed when the private-player registry cannot
 * be read.  Returning a cache-busting response here also keeps an accidental
 * CDN/proxy cache from preserving a previous public result.
 */
export async function blockPrivatePlayer(
  platform: string,
  nickname: string,
  accountId?: string,
): Promise<NextResponse | null> {
  try {
    if (await isPlayerPrivate(platform, nickname, accountId)) {
      return NextResponse.json(
        { error: "비공개 플레이어입니다.", code: "private_player" },
        { status: 403, headers: { "Cache-Control": "private, no-store" } },
      );
    }
  } catch (error) {
    console.error("[PRIVATE-PLAYER-GUARD] registry lookup failed", error);
    return NextResponse.json(
      {
        error: "비공개 플레이어 확인을 완료하지 못했습니다. 잠시 후 다시 시도해 주세요.",
        errorCode: "PRIVATE_PLAYER_CHECK_UNAVAILABLE",
        retryable: true,
      },
      { status: 503, headers: { "Cache-Control": "private, no-store", "Retry-After": "10" } },
    );
  }
  return null;
}
