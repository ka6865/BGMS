import { NextResponse } from "next/server";
import type { SupabaseClient } from "@supabase/supabase-js";
import { isPlayerPrivate } from "@/lib/pubg/privatePlayers";
import { resolveCachedPlayerAccountId } from "@/lib/pubg/privatePlayerCache";
import { resolvePrivatePlayerAccountId } from "@/lib/pubg/privatePlayerIdentity";

export type PrivatePlayerIdentityResolver = () => Promise<string | null>;

/**
 * Public PUBG routes must fail closed when the private-player registry cannot
 * be read.  Returning a cache-busting response here also keeps an accidental
 * CDN/proxy cache from preserving a previous public result.
 */
export async function blockPrivatePlayer(
  platform: string,
  nickname: string,
  accountId?: string,
  options?: { resolveAccountId?: PrivatePlayerIdentityResolver; lookupUpstream?: boolean; client?: SupabaseClient },
): Promise<NextResponse | null> {
  try {
    const checkPrivate = (resolvedId?: string) => options?.client
      ? isPlayerPrivate(platform, nickname, resolvedId, options.client)
      : isPlayerPrivate(platform, nickname, resolvedId);
    if (await checkPrivate(accountId)) {
      return NextResponse.json(
        { error: "비공개 플레이어입니다.", code: "private_player" },
        { status: 403, headers: { "Cache-Control": "private, no-store" } },
      );
    }
    const resolveAccountId = options?.resolveAccountId
      ?? (options?.lookupUpstream ? () => resolvePrivatePlayerAccountId(platform, nickname) : undefined);
    if (!accountId && resolveAccountId) {
      // The local cache is authoritative when present. Avoid an upstream
      // identity call for ordinary public cache hits and only resolve names
      // that have no local account mapping at all.
      const cachedAccountId = await resolveCachedPlayerAccountId(platform, nickname);
      if (cachedAccountId) {
        if (await checkPrivate(cachedAccountId)) {
          return NextResponse.json(
            { error: "비공개 플레이어입니다.", code: "private_player" },
            { status: 403, headers: { "Cache-Control": "private, no-store" } },
          );
        }
        return null;
      }
      const resolvedAccountId = await resolveAccountId();
      if (resolvedAccountId && await checkPrivate(resolvedAccountId)) {
        return NextResponse.json(
          { error: "비공개 플레이어입니다.", code: "private_player" },
          { status: 403, headers: { "Cache-Control": "private, no-store" } },
        );
      }
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
