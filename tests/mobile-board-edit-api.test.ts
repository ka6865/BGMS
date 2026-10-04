import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => {
  const read = vi.fn();
  const chain: any = { select: vi.fn(() => chain), eq: vi.fn(() => chain), maybeSingle: read };
  const auth = vi.fn();
  const write = vi.fn();
  return { read, chain, auth, write };
});
vi.mock('@/utils/supabase/guard', () => ({ withAuthGuard: mocks.auth, withOptionalAuth: vi.fn() }));
vi.mock('@supabase/supabase-js', () => ({ createClient: () => ({ from: () => mocks.chain }) }));
vi.mock('@/app/api/posts/write/route', () => ({ POST: mocks.write }));
import { PATCH } from '../app/api/mobile/board/posts/[postId]/route';

describe('mobile member edit preserves unsupported web fields', () => {
  const stored = {
    id: 10, user_id: 'member-a', revision: 2, status: 'published', is_notice: true,
    image_url: 'https://images.example/legacy.jpg', discord_url: 'https://discord.gg/example',
    discord_channel_id: '1234', clan_info: { id: 'clan.example', name: 'BGMS', tag: 'BG', level: 1, memberCount: 5 },
  };
  const request = (body: Record<string, unknown> = {}) => new Request('https://bgms.test/api/mobile/board/posts/10', {
    method: 'PATCH', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ title: '수정 제목', content: '<p>원래 본문</p>', category: '클랜홍보',
      expectedRevision: 2, contentImageIds: [], thumbnailImageId: null, ...body }),
  });
  beforeEach(() => {
    vi.clearAllMocks();
    process.env.NEXT_PUBLIC_SUPABASE_URL = 'https://example.supabase.co';
    mocks.auth.mockResolvedValue({ user: { id: 'member-a' }, supabaseAdmin: { from: () => mocks.chain } });
    mocks.read.mockResolvedValue({ data: stored, error: null });
    mocks.write.mockResolvedValue(new Response('{}', { status: 200 }));
  });
  it('제목 수정은 기존 대표 사진·디스코드·클랜·공지 설정을 그대로 전달한다', async () => {
    const response = await PATCH(request(), { params: Promise.resolve({ postId: '10' }) });
    expect(response.status).toBe(200);
    const forwarded = await mocks.write.mock.calls[0][0].json();
    expect(forwarded).toMatchObject({ image_url: stored.image_url, discord_url: stored.discord_url,
      discord_channel_id: stored.discord_channel_id, clan_info: stored.clan_info, is_notice: true });
  });
  it('새 대표 사진은 기존 URL을 새 관리 이미지 URL로 교체한다', async () => {
    const imageId = '00000000-0000-4000-8000-000000000001';
    const response = await PATCH(request({ thumbnailImageId: imageId }), { params: Promise.resolve({ postId: '10' }) });
    expect(response.status).toBe(200);
    expect((await mocks.write.mock.calls[0][0].json()).image_url)
      .toBe(`https://example.supabase.co/storage/v1/object/public/board-images-v2/${imageId}`);
  });
  it.each([{user_id:'other'}, {revision:3}])('권한 또는 revision 불일치는 저장 전에 거절한다: %j', async (change) => {
    mocks.read.mockResolvedValue({ data: { ...stored, ...change }, error: null });
    const response = await PATCH(request(), { params: Promise.resolve({ postId: '10' }) });
    expect(response.status).toBe('user_id' in change ? 403 : 409);
    expect(mocks.write).not.toHaveBeenCalled();
  });
});
