import { beforeEach, describe, expect, it, vi } from 'vitest';

const db = vi.hoisted(() => ({
  metadata: vi.fn(),
  detail: vi.fn(),
  comments: vi.fn(),
  createClient: vi.fn(),
}));

vi.mock('@/utils/supabase/server', () => ({ createClient: db.createClient }));
vi.mock('@/components/board/BoardDetailClient', () => ({ default: () => null }));

import PostDetailPage, { generateMetadata } from '@/app/board/[postId]/page';
import { getPostArticleJsonLd } from '@/lib/seo-config';

const post = {
  id: 64, title: '공개 게시글', content: '<p>게시글 본문</p>', category: '자유',
  author: '작성자', created_at: '2026-04-07T00:00:00Z', image_url: null,
  parent_id: null, revision: 1, user_id: null, ip_address: null,
};
const props = (postId = '64') => ({ params: Promise.resolve({ postId }) });
const notFound = { digest: 'NEXT_HTTP_ERROR_FALLBACK;404' };

describe('게시글 조회 실패와 검색 제외 구분', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    vi.spyOn(console, 'error').mockImplementation(() => {});
    db.metadata.mockResolvedValue({ data: post, error: null });
    db.detail.mockResolvedValue({ data: post, error: null });
    db.comments.mockResolvedValue({ data: [], error: null });
    db.createClient.mockResolvedValue({
      from: (table: string) => ({
        select: (fields: string) => ({
          eq: () => {
            const result = fields.includes('profiles(') ? db.detail : db.metadata;
            return table === 'comments'
              ? { order: db.comments }
              : { single: result, maybeSingle: result };
          },
        }),
      }),
    });
  });

  it('정상 글은 정식 주소와 본문을 유지하고 noindex를 붙이지 않는다', async () => {
    const metadata = await generateMetadata(props());
    expect(metadata.robots).toBeUndefined();
    expect(metadata.alternates?.canonical).toMatch(/\/board\/64$/);
    const page = await PostDetailPage(props());
    expect(page.props.children.props.initialPost).toMatchObject(post);
  });

  it('공개 조회에서 글이 없으면 메타데이터와 상세 화면 모두 notFound로 처리한다', async () => {
    db.metadata.mockResolvedValue({ data: null, error: null });
    await expect(generateMetadata(props())).rejects.toMatchObject(notFound);
    await expect(PostDetailPage(props())).rejects.toMatchObject(notFound);
  });

  it.each(['잘못된주소', '1.5', 'Infinity', '-1'])('유효하지 않은 ID %s는 DB를 조회하지 않는다', async (id) => {
    await expect(generateMetadata(props(id))).rejects.toMatchObject(notFound);
    expect(db.createClient).not.toHaveBeenCalled();
  });

  it.each(['08006', '42501', 'PGRST116'])('조회 오류 %s를 없는 글로 바꾸지 않는다', async (code) => {
    const error = { code, message: '게시글 조회 실패' };
    db.metadata.mockResolvedValue({ data: null, error });
    await expect(generateMetadata(props())).rejects.toHaveProperty('cause', error);
    await expect(getPostArticleJsonLd('64')).rejects.toHaveProperty('cause', error);
    await expect(PostDetailPage(props())).rejects.toHaveProperty('cause', error);
  });

  it('네트워크 예외를 noindex 메타데이터로 바꾸지 않는다', async () => {
    const error = new Error('fetch failed');
    db.metadata.mockRejectedValue(error);
    await expect(generateMetadata(props())).rejects.toBe(error);
  });

  it('메타데이터 조회 후 상세 조회가 실패해도 없는 글로 바꾸지 않는다', async () => {
    const error = { code: '08006', message: 'connection failure' };
    db.detail.mockResolvedValue({ data: null, error });
    await expect(PostDetailPage(props())).rejects.toHaveProperty('cause', error);
  });

  it('메타데이터 조회 후 사라진 글도 notFound로 처리한다', async () => {
    db.detail.mockResolvedValue({ data: null, error: null });
    await expect(PostDetailPage(props())).rejects.toMatchObject(notFound);
  });

  it('댓글 조회 실패는 공개 글을 검색에서 제외하지 않고 별도 상태로 전달한다', async () => {
    db.comments.mockResolvedValue({ data: null, error: { code: '08006' } });
    const page = await PostDetailPage(props());
    expect(page.props.children.props.initialCommentsHasError).toBe(true);
    expect(page.props.children.props.initialComments).toEqual([]);
  });
});
