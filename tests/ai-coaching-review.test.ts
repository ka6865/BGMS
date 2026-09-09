import { describe, expect, it } from 'vitest';
import { parseReviewDecision } from '@/lib/ai-coaching-review/types';
import seed from '@/lib/ai-coaching-review/seed.json';

const review = { allowed: '수치 비교', forbidden: '의도 단정', example: '관측 범위 설명', note: '근거 대조 완료' };
describe('coaching review decision boundary', () => {
  it.each(['pending','approved','held','excluded'])('accepts %s with complete criteria', status => {
    expect(parseReviewDecision({ revision: 0, status, review })).toEqual({ revision: 0, status, review });
  });
  it.each(['__proto__','constructor','unknown',null,1])('rejects invalid status %s', status => {
    expect(parseReviewDecision({ revision: 0, status, review })).toBeNull();
  });
  it.each([-1, 0.5, '0', null, 2147483647, 2147483648])('rejects invalid revision %s', revision => {
    expect(parseReviewDecision({ revision, status: 'approved', review })).toBeNull();
  });
  it.each(['allowed','forbidden','example','note'])('requires %s before approval', field => {
    expect(parseReviewDecision({ revision: 0, status: 'approved', review: { ...review, [field]: '  ' } })).toBeNull();
  });
  it('allows incomplete draft but requires reason for hold/exclusion', () => {
    const incomplete = { allowed: '', forbidden: '', example: '', note: '' };
    expect(parseReviewDecision({ revision: 0, status: 'pending', review: incomplete })).not.toBeNull();
    for (const status of ['held','excluded']) expect(parseReviewDecision({ revision: 0, status, review: incomplete })).toBeNull();
  });
  it('limits text and strips unsupported review keys', () => {
    expect(parseReviewDecision({ revision: 0, status: 'pending', review: { ...review, note: 'x'.repeat(6001) } })).toBeNull();
    expect(parseReviewDecision({ revision: 0, status: 'approved', review: { ...review, actor: 'forged' } })?.review).toEqual(review);
  });
  it('imports 15 real response drafts across all three scopes without auto-approval', () => {
    expect(seed).toHaveLength(15);
    expect(new Set(seed.map(c => c.source_key)).size).toBe(15);
    expect(seed.filter(c => c.analysis_kind === 'single')).toHaveLength(6);
    expect(seed.filter(c => c.analysis_kind === 'recent')).toHaveLength(3);
    expect(seed.filter(c => c.analysis_kind === 'squad')).toHaveLength(6);
    for (const c of seed) {
      expect(c).not.toHaveProperty('status');
      expect(c.review.note).toBe('');
      expect(c.original_response.length).toBeGreaterThan(30);
      expect(c.displayed_response.length).toBeGreaterThan(30);
      expect(c.evidence_text).toContain('분석 범위');
    }
    expect(seed.some(c => c.title.includes('KangHeeSung_'))).toBe(true);
  });
});
