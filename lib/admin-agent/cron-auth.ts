/**
 * @fileoverview Admin Agent cron(monitor, rollout) 공유 비밀 인증입니다.
 *
 * ADMIN_AGENT_CRON_SECRET 이 있으면 그것만, 없으면 CRON_SECRET 을 기대값으로 쓴다(기존 우선순위 유지).
 * Authorization: Bearer <secret> 또는 x-admin-agent-secret 헤더를 받으며, 비교는 상수 시간으로 한다.
 */

import { matchesSecret } from "@/lib/server/secretAuth";

export function isAdminAgentCronRequest(request: Request): boolean {
  const expected = process.env.ADMIN_AGENT_CRON_SECRET || process.env.CRON_SECRET;
  if (!expected) return false;

  const authorization = request.headers.get("authorization") || "";
  const bearerSecret = authorization.replace(/^Bearer\s+/i, "").trim();
  const headerSecret = (request.headers.get("x-admin-agent-secret") || "").trim();

  return matchesSecret(expected, bearerSecret || null, headerSecret || null);
}
