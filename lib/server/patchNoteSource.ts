/**
 * @fileoverview 관리자 패치노트 수동 동기화 URL 검증입니다.
 */

export type ManualPatchSource = { kind: "official" | "kakao"; url: string };

function hostMatches(hostname: string, domain: string) {
  return hostname === domain || hostname.endsWith(`.${domain}`);
}

/**
 * 관리자가 직접 넣은 URL 을 검증한다. 서버가 임의 주소로 요청을 보내지 않도록
 * https 이면서 허용 도메인(pubg.com, 카카오 배그 공지용 daum.net/kakao.com)일 때만 통과시킨다.
 */
export function parseManualPatchSource(raw: unknown): ManualPatchSource | null {
  if (typeof raw !== "string") return null;
  let parsed: URL;
  try {
    parsed = new URL(raw.trim());
  } catch {
    return null;
  }
  if (parsed.protocol !== "https:" || parsed.username || parsed.password) return null;
  if (parsed.port && parsed.port !== "443") return null;
  const hostname = parsed.hostname.toLowerCase();
  if (hostMatches(hostname, "pubg.com")) return { kind: "official", url: parsed.toString() };
  if (hostMatches(hostname, "daum.net") || hostMatches(hostname, "kakao.com")) return { kind: "kakao", url: parsed.toString() };
  return null;
}
