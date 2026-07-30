/**
 * @fileoverview PUBG 응답 캐시와 Discord 방 생성 쿼터 테이블을 정리합니다.
 *
 * 두 테이블 모두 TTL 기반이라 만료 행이 계속 쌓입니다.
 * 일일 유지보수 작업(.github/workflows/daily-tasks.yml)에서 호출합니다.
 */

import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";

type RpcClient = Pick<SupabaseClient, "rpc">;

export type PubgCacheCleanupResult = {
  deletedCacheRows: number;
  deletedDiscordQuotaRows: number;
};

/** 정리 RPC 를 호출합니다. 개별 실패는 다른 정리를 막지 않습니다. */
export async function cleanupPubgCacheTables(
  supabaseAdmin: RpcClient
): Promise<PubgCacheCleanupResult> {
  const result: PubgCacheCleanupResult = {
    deletedCacheRows: 0,
    deletedDiscordQuotaRows: 0,
  };

  const { data: cacheDeleted, error: cacheError } = await supabaseAdmin.rpc(
    "cleanup_pubg_response_cache"
  );
  if (cacheError) {
    throw new Error(`cleanup_pubg_response_cache 실패: ${cacheError.message}`);
  }
  if (typeof cacheDeleted === "number" && Number.isInteger(cacheDeleted) && cacheDeleted >= 0) {
    result.deletedCacheRows = cacheDeleted;
  }

  const { data: quotaDeleted, error: quotaError } = await supabaseAdmin.rpc(
    "cleanup_discord_room_rate_limits"
  );
  if (quotaError) {
    throw new Error(`cleanup_discord_room_rate_limits 실패: ${quotaError.message}`);
  }
  if (typeof quotaDeleted === "number" && Number.isInteger(quotaDeleted) && quotaDeleted >= 0) {
    result.deletedDiscordQuotaRows = quotaDeleted;
  }

  return result;
}

export async function runPubgCacheCleanup(
  env: Record<string, string | undefined> = process.env
): Promise<PubgCacheCleanupResult> {
  const supabaseUrl = env.NEXT_PUBLIC_SUPABASE_URL?.trim();
  const serviceRoleKey = env.SUPABASE_SERVICE_ROLE_KEY?.trim();

  if (!supabaseUrl || !serviceRoleKey) {
    throw new Error("pubg-cache-cleanup-credentials-missing");
  }

  const supabaseAdmin = createClient(supabaseUrl, serviceRoleKey, {
    auth: { autoRefreshToken: false, persistSession: false },
  });

  return cleanupPubgCacheTables(supabaseAdmin);
}

const isDirectRun = process.argv[1]
  && pathToFileURL(resolve(process.argv[1])).href === import.meta.url;

if (isDirectRun) {
  runPubgCacheCleanup()
    .then((result) => {
      console.info(
        `PUBG cache cleanup: 캐시 ${result.deletedCacheRows}행, Discord 쿼터 ${result.deletedDiscordQuotaRows}행 삭제.`
      );
    })
    .catch((err) => {
      console.error("PUBG cache cleanup failed:", err instanceof Error ? err.message : err);
      process.exitCode = 1;
    });
}
