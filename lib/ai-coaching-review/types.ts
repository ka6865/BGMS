export const REVIEW_STATUS = { pending: '검토 대기', approved: '승인됨', held: '보류', excluded: '제외' } as const;
export const ANALYSIS_KIND = { single: '개별 경기', recent: '최근 10경기', squad: '스쿼드' } as const;
export type ReviewStatus = keyof typeof REVIEW_STATUS;
export type AnalysisKind = keyof typeof ANALYSIS_KIND;
export interface ReviewDraft {
  allowed: string;
  forbidden: string;
  example: string;
  note: string;
}
export interface ReviewEvent {
  status: ReviewStatus;
  revision: number;
  at: string;
  actor: string;
  review: ReviewDraft;
}
export interface CoachingCase {
  id: string;
  source_key: string;
  analysis_kind: AnalysisKind;
  title: string;
  issue_type: string;
  source_label: string;
  evidence_text: string;
  original_response: string;
  displayed_response: string;
  review: ReviewDraft;
  status: ReviewStatus;
  revision: number;
  review_history: ReviewEvent[];
  created_at: string;
  updated_at: string;
}
export type CaseSummary = Pick<CoachingCase, 'id' | 'analysis_kind' | 'title' | 'issue_type' | 'status' | 'revision' | 'updated_at'>;
export interface CaseList {
  cases: CaseSummary[];
  total: number;
  page: number;
  pageSize: number;
  counts: Record<ReviewStatus, number>;
}

export function parseReviewDecision(value: unknown): { revision: number; status: ReviewStatus; review: ReviewDraft } | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const body = value as Record<string, unknown>;
  if (!Number.isSafeInteger(body.revision) || Number(body.revision) < 0 || Number(body.revision) >= 2147483647 || (typeof body.status !== 'string' || !Object.hasOwn(REVIEW_STATUS, body.status))) return null;
  const review = body.review as Record<string, unknown> | undefined;
  if (!review || typeof review !== 'object' || Array.isArray(review)) return null;
  const fields = ['allowed', 'forbidden', 'example', 'note'] as const;
  if (fields.some(key => typeof review[key] !== 'string' || (review[key] as string).length > 6000)) return null;
  const clean = Object.fromEntries(fields.map(key => [key, (review[key] as string).trim()])) as unknown as ReviewDraft;
  if (body.status === 'approved' && fields.some(key => !clean[key])) return null;
  if ((body.status === 'held' || body.status === 'excluded') && !clean.note) return null;
  return { revision: Number(body.revision), status: body.status as ReviewStatus, review: clean };
}
