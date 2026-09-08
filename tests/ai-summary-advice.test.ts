import { describe, expect, it } from 'vitest';
import { hasUnsupportedSummaryAdvice, sanitizeSummaryAdviceText } from '@/lib/pubg-analysis/aiSummaryJudgment';

describe('recent summary advice grounded in checkable situations', () => {
  it.each([
    '독립적인 교전 기회를 더 적극적으로 만들어야 합니다.',
    '교전 상황에서 피해를 더 누적할 수 있도록 공격적인 위치 선정과 사격 기회를 넓히세요.',
    '혼자 교전을 시도하세요.',
    '교전 참여 빈도를 높여 화력 생산력을 끌어올려야 합니다.',
    '교전 상황에서 지속적인 피해를 누적할 수 있도록 공격 기회를 늘리세요.',
  ])('replaces an observed count-optimization directive: %s', (text) => {
    expect(hasUnsupportedSummaryAdvice(text)).toBe(true);
    const result = sanitizeSummaryAdviceText(text);
    expect(result).not.toBe(text);
    expect(hasUnsupportedSummaryAdvice(result)).toBe(false);
    expect(result).toContain('확인');
    expect(result).toContain('팀 모드라면');
    expect(sanitizeSummaryAdviceText(result)).toBe(result);
  });
  it.each([
    '교전 전에 상대 위치와 빠져나올 경로를 확인하세요.',
    '팀원이 함께 대응할 수 있다는 점이 확인되면 교전 기회를 늘리세요.',
    '솔로 킬 비중이 낮다고 교전 기회를 늘려야 한다는 뜻은 아닙니다.',
    '혼자 교전을 시도하지 마세요.',
    '교전 횟수를 늘려야 하는 것은 아닙니다.',
    '교전 참여 빈도를 높여서는 안 됩니다.',
    '교전 참여 빈도를 높여야 하는 것은 결코 아닙니다.',
    '교전 참여 빈도를 높여야 하는 것은 아닙니다.',
    '교전 참여 빈도를 높여야 할 필요는 없습니다.',
    '교전 참여 빈도를 높여야 한다는 의미는 아닙니다.',
    '교전 참여 빈도를 높여야 한다는 뜻은 아닙니다.',
    '교전 참여 빈도를 높여야 한다고 단정할 수 없습니다.',
    '솔로 킬 비중은 비교 평균보다 낮습니다.',
    '다음 경기에서 아군 기절 상황의 연막 사용 시점을 점검하세요.',
  ])('keeps a fact, limitation or actionable conditional suggestion: %s', (text) => {
    expect(hasUnsupportedSummaryAdvice(text)).toBe(false);
    expect(sanitizeSummaryAdviceText(text)).toBe(text);
  });
  it('preserves the factual comparison before the directive', () => {
    const fact = '솔로 킬 비중은 비교 평균보다 낮습니다.';
    expect(sanitizeSummaryAdviceText(`${fact} 독립적인 교전 기회를 더 적극적으로 만들어야 합니다.`)).toMatch(new RegExp(`^${fact}`));
  });

  it('still rejects a later directive after a valid negated sentence', () => {
    const fact = '교전 참여 빈도를 높여야 하는 것은 아닙니다.';
    const text = `${fact} 교전 기회를 늘리세요.`;
    expect(hasUnsupportedSummaryAdvice(text)).toBe(true);
    expect(sanitizeSummaryAdviceText(text)).toContain(fact);
    expect(sanitizeSummaryAdviceText(text)).not.toContain('교전 기회를 늘리세요.');
  });
});
