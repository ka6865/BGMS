import { describe, expect, it } from 'vitest';
import { collectAiCoachingQualitySignals, sanitizeAiCoachingLanguage, sanitizeAiCoachingLanguageText } from '../lib/pubg-analysis/aiCoachingQuality';
import { buildBackupCoachingContext, sanitizeBackupCoachingText } from '../lib/pubg-analysis/backupCoaching';
import { applyMatchAiEvidencePolicy } from '../lib/pubg-analysis/matchAiEvidence';
import { applySquadEvidencePolicy } from '../lib/pubg-analysis/squadAiEvidence';

const withheld = '해당 평가는 행동 근거가 부족해 보류합니다.';

describe('coaching judgment regression corpus', () => {
  it.each([
    '소생 소요 시간을 줄여야 한다는 뜻은 아닙니다.',
    '소생 소요 시간을 단축할 필요는 없습니다.',
    '소생 소요 시간을 단축해야 한다는 뜻은 아닙니다.',
    '소생 소요 시간을 단축해서는 안 됩니다.',
    '소생 소요 시간을 줄여서는 안 됩니다.',
    '소생 소요 시간을 줄여야 하는 것은 아닙니다.',
  ])('preserves negated revive-duration advice across fresh and cached policy passes: %s', desc => {
    const input = { actionItems: [{ desc }] };
    const fresh = applyMatchAiEvidencePolicy(JSON.stringify(input), {});
    expect(JSON.parse(fresh)).toEqual(input);
    expect(applyMatchAiEvidencePolicy(fresh, {})).toBe(fresh);
  });

  it('keeps a revive limitation but removes the following unsupported directive', () => {
    const fact = '소생 소요 시간을 줄여야 한다는 뜻은 아닙니다.';
    const input = { actionItems: [{ desc: `${fact} 소생 시간을 단축하세요.` }] };
    const final = JSON.parse(applyMatchAiEvidencePolicy(JSON.stringify(input), {}));
    expect(final.actionItems[0].desc).toContain(fact);
    expect(final.actionItems[0].desc).not.toContain('소생 시간을 단축하세요.');
  });

  it('replaces concentration inferred from duel outcomes with observed match counts', () => {
    const input = { briefFeedback: ['유효 딜량은 374입니다. 1:1 교전 승률 75%와 선제 공격 성공률 60%를 통해 교전 상황에서의 높은 집중력을 보여주셨습니다.'] };
    const match = { duelStats: { wins: 3, totalDuels: 4, duelWinRate: 75 } };
    const final = JSON.parse(applyMatchAiEvidencePolicy(JSON.stringify(input), match));
    expect(final.briefFeedback[0]).toBe('유효 딜량은 374입니다. 관측된 1:1 교전 4회 중 3회 승리했습니다.');
    expect(JSON.parse(applyMatchAiEvidencePolicy(JSON.stringify(final), match))).toEqual(final);
  });

  it('does not manufacture duel facts when rejecting an unmeasured concentration claim', () => {
    const final = JSON.parse(applyMatchAiEvidencePolicy(JSON.stringify({ briefFeedback: ['높은 집중력을 보여주셨습니다.'] }), {}));
    expect(final.briefFeedback[0]).toBe('교전 결과만으로 집중력을 판단할 수 없습니다.');
  });

  it('preserves limitations and conditional concentration advice', () => {
    const input = { briefFeedback: ['높은 승률이 높은 집중력을 의미하지 않습니다.'], actionItems: [{ desc: '다음 교전에서 상대의 움직임에 집중해 보세요.' }] };
    expect(JSON.parse(applyMatchAiEvidencePolicy(JSON.stringify(input), {}))).toEqual(input);
  });

  it('does not turn revenge latency into a measured revive duration', () => {
    const input = { briefFeedback: ['백업 속도는 10.97초이며 소생은 1회입니다.'], actionItems: [{ title: '복구 시간 단축', desc: '성공적인 복구였지만 다음 교전 후에는 소생 소요 시간을 조금 더 줄여보세요.' }] };
    const match = { tradeStats: { revCount: 1, tradeLatencyMs: 10973 } };
    const final = JSON.parse(applyMatchAiEvidencePolicy(JSON.stringify(input), match));
    expect(final.briefFeedback).toEqual(input.briefFeedback);
    expect(final.actionItems[0].desc).toBe('다음 교전에서는 적 제압 후 아군의 상태를 확인하고 소생 가능한 상황인지 점검하세요.');
    expect(JSON.parse(applyMatchAiEvidencePolicy(JSON.stringify(final), match))).toEqual(final);
  });

  it.each([0, null, undefined])('does not infer rescue weakness without opportunities (%s)', (teammateKnocks) => {
    const text = '연막을 활용한 팀원 구출 능력을 보완해야 합니다.';
    const individual = JSON.parse(applyMatchAiEvidencePolicy(JSON.stringify({ briefFeedback: [text] }), { tradeStats: { teammateKnocks, smokeRescues: 0 } }));
    expect(individual.briefFeedback[0]).toContain('보류');
    const team = applySquadEvidencePolicy({ weakness: text }, { totalTeammateKnocks: teammateKnocks, totalSmokeRescues: 0 }, null);
    expect(team.weakness).toContain('보류');
  });

  it('keeps measured zero and practice advice distinct from unavailable rescue rates', () => {
    const input = { briefFeedback: ['연막 구출률은 0%입니다.'], actionItems: [{ desc: '아군이 기절하면 연막 사용이 가능한지 확인해 보세요.' }] };
    const observed = JSON.parse(applyMatchAiEvidencePolicy(JSON.stringify(input), { tradeStats: { teammateKnocks: 3, smokeRescues: 0 } }));
    expect(observed).toEqual(input);
    const unavailable = JSON.parse(applyMatchAiEvidencePolicy(JSON.stringify(input), { tradeStats: { teammateKnocks: 0, smokeRescues: 0 } }));
    expect(unavailable.briefFeedback[0]).toContain('보류');
    expect(unavailable.actionItems).toEqual(input.actionItems);
  });

  it.each([
    '22.4초는 느린 백업이며 방관입니다.',
    '팀원을 방패로 세운 채 혼자 다 해먹는 화력입니다.',
    '팀 딜량 비중 58%는 팀원들의 지원이 부족하다는 방증입니다.',
    '나머지 팀원들의 화력 지원이 전무합니다.',
    '연막 구출 0회라니 연막탄 아껴서 국 끓여 먹을 겁니까?',
  ])('withholds unsupported judgment rather than disguising it: %s', (raw) => {
    const final = sanitizeAiCoachingLanguageText(raw);
    expect(final).toBe(withheld);
    expect(final).not.toMatch(/후속 복구 부족|화력 분담 보완|팀 지원 지표 보완|백업 지연 위험/);
  });

  it.each([
    '백업 속도는 22.4초입니다. 소생은 1회입니다.',
    '연막 구출은 0회입니다.',
    '구출 기회가 관측되지 않아 성공률은 측정할 수 없습니다.',
    '비교 자료가 없어 상대 평가는 보류합니다.',
    '다음 교전에서는 아군이 기절했을 때 연막 사용이 가능한 상황인지 확인해 보세요.',
    '백업 속도는 비교 평균 12초보다 10초 길었습니다.',
    '피해형 투척을 2회 연습해 보세요.',
  ])('keeps factual observations and conditional practice advice: %s', (text) => {
    expect(sanitizeAiCoachingLanguageText(text)).toBe(text);
  });

  it('preserves decimals and adjacent useful sentences when rejecting a claim', () => {
    expect(sanitizeAiCoachingLanguageText('백업 속도는 5.36초입니다. 팀원을 방치했습니다. 다음 교전에서 함께 대응할 위치를 확인해 보세요.'))
      .toBe(`백업 속도는 5.36초입니다. ${withheld} 다음 교전에서 함께 대응할 위치를 확인해 보세요.`);
  });

  it('preserves JSON shape and identity fields, including nested member feedback', () => {
    const input = { name: '방관_Player', evidenceIds: ['team:방관'], memberFeedbacks: [{ name: '방관_Player', fault: '팀원을 방치했습니다.', advice: '다음 교전에서 아군과 함께 대응해 보세요.' }], count: 0 };
    const final = JSON.parse(sanitizeAiCoachingLanguageText(JSON.stringify(input)));
    expect(final).toEqual({ ...input, memberFeedbacks: [{ ...input.memberFeedbacks[0], fault: withheld }] });
    expect(sanitizeAiCoachingLanguage(final)).toEqual(final);
  });

  it('does not let contextual backup cleanup disguise blame before common validation', () => {
    const context = buildBackupCoachingContext({ avgBackupLatency: '22.4s', totalTradeKills: 2, totalRevCount: 1 });
    const final = sanitizeAiCoachingLanguageText(sanitizeBackupCoachingText('소생은 1회입니다. 팀원을 방패로 세운 방관입니다.', context));
    expect(final).toBe(`소생은 1회입니다. ${withheld}`);
  });

  it('keeps original quality failures visible for evaluation', () => {
    const raw = '연막 구출 0회라니 연막탄 아껴서 국 끓여 먹을 겁니까?';
    expect(collectAiCoachingQualitySignals(raw).hasUnsupportedUtilityIntent).toBe(true);
    expect(collectAiCoachingQualitySignals(sanitizeAiCoachingLanguageText(raw)).hasUnsupportedUtilityIntent).toBe(false);
    expect(sanitizeAiCoachingLanguageText(raw)).toBe(withheld);
  });
});
