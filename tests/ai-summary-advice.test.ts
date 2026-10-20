import { describe, expect, it } from 'vitest';
import { hasUnsupportedSummaryAdvice, sanitizeSummaryAdviceText } from '@/lib/pubg-analysis/aiSummaryJudgment';

describe('recent summary advice grounded in checkable situations', () => {
  it.each([
    '독립적인 교전 기회를 더 적극적으로 만들어야 합니다.',
    '교전 상황에서 피해를 더 누적할 수 있도록 공격적인 위치 선정과 사격 기회를 넓히세요.',
    '혼자 교전을 시도하세요.',
    '교전 참여 빈도를 높여 화력 생산력을 끌어올려야 합니다.',
    '교전 상황에서 지속적인 피해를 누적할 수 있도록 공격 기회를 늘리세요.',
    '평균 화력은 비교 평균보다 낮습니다. 교전 시 더 효과적인 화력 투사를 위해 사격 기회를 늘리거나 교전 거리 조절을 검토하십시오.',
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
    '팀원이 함께 대응할 수 있다는 점이 확인되면 사격 기회를 늘리거나 교전 거리 조절을 검토하십시오.',
    '상대 위치와 퇴로를 확인한 뒤 사격 기회를 늘리거나 교전 거리 조절을 검토하세요.',
    '사격 기회를 늘리거나 교전 거리 조절을 검토해야 할 필요는 없습니다.',
    '사격 기회를 늘리거나 교전 거리 조절을 검토해야 한다는 뜻은 아닙니다.',
    '사격 기회를 늘리거나 교전 거리 조절을 검토해야 한다고 단정할 수 없습니다.',
    '집계 횟수만으로 구출 연막 활용 빈도를 늘려야 한다고 단정할 수 없습니다.',
    '다음 아군 기절 상황에서 연막을 사용할 수 있었는지 확인한 뒤 구출 연막 활용을 점검하세요.',
    '교전 당 피해량을 높이기 위해 사격 기회를 늘려야 한다는 뜻은 아닙니다.',
    '다음 교전 후 피해를 주기 어려웠던 구간을 돌아보고 사격 기회가 있었는지 점검하세요.',
    '생존 시간이 길어도 교전 기여도를 반드시 높여야 한다는 뜻은 아닙니다.',
    '다음 경기에서 아군 기절 상황이 발생하면 연막 구출 가능 여부를 점검하세요.',
    '아군 기절 상황에서 연막을 사용할 수 있었는지 확인한 뒤 구출 연계를 점검하세요.',
  ])('keeps a fact, limitation or actionable conditional suggestion: %s', (text) => {
    expect(hasUnsupportedSummaryAdvice(text)).toBe(false);
    expect(sanitizeSummaryAdviceText(text)).toBe(text);
  });
  it('preserves the factual comparison before the directive', () => {
    const fact = '솔로 킬 비중은 비교 평균보다 낮습니다.';
    expect(sanitizeSummaryAdviceText(`${fact} 독립적인 교전 기회를 더 적극적으로 만들어야 합니다.`)).toMatch(new RegExp(`^${fact}`));
  });

  it('preserves the damage comparison when replacing the compound directive', () => {
    const fact = '평균 화력은 비교 평균보다 낮습니다.';
    expect(sanitizeSummaryAdviceText(`${fact} 교전 시 더 효과적인 화력 투사를 위해 사격 기회를 늘리거나 교전 거리 조절을 검토하십시오.`)).toBe(`${fact} 다음 교전이 끝난 뒤 피해를 주기 어려웠던 구간을 돌아보세요. 팀 모드라면 팀원과 같은 적에게 함께 대응할 수 있었는지도 확인하세요.`);
  });

  it('still rejects a later directive after a valid negated sentence', () => {
    const fact = '교전 참여 빈도를 높여야 하는 것은 아닙니다.';
    const text = `${fact} 교전 기회를 늘리세요.`;
    expect(hasUnsupportedSummaryAdvice(text)).toBe(true);
    expect(sanitizeSummaryAdviceText(text)).toContain(fact);
    expect(sanitizeSummaryAdviceText(text)).not.toContain('교전 기회를 늘리세요.');
  });

  it.each([
    '구출 상황에서 연막 활용 빈도를 높이십시오.',
    '그러나 구출 연막 시도 횟수를 더 늘려 다양한 교전 상황에 대비해야 합니다.',
    '교전 당 피해량을 높이기 위한 사격 기회를 더 만들어야 합니다.',
    '아군 기절 상황에서 연막을 활용한 구출 연계를 더 적극적으로 시도하십시오.',
    '생존 시간만큼 교전 기여도를 높여 팀의 승리에 더 직접적인 영향을 미치도록 분발하십시오.',
  ])('replaces unconditional count or damage optimization with a check: %s', (text) => {
    expect(hasUnsupportedSummaryAdvice(text)).toBe(true);
    const result = sanitizeSummaryAdviceText(text);
    expect(result).not.toBe(text);
    expect(result).toContain('점검');
    expect(hasUnsupportedSummaryAdvice(result)).toBe(false);
    expect(sanitizeSummaryAdviceText(result)).toBe(result);
  });
});
