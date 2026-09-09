import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  get: vi.fn(), notify: vi.fn(), generate: vi.fn(), proposal: vi.fn(), insert: vi.fn(), update: vi.fn(),
  existing: null as null | { id: number; status: string },
  saveError: null as null | { message: string },
  filters: [] as Array<[string, unknown]>,
}));
vi.mock('dotenv', () => ({ config: vi.fn() }));
vi.mock('axios', () => ({ default: { get: mocks.get, post: mocks.notify } }));
vi.mock('@google/generative-ai', () => ({ GoogleGenerativeAI: class {
  getGenerativeModel() { return { generateContent: mocks.generate }; }
} }));
vi.mock('../lib/patch-notes/weaponProposalTrigger', () => ({ triggerWeaponPatchProposal: mocks.proposal }));
vi.mock('@supabase/supabase-js', () => ({ createClient: () => ({ from: (table: string) => {
  if (table === 'sync_history') {
    const q = { select: () => q, eq: () => q, single: async () => ({ data: null, error: null }), upsert: async () => ({ error: null }) };
    return q;
  }
  const q = {
    select: () => q,
    eq: (key: string, value: unknown) => { mocks.filters.push([key, value]); return q; },
    maybeSingle: async () => ({ data: mocks.existing, error: null }),
    single: async () => ({ data: mocks.saveError ? null : { id: 1 }, error: mocks.saveError }),
    insert: mocks.insert,
    update: (value: unknown) => { mocks.update(value); return q; },
  };
  return q;
} }) }));

beforeEach(() => {
  vi.resetModules(); vi.clearAllMocks(); mocks.existing = null; mocks.saveError = null; mocks.filters = [];
  vi.stubEnv('PATCH_NOTES_DRAFT_ONLY', 'true');
  vi.stubEnv('PATCH_NOTES_TARGET_URL', 'https://pubg.com/ko/news/11057');
  vi.stubEnv('GOOGLE_GEMINI_API_KEY', 'fixture');
  vi.stubEnv('DISCORD_WEBHOOK_URL', 'https://example.test/notification');
  mocks.get.mockResolvedValue({ data: '<title>패치 노트 - 업데이트 43.1 - 뉴스 - PUBG: 배틀그라운드</title><article>' + '검증용 패치노트 본문입니다. '.repeat(40) + '</article>' });
  mocks.generate.mockResolvedValue({ response: { text: () => '[변경 사항]\n- ' + '공식 본문의 변경 사항을 요약한 검증용 문장입니다. '.repeat(3) } });
  mocks.insert.mockResolvedValue({ error: null });
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
});
afterEach(() => { process.exitCode = 0; vi.unstubAllEnvs(); vi.restoreAllMocks(); });

describe('patch-note draft-only execution', () => {
  it('saves a draft without weapon proposals or external notifications', async () => {
    const { syncPatchNotes } = await import('../scripts/sync_patch_notes');
    await syncPatchNotes();
    expect(mocks.insert).toHaveBeenCalledWith(expect.objectContaining({ title: '패치 노트 - 업데이트 43.1', status: 'draft' }));
    expect(mocks.update).not.toHaveBeenCalled();
    expect(mocks.proposal).not.toHaveBeenCalled();
    expect(mocks.notify).not.toHaveBeenCalled();
  });
  it('preserves bold text and omits empty bullets between bold section headings', async () => {
    const { formatAiSummaryToHtml } = await import('../scripts/sync_patch_notes');
    const html = formatAiSummaryToHtml('* **[무기]**\n- **LMG 조정**: 반동 변경\n* **[아이템]**\n- **즉시 사용**: 기능 추가');
    expect(html).not.toContain('**');
    expect(html.match(/<li /g)).toHaveLength(2);
    expect(html).toContain('>LMG 조정</strong>');
  });
  it('refuses to overwrite a published post', async () => {
    mocks.existing = { id: 1, status: 'published' };
    const { syncPatchNotes } = await import('../scripts/sync_patch_notes');
    await syncPatchNotes();
    expect(mocks.update).not.toHaveBeenCalled();
    expect(mocks.insert).not.toHaveBeenCalled();
    expect(process.exitCode).toBe(1);
  });
  it('checks draft status again when saving an existing draft', async () => {
    mocks.existing = { id: 1, status: 'draft' };
    mocks.saveError = { message: 'draft was promoted concurrently' };
    const { syncPatchNotes } = await import('../scripts/sync_patch_notes');
    await syncPatchNotes();
    expect(mocks.filters).toContainEqual(['status', 'draft']);
    expect(mocks.insert).not.toHaveBeenCalled();
    expect(mocks.notify).not.toHaveBeenCalled();
    expect(process.exitCode).toBe(1);
  });
});
