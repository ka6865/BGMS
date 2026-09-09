import { NextResponse } from 'next/server';
import { withAuthGuard } from '@/utils/supabase/guard';
import { verifyAdminRole } from '@/lib/admin-agent/logging';
import { ANALYSIS_KIND, REVIEW_STATUS } from '@/lib/ai-coaching-review/types';
import seed from '@/lib/ai-coaching-review/seed.json';

const headers = { 'Cache-Control': 'private, no-store' };
export async function GET(request: Request) {
  const auth = await withAuthGuard();
  if (auth.error) return auth.error;
  const denied = await verifyAdminRole(auth.supabaseAdmin, auth.user.id);
  if (denied) return denied;
  const params = new URL(request.url).searchParams;
  const status = params.get('status') || 'all';
  const kind = params.get('kind') || 'all';
  const page = Number(params.get('page') || 1);
  if ((status !== 'all' && !Object.hasOwn(REVIEW_STATUS, status))
    || (kind !== 'all' && !Object.hasOwn(ANALYSIS_KIND, kind))
    || !Number.isSafeInteger(page) || page < 1 || page > 10000) {
    return NextResponse.json({ error: '조회 조건을 확인해 주세요.' }, { status: 400, headers });
  }
  const db = auth.supabaseAdmin;
  let query = db.from('ai_coaching_review_cases')
    .select('id, analysis_kind, title, issue_type, status, revision, updated_at', { count: 'exact' });
  if (status !== 'all') query = query.eq('status', status);
  if (kind !== 'all') query = query.eq('analysis_kind', kind);
  const statuses = Object.keys(REVIEW_STATUS);
  const [result, ...counts] = await Promise.all([
    query.order('updated_at', { ascending: false }).order('id').range((page - 1) * 20, page * 20 - 1),
    ...statuses.map(value => db.from('ai_coaching_review_cases').select('id', { count: 'exact', head: true }).eq('status', value)),
  ]);
  if (result.error || counts.some(count => count.error)) {
    return NextResponse.json({ error: '사례를 불러오지 못했습니다. 잠시 후 다시 시도해 주세요.' }, { status: 503, headers });
  }
  return NextResponse.json({ cases: result.data, page, pageSize: 20, total: result.count ?? 0,
    counts: Object.fromEntries(statuses.map((value, index) => [value, counts[index].count ?? 0])) }, { headers });
}

export async function POST() {
  const auth = await withAuthGuard();
  if (auth.error) return auth.error;
  const denied = await verifyAdminRole(auth.supabaseAdmin, auth.user.id);
  if (denied) return denied;
  // Only the curated server snapshot is accepted. Reimport never resets reviews.
  const { data, error } = await auth.supabaseAdmin.from('ai_coaching_review_cases')
    .upsert(seed, { onConflict: 'source_key', ignoreDuplicates: true, defaultToNull: false }).select('id');
  if (error) return NextResponse.json({ error: '사례를 가져오지 못했습니다. 잠시 후 다시 시도해 주세요.' }, { status: 503, headers });
  return NextResponse.json({ imported: data?.length ?? 0, available: seed.length }, { headers });
}
