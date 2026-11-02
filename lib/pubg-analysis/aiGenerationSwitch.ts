/**
 * Gemini 생성 차단 스위치.
 *
 * PUBG_AI_GENERATION_DISABLED=true이면 AI 생성 요청만 막는다. ai-summary는 Gemini를 호출하지 않고
 * 사실 카드로 응답하며, ai-analyze는 503으로 응답한다. 캐시 적중은 계속 돌려준다.
 * 값은 요청마다 process.env에서 읽는다. Vercel에서는 환경 변수를 바꾼 뒤 재배포해야 반영된다(운영 절차는 docs/operations/ai-route-observability.md).
 */
export const AI_GENERATION_DISABLED_ERROR_CODE = "PUBG_AI_GENERATION_DISABLED" as const;
export const AI_GENERATION_DISABLED_MESSAGE = "AI 해석 생성이 잠시 중지되어 있습니다.";

export function isAiGenerationDisabled(env: Record<string, string | undefined> = process.env): boolean {
  return env.PUBG_AI_GENERATION_DISABLED === "true";
}
