/**
 * @fileoverview PUBG API 응답 캐시. 인메모리(L1) + DB(L2) 2단 구조입니다.
 *
 * 왜 2단인가
 *   - L1(인메모리): 같은 서버리스 인스턴스 안에서 반복 호출을 즉시 차단한다. 비용 0.
 *   - L2(DB): 인스턴스 간에 공유한다. Vercel 서버리스는 인스턴스마다 메모리가 분리되고
 *     콜드 스타트로 초기화되므로 L1 만으로는 히트율이 매우 낮았다.
 *     PUBG 무료 키는 분당 10회 제한이라 인스턴스 수가 늘면 곧바로 소진된다.
 *
 * DB 접근이 실패해도 요청을 실패시키지 않는다. L1 만으로 동작하는 성능 저하 모드로 떨어진다.
 */

import { createClient, type SupabaseClient } from "@supabase/supabase-js";

export const PLAYER_CACHE_TTL_SECONDS = 180; // 3분
export const FORCE_REFRESH_COOLDOWN_SECONDS = 60;

interface MemoryEntry {
  expiresAt: number;
  payload: unknown;
}

/** 인스턴스 로컬 L1 캐시. 상한을 두어 메모리 누수를 막는다. */
const memoryCache = new Map<string, MemoryEntry>();
const MEMORY_CACHE_MAX_ENTRIES = 500;


type AdminClient = SupabaseClient<any, any, any>;

let cachedAdminClient: AdminClient | null = null;

function getAdminClient(): AdminClient | null {
  if (cachedAdminClient) return cachedAdminClient;
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) return null;
  cachedAdminClient = createClient(url, key);
  return cachedAdminClient;
}

function pruneMemoryCache(): void {
  const now = Date.now();
  for (const [key, entry] of memoryCache) {
    if (entry.expiresAt <= now) memoryCache.delete(key);
  }
  // 만료 정리 후에도 넘치면 오래된 순으로 버린다(Map 은 삽입 순서를 유지한다).
  while (memoryCache.size > MEMORY_CACHE_MAX_ENTRIES) {
    const oldestKey = memoryCache.keys().next().value;
    if (oldestKey === undefined) break;
    memoryCache.delete(oldestKey);
  }
}

export function buildPlayerCacheKey(
  platform: string,
  nickname: string,
  season: string | null
): string {
  return `player:${platform}:${nickname.toLowerCase()}:${season || "current"}`;
}

/** L1 → L2 순으로 조회합니다. 미스면 null. */
export async function readPubgCache<T = unknown>(cacheKey: string): Promise<T | null> {
  const local = memoryCache.get(cacheKey);
  if (local && local.expiresAt > Date.now()) {
    return local.payload as T;
  }
  if (local) memoryCache.delete(cacheKey);

  const supabase = getAdminClient();
  if (!supabase) return null;

  try {
    const { data, error } = await supabase.rpc("read_pubg_response_cache", {
      p_cache_key: cacheKey,
    });
    if (error || data === null || data === undefined) return null;

    // L2 히트를 L1 로 승격시켜 같은 인스턴스의 다음 요청을 빠르게 처리한다.
    memoryCache.set(cacheKey, {
      expiresAt: Date.now() + PLAYER_CACHE_TTL_SECONDS * 1000,
      payload: data,
    });
    return data as T;
  } catch (err) {
    console.warn(
      "[pubg-cache] L2 조회 실패, L1 만 사용합니다:",
      err instanceof Error ? err.message : err
    );
    return null;
  }
}

/** L1 과 L2 에 모두 기록합니다. L2 실패는 무시합니다. */
export async function writePubgCache(
  cacheKey: string,
  payload: unknown,
  ttlSeconds: number = PLAYER_CACHE_TTL_SECONDS
): Promise<void> {
  memoryCache.set(cacheKey, {
    expiresAt: Date.now() + ttlSeconds * 1000,
    payload,
  });
  pruneMemoryCache();

  const supabase = getAdminClient();
  if (!supabase) return;

  try {
    const { error } = await supabase.rpc("write_pubg_response_cache", {
      p_cache_key: cacheKey,
      p_payload: payload,
      p_ttl_seconds: ttlSeconds,
    });
    if (error) {
      console.warn("[pubg-cache] L2 기록 실패:", error.message);
    }
  } catch (err) {
    console.warn("[pubg-cache] L2 기록 예외:", err instanceof Error ? err.message : err);
  }
}

/**
 * 강제 갱신 권한을 클레임합니다.
 * DB 를 사용할 수 없으면 인스턴스 로컬 쿨다운으로 대체합니다(성능 저하 모드).
 *
 * @returns true 면 갱신 진행 가능, false 면 쿨다운 중
 */
const localRefreshLocks = new Map<string, number>();

export async function claimForceRefresh(
  cacheKey: string,
  cooldownSeconds: number = FORCE_REFRESH_COOLDOWN_SECONDS
): Promise<boolean> {
  const supabase = getAdminClient();

  if (supabase) {
    try {
      const { data, error } = await supabase.rpc("claim_pubg_force_refresh", {
        p_lock_key: cacheKey,
        p_cooldown_seconds: cooldownSeconds,
      });
      if (!error) return data === true;
      console.warn("[pubg-cache] 강제 갱신 클레임 실패, 로컬 쿨다운으로 대체:", error.message);
    } catch (err) {
      console.warn(
        "[pubg-cache] 강제 갱신 클레임 예외, 로컬 쿨다운으로 대체:",
        err instanceof Error ? err.message : err
      );
    }
  }

  const now = Date.now();
  const lastClaimedAt = localRefreshLocks.get(cacheKey);
  if (lastClaimedAt && now - lastClaimedAt < cooldownSeconds * 1000) {
    return false;
  }
  localRefreshLocks.set(cacheKey, now);
  return true;
}

/** 테스트 전용. 인스턴스 로컬 상태를 비웁니다. */
export function __resetPubgCacheForTests(): void {
  memoryCache.clear();
  localRefreshLocks.clear();
  cachedAdminClient = null;
}
