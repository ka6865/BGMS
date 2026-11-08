/**
 * AI 라우트 단계별 계측 로그 (계약 키 kind "ai-route-timing").
 *
 * 요청이 결과를 기록할 때 구조화된 로그 한 줄을 console.info로 남긴다. 지연 원인을 단계별로
 * 나누어 보려는 제품 로그이며 임시 디버그 출력이 아니다. 조회 방법은 docs/operations/ai-route-observability.md에 있다.
 *
 * 로그 계약(키 이름을 바꾸면 스쿼드 라우트의 인라인 구현과 운영 문서를 함께 고친다):
 * {
 *   kind: "ai-route-timing",
 *   route: "summary" | "analyze" | "squad",
 *   requestId: string,                      요청 UUID. 사용자 식별자 대신 쓴다
 *   outcome: string,                        최종 결과 코드(success, partial, cache_hit, facts_only, first_part_timeout, stream_deadline, validation 등)
 *   stages: {
 *     auth?: number, privateGuard?: number, processedLookup?: number,   단계 소요 시간(ms)
 *     canonicalFallback?: { ms, calls, ok },  canonical 보충 호출 수·성공 수·총 시간
 *     benchmark?: number, promptBuild?: number,
 *     cacheLookup?: { ms, result: "hit" | "miss" | "skipped" },
 *     geminiFirstPart?: number,             모델 시도 전체 시간(첫 파트 또는 실패까지)
 *     geminiTotal?: number,                 Gemini 스트림 읽기 전체 시간
 *     persist?: { ms, status: "ok" | "failed" | "skipped" },
 *     total: number
 *   },
 *   attempts: Array<{ model: string, outcome: "ok" | "first_part_timeout" | "rate_limited" | "provider_error" | "stream_deadline" | "truncated", ms: number }>,
 *   reasons?: string,                       검증 사유 id 목록(쉼표 구분, 500자 이하)
 *   actionDrops?: string                    탈락한 행동 제안의 사유 id 목록
 * }
 *
 * 금지: 사용자 식별자, 닉네임, 프롬프트, 모델 원문. 값은 숫자, 고정 문자열, 규칙 id, 모델 이름만 담는다.
 * 단계 키가 없으면 그 단계에 도달하지 않은 것이다.
 */

export const AI_ROUTE_TIMING_KIND = "ai-route-timing" as const;
export const AI_ROUTE_REASON_MAX_LENGTH = 500;

export type AiRouteTimingRoute = "summary" | "analyze" | "squad";
export type AiRouteAttemptOutcome = "ok" | "first_part_timeout" | "rate_limited" | "provider_error" | "stream_deadline" | "truncated";
export type AiRouteAttempt = { model: string; outcome: AiRouteAttemptOutcome; ms: number };

export type AiRouteTimingStages = {
  auth?: number;
  privateGuard?: number;
  processedLookup?: number;
  canonicalFallback?: { ms: number; calls: number; ok: number };
  benchmark?: number;
  promptBuild?: number;
  cacheLookup?: { ms: number; result: "hit" | "miss" | "skipped" };
  geminiFirstPart?: number;
  geminiTotal?: number;
  persist?: { ms: number; status: "ok" | "failed" | "skipped" };
  total: number;
};

export type AiRouteTimingRecord = {
  kind: typeof AI_ROUTE_TIMING_KIND;
  route: AiRouteTimingRoute;
  requestId: string;
  outcome: string;
  stages: AiRouteTimingStages;
  attempts: AiRouteAttempt[];
  reasons?: string;
  actionDrops?: string;
};

type SimpleStage = "auth" | "privateGuard" | "processedLookup" | "benchmark" | "promptBuild" | "geminiFirstPart" | "geminiTotal";
type ObjectStage = "canonicalFallback" | "cacheLookup" | "persist";

export interface AiRouteTimer {
  readonly requestId: string;
  // 단계 밀리초를 기록한다. 같은 단계를 다시 쓰면 마지막 값이 남는다.
  stage(name: SimpleStage, ms: number): void;
  setStage<K extends ObjectStage>(name: K, value: NonNullable<AiRouteTimingStages[K]>): void;
  // 모델 시도 한 번을 기록한다.
  attempt(entry: AiRouteAttempt): void;
  // 마지막 시도의 결과를 바꾼다(스트림 도중 실패나 데드라인처럼 나중에 확정되는 경우).
  settleLastAttempt(outcome: AiRouteAttemptOutcome): void;
  // "모델=결과" 목록. 사유 문자열용이며 모델 원문은 담지 않는다. 시도가 없으면 빈 문자열이다.
  describeAttempts(): string;
  // 요청 시작 이후 경과 시간(ms).
  elapsed(): number;
  // 로그를 한 번만 남긴다. 두 번째 호출은 아무것도 하지 않는다.
  emit(input: { outcome: string; reasons?: readonly string[]; actionDrops?: readonly string[] }): AiRouteTimingRecord | null;
}

/** 검증 사유 목록을 로그와 error_message에 쓸 문자열로 만든다. 중복을 없애고 상한을 넘기지 않는다. */
export function formatAiRouteReasons(reasons: readonly string[]): string {
  return [...new Set(reasons)].join(",").slice(0, AI_ROUTE_REASON_MAX_LENGTH);
}

export function createAiRouteTimer(input: {
  route: AiRouteTimingRoute;
  requestId: string;
  startedAt: number;
  now?: () => number;
  log?: (line: string) => void;
}): AiRouteTimer {
  const now = input.now ?? Date.now;
  const log = input.log ?? ((line: string) => console.info(line));
  const stages: Record<string, unknown> = {};
  const attempts: AiRouteAttempt[] = [];
  let emitted = false;

  return {
    requestId: input.requestId,
    stage(name, ms) {
      stages[name] = Math.max(0, Math.round(ms));
    },
    setStage(name, value) {
      stages[name] = value;
    },
    attempt(entry) {
      attempts.push({ model: entry.model, outcome: entry.outcome, ms: Math.max(0, Math.round(entry.ms)) });
    },
    settleLastAttempt(outcome) {
      const last = attempts[attempts.length - 1];
      if (last) last.outcome = outcome;
    },
    describeAttempts() {
      return attempts.map((attempt) => `${attempt.model}=${attempt.outcome}`).join(",");
    },
    elapsed() {
      return now() - input.startedAt;
    },
    emit({ outcome, reasons, actionDrops }) {
      if (emitted) return null;
      emitted = true;
      const record: AiRouteTimingRecord = {
        kind: AI_ROUTE_TIMING_KIND,
        route: input.route,
        requestId: input.requestId,
        outcome,
        stages: { ...stages, total: Math.max(0, Math.round(now() - input.startedAt)) } as AiRouteTimingStages,
        attempts: attempts.map((attempt) => ({ ...attempt })),
        ...(reasons && reasons.length > 0 ? { reasons: formatAiRouteReasons(reasons) } : {}),
        ...(actionDrops && actionDrops.length > 0 ? { actionDrops: formatAiRouteReasons(actionDrops) } : {}),
      };
      log(JSON.stringify(record));
      return record;
    },
  };
}
