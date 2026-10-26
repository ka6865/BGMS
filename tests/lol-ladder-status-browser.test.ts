import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createServer, type Server } from "node:http";
import { mkdir, readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { build, type Plugin } from "esbuild";
import postcss from "postcss";
import tailwind from "@tailwindcss/postcss";
import puppeteer, { type Browser } from "puppeteer";

const stubs: Plugin = { name: "ladder-status-fixture", setup(builder) {
  builder.onResolve({ filter: /^(server-only|next\/link|next\/navigation|@\/lib\/lol\/(publicAccess|status|ladder)\.server)$/ }, args => ({ path: args.path, namespace: "fixture" }));
  builder.onLoad({ filter: /.*/, namespace: "fixture" }, args => ({ loader: "tsx", resolveDir: process.cwd(), contents:
    args.path === "next/link" ? "export default ({ children, ...props }) => <a {...props}>{children}</a>;"
      : args.path === "next/navigation" ? "export const usePathname = () => globalThis.__lolFixturePath ?? null;"
      : args.path.includes("publicAccess") ? "export const requireLolPublicPage = () => {};"
        : args.path.includes("status.server") ? `export const getLolPlatformStatus = async () => ({ available: true, stale: false, fetchedAt: new Date().toISOString(), items: [
          { id: 1, kind: 'maintenance', title: '한국 서버 정기 점검 안내와 게임 접속 지연 현상에 관한 상세 공지', message: '한국어 공지 내용입니다.' },
          { id: 2, kind: 'incident', title: '게임 접속 장애', message: '확인 중입니다.' }
        ] });`
          : args.path.includes("ladder.server") ? `export const getLolLadderDaily = async () => {
            const today = new Intl.DateTimeFormat('sv-SE', { timeZone: 'Asia/Seoul' }).format(new Date());
            return Array.from({ length: 30 }, (_, i) => {
              const day = new Date(Date.parse(today+'T00:00:00Z') - (29-i)*86400000).toISOString().slice(0,10);
              return ['RANKED_SOLO_5x5','RANKED_FLEX_SR'].flatMap(queue => ['CHALLENGER','GRANDMASTER','MASTER'].map((tier,j) => ({
                day, queue, tier, player_count: 300, cutoff_lp: 1100-j*300+i, top_lp: 2000, median_lp: 1300,
                fresh_blood_count: 12, hot_streak_count: 24, observed_at: day+'T20:19:00+09:00'
              })));
            }).flat();
          };` : "",
  }));
} };

describe.skipIf(process.env.RUN_LOL_DEV_BROWSER !== "true")("LoL 컷·상태 공개 페이지 브라우저 fixture", { timeout: 30_000 }, () => {
  let server: Server; let browser: Browser; let base: string;
  beforeAll(async () => {
    const bundle = await build({ bundle: true, write: false, platform: "node", format: "cjs", jsx: "automatic", plugins: [stubs],
      stdin: { loader: "tsx", resolveDir: process.cwd(), contents: `
        import { renderToPipeableStream } from 'react-dom/server'; import { PassThrough } from 'node:stream';
        import Layout from './app/lol/layout'; import LadderPage from './app/lol/kr/ladder/page'; import StatusPage from './app/lol/kr/status/page';
        import LadderView from './components/lol/LolLadderView'; import StatusView from './components/lol/LolStatusView';
        export async function render(path) {
          const empty = path.includes('empty'); const error = path.includes('error');
          globalThis.__lolFixturePath = path.split('?')[0];
          const today = new Intl.DateTimeFormat('sv-SE', { timeZone: 'Asia/Seoul' }).format(new Date());
          const element = path.includes('ladder') ? empty || error ? <LadderView rows={[]} today={today} error={error} /> : await LadderPage()
            : empty || error ? <StatusView status={{ available: !error, stale: error, items: [], fetchedAt: null }} /> : await StatusPage();
          return new Promise((resolve, reject) => {
            let html = ''; const output = new PassThrough(); output.on('data', chunk => html += chunk); output.on('end', () => resolve(html));
            const stream = renderToPipeableStream(<div style={{ height: '100dvh' }}><Layout>{element}</Layout></div>, {
              onAllReady() { stream.pipe(output); }, onError: reject
            });
          });
        }
      ` },
    });
    const fixture = { exports: {} as { render: (path: string) => Promise<string> } };
    new Function("require", "module", "exports", bundle.outputFiles[0].text)(createRequire(import.meta.url), fixture, fixture.exports);
    const css = await postcss([tailwind()]).process(await readFile("app/globals.css", "utf8"), { from: "app/globals.css" });
    server = createServer((req, res) => {
      if (req.url === "/style.css") { res.setHeader("Content-Type", "text/css"); res.end(css.css); return; }
      void fixture.exports.render(req.url ?? "/lol/kr/ladder").then(html => {
        res.setHeader("Content-Type", "text/html"); res.end('<!doctype html><html lang="ko"><head><meta charset="utf-8">'
          + '<meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/style.css"></head><body>' + html + '</body></html>');
      }).catch(error => { res.statusCode = 500; res.end(String(error)); });
    });
    await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
    const address = server.address(); if (!address || typeof address === "string") throw new Error("fixture 주소 확인 실패");
    base = `http://127.0.0.1:${address.port}`; browser = await puppeteer.launch({ headless: true });
    await mkdir("tmp/lol-ladder-status-review", { recursive: true });
  }, 90_000);
  afterAll(async () => { await browser?.close(); if (server) await new Promise<void>(resolve => server.close(() => resolve())); });
  it.each([[375, 667], [390, 844], [430, 932], [1440, 900]])("%ix%i에서 페이지·그래프·긴 배너·빈/오류 상태가 넘치지 않는다", async (width, height) => {
    const page = await browser.newPage(); await page.setViewport({ width, height });
    const errors: string[] = []; page.on("pageerror", error => errors.push(String(error)));
    await page.setRequestInterception(true);
    page.on("request", request => { if (request.url().startsWith(base)) void request.continue(); else void request.abort(); });
    for (const route of ["ladder", "status", "ladder?empty", "ladder?error", "status?empty", "status?error"]) {
      const response = await page.goto(`${base}/lol/kr/${route}`, { waitUntil: "networkidle0" }); expect(response?.status()).toBe(200);
      expect(await page.$eval("main h1", element => element.textContent)).toContain(route.startsWith("ladder") ? "랭크 컷" : "서버 상태");
      // 공지 배너는 한 줄로 접혀 있고, 같은 공지를 본문에 보여 주는 상태 페이지에서는 숨긴다.
      if (route.startsWith("status")) expect(await page.$('aside[aria-label="LoL 서버 상태 알림"]')).toBeNull();
      else {
        expect(await page.$eval('aside[aria-label="LoL 서버 상태 알림"]', element => element.textContent)).toContain("게임 접속 장애");
        expect(await page.$eval('aside[aria-label="LoL 서버 상태 알림"] details', element => (element as HTMLDetailsElement).open)).toBe(false);
        expect(await page.$eval('aside[aria-label="LoL 서버 상태 알림"]', element => element.getBoundingClientRect().height)).toBeLessThanOrEqual(46);
      }
      expect(await page.$eval('footer[aria-label="Riot Games 법적 고지"]', element => element.textContent)).toContain("Riot Games, and all associated properties");
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
      expect(await page.$$eval("main, article, aside, svg", elements => elements.every(element => {
        const rect = element.getBoundingClientRect(); return rect.left >= 0 && rect.right <= innerWidth + 1;
      }))).toBe(true);
      if (route === "ladder") expect(await page.$$("svg circle")).toHaveLength(180);
      // 티어별 그래프는 자기 범위에 맞춰 그려 하루 1 LP씩 오른 30일 변화가 눈에 보일 만큼 펼쳐진다.
      if (route === "ladder") expect(await page.$$eval('svg[aria-label^="최근 30일 "][aria-label$="최저 LP 기록"]', charts => charts.map(chart => {
        const ys = [...chart.querySelectorAll("circle")].map(circle => Number(circle.getAttribute("cy")));
        return Math.max(...ys) - Math.min(...ys);
      }).every(spread => spread >= 30))).toBe(true);
      if (route === "ladder?empty") expect(await page.$eval("main", element => element.textContent)).toContain("기록 시작일 이후 표시");
      if (route === "status?error") expect(await page.$eval("main", element => element.textContent)).toContain("현재 서버 상태를 확인할 수 없습니다");
      if (!route.includes("?")) await page.screenshot({ path: `tmp/lol-ladder-status-review/${route}-${width}.png`, fullPage: true });
      if (route === "ladder") {
        await page.$eval("figure", element => element.scrollIntoView({ block: "center" }));
        await page.screenshot({ path: `tmp/lol-ladder-status-review/ladder-graph-${width}.png`, fullPage: true });
      }
    }
    expect(errors).toEqual([]); await page.close();
  });
});
