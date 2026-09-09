import { NextResponse } from 'next/server';
import { withAuthGuard } from '@/utils/supabase/guard';
import { verifyAdminRole } from '@/lib/admin-agent/logging';
import { parseReviewDecision } from '@/lib/ai-coaching-review/types';

const headers = { 'Cache-Control': 'private, no-store' };
const validId = (id: string) => /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id);
type Context = { params: Promise<{ id: string }> };
export async function GET(_request: Request, context: Context) {
  const auth = await withAuthGuard();
  if (auth.error) return auth.error;
  const denied = await verifyAdminRole(auth.supabaseAdmin, auth.user.id);
  if (denied) return denied;
  const { id } = await context.params;
  if (!validId(id)) return NextResponse.json({ error: '올바른 사례를 선택해 주세요.' }, { status: 400, headers });
  const { data, error } = await auth.supabaseAdmin.from('ai_coaching_review_cases').select('*').eq('id', id).maybeSingle();
  if (error) return NextResponse.json({ error: '사례를 불러오지 못했습니다.' }, { status: 503, headers });
  if (!data) return NextResponse.json({ error: '사례를 찾을 수 없습니다.' }, { status: 404, headers });
  return NextResponse.json({ case: data }, { headers });
}

export async function PATCH(request: Request, context: Context) {
  const auth = await withAuthGuard();
  if (auth.error) return auth.error;
  const denied = await verifyAdminRole(auth.supabaseAdmin, auth.user.id);
  if (denied) return denied;
  const { id } = await context.params;
  if (!validId(id)) return NextResponse.json({ error: '올바른 사례를 선택해 주세요.' }, { status: 400, headers });
  const text = await request.text();
  if (text.length > 30000) return NextResponse.json({ error: '검토 내용이 너무 깁니다.' }, { status: 413, headers });
  let body: unknown;
  try { body = JSON.parse(text); } catch { return NextResponse.json({ error: '검토 내용을 확인해 주세요.' }, { status: 400, headers }); }
  const decision = parseReviewDecision(body);
  if (!decision) return NextResponse.json({ error: '승인에는 모든 기준과 검토 사유가 필요합니다. 보류·제외에는 사유를 적어 주세요.' }, { status: 400, headers });
  const { data, error } = await auth.supabaseAdmin.rpc('review_ai_coaching_case', {
    p_id: id, p_revision: decision.revision, p_status: decision.status,
    p_review: decision.review, p_actor: auth.user.id,
  });
  if (error) return NextResponse.json({ error: '검토를 저장하지 못했습니다. 다시 시도해 주세요.' }, { status: 503, headers });
  if (!data?.length) return NextResponse.json({ error: '다른 검토자가 수정했거나 사례가 삭제됐습니다. 최신 내용을 다시 불러와 주세요.' }, { status: 409, headers });
  return NextResponse.json({ case: data[0] }, { headers });
}
