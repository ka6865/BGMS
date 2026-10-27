/**
 * [계산 5 기록] 기습당한 교전마다 첫 피격에서 첫 반격까지 걸린 평균 시간(ms).
 * tradeStats.reactionLatencyMs는 직전 적 피격부터 내 모든 피격까지의 간격 평균이라 교전 중 연사 간격이 섞인다.
 * 반응 시간으로 보여 줄 때는 이 값을 쓴다. 3초 안에 반격한 교전이 없거나 계산 5 이전 결과면 null이다.
 */
export function firstReplyLatencyMs(result: any): number | null {
  const count = Number(result?.duelStats?.firstReplyWithin3sCount);
  const sum = Number(result?.duelStats?.firstReplyLatencySumMs);
  if (!Number.isInteger(count) || count <= 0 || !Number.isFinite(sum) || sum < 0) return null;
  return sum / count;
}
