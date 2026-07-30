/**
 * @fileoverview 서버 간 호출(cron, 유지보수 작업)용 공유 비밀 인증 헬퍼입니다.
 *
 * 설계 원칙
 *   1. 비밀값은 Authorization 헤더로만 받는다.
 *      쿼리 파라미터에 넣으면 접근 로그, 브라우저 히스토리, Referer 헤더에 남는다.
 *   2. 비교는 상수 시간으로 한다.
 *   3. 환경변수가 설정되지 않았으면 어떤 요청도 통과시키지 않는다.
 *      NODE_ENV 로 검증을 건너뛰는 예외를 두지 않는다.
 */

import { timingSafeEqual } from "node:crypto";

/** 설정된 비밀값과 후보값들을 상수 시간으로 비교합니다. */
export function matchesSecret(
  expected: string | undefined,
  ...candidates: (string | null | undefined)[]
): boolean {
  if (!expected) return false;
  const expectedBuffer = Buffer.from(expected);
  return candidates.some((candidate) => {
    if (!candidate) return false;
    const candidateBuffer = Buffer.from(candidate);
    if (candidateBuffer.length !== expectedBuffer.length) return false;
    return timingSafeEqual(candidateBuffer, expectedBuffer);
  });
}

/** Authorization 헤더에서 Bearer 토큰을 추출합니다. */
export function readBearerToken(request: Request): string | null {
  const header = request.headers.get("Authorization") ?? request.headers.get("authorization");
  if (!header) return null;
  if (!header.startsWith("Bearer ")) return null;
  const token = header.slice(7).trim();
  return token.length > 0 ? token : null;
}

/**
 * Authorization 헤더의 Bearer 토큰이 주어진 환경변수 중 하나와 일치하는지 검사합니다.
 *
 * @param envNames 허용할 환경변수 이름 목록 (예: ["CRON_SECRET", "ADMIN_SECRET_TOKEN"])
 */
export function authorizeBearerSecret(request: Request, envNames: string[]): boolean {
  const token = readBearerToken(request);
  if (!token) return false;
  return envNames.some((name) => matchesSecret(process.env[name], token));
}
