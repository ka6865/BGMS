import { describe, expect, it } from 'vitest';
import { sanitizeUnsupportedAiSummaryBenchmarkLanguage } from '@/lib/pubg-analysis/aiSummaryDebate';
import { adaptObservedBenchmark } from '@/lib/pubg-analysis/benchmarkAdapter';
import { buildSummaryCardEvidence } from '@/lib/pubg-analysis/aiSummaryCardEvidence';
import { buildSummaryCards, buildSummaryCardComparisonText, normalizeSummaryCardFinal, parseSummaryCards } from '@/lib/pubg-analysis/aiSummaryCards';

const context = { contextId: 'quality', gameMode: 'squad', matchType: 'official', tier: 'B+', userMatchCount: 5, benchmarkSampleCount: 20, filterVersion: 8, populationVersion: 1 };
function fixture() {
  const benchmark = adaptObservedBenchmark({ match_count: 40, avg_damage: 373.456, avg_damage_count: 40, avg_smoke_rate: 5.78, avg_smoke_rate_count: 40, avg_trade_rate: 8.4, avg_trade_rate_count: 40, avg_trade_latency_ms: 11211.123, avg_trade_latency_ms_count: 40 });
  const evidence = buildSummaryCardEvidence({ avgDamage: 412.123, totalSmokeRescues: 1, totalTeammateKnocks: 18, totalTradeKills: 3, avgBackupLatency: 23.25, metricMatchCounts: { damage_average: 5, smoke_opportunity_rate: 5, trade_success_rate: 5, backup_latency: 2 } }, benchmark);
  return buildSummaryCards({ topics: ['화력', '유틸리티 활용', '복수 성공률 및 백업'], evidence, context });
}
function provider(cards: ReturnType<typeof fixture>) {
  return { signature: '경기 기록', signatureSub: '확인된 지표입니다.', finalVerdict: '비교 자료에서 약점이 확인되지 않았습니다.', actionItems: [{ icon: 'target', title: '합류 점검', desc: '아군이 교전할 때 함께 대응할 수 있는지 확인하세요.' }], debateIssues: cards.map(card => ({ topicId: card.topicId, evidenceIds: card.evidenceIds, kindOpinion: '확인된 경기 기록입니다.', spicyOpinion: '다음 교전에서 함께 대응할 수 있는지 확인하세요.', winner: 'kind', reason: '관측된 지표입니다.', evaluation: '비교 자료에서 약점이 확인되지 않았습니다.' })) };
}
const options = { sanitizeText: (text: string) => text, hasUnsupportedMode: () => false };

describe('summary quality: precision and grounded conclusions', () => {
  it('compares 1/18 with the unrounded benchmark instead of 6% with 5.8%', () => {
    const cards = fixture();
    expect(buildSummaryCardComparisonText(cards[1])).toContain('비교 평균보다 낮습니다');
    expect(cards[1].evidence.find(row => row.metricId === 'smoke_opportunity_rate')).toMatchObject({ userValue: '5.6%', benchmarkValue: '5.8%', userNumericValue: 1 / 18 * 100, benchmarkNumericValue: 5.78 });
    expect(cards[0].evidence[0]).toMatchObject({ userNumericValue: 412.123, benchmarkNumericValue: 373.456 });
    expect(cards[2].evidence.find(row => row.metricId === 'backup_latency')?.benchmarkNumericValue).toBeCloseTo(11.211123, 9);
  });

  it('builds the verdict from all cards regardless of a provider winner or no-weakness claim', () => {
    const cards = fixture();
    const result = normalizeSummaryCardFinal(provider(cards), cards, options)!;
    expect(result.final.finalVerdict).toContain('평균 화력');
    expect(result.final.finalVerdict).toContain('연막 구출률');
    expect(result.final.finalVerdict).toContain('백업 속도');
    expect(result.final.finalVerdict).not.toContain('약점이 확인되지 않았습니다');
    expect(result.final.cards[2].evaluation).not.toContain('약점이 확인되지 않았습니다');
    // 종합 평가는 비교 방향별 수치를 쓰고, 관측 경기 수는 카드 평가에 둔다.
    expect(result.final.finalVerdict).toContain('18건 중 1건');
    expect(result.final.cards[2].evaluation).toContain('2경기');
  });

  it('removes unsupported prose while preserving a usable factual card', () => {
    const cards = fixture(); const raw = provider(cards);
    raw.debateIssues[0].kindOpinion = '꾸준하게 적에게 유효한 피해를 누적하며 팀에 기여하고 있습니다.';
    raw.debateIssues[0].spicyOpinion = '교전 당 피해량을 높이기 위한 사격 기회를 더 만들어야 합니다.';
    const result = normalizeSummaryCardFinal(raw, cards, options)!;
    expect(result.final.cards[0].analysisStatus).toBe('ready');
    expect(result.final.cards[0].kindOpinion).not.toContain('꾸준하게');
    expect(result.final.cards[0].spicyOpinion).not.toContain('더 만들어야');
    expect(parseSummaryCards(result.final)).not.toBeNull();
  });

  it('adds a concrete check when the critical coach only repeats a comparison', () => {
    const cards = fixture(); const raw = provider(cards);
    raw.debateIssues[1].kindOpinion = '다양한 투척물과 연막을 고루 사용한 기록이 확인됩니다.';
    raw.debateIssues[1].spicyOpinion = '아군 기절 대비 연막 구출률은 비교 평균보다 낮습니다.';
    const card = normalizeSummaryCardFinal(raw, cards, options)!.final.cards[1];
    expect(card.analysisStatus).toBe('ready');
    expect(card.kindOpinion).not.toContain('고루');
    // 비교만 반복한 매운맛은 가장 불리한 지표(연막 구출률)에 맞춘 점검으로 바꾸고, 승자는 비교 방향으로 정한다.
    expect(card.spicyOpinion).toBe('아군이 기절했을 때 연막으로 가릴 수 있는 구간이 있었는지 확인해 보세요.');
    expect(card.winner).toBe('spicy');
  });

  it('keeps a situational check without inferred causes or unconditional rescue directives', () => {
    const cards = fixture(); const raw = provider(cards);
    raw.debateIssues[0].spicyOpinion = '반응이 늦어 주도권을 빼앗기고 있습니다. 다음 교전 전에 상대 위치를 확인하세요.';
    raw.actionItems[0].desc = '아군이 기절하는 즉시 연막을 투척하여 안전한 구출 환경을 조성하십시오.';
    const result = normalizeSummaryCardFinal(raw, cards, options)!;
    expect(result.final.cards[0].spicyOpinion).toBe('다음 교전 전에 상대 위치를 확인하세요.');
    // 무조건 투척 지시는 항목만 빠지고, 가장 불리한 지표에 맞춘 서버 점검으로 채운다.
    expect(JSON.stringify(result.final.actionItems)).not.toContain('즉시');
    expect((result.final.actionItems as Array<{ title: string }>).map(item => item.title)).toEqual(['아군 기절 대비 연막 구출률 점검', '백업 속도 점검']);
    expect(result.rejectReasons).not.toContain('action_items');
    expect(result.cacheable).toBe(true);
  });

  it.each(['확인해 보세요', '확인해 보십시오', '점검해 보십시오'])('preserves a utility action ending in %s regardless of card order', (ending) => {
    const cards = fixture(); const raw = provider(cards);
    const action = { icon: 'target', title: '연막 구출 점검', desc: `아군이 기절하면 연막으로 시야를 가릴 수 있는지 ${ending}.` };
    raw.actionItems = [action];
    for (const ordered of [cards, [...cards].reverse()]) {
      const result = normalizeSummaryCardFinal(raw, ordered, options)!;
      expect(result.final.actionItems).toEqual([action]);
      expect(result.cacheable).toBe(true);
    }
  });

  it('omits an unsupported action without replacing its topic or dropping a valid following action', () => {
    const cards = fixture(); const raw = provider(cards);
    const valid = { icon: 'target', title: '연막 구출 점검', desc: '아군이 기절하면 연막으로 시야를 가릴 수 있는지 확인해 보십시오.' };
    raw.actionItems = [{ icon: 'target', title: '연막 구출', desc: '아군이 기절하면 무조건 연막을 던지세요.' }, valid];
    const result = normalizeSummaryCardFinal(raw, cards, options)!;
    expect(result.final.actionItems).toEqual([valid]);
    expect(result.cacheable).toBe(true);
    expect(result.usable).toBe(true);
    expect(result.rejectReasons).not.toContain('action_items');
  });

  it('owns factual prose and titles even when an unseen provider paraphrase passes the language guards', () => {
    const cards = fixture(); const raw = provider(cards);
    raw.signature = '흐름을 읽는 전술가';
    raw.signatureSub = '교전의 흐름을 읽으려는 시도가 돋보입니다.';
    raw.debateIssues[0].kindOpinion = '팀의 화력을 뒷받침하는 모습이 인상적입니다.';
    const result = normalizeSummaryCardFinal(raw, cards, options)!;
    // 비교 문장은 서버가 먼저 쓰고, 숫자·비교가 없는 모델 칭찬만 뒤에 붙는다. 승자는 비교 방향(화력 우위)으로 정한다.
    expect(result.final.cards[0].kindOpinion).toBe(`${buildSummaryCardComparisonText(cards[0])} 팀의 화력을 뒷받침하는 모습이 인상적입니다.`);
    expect(result.final.cards[0].winner).toBe('kind');
    expect(result.final.signature).toBe('AI 전술 분석');
    expect(result.final.signatureSub).not.toContain('시도');
  });

  it('rejects an immediate rescue directive hidden before a check and omits actions without usable cards', () => {
    const cards = fixture(); const raw = provider(cards);
    raw.actionItems[0].desc = '다음 아군 기절 상황에서 연막을 즉시 던져 구출한 뒤, 사용 가능 여부를 확인하세요.';
    const result = normalizeSummaryCardFinal(raw, cards, options)!;
    expect(JSON.stringify(result.final.actionItems)).not.toContain('즉시');
    raw.actionItems[0].desc = raw.actionItems[0].desc.replace('즉시 ', '');
    const withoutAdverb = normalizeSummaryCardFinal(raw, cards, options)!;
    expect(JSON.stringify(withoutAdverb.final.actionItems)).not.toContain('던져');
    raw.debateIssues.forEach(issue => { issue.evidenceIds = ['forged']; });
    const unavailable = normalizeSummaryCardFinal(raw, cards, options)!;
    expect(unavailable.usable).toBe(false);
    expect(unavailable.final.actionItems).toEqual([]);
  });

  it('validates prose with raw values even when both displayed values are equal', () => {
    const input = { smoke_opportunity_rate: { user: { label: '아군 기절 대비 연막 구출률', value: '5.6%', numericValue: 100 / 18 }, benchmark: { label: '동일 티어 평균 연막 구출률', value: '5.6%', numericValue: 5.56 } } };
    const fact = '아군 기절 대비 연막 구출률은 비교 평균보다 낮습니다.';
    expect(sanitizeUnsupportedAiSummaryBenchmarkLanguage(fact, input)).toBe(fact);
    expect(sanitizeUnsupportedAiSummaryBenchmarkLanguage('아군 기절 대비 연막 구출률은 비교 평균보다 높습니다.', input)).not.toContain('보다 높습니다');
  });

  it('rejects non-finite numeric evidence at the public card boundary', () => {
    const cards: any[] = fixture(); cards[0].evidence[0].userNumericValue = Infinity;
    expect(parseSummaryCards(cards)).toBeNull();
  });

  it.each([0, 18])('keeps unavailable observations valid with an observed benchmark and %s opportunities', (opportunities) => {
    const benchmark = adaptObservedBenchmark({ match_count: 20, avg_smoke_rate: 5.78, avg_smoke_rate_count: 20 });
    const evidence = buildSummaryCardEvidence({ totalTeammateKnocks: opportunities, totalSmokeRescues: opportunities ? null : 0 }, benchmark);
    const cards = buildSummaryCards({ topics: ['화력', '유틸리티 활용', '복수 성공률 및 백업'], evidence, context });
    expect(cards[1].evidence.find(row => row.metricId === 'smoke_opportunity_rate')).toMatchObject({ userValue: null, benchmarkValue: null, userNumericValue: null, benchmarkNumericValue: null });
    expect(parseSummaryCards(cards)).not.toBeNull();
  });
});
