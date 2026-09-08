import { describe, expect, it } from 'vitest';
import { hasUnsupportedSummaryInference, sanitizeSummaryInferenceText } from '@/lib/pubg-analysis/aiSummaryJudgment';
import { COACHING_JUDGMENT_WITHHELD } from '@/lib/pubg-analysis/aiCoachingQuality';

describe('recent summary observed inference regressions', () => {
  it.each([
    '빠른 이동 속도에 비해 교전 직후의 복수 성공 과정에서 확실한 마무리를 짓는 집중력이 더 필요합니다.',
    '교전 호흡과 이동 속도가 양호하게 유지되고 있습니다.',
    '꾸준히 높은 피해량을 기록한 점은 훌륭합니다.',
    '평균 화력 지표가 비교 평균을 상회하며 꾸준한 딜링 능력을 증명했습니다.',
    '매 경기 높은 피해량을 기록했습니다.',
    '관측된 피해량 분포가 안정적으로 유지되고 있습니다.',
    '꾸준한 전투 기여도로 훌륭한 화력을 보여주었습니다.',
    '교전 상황에서 집중력을 잘 유지하고 있습니다.',
    '유틸리티 보유량 대비 실전 연막 구출 연계 보완이 필요합니다.',
    '평균 고립 지수가 기준에 부합하여 안정적인 대열 유지가 확인됩니다.',
    '총 투척과 연막 사용 기록은 있으나 위기 상황에서의 구출 연막 활용 빈도가 낮습니다.',
    '개인 교전에서의 집중력이 매우 훌륭합니다.',
    '기동력 중심의 교전 참여가 확인됩니다.',
    '개인 전투 상황에서 상대를 제압하는 탁월한 집중력을 보여줍니다.',
    '뛰어난 1:1 교전 능력을 증명하며 전투에서 큰 주도권을 쥐고 있습니다.',
    '높은 화력 지표를 기록한 만큼 교전에서 더 주도적인 각을 만들어내야 합니다.',
  ])('withholds an unsupported inference: %s', (text) => {
    expect(hasUnsupportedSummaryInference(text)).toBe(true);
    expect(sanitizeSummaryInferenceText(text)).toBe(COACHING_JUDGMENT_WITHHELD);
  });
  it.each([
    '백업 속도는 비교 평균보다 빠릅니다.',
    '평균 화력이 높아도 높은 집중력을 의미하지 않습니다.',
    '높은 집중력을 뜻하지 않습니다.',
    '다음 경기에서도 꾸준히 높은 피해량을 기록해 보세요.',
    '평균 화력만으로 매 경기 꾸준했다고 단정할 수 없습니다.',
    '평균 화력은 비교 평균보다 높습니다.',
    '백업 시간으로 이동 속도나 기동력을 판단할 수 없습니다.',
    '집중력이 부족하다고 단정할 수 없습니다.',
    '다음 경기에서는 아군 기절 알림을 확인하고 대응 시점을 점검하세요.',
    '교전 전에 팀과 합류 경로를 확인해 보세요.',
    '다음 경기에서 구출 연막 활용 빈도를 확인해 보세요.',
    '아군 기절 대비 연막 구출률은 비교 평균보다 낮습니다.',
    '집중력을 유지하려면 경기 사이에 휴식을 취해 보세요.',
  ])('keeps facts, limitations and conditional advice: %s', (text) => {
    expect(sanitizeSummaryInferenceText(text)).toBe(text);
  });
  it('preserves the factual sentence when removing inferred mental ability', () => {
    const fact = '1:1 교전 승률은 비교 평균보다 높습니다.';
    expect(sanitizeSummaryInferenceText(`${fact} 탁월한 집중력을 보여줍니다.`)).toBe(fact);
  });
});
