import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createServer, type Server } from "node:http";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { createRequire } from "node:module";
import { build } from "esbuild";
import postcss from "postcss";
import tailwind from "@tailwindcss/postcss";
import puppeteer, { type Browser, type Page } from "puppeteer";

import { fixtureResult, matches } from "./fixtures/lol/browserScenario";
import { LOL_MATCH_PAGE_SIZE } from "../lib/lol/limits";

describe.skipIf(process.env.RUN_LOL_DEV_BROWSER !== "true")(
  "LoL 검색 반응형 브라우저 확인 — 가상 fixture",
  { timeout: 30_000 },
  () => {
    let server: Server;
    let browser: Browser;
    let baseUrl: string;
    let holdRefresh: ((send: () => void) => void) | undefined;
    let buildRequests = 0;
    const collectionRequests: Array<{ riotId: string; count: number; startOffset: number; confirm: boolean }> = [];
    const navigationFixture = `
      import { useMemo, useSyncExternalStore } from 'react';
      const event = 'lol-fixture-navigation';
      function subscribe(listener) {
        window.addEventListener(event, listener);
        window.addEventListener('popstate', listener);
        return () => {
          window.removeEventListener(event, listener);
          window.removeEventListener('popstate', listener);
        };
      }
      function useLocation() {
        return useSyncExternalStore(subscribe, () => location.pathname + location.search, () => '/admin/lol');
      }
      export function usePathname() { return useLocation().split('?')[0]; }
      export function useSearchParams() {
        const path = useLocation();
        return useMemo(() => new URLSearchParams(path.includes('?') ? path.slice(path.indexOf('?')) : ''), [path]);
      }
      const router = {
        push(path) { history.pushState(null, '', path); window.dispatchEvent(new Event(event)); },
        replace(path) { history.replaceState(null, '', path); window.dispatchEvent(new Event(event)); }
      };
      export function useRouter() { return router; }
    `;

    beforeAll(async () => {
      const serverBundle = await build({
        stdin: {
          contents: `
            import React from 'react';
            import { renderToString } from 'react-dom/server';
            import Layout from './app/admin/lol/layout';
            import Page from './app/admin/lol/page';
            import RiotIdPage from './app/admin/lol/kr/[riotId]/page';
            export async function render(path = '/admin/lol') {
              const pathname = new URL(path, 'http://fixture').pathname;
              const page = pathname.startsWith('/admin/lol/kr/')
                ? await RiotIdPage({ params: Promise.resolve({ riotId: decodeURIComponent(pathname.slice('/admin/lol/kr/'.length)) }) })
                : await Page();
              const layout = await Layout({ children: page });
              const body = renderToString(
                <div id="lol-shell" style={{ height: 'calc(100dvh - 56px)', overflow: 'hidden' }}>
                  <div id="lol-root" style={{ height: '100%' }}>{layout}</div>
                </div>,
              );
              return '<!doctype html><html lang="ko"><head><meta charset="utf-8" />'
                + '<meta name="viewport" content="width=device-width,initial-scale=1" />'
                + '<link rel="stylesheet" href="/style.css" /></head><body>'
                + body + '<script defer src="/app.js"></script></body></html>';
            }
          `,
          resolveDir: process.cwd(),
          loader: "tsx",
        },
        bundle: true,
        write: false,
        platform: "node",
        format: "cjs",
        jsx: "automatic",
        tsconfig: "tsconfig.json",
        plugins: [
          {
            name: "fixture-guard",
            setup(builder) {
              builder.onResolve({ filter: /^next\/navigation$/ }, () => ({ path: "navigation", namespace: "fixture-navigation" }));
              builder.onLoad({ filter: /.*/, namespace: "fixture-navigation" }, () => ({
                contents: `exports.useRouter=()=>({push(){},replace(){}});
                  exports.usePathname=()=>'/admin/lol'; exports.useSearchParams=()=>new URLSearchParams();`,
                loader: "js",
              }));
              builder.onResolve({ filter: /^@\/components\/lol\/LolStatusBanner$/ }, () => ({ path: "banner", namespace: "fixture-banner" }));
              builder.onLoad({ filter: /.*/, namespace: "fixture-banner" }, () => ({ contents: "export default () => null;", loader: "js" }));
              builder.onResolve(
                { filter: /^@\/lib\/lol\/access\.server$/ },
                () => ({ path: "guard", namespace: "fixture" }),
              );
              builder.onLoad({ filter: /.*/, namespace: "fixture" }, () => ({
                contents: "exports.requireLolDevPageAdmin=async()=>undefined",
                loader: "js",
              }));
            },
          },
        ],
      });
      const fixtureModule = {
        exports: {} as { render?: (path?: string) => Promise<string> },
      };
      new Function(
        "require",
        "module",
        "exports",
        serverBundle.outputFiles[0].text,
      )(createRequire(import.meta.url), fixtureModule, fixtureModule.exports);
      const html = await fixtureModule.exports.render!();

      const clientBundle = await build({
        stdin: {
          contents: `
            import React from 'react';
            import { hydrateRoot } from 'react-dom/client';
            import { usePathname } from 'next/navigation';
            import { parseLolRiotIdSegment, LOL_RIOT_ID_ERROR } from './lib/lol/riotId';
            import LolSearchPanel from './components/lol/LolSearchPanel';
            import LolOpsPanel from './components/lol/LolOpsPanel';
            function FixturePage() {
              React.useEffect(() => { document.documentElement.dataset.lolFixtureHydrated = 'true'; }, []);
              const path = usePathname();
              const segment = path.startsWith('/admin/lol/kr/') ? path.slice('/admin/lol/kr/'.length) : undefined;
              const riotId = segment === undefined ? undefined : parseLolRiotIdSegment(segment);
              return <LolSearchPanel adminTools={<LolOpsPanel />} initialRiotId={riotId ?? undefined} initialError={riotId === null ? LOL_RIOT_ID_ERROR : undefined} />;
            }
            hydrateRoot(document.getElementById('lol-root'), <React.StrictMode><FixturePage /></React.StrictMode>);
          `,
          resolveDir: process.cwd(),
          loader: "tsx",
        },
        bundle: true,
        write: false,
        platform: "browser",
        format: "iife",
        jsx: "automatic",
        tsconfig: "tsconfig.json",
        plugins: [{
          name: "fixture-navigation",
          setup(builder) {
            builder.onResolve({ filter: /^next\/navigation$/ }, () => ({ path: "navigation", namespace: "fixture-navigation" }));
            builder.onLoad({ filter: /.*/, namespace: "fixture-navigation" }, () => ({
              contents: navigationFixture, loader: "js", resolveDir: process.cwd(),
            }));
          },
        }],
      });
      const css = await postcss([tailwind()]).process(
        await readFile("app/globals.css", "utf8"),
        { from: join(process.cwd(), "app/globals.css") },
      );

      const failedMoreAccounts = new Set<string>();
      const failedSearchAccounts = new Set<string>();
      server = createServer((request, response) => {
        if (request.url?.startsWith("/lol/ranked-emblems/")) {
          response.writeHead(404).end();
          return;
        }
        if (request.url === "/api/admin/lol/collect" && request.method === "POST") {
          let body = "";
          request.on("data", (chunk) => { body += chunk; });
          request.on("end", () => {
            const input = JSON.parse(body);
            collectionRequests.push(input);
            const processed = Math.min(input.count, 20);
            setTimeout(() => response.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify({
              requested: input.count, fetched: processed + 1, reused: 0, failed: 0, aggregated: processed, skipped: 0,
              processed, nextOffset: input.startOffset + processed, hasMore: true, durationMs: 250,
            })), 250);
          });
          return;
        }
        if (request.url === "/api/admin/lol/operations") {
          const counts = { cache_rows: 2, match_rows: 1, account_rows: 0, lease_rows: 0 };
          response.writeHead(200, { "Content-Type": "application/json" });
          if (request.method === "POST") {
            let body = "";
            request.on("data", (chunk) => { body += chunk; });
            request.on("end", () => {
              response.end(JSON.stringify(JSON.parse(body).action === "account-preview" ? { riotId: JSON.parse(body).riotId }
                : JSON.parse(body).action === "account-delete" ? { account_rows: 1, history_rows: 3, summary_rows: 5 }
                : JSON.parse(body).action === "preview" ? counts : { deleted: counts, remaining: counts }));
            });
          } else response.end(JSON.stringify({
            enabled: true, today: "2026-10-23", todayRiotCalls: 15, cooldownActive: true, keyNeedsAttention: true,
            lastLadderSnapshotAt: "2026-10-23T20:19:00Z",
            metrics: [{ day: "2026-10-23", metric: "riot_key_error", value: 1 }],
            rateLimits: [{ host: "global", budgetDay: "2026-10-23", usedCount: 17, blockedUntil: null }],
            tables: [{ table: "lol_player_match_summaries", rows: 1000, totalBytes: 819200 }], pending: counts,
            benchmarks: { processed: 120, skipped: 3 },
          }));
          return;
        }
        if (request.url === "/style.css") {
          response.writeHead(200, { "Content-Type": "text/css" }).end(css.css);
          return;
        }
        if (request.url === "/app.js") {
          response
            .writeHead(200, { "Content-Type": "text/javascript" })
            .end(clientBundle.outputFiles[0].text);
          return;
        }
        if (
          request.url === "/api/admin/lol/search" &&
          request.method === "POST"
        ) {
          let body = "";
          request.setEncoding("utf8");
          request.on("data", (chunk) => {
            body += chunk;
          });
          request.on("end", () => {
            const requestBody = JSON.parse(body) as { riotId: string; refresh?: boolean };
            const riotId = requestBody.riotId;
            if (riotId.startsWith("searchretry#") && !failedSearchAccounts.has(riotId)) {
              failedSearchAccounts.add(riotId);
              response.writeHead(503, { "Content-Type": "application/json" })
                .end(JSON.stringify({ error: "LoL 저장소를 사용할 수 없습니다." }));
              return;
            }
            if (requestBody.refresh && riotId.startsWith("cooldown#")) {
              response.writeHead(200, { "Content-Type": "application/json" })
                .end(JSON.stringify({ status: "cooldown", remainSeconds: 37, lastUpdatedAt: new Date().toISOString() }));
              return;
            }
            const makeResult = () => structuredClone({
              ...fixtureResult,
              challengeProfile: riotId.startsWith("challengefail#") ? { ...fixtureResult.challengeProfile, status: "failed" }
                : riotId.startsWith("challengeempty#") ? { ...fixtureResult.challengeProfile, rarest: [], distributionStatus: "unavailable" }
                  : fixtureResult.challengeProfile,
              recentTrends: riotId.startsWith("challengeempty#") ? undefined : fixtureResult.recentTrends,
              mastery: riotId.startsWith("masteryfail#") ? { ...fixtureResult.mastery, status: "failed", champions: [] }
                : riotId.startsWith("masteryempty#") ? { ...fixtureResult.mastery, champions: [], recent: { status: "ready", sampleSize: 0, champions: [] } }
                  : fixtureResult.mastery,
              ranked: riotId.startsWith("unrank#")
                ? fixtureResult.ranked.filter((rank) => rank.queueType === "RANKED_SOLO_5x5")
                : fixtureResult.ranked,
              account: {
                gameName: riotId.split("#")[0],
                tagLine: riotId.split("#")[1],
              },
              lastUpdatedAt: new Date().toISOString(),
              refreshRemainSeconds: /^(cooldown|refresh(?:short)?)#/.test(riotId) ? 0 : 120,
              matchIds: riotId.startsWith("refreshshort#") ? fixtureResult.matchIds.slice(0, 7) : fixtureResult.matchIds,
              matchFailures: riotId.startsWith("retry#") ? [
                { matchId: "FAIL_RIOT", kind: "riot_rate_limited", retryAfterSeconds: 17 },
                { matchId: "FAIL_BGMS", kind: "bgms_busy" },
              ] : [],
            });
            if (riotId.startsWith("restricted#")) {
              response.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify({ ...makeResult(),
                matches: [], matchStatus: "failed", hasMore: false, matchFailures: [
                  { matchId: "KR_991", kind: "invalid_match" }, { matchId: "KR_992", kind: "restricted_match" },
                ],
              }));
              return;
            }
            if (requestBody.refresh && /^refresh(?:short)?#/.test(riotId)) {
              const refreshed = makeResult();
              refreshed.matches = [{ ...structuredClone(matches[0]), matchId: "NEW_1" }, ...refreshed.matches.slice(0, 4)];
              refreshed.matchIds = ["NEW_1", ...refreshed.matchIds.slice(0, 19)];
              const sendRefresh = () => { response.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify(refreshed)); };
              if (holdRefresh) { const receive = holdRefresh; holdRefresh = undefined; receive(sendRefresh); }
              else setTimeout(sendRefresh, 250);
              return;
            }
            const send = () =>
              response
                .writeHead(200, {
                  "Content-Type": "application/json",
                  "Cache-Control": "no-store",
                })
                .end(JSON.stringify(makeResult()));
            if (riotId.startsWith("identity#")) {
              const identity = makeResult();
              for (const match of identity.matches) {
                for (const team of match.details.teams) {
                  for (const player of team.participants) {
                    if (player.riotId === "blue0#KR1") player.riotId = riotId;
                    Object.assign(player, { playerKey: `key-${player.riotId}`, ref: `fixture-${player.riotId.split("#")[0]}` });
                  }
                }
              }
              response.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify(identity));
            } else if (riotId.startsWith("slow#")) setTimeout(send, 300);
            else if (riotId.startsWith("missing#")) {
              const missing = makeResult();
              Object.assign(missing.matches[0], {
                kills: null,
                deaths: null,
                assists: null,
                cs: null,
                csPerMinute: null,
                details: undefined,
              });
              response
                .writeHead(200, { "Content-Type": "application/json" })
                .end(JSON.stringify(missing));
            } else if (riotId.startsWith("perfect#")) {
              const perfect = makeResult();
              for (const match of perfect.matches) match.deaths = 0;
              for (const summary of Object.values(perfect.summaries)) {
                summary.averageKda = null;
                summary.perfect = true;
                for (const champion of summary.champions) {
                  champion.averageKda = null;
                  champion.perfect = true;
                }
              }
              response.writeHead(200, { "Content-Type": "application/json" })
                .end(JSON.stringify(perfect));
            } else if (riotId.startsWith("legacy#")) {
              const legacy = makeResult();
              Reflect.deleteProperty(legacy, "rankedHistory");
              for (const match of legacy.matches) {
                for (const field of ["killParticipationPct", "csPerMinute", "goldPerMinute", "kills"])
                  Reflect.deleteProperty(match, field);
                for (const team of match.details.teams)
                  for (const player of team.participants)
                    for (const field of ["spells", "runes", "items", "killParticipationPct"])
                      Reflect.deleteProperty(player, field);
              }
              for (const summary of Object.values(legacy.summaries))
                for (const field of [
                  "positions", "teammates", "averageKda", "perfect", "wins", "losses",
                  "averageKills", "averageDeaths", "averageAssists", "averageKillParticipationPct",
                ])
                  Reflect.deleteProperty(summary, field);
              response.writeHead(200, { "Content-Type": "application/json" })
                .end(JSON.stringify(legacy));
            } else send();
          });
          return;
        }
        if (/^\/api\/admin\/lol\/matches\/[^/]+\/build$/.test(request.url ?? "")) {
          buildRequests += 1;
          response.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify({
            matchId: "FIXTURE_1",
            players: matches[0].details!.teams.flatMap((team) => team.participants.map((player) => ({
              teamId: team.teamId, championId: player.championId,
              items: [{ minute: 0, items: [1055, 2003] }, { minute: 9, items: [3031] }], skills: [1, 3, 1, 2, 1, 4],
            }))),
          }));
          return;
        }
        if (request.url === "/api/admin/lol/matches/more" && request.method === "POST") {
          let body = "";
          request.setEncoding("utf8");
          request.on("data", (chunk) => { body += chunk; });
          request.on("end", () => {
            const { riotId, offset, matchIds: retryIds } = JSON.parse(body) as { riotId: string; offset: number; matchIds?: string[] };
            // 실제 경로와 같은 경기 ID 개수 한도를 적용해, 화면과 서버 계약이 어긋나면 이 테스트가 잡게 한다.
            if (retryIds !== undefined && (retryIds.length < 1 || retryIds.length > LOL_MATCH_PAGE_SIZE)) {
              response.writeHead(400, { "Content-Type": "application/json" })
                .end(JSON.stringify({ error: "Riot ID 또는 경기 목록 위치를 확인해 주세요." }));
              return;
            }
            if (riotId.startsWith("storage#") && !failedMoreAccounts.has(riotId)) {
              failedMoreAccounts.add(riotId);
              response.writeHead(503, { "Content-Type": "application/json" })
                .end(JSON.stringify({ error: "LoL 저장소를 사용할 수 없습니다." }));
              return;
            }
            if (riotId.startsWith("quota#")) {
              response.writeHead(429, { "Content-Type": "application/json", "Retry-After": "17" })
                .end(JSON.stringify({ error: "Riot API 요청 한도에 도달했습니다." }));
              return;
            }
            const selected = retryIds ?? Array.from({ length: 5 }, (_, index) => `MORE_${offset + index + 1}`);
            const next = selected.map((matchId) => ({ ...structuredClone(matches[0]), matchId }));
            response.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify({
              matches: next,
              matchIds: retryIds ?? Array.from({ length: 20 }, (_, index) => `MORE_${offset + index + 1}`),
              loadedCount: offset + selected.length,
              hasMore: true,
              matchFailures: [],
            }));
          });
          return;
        }
        void fixtureModule.exports.render!(request.url ?? "/admin/lol").then((body) => {
          response.writeHead(200, { "Content-Type": "text/html" }).end(body);
        });
      });

      await new Promise<void>((resolve) =>
        server.listen(0, "127.0.0.1", resolve),
      );
      const address = server.address();
      if (!address || typeof address === "string")
        throw new Error("fixture 포트 생성 실패");
      baseUrl = `http://127.0.0.1:${address.port}`;
      browser = await puppeteer.launch({ headless: true });
      await mkdir("tmp/lol-detail-alignment", { recursive: true });
      await writeFile("tmp/lol-detail-alignment/rendered.html", html);
    }, 90_000);

    afterAll(async () => {
      await browser?.close();
      if (server)
        await new Promise<void>((resolve) => server.close(() => resolve()));
    }, 30_000);

    async function openPage(viewport = { width: 390, height: 844 }) {
      const page = await browser.newPage();
      page.setDefaultTimeout(10_000);
      page.setDefaultNavigationTimeout(30_000);
      await page.setViewport(viewport);
      await page.setRequestInterception(true);
      page.on("request", (request) => {
        const url = request.url();
        if (url.startsWith(`${baseUrl}/`)) void request.continue();
        else if (url.includes("ddragon")) {
          void request.respond({
            status: 200,
            contentType: "image/svg+xml",
            body: '<svg xmlns="http://www.w3.org/2000/svg" />',
          });
        } else void request.abort();
      });
      await page.goto(baseUrl, { waitUntil: "domcontentloaded" });
      await page.waitForSelector("#lol-riot-id");
      await page.waitForFunction(() => document.documentElement.dataset.lolFixtureHydrated === "true");
      return page;
    }

    async function search(page: Page, riotId = "BLUE0#kr1") {
      await page.type("#lol-riot-id", riotId);
      await page.click('form button[type="submit"]');
      await page.waitForSelector('section[aria-label="최근 경기"] article');
    }

    async function clickButtonText(page: Page, text: string) {
      await page.$$eval("button", (buttons, label) => {
        const button = buttons.find((item) => item.textContent?.includes(label));
        if (!button) throw new Error(`버튼을 찾을 수 없습니다: ${label}`);
        (button as HTMLButtonElement).click();
      }, text);
    }

    // lg 미만에서는 전적과 통계를 탭으로 나눠 보여 주므로, 보이는 탭이 있을 때만 바꾼다.
    async function showView(page: Page, view: "matches" | "stats") {
      await page.$eval(`#lol-view-${view}-tab`, (tab) => {
        if (getComputedStyle(tab.parentElement!).display !== "none") (tab as HTMLButtonElement).click();
      });
      await page.waitForFunction((id) => {
        const panel = document.getElementById(id);
        return !!panel && getComputedStyle(panel).display !== "none";
      }, {}, `lol-view-${view}`);
    }

    async function openFirstDetail(page: Page) {
      const button =
        'section[aria-label="최근 경기"] [data-testid="lol-match-card"] button[aria-controls]';
      await page.waitForSelector(button);
      await page.waitForFunction(
        () => document.querySelector("h1")?.textContent === "LoL 전적 검색",
      );
      await new Promise((resolve) => setTimeout(resolve, 150));
      for (let attempt = 0; attempt < 20; attempt += 1) {
        await page.$eval(button, (element) =>
          (element as HTMLButtonElement).click(),
        );
        const opened = await page.evaluate(
          (selector) =>
            document.querySelector(selector)?.getAttribute("aria-expanded") ===
            "true",
          button,
        );
        if (opened) break;
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
      await page.waitForFunction(
        (selector) =>
          document.querySelector(selector)?.getAttribute("aria-expanded") ===
          "true",
        {},
        button,
      );
      await page.waitForSelector('[data-testid="lol-player-row"]');
    }

    it.each([
      { width: 375, height: 667 },
      { width: 390, height: 844 },
      { width: 430, height: 932 },
      { width: 1024, height: 900 },
      { width: 1440, height: 900 },
    ])(
      "검색·요약·상세가 $width × $height에서 잘리지 않는다",
      async (viewport) => {
        const page = await openPage(viewport);
        const errors: string[] = [];
        const apiCalls: string[] = [];
        page.on("pageerror", (error) => errors.push(String(error)));
        page.on("request", (request) => {
          if (request.url().startsWith(`${baseUrl}/api/`)) {
            apiCalls.push(request.url());
          }
        });
        await search(page);
        expect(await page.$eval('[data-testid="lol-challenge-profile"]', element => element.textContent)).toContain("상위 0.3%");
        expect(await page.$eval('[data-testid="lol-challenge-profile"]', element => element.textContent)).toContain("칭호 매핑 미확인");
        expect(await page.$eval('[data-testid="lol-recent-trends"]', element => element.textContent)).toContain("최근 9경기");
        const mobile = viewport.width < 1024;
        if (mobile) {
          // 전적 탭이 기본이며 통계는 숨겨져 첫 경기 카드가 빨리 보인다.
          expect(await page.$eval('[data-testid="lol-sidebar-stats"]', (aside) => getComputedStyle(aside).display)).toBe("none");
          await showView(page, "stats");
          expect(await page.$eval('[data-testid="lol-history"]', (section) => section.getBoundingClientRect().height)).toBe(0);
        }
        const mastery = await page.$('[data-testid="lol-mastery"]');
        expect(mastery).not.toBeNull();
        const masteryText = await mastery!.evaluate(element => element.textContent ?? "");
        for (const text of ["챔피언 숙련도와 최근 성과", "250,000", "BGMS에 저장된 최근 9경기 기준", "주력", "떠오르는 챔피언"])
          expect(masteryText).toContain(text);
        const masteryBounds = await mastery!.boundingBox();
        expect(masteryBounds!.x + masteryBounds!.width).toBeLessThanOrEqual(viewport.width);
        await page.screenshot({ path: `tmp/lol-detail-alignment/layout-${viewport.width}x${viewport.height}.png`, fullPage: true });
        if (mobile) await showView(page, "matches");
        const columns = await page.evaluate(() => {
          const bounds = (selector: string) => {
            const rect = document.querySelector(selector)!.getBoundingClientRect();
            return { x: rect.x, y: rect.y, right: rect.right, bottom: rect.bottom };
          };
          return {
            ranks: bounds('[data-testid="lol-ranks"]'),
            stats: bounds('[data-testid="lol-sidebar-stats"]'),
            history: bounds('[data-testid="lol-history"]'),
            champions: bounds('[aria-label="최근 챔피언"]'),
            teammates: bounds('[aria-label="함께 플레이한 소환사"]'),
            summary: bounds('[data-testid="lol-summary-header"]'),
          };
        });
        if (viewport.width >= 1024) {
          expect(columns.ranks.right).toBeLessThan(columns.history.x);
          expect(columns.stats.right).toBeLessThan(columns.history.x);
          expect(columns.ranks.x).toBe(columns.stats.x);
          expect(columns.ranks.y).toBe(columns.history.y);
          expect(columns.champions.right).toBeLessThan(columns.history.x);
          expect(columns.teammates.right).toBeLessThan(columns.summary.x);
          const metricCenters = await page.$$eval('[data-testid="lol-summary-metrics"] > div', (metrics) =>
            metrics.map((metric) => {
              const bounds = metric.getBoundingClientRect();
              return bounds.y + bounds.height / 2;
            }),
          );
          expect(Math.max(...metricCenters) - Math.min(...metricCenters)).toBeLessThanOrEqual(1);
        } else {
          expect(columns.ranks.bottom).toBeLessThanOrEqual(columns.history.y);
          expect(columns.stats.bottom - columns.stats.y).toBe(0);
          // 모바일 랭크 카드는 두 큐를 나란히 두고, 그래프는 접어 둔다.
          expect(await page.$$eval('[data-testid="lol-ranked-graph"]', (graphs) =>
            graphs.every((graph) => graph.getBoundingClientRect().height === 0))).toBe(true);
          const rankCards = await page.$$eval('[data-testid="lol-ranks"] > div', (cards) =>
            cards.map((card) => card.getBoundingClientRect().y));
          expect(rankCards[0]).toBe(rankCards[1]);
        }

        expect(await page.$eval("h1", (element) => element.textContent)).toBe(
          "LoL 전적 검색",
        );
        expect(
          await page.$eval(
            'section[aria-label="랭크"]',
            (element) => element.textContent,
          ),
        ).toMatch(/솔로 랭크[\s\S]*자유 랭크/);
        await page.waitForFunction(() =>
          document.querySelectorAll('[data-testid="lol-tier-badge"]').length === 2,
        );
        const rankText = await page.$eval('[data-testid="lol-ranks"]', (section) => section.textContent);
        expect(rankText).toContain("이번 시즌 18게임 · 솔로 랭크 한정");
        expect(rankText).toContain("이번 시즌 18게임 · 자유 랭크 한정");
        expect(rankText).toContain("최고 티어(BGMS 기록): 플래티넘 4 · 20 LP");
        expect(rankText).toContain("기록 시작 2026-10-22");
        expect(await page.$$eval('[data-testid="lol-tier-badge"]', (badges) =>
          badges.map((badge) => badge.textContent?.trim()),
        )).toEqual(["플래티넘 4", "골드 2"]);
        expect(await page.$$eval('[aria-label="솔로 랭크 최근 30일 티어 그래프"]', (charts) => charts.length)).toBe(1);
        expect(await page.$$eval('[aria-label="자유 랭크 최근 30일 티어 그래프"]', (charts) => charts.length)).toBe(1);
        const graphLabelsFit = await page.$$eval('[data-testid="lol-ranked-graph"] svg', (charts) => charts.every((chart) => {
          const bounds = chart.getBoundingClientRect();
          return [...chart.querySelectorAll("text")].every((label) => {
            const rect = label.getBoundingClientRect();
            return rect.left >= bounds.left && rect.right <= bounds.right;
          });
        }));
        expect(graphLabelsFit).toBe(true);
        expect(await page.$eval('[aria-label="솔로 랭크 최근 30일 티어 그래프"] polyline', (line) => line.getAttribute("points")))
          .toMatch(/^[-.\d]+,[-.\d]+ [-.\d]+,[-.\d]+$/);
        expect(
          await page.$eval(
            'section[aria-label="검색 결과"]',
            (element) => element.textContent,
          ),
        ).toContain("함께 플레이한 소환사");
        expect(
          await page.$eval(
            '[aria-label="포지션별 경기 수"]',
            (element) => element.textContent,
          ),
        ).toContain("탑");
        const resultText = await page.$eval('[data-testid="lol-summary-header"]', (section) => section.textContent);
        expect(resultText).not.toContain("경기 기준");
        expect(await page.$eval('[data-testid="lol-summary-metrics"]', (metrics) => metrics.textContent))
          .toContain("8.75:1");
        expect(await page.$eval('[aria-label="챔피언별 최근 통계"]', (list) => list.textContent))
          .toContain("10.50:1");
        expect(
          await page.$eval('[data-testid="lol-match-player-groups"]', (list) =>
            getComputedStyle(list).display !== "none"
              ? list.querySelectorAll('[data-testid="lol-match-player"]').length
              : 0,
          ),
        ).toBe(mobile ? 0 : 10);

        const cardLayout = await page.$eval('[data-testid="lol-match-card"]', (card) => {
          const bounds = card.getBoundingClientRect();
          const metrics = [...card.querySelectorAll<HTMLElement>('[data-testid="lol-match-metric"]')];
          const slots = [...card.querySelectorAll('[data-testid="lol-match-items"] [data-testid="lol-player-item-slot"]')];
          const parts = [
            card.querySelector('[data-testid="lol-match-metrics"]'),
            card.querySelector('[data-testid="lol-match-player-groups"]'),
          ];
          return {
            metrics: metrics.map((element) => ({
              text: element.textContent,
              height: element.getBoundingClientRect().height,
              lineHeight: Number.parseFloat(getComputedStyle(element).lineHeight),
            })),
            slots: slots.map((slot) => {
              const rect = slot.getBoundingClientRect();
              return rect.width > 0 && rect.height > 0 &&
                rect.left >= bounds.left && rect.right <= bounds.right &&
                rect.top >= bounds.top && rect.bottom <= bounds.bottom;
            }),
            parts: parts.map((part) => part!.getBoundingClientRect().y + part!.getBoundingClientRect().height / 2),
          };
        });
        expect(cardLayout.metrics.map((metric) => metric.text?.trim())).toEqual([
          "관여 40%", "CS 180 (7.2/분)", "골드/분 480",
        ]);
        // 경기별 LP 증감은 결과(승리·패배) 옆에 붙고, 값이 없는 판은 결과만 보인다.
        expect(await page.$$eval('[data-testid="lol-match-card"]', (cards) =>
          cards.map((card) => card.querySelector('[data-testid="lol-lp-change"]')?.textContent ?? null)))
          .toEqual(["+20 LP", "강등", null, null, null]);
        for (const metric of cardLayout.metrics)
          expect(metric.height).toBeLessThanOrEqual(metric.lineHeight + 1);
        expect(cardLayout.slots).toEqual(Array(7).fill(true));
        if (viewport.width >= 1440)
          expect(Math.max(...cardLayout.parts) - Math.min(...cardLayout.parts)).toBeLessThanOrEqual(1);
        const card = await page.$('[data-testid="lol-match-card"]');
        const summaryHeader = await page.$('[data-testid="lol-summary-header"]');
        if (viewport.width >= 1024) {
          await page.$eval('main', (main) => main.scrollTo({ top: 400 }));
          await page.screenshot({ path: `tmp/lol-detail-alignment/sidebar-${viewport.width}x${viewport.height}.png`, fullPage: true });
        }
        await summaryHeader!.screenshot({ path: `tmp/lol-detail-alignment/summary-${viewport.width}x${viewport.height}.png` });
        await card!.screenshot({ path: `tmp/lol-detail-alignment/card-${viewport.width}x${viewport.height}.png` });

        await openFirstDetail(page);
        expect(await page.$eval('[data-testid="lol-match-insights"]', element => element.textContent)).toContain("시야 점수");
        // 좁은 상세 표에서도 피해량 막대 라벨이 잘리지 않고 보이고, 넓은 표는 열 제목 행으로 설명한다.
        if (viewport.width >= 1440) {
          const header = await page.$eval('[data-testid="lol-player-table-header"]', (row) => ({
            display: getComputedStyle(row).display, text: row.textContent ?? "",
          }));
          expect(header.display).toBe("grid");
          for (const label of ["BGMS 점수", "KDA", "피해량", "와드", "CS", "아이템"]) expect(header.text).toContain(label);
          // 머리글과 모든 행의 열 시작 위치가 같아 이름 길이와 관계없이 열이 맞는다.
          const starts = await page.$eval('[role="table"][aria-label$="참가자 상세"]', (table) =>
            [...table.querySelectorAll('[role="row"]')].map((row) =>
              [...row.querySelectorAll(':scope > [role="columnheader"], :scope > [role="cell"], :scope > div > [role="cell"]')]
                .filter((cell) => getComputedStyle(cell).display !== "none")
                .map((cell) => Math.round(cell.getBoundingClientRect().right))));
          const [headerEdges, ...rowEdges] = starts;
          expect(headerEdges.slice(-6)).toHaveLength(6);
          for (const edges of rowEdges) expect(edges.slice(-6)).toEqual(headerEdges.slice(-6));
        } else {
          expect(await page.$eval('[data-testid="lol-player-row"]', (row) =>
            [...row.querySelectorAll<HTMLElement>('[aria-label^="챔피언 피해"] span, [aria-label^="받은 피해"] span')]
              .filter((span) => span.getBoundingClientRect().width > 0 && span.scrollWidth <= span.clientWidth + 1)
              .map((span) => span.textContent).join(" "))).toMatch(/가한 .*받은 /);
        }
        const teamLabels = await page.$$eval(
          '[aria-label$="참가자 상세"]',
          (sections) =>
            sections.map((section) => section.getAttribute("aria-label")),
        );
        expect(teamLabels[0]).toContain("블루팀");
        expect(teamLabels[1]).toContain("레드팀");
        expect(
          await page.$$eval(
            'section[aria-label="최근 경기"] > div > article:first-child [data-testid="lol-player-row"]',
            (rows) => rows.length,
          ),
        ).toBe(10);
        expect(
          await page.$eval(
            'section[aria-label="블루팀 · 패배"] [data-testid="lol-player-row"]',
            (row) => row.className,
          ),
        ).toContain("bg-amber-400/10");
        expect(
          await page.$$eval('[aria-label$="아이템"]', (lists) =>
            lists.every((list) => list.children.length === 7),
          ),
        ).toBe(true);
        expect(
          await page.$eval(
            'section[aria-label="최근 경기"]',
            (section) => section.textContent,
          ),
        ).toContain("Perfect");
        expect(
          await page.$eval(
            '[aria-label="블루팀 · 패배"]',
            (section) => section.textContent,
          ),
        ).toContain("7.00:1");

        const finalSlot = await page.$eval(
          'section[aria-label="블루팀 · 패배"] [data-testid="lol-player-row"]',
          (row) => {
            const slots = row.querySelectorAll(
              '[data-testid="lol-player-item-slot"]',
            );
            const slot = slots[slots.length - 1];
            const bounds = slot.getBoundingClientRect();
            const container = row.getBoundingClientRect();
            return {
              left: bounds.left,
              right: bounds.right,
              width: bounds.width,
              edge: container.right,
            };
          },
        );
        expect(finalSlot.width).toBeGreaterThan(0);
        expect(finalSlot.left).toBeGreaterThanOrEqual(0);
        expect(finalSlot.right).toBeLessThanOrEqual(finalSlot.edge + 1);

        const bounds = await page.evaluate(() => ({
          viewport: innerWidth,
          document: document.documentElement.scrollWidth,
          panel: (document.querySelector("#lol-root > main") as HTMLElement)
            .scrollWidth,
          client: (document.querySelector("#lol-root > main") as HTMLElement)
            .clientWidth,
        }));
        expect(bounds.document).toBeLessThanOrEqual(bounds.viewport);
        expect(bounds.panel).toBeLessThanOrEqual(bounds.client);
        expect(errors).toEqual([]);
        // 상세를 펼치며 목록 끝까지 스크롤되면 추가 조회가 이어질 수 있다.
        expect(apiCalls.filter((url) => url !== `${baseUrl}/api/admin/lol/matches/more`))
          .toEqual([`${baseUrl}/api/admin/lol/search`]);
        await page.screenshot({
          path: `tmp/lol-detail-alignment/${viewport.width}x${viewport.height}.png`,
          fullPage: true,
        });
        if (mobile) await showView(page, "stats");
        await mastery!.screenshot({ path: `tmp/lol-detail-alignment/mastery-${viewport.width}x${viewport.height}.png` });
        const challengeCard = await page.$('[data-testid="lol-challenge-profile"]');
        await challengeCard!.screenshot({ path: `tmp/lol-detail-alignment/challenges-${viewport.width}x${viewport.height}.png` });
        await page.close();
      },
      30_000,
    );

    it.each([{ width: 375, height: 667 }, { width: 390, height: 844 }, { width: 430, height: 932 }, { width: 1440, height: 900 }])(
      "숙련도 빈 상태·실패 안내가 $width 폭에서 전적을 보존한다", async viewport => {
        for (const [name, message] of [["masteryfail#FIX", "숙련도 정보를 불러오지 못했습니다"], ["masteryempty#FIX", "숙련도 기록이 없습니다"]]) {
          const page = await openPage(viewport); await search(page, name);
          const text = await page.$eval('[data-testid="lol-mastery"]', element => element.textContent ?? "");
          expect(text).toContain(message);
          expect(await page.$('section[aria-label="최근 경기"] article')).not.toBeNull();
          expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
          await page.close();
        }
      },
    );

    it.each([{ width: 375, height: 667 }, { width: 390, height: 844 }, { width: 430, height: 932 }, { width: 1440, height: 900 }])(
      "도전과제 실패·분포 누락과 표본 부족이 $width 폭에서 전적을 보존한다", async viewport => {
        for (const [name, message] of [["challengefail#FIX", "도전과제 정보를 불러오지 못했습니다"], ["challengeempty#FIX", "분포 정보를 확인할 수 없습니다"]]) {
          const page = await openPage(viewport); await search(page, name);
          const text = await page.$eval('[data-testid="lol-challenge-profile"]', element => element.textContent ?? "");
          expect(text).toContain(message);
          if (name.startsWith("challengeempty")) expect(await page.$('[data-testid="lol-recent-trends"]')).toBeNull();
          expect(await page.$('section[aria-label="최근 경기"] article')).not.toBeNull();
          expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
          await page.close();
        }
      },
    );

    it("Riot ID URL은 새로고침·뒤로·앞으로 이동에서 대상과 큐를 복원한다", async () => {
      const page = await openPage();
      let searches = 0;
      page.on("request", (request) => {
        if (request.url() === `${baseUrl}/api/admin/lol/search`) searches += 1;
      });
      await search(page, "강 희-성#5955");
      expect(page.url()).toBe(`${baseUrl}/admin/lol/kr/${encodeURIComponent("강 희-성-5955")}`);
      const historyLength = await page.evaluate(() => history.length);
      await page.select('select[aria-label="큐 필터"]', "flex");
      await page.waitForFunction(() => location.search === "?queue=flex");
      expect(await page.evaluate(() => history.length)).toBe(historyLength);
      expect(searches).toBe(1);
      await page.reload({ waitUntil: "domcontentloaded" });
      await page.waitForFunction(() => document.querySelector("h2")?.textContent === "강 희-성#5955");
      expect(await page.$eval('select[aria-label="큐 필터"]', (select) => (select as HTMLSelectElement).value)).toBe("flex");
      expect(await page.$$eval('[data-testid="lol-match-card"]', (cards) => cards.length)).toBe(2);
      await page.$$eval('[data-testid="lol-match-player"]', (buttons) => {
        (buttons.find((button) => button.textContent?.trim() === "blue1#KR1") as HTMLButtonElement).click();
      });
      await page.waitForFunction(() => document.querySelector("h2")?.textContent === "blue1#KR1");
      expect(page.url()).toBe(`${baseUrl}/admin/lol/kr/blue1-KR1?queue=flex`);
      await page.goBack();
      await page.waitForFunction(() => document.querySelector("h2")?.textContent === "강 희-성#5955");
      expect(new URL(page.url()).searchParams.get("queue")).toBe("flex");
      await page.goForward();
      await page.waitForFunction(() => document.querySelector("h2")?.textContent === "blue1#KR1");
      expect(searches).toBe(5);
      await page.close();
    });

    it("함께 플레이 이름도 URL로 이동하고 잘못된 주소는 API 호출 없이 오류를 표시한다", async () => {
      const page = await openPage();
      await search(page, "blue0#KR1");
      await showView(page, "stats");
      await page.click('[aria-label="함께 플레이한 소환사"] [data-testid="lol-peer"] button');
      await page.waitForFunction(() => document.querySelector("h2")?.textContent === "blue1#KR1");
      expect(page.url()).toBe(`${baseUrl}/admin/lol/kr/blue1-KR1`);
      // 다른 소환사로 이동하면 모바일 보기는 전적 탭으로 돌아간다.
      expect(await page.$eval("#lol-view-matches-tab", (tab) => tab.getAttribute("aria-selected"))).toBe("true");
      let searches = 0;
      page.on("request", (request) => { if (request.url().includes("/api/admin/lol/search")) searches += 1; });
      await page.goto(`${baseUrl}/admin/lol/kr/invalid`, { waitUntil: "domcontentloaded" });
      await page.waitForSelector('[role="alert"]');
      expect(await page.$eval('[role="alert"]', (alert) => alert.textContent)).toContain("주소는 이름-태그");
      expect(searches).toBe(0);
      await page.close();
    });

    it.each(["card", "detail", "sidebar"] as const)("%s 이름은 ref가 있으면 봉인된 경로로 이동한다", async (entry) => {
      const page = await openPage({ width: 1440, height: 900 });
      await search(page, "identity#KR1");
      if (entry === "detail") await openFirstDetail(page);
      const selector = entry === "card" ? '[data-testid="lol-match-player"]'
        : entry === "detail" ? '[data-testid="lol-player-row"] button' : '[aria-label="함께 플레이한 소환사"] [data-testid="lol-peer"] button';
      await page.$$eval(selector, (buttons) => {
        const button = buttons.find((item) => item.textContent?.trim() === "blue1#KR1");
        if (!button) throw new Error("참가자 버튼을 찾을 수 없습니다");
        (button as HTMLButtonElement).click();
      });
      await page.waitForFunction(() => location.pathname === "/admin/lol/kr/by-ref/fixture-blue1");
      expect(page.url()).toBe(`${baseUrl}/admin/lol/kr/by-ref/fixture-blue1`);
      await page.close();
    });

    it("같은 Riot ID URL의 검색 실패도 검색 버튼으로 재시도한다", async () => {
      const page = await openPage();
      let searches = 0;
      page.on("request", (request) => { if (request.url().includes("/api/admin/lol/search")) searches += 1; });
      await page.type("#lol-riot-id", "searchretry#kr1");
      await page.click('form button[type="submit"]');
      await page.waitForSelector('[role="alert"]');
      const path = page.url();
      await page.click('form button[type="submit"]');
      await page.waitForFunction(() => document.querySelector("h2")?.textContent === "searchretry#kr1");
      expect(page.url()).toBe(path);
      expect(searches).toBe(2);
      await page.close();
    });

    it("느린 이전 검색 응답이 최신 결과를 덮지 않는다", async () => {
      const page = await openPage();
      await page.type("#lol-riot-id", "slow#kr1");
      await page.click('form button[type="submit"]');
      await page.click("#lol-riot-id");
      await page.keyboard.down("Control");
      await page.keyboard.press("A");
      await page.keyboard.up("Control");
      await page.$eval("#lol-riot-id", (element) => {
        const input = element as HTMLInputElement;
        const setValue = Object.getOwnPropertyDescriptor(
          HTMLInputElement.prototype,
          "value",
        )?.set;
        setValue?.call(input, "fast#kr1");
        input.dispatchEvent(new Event("input", { bubbles: true }));
      });
      expect(
        await page.$eval(
          "#lol-riot-id",
          (input) => (input as HTMLInputElement).value,
        ),
      ).toBe("fast#kr1");
      await page.click('form button[type="submit"]');
      await page.waitForFunction(
        () => document.querySelector("h2")?.textContent === "fast#kr1",
      );
      await new Promise((resolve) => setTimeout(resolve, 350));
      expect(await page.$eval("h2", (element) => element.textContent)).toBe(
        "fast#kr1",
      );
      await page.close();
    });

    it("커스텀·제한 경기는 실패 카드와 재시도 대신 숨긴 개수만 표시한다", async () => {
      const page = await openPage();
      await page.type("#lol-riot-id", "restricted#FIX");
      await page.click('form button[type="submit"]');
      await page.waitForFunction(() => document.body.textContent?.includes("표시하지 않는 경기 2개"));
      const text = await page.$eval("body", element => element.textContent ?? "");
      expect(text).toContain("표시하지 않는 경기 2개");
      expect(text).not.toContain("최근 경기 정보를 가져오지 못했습니다");
      expect(await page.$$('[data-testid="lol-match-failure"]')).toHaveLength(0);
      expect(await page.$$('[data-testid="lol-match-card"]')).toHaveLength(0);
      await page.close();
    });

    it("결측 기록은 미제공 상태로 표시한다", async () => {
      const page = await openPage();
      await search(page, "missing#kr1");
      expect(
        await page.$eval(
          'section[aria-label="최근 경기"] article',
          (card) => card.textContent,
        ),
      ).toContain("미제공");
      await page.close();
    });

    it("큐 필터는 요약과 카드를 함께 바꾸고 이름 클릭은 재검색한다", async () => {
      const page = await openPage({ width: 1440, height: 900 });
      const apiCalls: string[] = [];
      page.on("request", (request) => {
        if (request.url().startsWith(`${baseUrl}/api/`)) apiCalls.push(request.url());
      });
      await search(page);
      for (const [filter, count, queueLabel] of [
        ["solo", 2, "솔로 랭크"], ["flex", 2, "자유 랭크"],
        ["aram", 1, "무작위 총력전"], ["all", 5, ""],
      ] as const) {
        await page.select('select[aria-label="큐 필터"]', filter);
        await page.waitForFunction((expected) =>
          document.querySelectorAll('[data-testid="lol-match-card"]').length === expected,
        {}, count);
        const championText = await page.$eval('[aria-label="챔피언별 최근 통계"]', (list) => list.textContent);
        expect(championText).toContain(filter === "flex" ? "가렌" : "아리");
        if (filter === "solo" || filter === "aram") expect(championText).not.toContain("가렌");
        if (filter === "flex") expect(championText).not.toContain("아리");
        if (filter === "all") expect(championText).toMatch(/아리[\s\S]*3전[\s\S]*가렌[\s\S]*2전/);
        const sectionText = await page.$eval('section[aria-label="최근 경기"]', (section) => section.textContent);
        expect(sectionText).toContain(`최근 ${count}경기 중 유효 ${count}경기`);
        expect(await page.$$eval('[data-testid="lol-match-card"]', (cards, label) =>
          cards.every((card) => card.textContent?.includes(label)), queueLabel,
        )).toBe(true);
      }
      expect(apiCalls).toHaveLength(1);
      await page.$$eval('[data-testid="lol-match-player"]', (buttons) => {
        const button = buttons.find((element) => element.textContent?.trim() === "blue1#KR1");
        (button as HTMLButtonElement).click();
      });
      await page.waitForFunction(() => document.querySelector("h2")?.textContent === "blue1#KR1");
      expect(await page.$$eval('[data-testid="lol-match-player"]', (buttons) =>
        buttons.filter((button) => button.classList.contains("text-amber-300"))
          .every((button) => button.textContent?.trim() === "blue1#KR1"),
      )).toBe(true);
      expect(apiCalls).toHaveLength(2);
      await page.close();
    });

    it("합산 데스가 0인 요약과 챔피언은 Perfect로 표시한다", async () => {
      const page = await openPage();
      await search(page, "perfect#kr1");
      expect(await page.$eval('[data-testid="lol-summary-metrics"]', (metrics) => metrics.textContent))
        .toContain("Perfect");
      expect(await page.$$eval('[aria-label="챔피언별 최근 통계"] li', (rows) =>
        rows.every((row) => row.textContent?.includes("KDA Perfect")),
      )).toBe(true);
      await page.close();
    });

    it("구 DTO에서 새 필드가 없어도 카드와 상세를 열 수 있다", async () => {
      const page = await openPage();
      const errors: string[] = [];
      page.on("pageerror", (error) => errors.push(String(error)));
      await search(page, "legacy#kr1");
      expect(await page.$$eval('[data-testid="lol-ranks"] svg', (charts) => charts.length)).toBe(0);
      expect(await page.$eval('[data-testid="lol-ranks"]', (section) => section.textContent)).toContain("기록 없음");
      expect(await page.$eval('[data-testid="lol-match-card"]', (card) => card.textContent))
        .toContain("미제공");
      expect(await page.$eval('[aria-label="포지션별 경기 수"]', (section) => section.textContent))
        .toContain("미드 5");
      await openFirstDetail(page);
      expect(await page.$$eval('[data-testid="lol-player-row"]', (rows) => rows.length)).toBe(10);
      expect(await page.$$eval('[aria-label$="아이템"]', (lists) =>
        lists.every((list) => list.children.length === 7),
      )).toBe(true);
      expect(errors).toEqual([]);
      await page.close();
    });

    it("랭크 기록이 없는 큐도 랭크 없음 카드로 유지한다", async () => {
      const page = await openPage();
      await search(page, "unrank#kr1");
      const ranks = await page.$eval('[data-testid="lol-ranks"]', (section) => section.textContent);
      expect(ranks).toMatch(/솔로 랭크[\s\S]*플래티넘 4[\s\S]*자유 랭크[\s\S]*랭크 없음/);
      expect(await page.$$eval('[data-testid="lol-ranks"] > div', (cards) => cards.length)).toBe(2);
      await page.close();
    });

    it("다음 페이지를 추가하고 로드된 전체 경기로 요약을 다시 계산한다", async () => {
      const page = await openPage();
      let moreBody: unknown;
      page.on("request", (request) => {
        if (request.url() === `${baseUrl}/api/admin/lol/matches/more`)
          moreBody = JSON.parse(request.postData() ?? "{}");
      });
      await search(page);
      expect(await page.$$eval('[data-testid="lol-match-card"]', (cards) => cards.length)).toBe(5);
      expect(await page.$eval('section[aria-label="검색 결과"] > div:first-child', (profile) => profile.textContent))
        .toMatch(/최근 갱신 \d+초 전/);
      const cooldown = await page.$eval("body", (body) =>
        [...body.querySelectorAll("button")].find((button) => button.textContent?.includes("초 후 갱신 가능"))?.textContent,
      );
      expect(cooldown).toMatch(/^\d+초 후 갱신 가능$/);
      expect(Number(cooldown?.match(/\d+/)?.[0])).toBeGreaterThan(0);
      expect(Number(cooldown?.match(/\d+/)?.[0])).toBeLessThanOrEqual(120);
      await clickButtonText(page, "경기 더 불러오기");
      await page.waitForFunction(() => document.querySelectorAll('[data-testid="lol-match-card"]').length === 20);
      // 더보기는 한 번에 남은 ID를 최대 20개까지 요청한다.
      expect(moreBody).toEqual({ riotId: "BLUE0#kr1", offset: 5, matchIds: Array.from({ length: 15 }, (_, index) => `FIXTURE_${index + 6}`) });
      expect(await page.$eval('[data-testid="lol-summary-header"]', (summary) => summary.textContent))
        .toContain("최근 20경기 중 유효 20경기");
      await page.close();
    });

    it("빌드 탭은 처음 열 때만 타임라인 빌드를 요청하고 아이템·스킬 순서를 보여 준다", async () => {
      const page = await openPage();
      buildRequests = 0;
      await search(page);
      await openFirstDetail(page);
      expect(buildRequests).toBe(0);
      const selectTab = (label: string) => page.$eval('section[aria-label="최근 경기"] article', (card, text) =>
        ([...card.querySelectorAll('[role="tab"]')].find((tab) => tab.textContent === text) as HTMLElement).click(), label);
      await selectTab("빌드");
      await page.waitForSelector('[aria-label="아이템 빌드"]');
      const text = await page.$eval('[data-testid="lol-match-build"]', (section) => section.textContent ?? "");
      expect(text).toContain("9분"); expect(text).toContain("Q›E");
      // 선택한 소환사 이름을 보여 주고, 선택 버튼은 44px 터치 영역을 가진다.
      expect(await page.$eval('[data-testid="lol-match-build-selected"]', (element) => element.textContent)).toContain("blue0");
      expect(await page.$$eval('[data-testid="lol-match-build"] [role="radio"]', (buttons) =>
        buttons.every((button) => button.getBoundingClientRect().height >= 44 && button.getBoundingClientRect().width >= 44))).toBe(true);
      await selectTab("종합");
      await selectTab("빌드");
      expect(buildRequests).toBe(1);
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
      await page.close();
    });

    it("더보기로 늘린 경기 수는 새로고침 후에도 같은 수까지 다시 채운다", async () => {
      const page = await openPage();
      let moreCalls = 0;
      page.on("request", (request) => {
        if (request.url() === `${baseUrl}/api/admin/lol/matches/more`) moreCalls += 1;
      });
      await search(page);
      expect(await page.$$eval('[data-testid="lol-match-card"]', (cards) => cards.length)).toBe(5);
      await clickButtonText(page, "경기 더 불러오기");
      await page.waitForFunction(() => document.querySelectorAll('[data-testid="lol-match-card"]').length === 20);
      expect(await page.evaluate(() => sessionStorage.getItem("bgms:lol-loaded:blue0#kr1"))).toBe("20");
      moreCalls = 0;
      await page.reload({ waitUntil: "domcontentloaded" });
      await page.waitForFunction(() => document.querySelectorAll('[data-testid="lol-match-card"]').length === 20);
      expect(moreCalls).toBe(1);
      await page.close();
    });

    it("갱신은 기존 10경기를 유지하고 신규 경기만 앞에 추가하며 다음 offset을 보존한다", async () => {
      const page = await openPage();
      const requests: Array<{ offset: number; matchIds?: string[] }> = [];
      page.on("request", (request) => {
        if (request.url() === `${baseUrl}/api/admin/lol/matches/more`)
          requests.push(JSON.parse(request.postData() ?? "{}"));
      });
      await search(page, "refresh#kr1");
      await clickButtonText(page, "경기 더 불러오기");
      await page.waitForFunction(() => document.querySelectorAll('[data-testid="lol-match-card"]').length === 20);
      const before = await page.$$eval('[data-testid="lol-match-card"]', (cards) => cards.map((card) => card.textContent));
      // 응답을 직접 풀어 처리 중 상태 검증이 250ms 타이밍에 의존하지 않게 한다.
      const refreshResponse = new Promise<() => void>(resolve => { holdRefresh = resolve; });
      await clickButtonText(page, "전적 갱신");
      const finishRefresh = await refreshResponse;
      expect(await page.$$eval('[data-testid="lol-match-card"]', (cards) => cards.length)).toBe(20);
      expect(await page.$eval('section[aria-label="검색 결과"] > div:first-child', (profile) => profile.textContent))
        .toContain("BGMS 데이터 처리 중");
      expect(await page.$$eval('[data-testid="lol-history"] button', (buttons) =>
        buttons.some((button) => button.textContent?.includes("BGMS 데이터 처리 중")),
      )).toBe(false);
      finishRefresh();
      await page.waitForFunction(() => document.querySelectorAll('[data-testid="lol-match-card"]').length === 21);
      expect(await page.$$eval('[data-testid="lol-match-card"]', (cards) => cards.slice(1).map((card) => card.textContent))).toEqual(before);
      expect(await page.$eval('[data-testid="lol-summary-header"]', (header) => header.textContent)).toContain("최근 21경기");
      // 첫 페이지 ID를 모두 불러온 뒤에는 다음 Riot 페이지를 offset으로 요청한다.
      await clickButtonText(page, "경기 더 불러오기");
      await page.waitForFunction(() => document.querySelectorAll('[data-testid="lol-match-card"]').length === 26);
      expect(requests[1]).toEqual({ riotId: "refresh#kr1", offset: 21 });
      await page.close();
    });

    it("짧은 목록을 모두 로드한 뒤 갱신해도 새 경기만 추가하고 목록 끝을 유지한다", async () => {
      const page = await openPage();
      await search(page, "refreshshort#kr1");
      await clickButtonText(page, "경기 더 불러오기");
      await page.waitForFunction(() => document.querySelectorAll('[data-testid="lol-match-card"]').length === 7);
      await clickButtonText(page, "전적 갱신");
      await page.waitForFunction(() => document.querySelectorAll('[data-testid="lol-match-card"]').length === 8);
      expect(await page.$$eval("button", (buttons) => buttons.some((button) => button.textContent === "경기 더 불러오기"))).toBe(false);
      expect(await page.$eval('[data-testid="lol-summary-header"]', (header) => header.textContent)).toContain("최근 8경기");
      await page.close();
    });

    it("저장소 503 뒤에는 같은 더보기 요청을 재시도하고 기존 카드를 유지한다", async () => {
      const page = await openPage();
      const requests: unknown[] = [];
      page.on("request", (request) => {
        if (request.url() === `${baseUrl}/api/admin/lol/matches/more`)
          requests.push(JSON.parse(request.postData() ?? "{}"));
      });
      await search(page, "storage#kr1");
      await clickButtonText(page, "경기 더 불러오기");
      await page.waitForSelector('[role="alert"] button');
      expect(await page.$eval('[role="alert"]', (alert) => alert.textContent)).toContain("LoL 저장소를 사용할 수 없습니다.");
      expect(await page.$$eval('[data-testid="lol-match-card"]', (cards) => cards.length)).toBe(5);
      await clickButtonText(page, "잠시 후 다시 시도");
      await page.waitForFunction(() => document.querySelectorAll('[data-testid="lol-match-card"]').length === 20);
      expect(requests).toHaveLength(2);
      expect(requests[0]).toEqual(requests[1]);
      expect(await page.$('[role="alert"]')).toBeNull();
      await page.close();
    });

    it("실패 경기 종류를 구분하고 해당 ID만 재시도한다", async () => {
      const page = await openPage();
      let retryBody: unknown;
      page.on("request", (request) => {
        if (request.url() === `${baseUrl}/api/admin/lol/matches/more`)
          retryBody = JSON.parse(request.postData() ?? "{}");
      });
      await search(page, "retry#kr1");
      const failures = await page.$$eval('[data-testid="lol-match-failure"]', (cards) => cards.map((card) => card.textContent));
      expect(failures[0]).toContain("17초 후 다시 시도");
      expect(failures[1]).toContain("BGMS에서 경기 정보를 처리 중");
      await page.click('[data-testid="lol-match-failure"] button');
      await page.waitForFunction(() => document.querySelectorAll('[data-testid="lol-match-failure"]').length === 1);
      expect(retryBody).toEqual({ riotId: "retry#kr1", offset: 5, matchIds: ["FAIL_RIOT"] });
      expect(await page.$$eval('[data-testid="lol-match-card"]', (cards) => cards.length)).toBe(6);
      await clickButtonText(page, "경기 더 불러오기");
      await page.waitForFunction(() => document.querySelectorAll('[data-testid="lol-match-card"]').length === 21);
      expect(retryBody).toEqual({ riotId: "retry#kr1", offset: 5, matchIds: Array.from({ length: 15 }, (_, index) => `FIXTURE_${index + 6}`) });
      await page.close();
    });

    it("목록 요청의 Riot 429는 남은 초와 함께 표시하고 성공 카드를 보존한다", async () => {
      const page = await openPage();
      await search(page, "quota#kr1");
      await clickButtonText(page, "경기 더 불러오기");
      await page.waitForFunction(() => document.querySelector('[role="alert"]')?.textContent?.includes("17초"));
      expect(await page.$eval('[role="alert"]', (alert) => alert.textContent))
        .toContain("잠시 후 다시 시도 (17초)");
      expect(await page.$$eval('[data-testid="lol-match-card"]', (cards) => cards.length)).toBe(5);
      await page.close();
    });

    it.each([
      { width: 375, height: 667 }, { width: 390, height: 844 },
      { width: 430, height: 932 }, { width: 1440, height: 900 },
    ])("운영 패널은 기본 접힘이고 $width 폭에서 검색 결과와 분리된다", async (viewport) => {
      const page = await openPage(viewport);
      const panel = '[aria-label="LoL 운영 상태"]';
      expect(await page.$eval(panel, (element) => (element.parentElement as HTMLDetailsElement).open)).toBe(false);
      await page.$$eval("summary", (items) => (items.find((item) => item.textContent === "운영 상태") as HTMLElement).click());
      await page.waitForFunction(() => document.querySelector('[aria-label="LoL 운영 상태"]')?.textContent?.includes("키 확인 필요"));
      expect(await page.$eval(panel, (element) => element.textContent)).toContain("429 쿨다운 중");
      expect(await page.$eval(panel, (element) => element.textContent)).toContain("마지막 랭크 컷 스냅샷:");
      await clickButtonText(page, "정리 미리보기");
      await page.waitForSelector(`${panel} input[type="checkbox"]`);
      expect(await page.$$eval(`${panel} button`, (buttons) =>
        (buttons.find((button) => button.textContent === "정리 실행(배치 1회)") as HTMLButtonElement).disabled,
      )).toBe(true);
      await page.click(`${panel} input[type="checkbox"]`);
      await page.waitForFunction(() => [...document.querySelectorAll<HTMLButtonElement>('[aria-label="LoL 운영 상태"] button')]
        .some(button => button.textContent === "정리 실행(배치 1회)" && !button.disabled));
      await clickButtonText(page, "정리 실행(배치 1회)");
      await page.waitForFunction(() => document.querySelector('[aria-label="LoL 운영 상태"] [role="status"]')?.textContent?.includes("삭제:"));
      expect(await page.$eval(panel, (element) => element.textContent)).toContain("계정·랭크 이력·본인 경기 요약은 보관");
      expect(await page.$eval(panel, (element) => element.textContent)).not.toContain("계정 0행");
      await page.type('[aria-label="삭제할 Riot ID"]', "Owner#SUM");
      expect(await page.$$eval(`${panel} button`, (buttons) => buttons.some((button) => button.textContent === "계정 영구 삭제 실행"))).toBe(false);
      await clickButtonText(page, "삭제 대상 확인");
      await page.waitForFunction(() => document.body.textContent?.includes("삭제 대상: Owner#SUM"));
      expect(await page.$$eval(`${panel} button`, (buttons) =>
        (buttons.find((button) => button.textContent === "계정 영구 삭제 실행") as HTMLButtonElement).disabled,
      )).toBe(true);
      const bounds = await page.evaluate(() => ({ width: innerWidth, document: document.documentElement.scrollWidth }));
      expect(bounds.document).toBeLessThanOrEqual(bounds.width);
      expect(await page.$('section[aria-label="검색 결과"]')).toBeNull();
      await page.screenshot({ path: `tmp/lol-detail-alignment/ops-${viewport.width}x${viewport.height}.png`, fullPage: true });
      await page.click('[aria-label="계정 영구 삭제 확인"]');
      await clickButtonText(page, "계정 영구 삭제 실행");
      await page.waitForFunction(() => document.querySelector('[aria-label="LoL 운영 상태"] [role="status"]')?.textContent?.includes("본인 경기 요약 5행 삭제"));
      await page.close();
    });

    it.each([
      { width: 375, height: 667 }, { width: 390, height: 844 },
      { width: 430, height: 932 }, { width: 1440, height: 900 },
    ])("경기 수집은 $width 폭에서 진행·반복·중지하며 넘치지 않는다", async (viewport) => {
      collectionRequests.length = 0;
      const page = await openPage(viewport);
      await page.$$eval("summary", (items) => (items.find((item) => item.textContent === "운영 상태") as HTMLElement).click());
      await page.waitForSelector('[aria-label="수집할 Riot ID"]');
      await page.type('[aria-label="수집할 Riot ID"]', "Collector#FIX");
      await page.$eval('[aria-label="목표 경기 수"]', (input) => (input as HTMLInputElement).select());
      await page.type('[aria-label="목표 경기 수"]', "45");
      expect(await page.$$eval("button", (buttons) =>
        (buttons.find((button) => button.textContent === "수집 시작") as HTMLButtonElement).disabled)).toBe(true);
      await page.click('[aria-label="경기 수집 실행 확인"]');
      await clickButtonText(page, "수집 시작");
      await viWaitForCollection(1);
      await clickButtonText(page, "수집 중지");
      await page.waitForFunction(() => document.querySelector('[aria-label="경기 수집"]')?.textContent?.includes("중지됨"));
      expect(collectionRequests).toHaveLength(1);
      expect(collectionRequests[0]).toMatchObject({ count: 45, startOffset: 0, confirm: true });
      expect(await page.$eval('[aria-label="경기 수집 진행"]', (progress) => (progress as HTMLProgressElement).value)).toBe(20);
      collectionRequests.length = 0;
      await clickButtonText(page, "수집 시작");
      await page.waitForFunction(() => document.querySelector('[aria-label="경기 수집"]')?.textContent?.includes("수집 완료"));
      expect(collectionRequests.map((item) => item.startOffset)).toEqual([0, 20, 40]);
      expect(collectionRequests.map((item) => item.count)).toEqual([45, 25, 5]);
      expect(await page.$eval('[aria-label="경기 수집"]', (panel) => panel.textContent)).toContain("처리 45/45");
      const bounds = await page.evaluate(() => ({ width: innerWidth, document: document.documentElement.scrollWidth }));
      expect(bounds.document).toBeLessThanOrEqual(bounds.width);
      await page.screenshot({ path: `tmp/lol-detail-alignment/collect-${viewport.width}x${viewport.height}.png`, fullPage: true });
      await page.close();
    });

    async function viWaitForCollection(count: number) {
      const started = Date.now();
      while (collectionRequests.length < count) {
        if (Date.now() - started > 5000) throw new Error("수집 요청 대기 초과");
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
    }

    it("갱신 쿨다운을 초 단위로 표시하고 버튼을 잠근다", async () => {
      const page = await openPage();
      await search(page, "cooldown#kr1");
      await page.waitForFunction(() => [...document.querySelectorAll("button")]
        .some((button) => button.textContent === "전적 갱신"));
      await clickButtonText(page, "전적 갱신");
      await page.waitForFunction(() => [...document.querySelectorAll("button")]
        .some((button) => button.textContent?.includes("초 후 갱신 가능")));
      expect(await page.$eval("body", (body) =>
        [...body.querySelectorAll("button")].find((item) => item.textContent?.includes("초 후 갱신 가능"))?.disabled,
      )).toBe(true);
      await page.close();
    });
  },
);
