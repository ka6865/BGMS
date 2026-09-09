// @vitest-environment jsdom
import { createElement } from 'react';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import AICoachingReview from '../components/admin/AICoachingReview';
import seed from '../lib/ai-coaching-review/seed.json';

const row = { ...seed[0], id: '11111111-1111-4111-8111-111111111111', status: 'pending', revision: 0, review_history: [], created_at: '2026-09-08T12:00:00Z', updated_at: '2026-09-08T12:00:00Z' };
const list = { cases: [row], total: 1, page: 1, pageSize: 20, counts: { pending: 1, approved: 0, held: 0, excluded: 0 } };
let fetchMock: ReturnType<typeof vi.fn>;
beforeEach(() => {
  fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
    if (init?.method === 'PATCH') return Response.json({ error: '다른 관리자가 먼저 수정했습니다.' }, { status: 409 });
    return Response.json(url.includes('?') ? list : { case: row });
  });
  vi.stubGlobal('fetch', fetchMock);
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });
async function openCase() {
  render(createElement(AICoachingReview));
  fireEvent.click(await screen.findByRole('button', { name: new RegExp(row.title) }));
  await screen.findByRole('heading', { name: row.title });
}
it('requires all approval fields and preserves the correction on a revision conflict', async () => {
  await openCase();
  const approve = screen.getByRole('button', { name: /^승인$/ }) as HTMLButtonElement;
  expect(approve.disabled).toBe(true);
  fireEvent.change(screen.getByLabelText('검토 사유'), { target: { value: '근거와 수치 확인 완료' } });
  expect(approve.disabled).toBe(false);
  fireEvent.click(approve);
  expect(fetchMock.mock.calls.filter(([, init]) => init?.method === 'PATCH')).toHaveLength(0);
  fireEvent.click(screen.getByRole('button', { name: '확인하고 승인' }));
  await screen.findByRole('alert');
  expect((screen.getByLabelText('검토 사유') as HTMLTextAreaElement).value).toBe('근거와 수치 확인 완료');
  expect(screen.getByRole('button', { name: '최신 내용 다시 불러오기' })).toBeTruthy();
  const save = fetchMock.mock.calls.find(([, init]) => init?.method === 'PATCH')!;
  expect(JSON.parse(save[1]!.body as string)).toMatchObject({ revision: 0, status: 'approved' });
});
it('keeps an unsaved correction when the administrator cancels changing filters', async () => {
  await openCase();
  fireEvent.change(screen.getByLabelText('검토 사유'), { target: { value: '검토 중' } });
  vi.spyOn(window, 'confirm').mockReturnValue(false);
  fireEvent.change(screen.getByLabelText('분석 종류'), { target: { value: 'squad' } });
  expect((screen.getByLabelText('분석 종류') as HTMLSelectElement).value).toBe('all');
  expect((screen.getByLabelText('검토 사유') as HTMLTextAreaElement).value).toBe('검토 중');
});
it('records successful approval and renders the saved history', async () => {
  await openCase();
  fireEvent.change(screen.getByLabelText('검토 사유'), { target: { value: '근거 확인' } });
  const review = { ...row.review, note: '근거 확인' };
  fetchMock.mockImplementation(async (url: string, init?: RequestInit) => Response.json(init?.method === 'PATCH' ? { case: { ...row, review, status: 'approved', revision: 1, review_history: [{ status: 'approved', revision: 1, at: row.updated_at, actor: 'admin', review }] } } : url.includes('?') ? list : { case: row }));
  fireEvent.click(screen.getByRole('button', { name: /^승인$/ }));
  fireEvent.click(screen.getByRole('button', { name: '확인하고 승인' }));
  await waitFor(() => expect(screen.getByRole('status').textContent).toContain('승인됨 상태로 저장'));
  expect(screen.getByText('검토 이력 1건')).toBeTruthy();
  expect(screen.queryByText('저장하지 않은 변경이 있습니다.')).toBeNull();
});
