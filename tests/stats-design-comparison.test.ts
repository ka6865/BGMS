import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import puppeteer, { type Browser } from 'puppeteer';
import { createStatsQaClock } from './fixtures/stats/browserScenarios';
import { gotoStatsPage, startOwnedStatsDevServer, withStatsBrowserPage, type OwnedStatsDevServer } from './helpers/statsBrowserHarness';

const enabled = process.env.RUN_STATS_DESIGN_COMPARISON === 'true';
const phase = process.env.STATS_DESIGN_PHASE === 'before' ? 'before' : 'after';
const clock = createStatsQaClock(Date.parse('2026-11-03T00:00:00+09:00'));
const viewports = [{ width: 375, height: 667 }, { width: 390, height: 844 }, { width: 430, height: 932 }, { width: 1440, height: 900 }, { width: 1920, height: 1080 }];

describe.skipIf(!enabled)('전적 검색 디자인 전후 비교', () => {
  let server: OwnedStatsDevServer;
  let browser: Browser;
  const metrics: unknown[] = [];
  const output = join(process.cwd(), 'tmp/stats-design-comparison', phase);

  beforeAll(async () => {
    vi.stubEnv('NEXT_PUBLIC_SUPABASE_URL', 'http://127.0.0.1:59999');
    vi.stubEnv('NEXT_PUBLIC_SUPABASE_ANON_KEY', 'local-browser-qa-anon-key');
    vi.stubEnv('SUPABASE_SERVICE_ROLE_KEY', 'local-browser-qa-service-key');
    await mkdir(output, { recursive: true });
    server = await startOwnedStatsDevServer();
    browser = await puppeteer.launch({ headless: true });
  }, 130000);

  afterAll(async () => {
    if (metrics.length > 0) await writeFile(join(output, 'metrics.json'), JSON.stringify(metrics, null, 2));
    try { await browser?.close(); } finally { await server?.stop(); vi.unstubAllEnvs(); }
  }, 30000);

  for (const viewport of viewports) {
    for (const state of ['landing', 'result'] as const) {
      it(`${state} ${viewport.width}x${viewport.height}`, async () => {
        await withStatsBrowserPage({ browser, baseUrl: server.baseUrl, scenarioName: 'ready', clock, viewport,
          run: async ({ page, dispatcher }) => {
            const errors: string[] = [];
            page.on('pageerror', error => errors.push(String(error)));
            await gotoStatsPage({ dispatcher, page, url: server.baseUrl + (state === 'landing' ? '/stats' : '/stats/steam/ManyMatches') });
            await page.waitForSelector('input[name="nickname"]');
            if (state === 'landing') {
              await page.waitForSelector('[data-testid="stats-landing-feature"]');
            } else {
              await dispatcher.waitForTerminal({ selector: { pathname: '/api/pubg/player', successful: true }, count: 1 });
              await dispatcher.waitForTerminal({ selector: { pathname: '/api/pubg/matches-summary', successful: true }, count: 1 });
              await page.waitForSelector('[data-compact-match-id="match-many-1"]');
              await page.waitForFunction(() => document.querySelector('[aria-label="최근 20경기 요약"]')?.textContent?.includes('16경기') || document.body.innerText.includes('16경기 집계'));
            }
            await page.evaluate(() => document.fonts.ready);
            const evidence = await page.evaluate(() => {
              const rect = (selector: string) => {
                const node = document.querySelector(selector);
                if (!node) return null;
                const box = node.getBoundingClientRect();
                return { top: box.top + scrollY, height: box.height, width: box.width };
              };
              return { overflow: document.documentElement.scrollWidth > innerWidth, pageHeight: document.documentElement.scrollHeight,
                profile: rect('header[aria-label="플레이어 프로필"]'), firstMatch: rect('[data-compact-match-id]'),
                ad: rect('[data-ad-placement="stats-top"]'), inputHeight: rect('input[name="nickname"]')?.height };
            });
            expect(evidence.overflow).toBe(false);
            expect(errors).toEqual([]);
            dispatcher.ledger.assertNoUnexpected();
            dispatcher.ledger.assertNoUnauthenticatedAi();
            const name = `${state}-${viewport.width}x${viewport.height}`;
            await page.screenshot({ path: join(output, name + '-fold.png') });
            await page.screenshot({ path: join(output, name + '-full.png'), fullPage: true });
            metrics.push({ name, viewport, state, phase, ...evidence });
          } });
      }, 90000);
    }
  }

  it.skipIf(phase === 'before')('추천은 방향키로 선택하고 Escape·Tab으로 닫으며 다시 열 수 있다', async () => {
    await withStatsBrowserPage({ browser, baseUrl: server.baseUrl, scenarioName: 'autocomplete-abort', clock,
      viewport: { width: 390, height: 844 }, run: async ({ page, dispatcher }) => {
        await gotoStatsPage({ dispatcher, page, url: server.baseUrl + '/stats' });
        await page.waitForSelector('input[name="nickname"]');
        expect(await page.$eval('input[name="nickname"]', node => node.getAttribute('role'))).toBe('combobox');
        // shortcut: 기존 하네스처럼 React 입력 연결을 기다리며, 공개 hydration 신호가 생기면 교체한다.
        await page.waitForFunction(() => {
          const input = document.querySelector<HTMLInputElement>('input[name="nickname"]');
          return input && Object.keys(input).some(key => key.startsWith('__reactProps$') && typeof Reflect.get(input, key)?.onChange === 'function');
        });
        await page.type('input[name="nickname"]', 'Latest');
        await page.waitForSelector('[role="listbox"] [role="option"]');
        await page.keyboard.press('ArrowDown');
        expect(await page.$eval('input[name="nickname"]', node => node.getAttribute('aria-activedescendant'))).toBeTruthy();
        await page.screenshot({ path: join(output, 'search-keyboard-390x844.png') });
        await page.keyboard.press('Escape');
        await page.waitForSelector('[role="listbox"]', { hidden: true });
        expect(await page.$eval('input[name="nickname"]', node => (node as HTMLInputElement).value)).toBe('Latest');
        await page.keyboard.press('ArrowDown');
        await page.waitForSelector('[role="listbox"]');
        await page.keyboard.press('Tab');
        await page.waitForSelector('[role="listbox"]', { hidden: true });
        expect(dispatcher.ledger.count({ pathname: '/api/pubg/player' })).toBe(0);
        dispatcher.ledger.assertNoUnexpected();
      } });
  }, 60000);

  it.skipIf(phase === 'before')('모바일의 주요 지표·첫 매치가 앞당겨지고 상세 지표는 펼쳐볼 수 있다', async () => {
    const baseline = JSON.parse(await readFile(join(process.cwd(), 'tmp/stats-design-comparison/before/metrics.json'), 'utf8')) as Array<{ name: string; profile: { height: number }; firstMatch: { top: number } }>;
    await withStatsBrowserPage({ browser, baseUrl: server.baseUrl, scenarioName: 'ready', clock,
      viewport: { width: 375, height: 667 }, run: async ({ page, dispatcher }) => {
        await gotoStatsPage({ dispatcher, page, url: server.baseUrl + '/stats/steam/ManyMatches' });
        await dispatcher.waitForTerminal({ selector: { pathname: '/api/pubg/matches-summary', successful: true }, count: 1 });
        await page.waitForSelector('[data-compact-match-id="match-many-1"]');
        const old = baseline.find(item => item.name === 'result-375x667')!;
        const compact = await page.evaluate(() => ({
          profileHeight: document.querySelector('header[aria-label="플레이어 프로필"]')!.getBoundingClientRect().height,
          firstMatchTop: document.querySelector('[data-compact-match-id]')!.getBoundingClientRect().top + scrollY,
          topAdCount: document.querySelectorAll('[data-ad-placement="stats-top"]').length,
        }));
        expect(compact.profileHeight).toBeLessThan(old.profile.height);
        expect(compact.firstMatchTop).toBeLessThan(old.firstMatch.top);
        expect(compact.topAdCount).toBe(1);
        const details = 'header[aria-label="플레이어 프로필"] details';
        expect(await page.$eval(details, node => (node as HTMLDetailsElement).open)).toBe(false);
        await page.click(details + ' > summary');
        expect(await page.$eval(details, node => (node as HTMLDetailsElement).open)).toBe(true);
        await page.waitForFunction(() => document.body.innerText.includes('Lv.441'));
        await page.screenshot({ path: join(output, 'season-details-375x667.png'), fullPage: true });
        dispatcher.ledger.assertNoUnexpected();
        dispatcher.ledger.assertNoUnauthenticatedAi();
      } });
  }, 60000);
});
