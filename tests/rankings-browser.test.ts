import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import puppeteer, { type Browser } from 'puppeteer';
import { startOwnedStatsDevServer, type OwnedStatsDevServer } from './helpers/statsBrowserHarness';

const enabled = process.env.RUN_RANKINGS_BROWSER_SMOKE === 'true';
const viewports = [{ width: 375, height: 667 }, { width: 390, height: 844 }, { width: 430, height: 932 }, { width: 1440, height: 900 }];

describe.skipIf(!enabled)('검색 계정 랭킹 브라우저', () => {
  let server: OwnedStatsDevServer;
  let browser: Browser;

  beforeAll(async () => {
    vi.stubEnv('NEXT_PUBLIC_SUPABASE_URL', 'http://127.0.0.1:59999');
    vi.stubEnv('NEXT_PUBLIC_SUPABASE_ANON_KEY', 'local-browser-qa-anon-key');
    vi.stubEnv('SUPABASE_SERVICE_ROLE_KEY', 'local-browser-qa-service-key');
    server = await startOwnedStatsDevServer();
    browser = await puppeteer.launch({ headless: true });
    await mkdir(join(process.cwd(), 'tmp/rankings-searched-qa'), { recursive: true });
  }, 120000);

  afterAll(async () => {
    await browser?.close();
    await server?.stop();
    vi.unstubAllEnvs();
  }, 30000);

  for (const viewport of viewports) {
    it(`${viewport.width}x${viewport.height}: 참가 기준, 필터, 빈 목록과 오류`, async () => {
      const context = await browser.createBrowserContext();
      const page = await context.newPage();
      const errors: string[] = [];
      page.on('pageerror', error => errors.push(String(error)));
      let state: 'success' | 'empty' | 'error' | 'pending' = 'success';
      const queries: string[] = [];
      try {
        await page.setViewport(viewport);
        await page.setRequestInterception(true);
        page.on('request', async request => {
          if (request.isInterceptResolutionHandled()) return;
          const url = new URL(request.url());
          if (url.origin !== server.baseUrl) { await request.abort(); return; }
          if (url.pathname !== '/api/rankings') { await request.continue(); return; }
          queries.push(url.search);
          await request.respond({ status: state === 'error' ? 503 : state === 'pending' ? 202 : 200, contentType: 'application/json', body: JSON.stringify(
            state === 'error' ? { error: 'fixture error' } : state === 'pending' ? { pending: true, entries: [] } : {
              entries: state === 'empty' ? [] : [{ rank: 1, platform: 'steam', playerId: 'SearchedPlayer', nickname: 'SearchedPlayer', value: 1234, secondary: 8, gameMode: '스쿼드', mapName: '에란겔' }],
              generatedAt: '2026-11-02T00:00:00Z', period: { start: '2026-10-25T15:00:00Z', end: '2026-11-01T15:00:00Z', finalized: true },
            }) });
        });
        await page.goto(`${server.baseUrl}/rankings`, { waitUntil: 'domcontentloaded' });
        const waitText = (text: string) => page.waitForFunction(value => document.body.innerText.includes(value), { timeout: 20000 }, text);
        await waitText('SearchedPlayer');
        expect(await page.evaluate(() => document.body.innerText.includes('BGMS에서 전적을 조회한 이력이 있는 계정'))).toBe(true);
        expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
        expect(queries.length).toBeGreaterThan(0);
        expect(queries.every(query => new URLSearchParams(query).get('tab') === 'damage')).toBe(true);
        await page.screenshot({ path: join(process.cwd(), `tmp/rankings-searched-qa/${viewport.width}.png`), fullPage: true });
        const click = async (label: string) => {
          await page.evaluate(value => {
            const button = Array.from(document.querySelectorAll('button')).find(item => item.textContent?.trim() === value || item.getAttribute('aria-label') === value);
            if (!button) throw new Error('Missing button: ' + value);
            button.click();
          }, label);
        };
        expect(await page.$$eval('button', buttons => buttons.some(button => button.textContent?.trim() === '새로고침'))).toBe(false);
        state = 'pending';
        await click('지난주 킬');
        await waitText('집계 시각: 집계 중');
        await waitText('잠시 후 자동으로 다시 불러옵니다.');
        await page.screenshot({ path: join(process.cwd(), `tmp/rankings-searched-qa/${viewport.width}-pending.png`), fullPage: true });
        state = 'empty';
        await waitText('이번 주 데이터가 없습니다');
        expect(queries.at(-1)).toContain('tab=kills');
        state = 'error';
        await click('스쿼드');
        await waitText('다시 시도');
        expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
        state = 'success';
        await click('다시 시도');
        await waitText('SearchedPlayer');
        expect(errors).toEqual([]);
      } finally {
        await context.close();
      }
    }, 90000);
  }
});
