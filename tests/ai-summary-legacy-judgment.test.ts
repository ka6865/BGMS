import { describe, expect, it } from 'vitest';
import {
  hasUnsupportedSummaryAdvice,
  hasUnsupportedSummaryInference,
  sanitizeLegacySummaryJudgment,
  sanitizeSummaryAdviceText,
} from '@/lib/pubg-analysis/aiSummaryJudgment';
import { normalizeAiSummaryDebatePayload } from '@/lib/pubg-analysis/aiSummaryDebate';
import { COACHING_JUDGMENT_WITHHELD } from '@/lib/pubg-analysis/aiCoachingQuality';

const NEXT_ENGAGEMENT_CHECK = '다음 교전 전에 상대 위치와 빠져나올 경로를 확인해 보세요. 팀 모드라면 팀원이 함께 대응할 수 있는지도 확인하세요.';
const THROW_CHECK = '다음 교전에서 투척을 쓸 수 있었던 상황이 있었는지 확인해 보세요.';

// 2026-11-02 실제 Gemini 원문(이전 형식 v1 응답)에서 나온 문장을 그대로 쓴다.
const TEAM_ATTACK = '협공 교전 비중 확대: 아군과 타이밍을 맞춘 집중 타격을 시도하십시오';
const THROW_INCREASE = '공격형 투척 시도를 늘려 교전 압박력을 높이십시오.';
const CONCENTRATION_GAP = '화력 집중력을 보완해야';

const legacyFinal = () => ({
  signature: '화력 기여형 플레이어',
  signatureSub: '관측된 경기 지표와 다음 경기의 점검 과제입니다.',
  finalVerdict: CONCENTRATION_GAP,
  debateIssues: [{
    topicId: 'firepower',
    topic: '전투력',
    question: '화력 기여가 충분한가?',
    kindOpinion: TEAM_ATTACK,
    spicyOpinion: THROW_INCREASE,
    winner: 'draw',
    reason: '관측된 화력 기록을 바탕으로 합니다.',
    evaluation: CONCENTRATION_GAP,
    userStats: [{ label: '평균 화력', value: '320' }],
    benchmarkStats: [{ label: '상위권 평균 화력', value: '300' }],
  }],
  actionItems: [
    { icon: 'target', title: '협공 교전 비중 확대', desc: TEAM_ATTACK },
    { icon: 'target', title: '투척 활용', desc: THROW_INCREASE },
  ],
});

describe('legacy summary judgment policy on real provider text', () => {
  it('replaces the unsupported coordination, throw and concentration claims in every judgment field', () => {
    const result = sanitizeLegacySummaryJudgment(legacyFinal()) as ReturnType<typeof legacyFinal>;
    const serialized = JSON.stringify(result);
    expect(serialized).not.toContain('타이밍을 맞춘');
    expect(serialized).not.toContain('공격형 투척 시도를 늘려');
    expect(serialized).not.toContain('집중력을 보완');
    expect(result.finalVerdict).toBe(COACHING_JUDGMENT_WITHHELD);
    expect(result.debateIssues[0].kindOpinion).toBe('다음 교전 전에 상대 위치와 빠져나올 경로를 확인해 보세요. 팀 모드라면 팀원이 함께 대응할 수 있는지도 확인하세요.');
    expect(result.debateIssues[0].spicyOpinion).toBe('다음 교전에서 투척을 쓸 수 있었던 상황이 있었는지 확인해 보세요.');
    expect(result.debateIssues[0].evaluation).toBe(COACHING_JUDGMENT_WITHHELD);
    expect(result.actionItems.map(item => item.desc)).toEqual([
      '다음 교전 전에 상대 위치와 빠져나올 경로를 확인해 보세요. 팀 모드라면 팀원이 함께 대응할 수 있는지도 확인하세요.',
      '다음 교전에서 투척을 쓸 수 있었던 상황이 있었는지 확인해 보세요.',
    ]);
  });

  it('replaces a short action title that states the unsupported claim with a neutral label', () => {
    const result = sanitizeLegacySummaryJudgment(legacyFinal()) as ReturnType<typeof legacyFinal>;
    expect(result.actionItems[0].title).toBe('다음 교전 점검');
    expect(result.actionItems[1].title).toBe('투척 활용');
  });

  it('keeps identity, numeric evidence and key order untouched', () => {
    const input = legacyFinal();
    const result = sanitizeLegacySummaryJudgment(input) as ReturnType<typeof legacyFinal>;
    expect(Object.keys(result)).toEqual(Object.keys(input));
    expect(result.debateIssues[0].topicId).toBe('firepower');
    expect(result.debateIssues[0].winner).toBe('draw');
    expect(result.debateIssues[0].userStats).toEqual(input.debateIssues[0].userStats);
    expect(result.debateIssues[0].benchmarkStats).toEqual(input.debateIssues[0].benchmarkStats);
    expect(result.signature).toBe(input.signature);
    expect(result.signatureSub).toBe(input.signatureSub);
    expect(result.actionItems[1].title).toBe('투척 활용');
  });

  it('is idempotent across the fresh write and every later cache read', () => {
    const once = sanitizeLegacySummaryJudgment(legacyFinal());
    const twice = sanitizeLegacySummaryJudgment(once);
    const thrice = sanitizeLegacySummaryJudgment(twice);
    expect(twice).toEqual(once);
    expect(thrice).toEqual(once);
  });

  it('replaces an action item whose only description is withheld with the neutral check, so the list is never saved empty', () => {
    const input = { actionItems: [{ icon: 'target', title: '집중력 점검', desc: CONCENTRATION_GAP }] };
    expect(sanitizeLegacySummaryJudgment(input)).toEqual({
      actionItems: [{ icon: 'target', title: '다음 교전 점검', desc: NEXT_ENGAGEMENT_CHECK }],
    });
  });

  it('keeps a legacy final readable after its only action item is withheld (save, then cache read)', () => {
    const raw = {
      signature: '화력 기여형 플레이어',
      signatureSub: '관측된 경기 지표와 다음 경기의 점검 과제입니다.',
      finalVerdict: '관측된 기록을 바탕으로 합니다.',
      debateIssues: [1, 2, 3].map(n => ({
        topic: `주제 ${n}`, question: '질문인가?', kindOpinion: '관측된 기록입니다.', spicyOpinion: '관측된 기록입니다.',
        winner: null, reason: '근거입니다.', evaluation: '평가입니다.', userStats: [], benchmarkStats: [],
      })),
      actionItems: [{ icon: 'target', title: '집중력 점검', desc: '집중력을 높여야 합니다.' }],
    };
    const normalized = normalizeAiSummaryDebatePayload(raw);
    expect(normalized).not.toBeNull();
    // 새 응답 저장 경로: 정규화 뒤 판단 정책을 적용해 JSON으로 저장한다.
    const saved = sanitizeLegacySummaryJudgment(normalized) as Record<string, unknown>;
    expect(saved.actionItems).toEqual([{ icon: 'target', title: '다음 교전 점검', desc: NEXT_ENGAGEMENT_CHECK }]);
    // 캐시 읽기 경로: 저장된 JSON을 다시 정규화할 수 있어야 캐시 미스가 나지 않는다.
    const reread = normalizeAiSummaryDebatePayload(JSON.parse(JSON.stringify(saved)));
    expect(reread).not.toBeNull();
    expect(sanitizeLegacySummaryJudgment(reread)).toEqual(saved);
  });

  it('keeps factual, limited and conditional sentences that the v2 policy already keeps', () => {
    const input = {
      finalVerdict: '평균 화력은 비교 평균보다 높습니다.',
      debateIssues: [{ kindOpinion: '집중력을 유지하려면 경기 사이에 휴식을 취해 보세요.', spicyOpinion: '교전 전에 팀과 합류 경로를 확인해 보세요.', reason: '투척물 사용 횟수만으로 연막과 피해형 투척의 목적을 알 수 없습니다.', evaluation: '팀원이 함께 대응할 수 있다는 점이 확인되면 교전 기회를 늘리세요.' }],
      actionItems: [
        { icon: 'target', title: '합류 경로', desc: '다음 경기에서 아군 기절 상황이 발생하면 연막 구출 가능 여부를 점검하세요.' },
        { icon: 'target', title: '집중력 기준', desc: '집중력을 보완할 필요는 없습니다.' },
      ],
    };
    expect(sanitizeLegacySummaryJudgment(input)).toEqual(input);
  });

  it('passes through values that are not a summary object', () => {
    expect(sanitizeLegacySummaryJudgment(null)).toBeNull();
    expect(sanitizeLegacySummaryJudgment('화력 집중력을 보완해야')).toBe('화력 집중력을 보완해야');
    expect(sanitizeLegacySummaryJudgment(['화력 집중력을 보완해야'])).toEqual(['화력 집중력을 보완해야']);
  });
});

describe('v2 공유 규칙 확장과 오탐 방지 (2026-11-02 후속)', () => {
  it.each([
    '집중력을 높이세요.',
    '집중력을 높이기 위해 휴식을 취하세요.',
    '집중력을 높일 필요가 있습니다.',
    '집중력 향상을 위해 휴식을 취하세요.',
  ])('flags a concentration improvement directive: %s', sentence => {
    expect(hasUnsupportedSummaryInference(sentence)).toBe(true);
  });

  it.each([
    '투척 횟수를 늘리세요.',
    '피해형 투척을 늘리세요.',
    '피해형 투척을 더 많이 던지세요.',
    '공격형 투척을 더 자주 사용하세요.',
    '수류탄을 더 많이 던져 보세요.',
    '유틸리티 사용량을 늘려야 합니다.',
    '투척 명중률을 높여야 합니다.',
    '피해형 투척을 늘리는 것이 필요합니다.',
  ])('flags a throw-usage increase directive: %s', sentence => {
    expect(hasUnsupportedSummaryAdvice(sentence)).toBe(true);
    expect(sanitizeSummaryAdviceText(sentence)).toBe(THROW_CHECK);
  });

  it.each([
    '투척 횟수를 늘리지 마세요.',
    '투척을 늘릴 필요는 없습니다.',
    '피해형 투척을 많이 사용하지 않으세요.',
    '피해형 투척을 사용하지 않아도 됩니다.',
    '피해형 투척을 사용하지 않아 피해를 높이지 못했다.',
    '투척 횟수가 늘었습니다.',
  ])('does not treat a fact or a negated remark as a throw-usage directive: %s', sentence => {
    expect(hasUnsupportedSummaryAdvice(sentence)).toBe(false);
  });

  it.each([
    '집중력을 유지하세요.',
    '집중력 보완 필요성은 이 기록만으로 판단할 수 없습니다.',
    '집중력을 개선할 근거는 관측되지 않았습니다.',
    '집중력 향상 효과는 측정되지 않았습니다.',
    '집중력이 향상된 흔적은 확인되지 않았습니다.',
    '집중력 보완이 필요 없습니다.',
  ])('keeps a concentration limitation or maintenance remark: %s', sentence => {
    expect(hasUnsupportedSummaryInference(sentence)).toBe(false);
  });

  it('applies the shared rules idempotently on the legacy path', () => {
    const once = sanitizeLegacySummaryJudgment(legacyFinal());
    expect(sanitizeLegacySummaryJudgment(once)).toEqual(once);
  });
});
