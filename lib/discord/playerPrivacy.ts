import { isPlayerPrivate } from "@/lib/pubg/privatePlayers";
import { resolveCachedPlayerAccountId } from "@/lib/pubg/privatePlayerCache";
import { resolvePrivatePlayerAccountId } from "@/lib/pubg/privatePlayerIdentity";

const UPSTREAM_ACCOUNT_TTL_MS = 10 * 60_000;
const UPSTREAM_ACCOUNT_CACHE_LIMIT = 500;

// 같은 인스턴스에서 반복 조회되는 이름의 PUBG 계정 조회 결과만 짧게 보관한다.
// 비공개 목록 검사는 매번 다시 수행하므로 관리자가 등록한 비공개 상태는 즉시 반영된다.
const upstreamAccountIds = new Map<string, { accountId: string | null; expiresAt: number }>();

async function upstreamAccountId(platform: string, nickname: string): Promise<string | null> {
  const key = `${platform}:${nickname.trim().toLowerCase()}`;
  const now = Date.now();
  const cached = upstreamAccountIds.get(key);
  if (cached && cached.expiresAt > now) return cached.accountId;
  upstreamAccountIds.delete(key);

  // 조회 실패는 보관하지 않고 그대로 전파해 비공개 확인을 차단 상태로 둔다.
  const accountId = await resolvePrivatePlayerAccountId(platform, nickname);
  if (upstreamAccountIds.size >= UPSTREAM_ACCOUNT_CACHE_LIMIT) {
    const oldest = upstreamAccountIds.keys().next().value;
    if (oldest !== undefined) upstreamAccountIds.delete(oldest);
  }
  upstreamAccountIds.set(key, { accountId, expiresAt: now + UPSTREAM_ACCOUNT_TTL_MS });
  return accountId;
}

export function clearDiscordPlayerPrivacyCache(): void {
  upstreamAccountIds.clear();
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
  const accountId = await upstreamAccountId(platform, nickname);
  return accountId ? isPlayerPrivate(platform, nickname, accountId) : false;
}
