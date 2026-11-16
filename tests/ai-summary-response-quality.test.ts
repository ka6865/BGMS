import { describe, expect, it } from 'vitest';
import { buildSummaryCardEvidence } from '@/lib/pubg-analysis/aiSummaryCardEvidence';
import { buildSummaryCards, normalizeSummaryCardFinal, parseSummaryCards, type SummaryEvidenceInput } from '@/lib/pubg-analysis/aiSummaryCards';
import { selectSummaryDebateTopics } from '@/lib/pubg-analysis/aiSummaryTopics';

const context = { contextId: 'summary-v37', gameMode: 'squad', matchType: 'competitive', tier: 'B', userMatchCount: 10, benchmarkSampleCount: 40, filterVersion: 8, populationVersion: 1 };
const options = { sanitizeText: (value: string) => value, hasUnsupportedMode: () => false };
const benchmark = { sampleCount: 40, avgDamage: 100, avgPressureIndex: 5.66, avgFirstReplyLatency: 0.94, avgDuelWinRate: 12.5, avgIsolationIndex: 1, metricSampleCounts: { avgDamage: 40, avgPressureIndex: 40, avgFirstReplyLatency: 40, avgDuelWinRate: 40, avgIsolationIndex: 40 } };

function evaluate(rows: SummaryEvidenceInput[], legacy = false) {
  const cards = buildSummaryCards({ topics: ['화력', '교전 주도권', '1:1 결정력'], context, evidence: rows });
  const provider = {
    signature: '화력 장인',
    debateIssues: cards.map(card => ({ topicId: card.topicId, evidenceIds: card.evidenceIds, kindOpinion: '이번 지표의 관측 범위를 확인했습니다.', spicyOpinion: '다음 교전 후 관측 기록을 확인해 보세요.', ...(legacy ? { winner: 'invalid', reason: '', evaluation: '다른 모드의 옛 평가' } : {}) })),
    actionItems: [],
    ...(legacy ? { finalVerdict: '', signatureSub: '예전 문장' } : {}),
  };
  const result = normalizeSummaryCardFinal(provider, cards, options)!;
  return { cards, provider, result };
}

function metric(metricId: string, user: number, average: number, unit = '', userMatchCount = 2): SummaryEvidenceInput {
  const label = ({ damage_average: '평균 화력', pressure_index: '평균 압박 지수', reaction_latency: '반격 소요 시간', initiative_rate: '선제 타격 성공률', duel_win_rate: '1:1 교전 승률' } as Record<string, string>)[metricId];
  return { metricId, label, unit, userValue: `${Number(user.toFixed(unit === "%" ? 1 : 2))}${unit}`, userNumericValue: user, benchmarkValue: `${Number(average.toFixed(unit === "%" ? 1 : 2))}${unit}`, benchmarkNumericValue: average, benchmarkLabel: '동일 티어 평균', sampleCount: 40, userMatchCount };
}

describe('최근 요약 v37 응답 판정', () => {
  it.each([1, 2])('실제 반격 관측 %s경기로 평가 적격성을 정하고 원수치를 보존한다', count => {
    const rows = buildSummaryCardEvidence({ mLen: 10, avgMeasuredReactionLatency: '2.40s', metricMatchCounts: { reaction_latency: count } }, benchmark);
    const { cards, result } = evaluate(rows);
    const card = result.final.cards[1];
    expect(card.evidence.find(row => row.metricId === 'reaction_latency')).toMatchObject({ userValue: count === 1 ? '2.4s' : '2.40s', userMatchCount: count });
    expect(card.winner).toBe(count === 1 ? null : 'spicy');
    expect(card.spicyOpinion).not.toContain('트집');
    expect(JSON.stringify(result.final.actionItems)).toContain(count === 1 ? '[]' : '반격 소요 시간');
    expect(result.cacheable).toBe(true);
    expect(normalizeSummaryCardFinal(result.final, cards, options)?.final).toEqual(result.final);
  });

  it.each([
    ['damage_average', 101, 100, '', null], ['damage_average', 104, 100, '', null],
    ['damage_average', 105, 100, '', null], ['damage_average', 95, 100, '', null],
    ['damage_average', 105.01, 100, '', 'kind'], ['damage_average', 94.99, 100, '', 'spicy'],
    ['initiative_rate', 53, 50, '%', null], ['initiative_rate', 47, 50, '%', null],
    ['initiative_rate', 53.01, 50, '%', 'kind'], ['initiative_rate', 46.99, 50, '%', 'spicy'],
    ['damage_average', 100, 100, '', null], ['damage_average', 0, 0, '', null],
    ['damage_average', 1, 0, '', 'kind'], ['reaction_latency', 1, 0, 's', 'spicy'],
  ] as const)('%s %s 대 %s%s는 경계 정책에 맞게 판정한다', (id, user, average, unit, winner) => {
    const { cards, result } = evaluate([metric(id, user, average, unit)]);
    const card = result.final.cards.find(item => item.evidence.some(row => row.metricId === id))!;
    expect(card.winner).toBe(winner);
    expect(card.reason).toContain(`${Number(user.toFixed(unit === "%" ? 1 : 2))}${unit}`);
    if (winner === null) {
      expect(result.final.actionItems).toEqual([]);
      expect(card.spicyOpinion).not.toMatch(/인정|다음 교전|버튼|하이라이트/);
    }
    expect(result.cacheable).toBe(true);
    expect(parseSummaryCards(result.final.cards)).not.toBeNull();
    expect(normalizeSummaryCardFinal(result.final, cards, options)?.final).toEqual(result.final);
  });

  it.each([4, 5])('비율 기회 %s건의 경계에서도 관측값과 분모를 남기고 판정만 보류한다', opportunities => {
    const rows = buildSummaryCardEvidence({ totalInitiativeSuccess: 2, totalInitiativeAttempts: opportunities, metricMatchCounts: { initiative_rate: 1 } }, { sampleCount: 40, avgInitiativeRate: 20, metricSampleCounts: { avgInitiativeRate: 40 } });
    const { cards, result } = evaluate(rows);
    expect(result.final.cards[1].winner).toBe(opportunities === 4 ? null : 'kind');
    expect(result.final.cards[1].reason).toContain(`${opportunities}건 중 2건`);
    expect(result.cacheable).toBe(true);
    expect(normalizeSummaryCardFinal(result.final, cards, options)?.final).toEqual(result.final);
  });

  it('1경기 연속형과 1% 압박 차이만 남아도 정상 보류로 캐시한다', () => {
    const rows = buildSummaryCardEvidence({ mLen: 10, avgDamage: 100, avgPressureIndex: 5.71, avgMeasuredReactionLatency: '2.40s', metricMatchCounts: { damage_average: 1, pressure_index: 4, reaction_latency: 1 } }, benchmark);
    const { cards, result } = evaluate(rows);
    expect(result).toMatchObject({ cacheable: true, usable: true, rejectReasons: [], final: { analysisStatus: 'complete', actionItems: [] } });
    expect(result.final.cards.every(card => card.winner === null)).toBe(true);
    expect(result.final.cards[1].reason).toContain('5.71');
    expect(result.final.cards[1].reason).toContain('비슷한 수준');
    expect(result.final.cards[1].reason).toContain('1경기');
    expect(normalizeSummaryCardFinal(result.final, cards, options)?.final).toEqual(result.final);
  });

  it('2승/10전은 산식이 통일될 때까지 건수만 표시하며 강약점과 놀림을 만들지 않는다', () => {
    const rows = buildSummaryCardEvidence({ totalDuelWins: 2, totalDuelLosses: 8, metricMatchCounts: { duel_win_rate: 5 } }, benchmark);
    const { cards, result } = evaluate(rows);
    const duel = result.final.cards[2];
    expect(duel.evidence[0]).toMatchObject({ userValue: '20%', numerator: 2, denominator: 10, benchmarkValue: null });
    expect(duel.reason).toContain('10건 중 2건');
    expect(duel.reason).toContain('산식');
    expect(duel.winner).toBeNull();
    expect(duel.spicyOpinion).not.toMatch(/하이라이트|인정|트집/);
    expect(result.final.actionItems).toEqual([]);
    expect(result.cacheable).toBe(true);
    expect(normalizeSummaryCardFinal(result.final, cards, options)?.final).toEqual(result.final);
  });

  it('유리한 카드의 매운 의견은 범위를 제한해 인정하고 점검은 행동 안내로 넘긴다', () => {
    const { cards, result } = evaluate([metric('damage_average', 150, 100), metric('pressure_index', 8, 5), metric('initiative_rate', 80, 50, '%')]);
    for (const card of result.final.cards.filter(card => card.analysisStatus === 'ready')) {
      expect(card.spicyOpinion).toMatch(/이번 관측/);
      expect(card.spicyOpinion).not.toMatch(/트집|맵게 할 말|다음|점검|보세요|습니다/);
      expect(card.kindOpinion).toMatch(/습니다\.$/);
    }
    expect(JSON.stringify(result.final.actionItems)).toContain('확인해 보세요');
    expect(normalizeSummaryCardFinal(result.final, cards, options)?.final).toEqual(result.final);
  });

  it('같은 카드에 유리한 지표가 있어도 보류된 지표를 겨냥한 행동은 만들지 않는다', () => {
    const { cards, provider } = evaluate([metric('damage_average', 50, 100), metric('pressure_index', 8, 5), metric('reaction_latency', 2.4, 0.94, 's', 1)]);
    const result = normalizeSummaryCardFinal({ ...provider, actionItems: [{ icon: 'target', title: '반격 소요 시간 점검', desc: '다음 교전 후 반격 소요 시간을 확인해 보세요.' }] }, cards, options)!;
    expect(JSON.stringify(result.final.actionItems)).not.toContain('반격 소요 시간');
    expect(JSON.stringify(result.final.actionItems)).toContain('평균 화력');
    expect(result.cacheable).toBe(true);
    expect(normalizeSummaryCardFinal(result.final, cards, options)?.final).toEqual(result.final);
  });

  it('레거시의 버리는 필드는 검증하지 않고 간소한 출력과 같은 결과로 재정규화한다', () => {
    const rows = [metric('damage_average', 150, 100), metric('pressure_index', 3, 5)];
    const fresh = evaluate(rows), cached = evaluate(rows, true);
    expect(cached.result.final).toEqual(fresh.result.final);
    expect(cached.result.cacheable).toBe(true);
    expect(normalizeSummaryCardFinal(cached.result.final, cached.cards, options)?.final).toEqual(cached.result.final);
    expect(String(cached.result.final.finalVerdict).match(/[.!?](?:\s|$)/g)).toHaveLength(2);
    const prose = cached.result.final.cards.flatMap(card => [card.reason, card.evaluation]).join(' ');
    expect(prose).not.toContain('평균·비율만으로');
    expect(String(cached.result.final.finalVerdict).match(/평균·비율만으로/g)).toHaveLength(1);
    expect(cached.result.final.signatureSub).toContain('관측 2경기: 평균 화력: 150');
  });

  it.each(['관측된 스쿼드 경쟁전 기록', '전적 분석', '전투 요약', '최근 관측'])('서술형 칭호 %s는 기존 기본 칭호로 바꾼다', signature => {
    const { provider, cards } = evaluate([metric('damage_average', 150, 100)]);
    expect(normalizeSummaryCardFinal({ ...provider, signature }, cards, options)?.final.signature).toBe('AI 전술 분석');
  });

  it('고립 지수는 비교 수치를 보존해도 판정 방향과 승자를 만들지 않는다', () => {
    const rows = buildSummaryCardEvidence({ mLen: 3, avgIsolationStr: '0.28', metricMatchCounts: { isolation_average: 3 } }, benchmark);
    const cards = buildSummaryCards({ topics: ['화력', '교전 주도권', '포지셔닝'], context, evidence: rows });
    const provider = { signature: '경기 탐험가', debateIssues: cards.map(card => ({ topicId: card.topicId, evidenceIds: card.evidenceIds, kindOpinion: '관측한 기록을 확인했습니다.', spicyOpinion: '다음 교전 전에 팀원 위치를 확인해 보세요.' })), actionItems: [] };
    const result = normalizeSummaryCardFinal(provider, cards, options)!;
    expect(result.final.cards[2].winner).toBeNull();
    expect(result.final.cards[2].reason).toContain('0.28');
    expect(result.final.cards[2].reason).toContain('비교 평균 1.00');
    expect(result.final.finalVerdict).not.toContain('강점으로');
    expect(result.final.actionItems).toEqual([]);
    expect(normalizeSummaryCardFinal(result.final, cards, options)?.final).toEqual(result.final);
  });

  it('대표 강점이 없으면 모델이 강점 칭호를 보내도 중립 기본 칭호를 쓴다', () => {
    const { result } = evaluate([metric('damage_average', 104, 100), metric('reaction_latency', 2.4, 0.94, 's', 1)]);
    expect(result.final.signature).toBe('AI 전술 분석');
    expect(result.final.signatureSub).toContain('관측 2경기: 평균 화력: 104');
    expect(result.cacheable).toBe(true);
  });

  it('소표본·미미한 차이·1:1 승률을 비교 주제 후보에서 제외한다', () => {
    const stats = { avgDamage: 104, avgDuelWinRate: 20, avgMeasuredReactionLatency: '2.40s', avgPressureIndex: 5.71, metricMatchCounts: { damage_average: 4, pressure_index: 4, reaction_latency: 1 }, totalUtilityThrows: 5, avgIsolationStr: '1', avgDeathPhase: null };
    const topics = selectSummaryDebateTopics(stats, benchmark, { userTradeRate: null });
    expect(topics).toEqual(['유틸리티 활용', '포지셔닝', '생존 운영']);
  });
});
