import { beforeEach, describe, expect, it, vi } from 'vitest';
const mocks = vi.hoisted(() => ({ auth: vi.fn(), role: vi.fn(), from: vi.fn(), rpc: vi.fn(), upsert: vi.fn() }));
vi.mock('@/utils/supabase/guard', () => ({ withAuthGuard: mocks.auth }));
vi.mock('@/lib/admin-agent/logging', () => ({ verifyAdminRole: mocks.role }));
import { GET, POST } from '@/app/api/admin/ai-coaching/cases/route';
import { GET as detail, PATCH } from '@/app/api/admin/ai-coaching/cases/[id]/route';
const id = '00000000-0000-4000-a000-000000000001';
const context = { params: Promise.resolve({ id }) };
const review = { allowed: '관측값', forbidden: '미측정', example: '설명', note: '확인 완료' };
const req = (body: unknown) => new Request('http://localhost/api', { method: 'PATCH', body: JSON.stringify(body) });
beforeEach(() => {
  vi.resetAllMocks();
  mocks.auth.mockResolvedValue({ user: { id: 'actual-admin' }, supabaseAdmin: { from: mocks.from, rpc: mocks.rpc } });
  mocks.role.mockResolvedValue(null);
});
describe('admin-only coaching cases API', () => {
  it('blocks unauthenticated requests before reading data', async () => {
    mocks.auth.mockResolvedValue({ error: new Response(null, { status: 401 }) });
    expect((await GET(new Request('http://localhost/api'))).status).toBe(401);
    expect((await POST()).status).toBe(401);
    expect((await detail(new Request('http://localhost/api'), context)).status).toBe(401);
    expect((await PATCH(req({}), context)).status).toBe(401);
    expect(mocks.from).not.toHaveBeenCalled(); expect(mocks.rpc).not.toHaveBeenCalled();
  });
  it('blocks ordinary members from imports and approvals', async () => {
    mocks.role.mockResolvedValue(new Response(null, { status: 403 }));
    expect((await POST()).status).toBe(403);
    expect((await PATCH(req({}), context)).status).toBe(403);
    expect(mocks.from).not.toHaveBeenCalled(); expect(mocks.rpc).not.toHaveBeenCalled();
  });
  it('imports only built-in drafts and preserves existing decisions on repeat imports', async () => {
    const select = vi.fn().mockResolvedValueOnce({ data: [{ id }], error: null }).mockResolvedValueOnce({ data: [], error: null });
    mocks.upsert.mockReturnValue({ select }); mocks.from.mockReturnValue({ upsert: mocks.upsert });
    expect(await (await POST()).json()).toMatchObject({ imported: 1, available: 15 });
    expect(await (await POST()).json()).toMatchObject({ imported: 0 });
    expect(mocks.upsert).toHaveBeenCalledWith(expect.any(Array), { onConflict: 'source_key', ignoreDuplicates: true, defaultToNull: false });
  });
  it.each(['?page=-1','?page=1.5','?kind=constructor','?status=__proto__'])('rejects invalid filters %s', query => {
    return expect(GET(new Request('http://localhost/api'+query))).resolves.toMatchObject({ status: 400 });
  });
  it('paginates metadata without exposing response bodies in the list', async () => {
    const chain = { select: vi.fn().mockReturnThis(), eq: vi.fn().mockReturnThis(), order: vi.fn().mockReturnThis(), range: vi.fn().mockReturnThis(), then: (resolve: (v: unknown) => unknown) => Promise.resolve({ data: [], count: 0, error: null }).then(resolve) };
    mocks.from.mockReturnValue(chain);
    const response = await GET(new Request('http://localhost/api?page=2&kind=recent&status=pending'));
    expect(response.status).toBe(200);
    expect(response.headers.get('cache-control')).toContain('no-store');
    expect(chain.range).toHaveBeenCalledWith(20,39);
    expect(chain.select.mock.calls[0][0]).not.toContain('original_response');
  });
  it('uses authenticated reviewer identity and exact revision for atomic approval', async () => {
    mocks.rpc.mockResolvedValue({ data: [{ id, revision: 3 }], error: null });
    const response = await PATCH(req({ revision: 2, status: 'approved', review, actor: 'forged-user' }), context);
    expect(response.status).toBe(200);
    expect(mocks.rpc).toHaveBeenCalledWith('review_ai_coaching_case', { p_id: id, p_revision: 2, p_status: 'approved', p_review: review, p_actor: 'actual-admin' });
  });
  it('returns conflict rather than overwriting a newer review', async () => {
    mocks.rpc.mockResolvedValue({ data: [], error: null });
    expect((await PATCH(req({ revision: 0, status: 'approved', review }), context)).status).toBe(409);
  });
  it('rejects incomplete approvals and malformed bodies without writing', async () => {
    expect((await PATCH(req({ revision: 0, status: 'approved', review: { ...review, note: '' } }), context)).status).toBe(400);
    expect((await PATCH(new Request('http://localhost/api', { method: 'PATCH', body: '{' }), context)).status).toBe(400);
    expect(mocks.rpc).not.toHaveBeenCalled();
  });
  it('does not leak database diagnostics to clients', async () => {
    mocks.rpc.mockResolvedValue({ error: { message: 'secret database detail' } });
    const response = await PATCH(req({ revision: 0, status: 'pending', review }), context);
    expect(response.status).toBe(503);
    expect(await response.text()).not.toContain('secret');
  });
});
