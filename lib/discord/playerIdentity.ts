import { createClient } from "@supabase/supabase-js";
import { isPlayerPrivate } from "@/lib/pubg/privatePlayers";
import { resolveCachedPlayerAccountId } from "@/lib/pubg/privatePlayerCache";
import { resolvePubgPlayerIdentity, type PubgPlayerIdentity } from "@/lib/pubg/privatePlayerIdentity";

const supabaseAdmin = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL || "https://placeholder.supabase.co",
  process.env.SUPABASE_SERVICE_ROLE_KEY || "placeholder-key",
);

const UPSTREAM_IDENTITY_TTL_MS = 10 * 60_000;
const UPSTREAM_IDENTITY_CACHE_LIMIT = 500;

// 같은 인스턴스에서 반복 조회되는 이름의 PUBG 계정 조회 결과만 짧게 보관한다.
// 비공개 목록 검사는 매번 다시 수행하므로 관리자가 등록한 비공개 상태는 즉시 반영된다.
const upstreamIdentities = new Map<string, { identity: PubgPlayerIdentity | null; expiresAt: number }>();

async function upstreamIdentity(platform: string, nickname: string): Promise<PubgPlayerIdentity | null> {
  const key = `${platform}:${nickname.trim().toLowerCase()}`;
  const now = Date.now();
  const cached = upstreamIdentities.get(key);
  if (cached && cached.expiresAt > now) return cached.identity;
  upstreamIdentities.delete(key);

  // 조회 실패는 보관하지 않고 그대로 전파해 호출부가 차단 상태로 처리하게 한다.
  const identity = await resolvePubgPlayerIdentity(platform, nickname);
  if (upstreamIdentities.size >= UPSTREAM_IDENTITY_CACHE_LIMIT) {
    const oldest = upstreamIdentities.keys().next().value;
    if (oldest !== undefined) upstreamIdentities.delete(oldest);
  }
  upstreamIdentities.set(key, { identity, expiresAt: now + UPSTREAM_IDENTITY_TTL_MS });
  return identity;
}

export function clearDiscordPlayerIdentityCache(): void {
  upstreamIdentities.clear();
}

/**
 * Discord 전적 명령의 비공개 대상 여부를 확인한다.
 * 웹 비공개 guard와 같이 로컬 캐시의 계정 ID를 우선하고, 캐시가 없는 이름만 PUBG API로 확인한다.
 * 확인 실패는 예외로 전파한다.
 */
export async function isDiscordTargetPrivate(platform: string, nickname: string): Promise<boolean> {
  if (await isPlayerPrivate(platform, nickname)) return true;
  const cachedAccountId = await resolveCachedPlayerAccountId(platform, nickname);
  if (cachedAccountId) return isPlayerPrivate(platform, nickname, cachedAccountId);
  const identity = await upstreamIdentity(platform, nickname);
  return identity ? isPlayerPrivate(platform, nickname, identity.accountId) : false;
}

/**
 * 연동할 닉네임이 실제 PUBG 계정인지 확인하고 정확한 표기를 돌려준다.
 * 로컬 플레이어 캐시를 우선하고, 없을 때만 PUBG API로 확인한다.
 * 미발견은 null이며 DB·API 오류는 예외로 전파해 연동을 막는다.
 */
export async function resolveDiscordLinkTarget(platform: string, nickname: string): Promise<string | null> {
  const { data, error } = await supabaseAdmin
    .from("pubg_player_cache")
    .select("nickname")
    .eq("platform", platform)
    .eq("lower_nickname", nickname.trim().toLowerCase())
    .maybeSingle();
  if (error) throw error;
  if (typeof data?.nickname === "string" && data.nickname.trim()) return data.nickname.trim();
  return (await upstreamIdentity(platform, nickname))?.nickname ?? null;
}
