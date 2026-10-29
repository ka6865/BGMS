/**
 * @fileoverview 운영 화면용 병렬 조회를 소스별로 독립 실패시키는 헬퍼입니다.
 *
 * command center 와 monitor 는 여러 테이블·외부 API 를 Promise.all 로 동시에 읽는다.
 * 그중 하나가 예외를 던지면 전체 응답이 500 이 되므로, 각 소스를 감싸서
 * 실패한 소스만 같은 모양의 기본값(error 필드 포함)으로 대체하고 실패 목록을 남긴다.
 */

export type AgentSourceFailure = { source: string; message: string };

export const AGENT_SOURCE_FAILURE_MESSAGE = "이 항목을 불러오지 못해 기본값으로 대체했습니다.";

export function createSourceSettler(failures: AgentSourceFailure[], logPrefix: string) {
  return async function settle<T>(
    source: string,
    task: () => Promise<T>,
    fallback: (message: string) => T
  ): Promise<T> {
    try {
      return await task();
    } catch (error: any) {
      // 원인은 서버 로그에만 남기고 응답에는 일반 문구만 싣는다.
      console.error(`${logPrefix} ${source} failed:`, error?.message || error);
      failures.push({ source, message: AGENT_SOURCE_FAILURE_MESSAGE });
      return fallback(AGENT_SOURCE_FAILURE_MESSAGE);
    }
  };
}
