import { createServer, type Server } from 'node:http';
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import puppeteer, { type Browser, type Page } from 'puppeteer';
import { startOwnedStatsDevServer, type OwnedStatsDevServer } from './helpers/statsBrowserHarness';

const enabled = process.env.RUN_AUDIT_ACCESSIBILITY_BROWSER_SMOKE === 'true';
const viewports = [{ width: 375, height: 667 }, { width: 390, height: 844 }, { width: 430, height: 932 }, { width: 1440, height: 900 }];
const user = { id: '00000000-0000-4000-8000-000000000001', aud: 'authenticated', role: 'authenticated', email: 'fixture@example.invalid', app_metadata: {}, user_metadata: {}, created_at: '2026-01-01T00:00:00Z' };
const faq = { id: 'faq-1', category: 'stats', question: '격리 검증 FAQ', answer: '고객센터 안내', sort_order: 0, is_published: true };
const ticketId = '11111111-1111-4111-8111-111111111111';
const postId = '22222222-2222-4222-8222-222222222222';
const ticket = { id: ticketId, subject: '격리 검증 문의', category: 'other', status: 'answered', verification_status: 'not_required', requester_nickname: '검증 회원', created_at: '2026-01-01T00:00:00Z', updated_at: '2026-01-01T00:00:00Z', messages: [{ id: 'm-1', sender_type: 'admin', body: '답변 내용\n'.repeat(35), created_at: '2026-01-01T00:00:00Z' }], attachments: [] };
const post = { id: postId, title: '키보드로 여는 게시글', author: '검증 회원', user_id: user.id, category: '자유', status: 'published', content: '<p>검증 내용</p>', created_at: '2026-01-01T00:00:00Z', views: 1, likes: 0, is_notice: false, comments: [], profiles: { nickname: '검증 회원', role: 'user' } };

async function waitText(page: Page, text: string) {
  await page.waitForFunction((value) => document.body.innerText.includes(value), { timeout: 20000 }, text);
}

async function checkLayout(page: Page) {
  expect(await page.evaluate(() => document.querySelectorAll('main').length)).toBe(1);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
}

async function tabTo(page: Page, selector: string) {
  await page.waitForSelector(selector);
  await page.evaluate(() => { (document.activeElement as HTMLElement)?.blur(); });
  for (let index = 0; index < 70; index += 1) {
    await page.keyboard.press('Tab');
    if (await page.evaluate((query) => document.activeElement?.matches(query), selector)) return;
  }
  throw new Error('Tab으로 링크에 도달하지 못했습니다: ' + selector);
}

describe.skipIf(!enabled)('점검 7·8 격리 브라우저 검증', () => {
  let stub: Server;
  let server: OwnedStatsDevServer;
  let browser: Browser;
  const unexpected: string[] = [];
  beforeAll(async () => {
    stub = createServer((request, response) => {
      response.setHeader('Access-Control-Allow-Origin', '*');
      response.setHeader('Access-Control-Allow-Headers', '*');
      response.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
      response.setHeader('Content-Type', 'application/json');
      if (request.method === 'OPTIONS') { response.end(); return; }
      const path = new URL(request.url!, 'http://fixture').pathname;
      if (request.method === 'POST' && path === '/rest/v1/rpc/get_pubg_rankings') {
        response.end(JSON.stringify([{ player_id: 'KeyboardPlayer', platform: 'steam', value: 900, secondary: 5, tier: 'A', game_mode: 'squad', map_name: 'Baltic_Main', match_count: 1, played_at: new Date().toISOString() }])); return;
      }
      // 게시글 이동 시 조회수 RPC는 로컬 응답만 반환하고 저장하지 않는다.
      if (request.method === 'POST' && path === '/rest/v1/rpc/increment_views') { response.end('null'); return; }
      if (request.method !== 'GET') { unexpected.push(request.method + ' ' + path); response.writeHead(405); response.end('{}'); return; }
      let value: unknown = [];
      if (path === '/auth/v1/user') value = user;
      else if (path === '/rest/v1/profiles') value = { id: user.id, role: 'admin', nickname: '검증 관리자' };
      else if (path === '/rest/v1/system_settings') value = { value: '[]' };
      else if (path === '/rest/v1/support_faqs') value = [faq];
      else if (path === '/rest/v1/posts') { value = request.headers.accept?.includes('object') ? post : [post]; response.setHeader('Content-Range', '0-0/1'); }
      if (path !== '/auth/v1/user' && !Array.isArray(value) && !request.headers.accept?.includes('object')) value = [value];
      response.end(JSON.stringify(value));
    });
    await new Promise<void>((resolve) => stub.listen(0, '127.0.0.1', resolve));
    const address = stub.address();
    if (!address || typeof address === 'string') throw new Error('fixture 포트 없음');
    vi.stubEnv('NEXT_PUBLIC_SUPABASE_URL', 'http://127.0.0.1:' + address.port);
    vi.stubEnv('NEXT_PUBLIC_SUPABASE_ANON_KEY', 'local-browser-qa-anon-key');
    vi.stubEnv('SUPABASE_SERVICE_ROLE_KEY', 'local-browser-qa-service-key');
    server = await startOwnedStatsDevServer();
    browser = await puppeteer.launch({ headless: true });
    await mkdir(join(process.cwd(), 'tmp', 'audit-accessibility-qa'), { recursive: true });
  }, 180000);
  afterAll(async () => {
    await browser?.close(); await server?.stop();
    await new Promise<void>((resolve) => stub ? stub.close(() => resolve()) : resolve());
    vi.unstubAllEnvs();
  }, 30000);

  it.each(viewports)('키보드 이동·고객센터 본문·하단 접근 $width × $height', async (viewport) => {
    const context = await browser.createBrowserContext();
    const page = await context.newPage();
    let ticketStatus = 200;
    const errors: string[] = [];
    page.on('pageerror', (error) => errors.push(String(error)));
    await page.setViewport(viewport);
    const expiresAt = Math.floor(Date.now() / 1000) + 3600;
    const token = [Buffer.from('{"alg":"HS256","typ":"JWT"}').toString('base64url'), Buffer.from(JSON.stringify({ sub: user.id, aud: 'authenticated', role: 'authenticated', exp: expiresAt })).toString('base64url'), 'fixture-signature'].join('.');
    await context.setCookie({ name: 'sb-127-auth-token', domain: '127.0.0.1', path: '/', value: 'base64-' + Buffer.from(JSON.stringify({ access_token: token, refresh_token: 'fixture-refresh-token', token_type: 'bearer', expires_in: 3600, expires_at: expiresAt, user })).toString('base64url') });
    await page.evaluateOnNewDocument((id) => localStorage.setItem('last_active_tracked_' + id, String(Date.now())), user.id);
    await page.setRequestInterception(true);
    page.on('request', async (request) => {
      if (request.isInterceptResolutionHandled()) return;
      const url = new URL(request.url());
      if (url.origin !== server.baseUrl && url.origin !== process.env.NEXT_PUBLIC_SUPABASE_URL) { await request.abort(); return; }
      if (!url.pathname.startsWith('/api/')) { await request.continue(); return; }
      let result: unknown = {};
      let status = 200;
      if (url.pathname === '/api/admin/support/faqs') result = { faqs: [faq] };
      else if (url.pathname === '/api/admin/support/tickets' || url.pathname === '/api/support/tickets') result = { tickets: [ticket] };
      else if (url.pathname === '/api/admin/support/tickets/' + ticketId) result = { ticket };
      else if (url.pathname === '/api/support/tickets/' + ticketId) { status = ticketStatus; result = status === 200 ? { ticket } : { error: '격리 검증 오류' }; }
      else if (url.pathname.startsWith('/api/pubg/')) { status = 404; result = { error: '격리 검증에서는 외부 전적 조회를 하지 않습니다.' }; }
      else if (url.pathname === '/api/auth/get-profile') result = { profile: { id: user.id, role: 'admin', nickname: '검증 관리자' } };
      else if (url.pathname === '/api/analytics/event') result = { ok: true };
      else if (request.method() !== 'GET') unexpected.push(request.method() + ' ' + url.pathname);
      await request.respond({ status, contentType: 'application/json', body: JSON.stringify(result) });
    });
    try {
      await page.goto(server.baseUrl + '/rankings', { waitUntil: 'domcontentloaded' });
      const rankingLink = 'a[aria-label="KeyboardPlayer 전적 보기"]';
      await tabTo(page, rankingLink);
      expect(await page.$eval(rankingLink, (element) => element.getAttribute('href'))).toBe('/stats/steam/KeyboardPlayer');
      await page.keyboard.press('Enter');
      await page.waitForFunction(() => location.pathname === '/stats/steam/KeyboardPlayer');

      await page.goto(server.baseUrl + '/board', { waitUntil: 'domcontentloaded' });
      const postLink = (viewport.width >= 768 ? 'tr ' : 'li ') + 'a[href="/board/' + postId + '"]';
      await tabTo(page, postLink);
      await page.keyboard.press('Enter');
      await page.waitForFunction((id) => location.pathname === '/board/' + id, {}, postId);

      for (const [path, text] of [['/support', '격리 검증 FAQ'], ['/support/new', '문의 작성'], ['/support/' + ticketId, '격리 검증 문의'], ['/admin/support', 'FAQ 관리'], ['/admin/support/' + ticketId, '관리자 답변']]) {
        await page.goto(server.baseUrl + path, { waitUntil: 'domcontentloaded' }); await waitText(page, text); await checkLayout(page);
        if (path.startsWith('/admin/support')) {
          expect(await page.$eval('main > div', (element) => getComputedStyle(element).overflowY)).toBe('auto');
          const needsScroll = await page.$eval('main > div', (element) => { element.scrollTop = 0; return element.scrollHeight > element.clientHeight; });
          if (needsScroll) {
            await page.mouse.move(viewport.width / 2, viewport.height / 2);
            await page.mouse.wheel({ deltaY: 2000 });
            await page.waitForFunction(() => (document.querySelector('main > div')?.scrollTop || 0) > 0);
          }
          const selector = path === '/admin/support' ? 'textarea[aria-label="FAQ 답변"]' : 'textarea[aria-label="관리자 답변"]';
          await page.$eval(selector, (element) => element.scrollIntoView({ block: 'center' }));
          expect(await page.$eval(selector, (element) => { const box = element.getBoundingClientRect(); return box.top >= 0 && box.bottom <= innerHeight; })).toBe(true);
        }
        await page.screenshot({ path: join(process.cwd(), 'tmp', 'audit-accessibility-qa', path.replaceAll('/', '_') + '-' + viewport.width + '.png') });
      }
      for (const status of [404, 500]) {
        ticketStatus = status;
        await page.goto(server.baseUrl + '/support/' + ticketId, { waitUntil: 'domcontentloaded' });
        await waitText(page, status === 404 ? '문의가 없습니다' : '문의를 불러오지 못했습니다'); await checkLayout(page);
      }
      await context.deleteCookie(...await context.cookies());
      for (const path of ['/admin/support', '/admin/support/' + ticketId]) {
        await page.goto(server.baseUrl + path, { waitUntil: 'domcontentloaded' });
        await page.waitForFunction(() => location.pathname === '/login');
      }
      expect(errors).toEqual([]);
    } finally { await context.close(); }
  }, 180000);
  it('운영 쓰기와 외부 서비스 호출 없이 검증했다', () => { expect(unexpected).toEqual([]); });
});
