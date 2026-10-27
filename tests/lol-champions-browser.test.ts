import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createServer, type Server } from "node:http";
import { mkdir, readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { build, type Plugin } from "esbuild";
import postcss from "postcss";
import tailwind from "@tailwindcss/postcss";
import puppeteer, { type Browser } from "puppeteer";
import type { LolChampion } from "../lib/lol/champions";

const stubs: Plugin = { name: "champions-fixture", setup(builder) {
  builder.onResolve({ filter: /^(server-only|next\/link|next\/navigation|@\/lib\/lol\/(publicAccess|status|champions|championStats|riotSearch)\.server)$/ }, args => ({ path: args.path, namespace: "fixture" }));
  builder.onLoad({ filter: /.*/, namespace: "fixture" }, args => ({ loader: "tsx", resolveDir: process.cwd(), contents:
    args.path === "next/link" ? "export default ({ children, ...props }) => <a {...props}>{children}</a>;"
      : args.path === "next/navigation" ? "export const usePathname = () => globalThis.__lolFixturePath ?? null; export const notFound = () => { throw new Error('NOT_FOUND'); };"
      : args.path.includes("publicAccess") ? "export const requireLolPublicPage = () => {};"
        : args.path.includes("status.server") ? "export const getLolPlatformStatus = async () => ({ available: true, stale: false, fetchedAt: new Date().toISOString(), items: [] });"
          : args.path.includes("championStats.server") ? `export const getLolChampionStats = async () => globalThis.__lolStats;
            export const getLolChampionDetailStats = async () => globalThis.__lolDetail;`
          : args.path.includes("riotSearch.server") ? `export const getLolBuildCatalog = async () => ({ version: '16.21.1',
            items: { '6692': '월식', '3071': '칠흑의 양날 도끼', '6333': '죽음의 무도', '3047': '판금 장화', '1055': '도란의 검', '2003': '체력 물약' },
            spells: { '4': { name: '점멸', image: 'SummonerFlash.png' }, '12': { name: '순간이동', image: 'SummonerTeleport.png' } },
            runes: { '8000': { name: '정밀', icon: 'a.png' }, '8010': { name: '정복자', icon: 'b.png' } } });`
          : args.path.includes("champions.server") ? `export const getLolChampions = async () => globalThis.__lolChampions;` : "",
  }));
} };

const champions: LolChampion[] = [
  { id: 266, imageId: "Aatrox", name: "아트록스", title: "다르킨의 검", tags: ["Fighter"] },
  { id: 103, imageId: "Ahri", name: "아리", title: "구미호", tags: ["Mage", "Assassin"] },
  { id: 22, imageId: "Ashe", name: "애쉬", title: "서리 궁수", tags: ["Marksman", "Support"] },
  ...Array.from({ length: 160 }, (_, i) => ({ id: 1000 + i, imageId: `Champ${i}`, name: `아주긴챔피언이름테스트${i}`, title: "", tags: ["Tank" as const] })),
];

const statRows = [
  { team_position: "TOP", champion_id: 266, games: 400, wins: 212, bans: 120, matches: 2000 },
  { team_position: "TOP", champion_id: 1000, games: 300, wins: 140, bans: 5, matches: 2000 },
  { team_position: "TOP", champion_id: 1001, games: 5, wins: 5, bans: 0, matches: 2000 },
  { team_position: "MIDDLE", champion_id: 103, games: 500, wins: 260, bans: 80, matches: 2000 },
  ...Array.from({ length: 60 }, (_, i) => ({ team_position: "TOP", champion_id: 1002 + i, games: 30 + i, wins: 15 + Math.floor(i / 2), bans: i, matches: 2000 })),
];
const stats = { patch: "16.21", patches: [{ patch: "16.21", matches: 2000, timelineMatches: 1000 }], matches: 2000, rows: statRows };
const detail = {
  patch: "16.21", patches: stats.patches, matches: 2000, timelineMatches: 1000, bans: 120,
  positions: [{ team_position: "TOP", games: 400, wins: 212, kills: 2000, deaths: 1800, assists: 2400, cs: 76000, gold: 4800000, damage: 9000000,
    duration_seconds: 720000, gd15_sum: 60000, gd15_count: 200 }, { team_position: "JUNGLE", games: 12, wins: 5, kills: 50, deaths: 60, assists: 70,
    cs: 2000, gold: 100000, damage: 200000, duration_seconds: 21600, gd15_sum: 0, gd15_count: 0 }],
  builds: [
    { position: "TOP", kind: "runes", value: "8000:8010,9111,9104,8299|8400:8444,8453|5005,5008,5001", games: 300, wins: 160 },
    { position: "TOP", kind: "spells", value: "4,12", games: 380, wins: 200 },
    { position: "TOP", kind: "start_items", value: "1055+2003", games: 180, wins: 95 },
    { position: "TOP", kind: "core_items", value: "6692>3071>6333", games: 90, wins: 52 },
    { position: "TOP", kind: "skill_order", value: "Q>E>W", games: 190, wins: 100 },
    { position: "TOP", kind: "boots", value: "3047", games: 250, wins: 130 },
    { position: "TOP", kind: "item", value: "6692", games: 350, wins: 190 },
  ],
  matchups: [{ position: "TOP", opponent: 1000, games: 40, wins: 26, gd15Sum: 4000, gd15Count: 20 },
    { position: "TOP", opponent: 1001, games: 30, wins: 10, gd15Sum: -3000, gd15Count: 15 }],
};

describe.skipIf(process.env.RUN_LOL_DEV_BROWSER !== "true")("LoL 챔피언 공개 페이지 브라우저 fixture", { timeout: 30_000 }, () => {
  let server: Server; let browser: Browser; let base: string;
  beforeAll(async () => {
    const bundle = await build({ bundle: true, write: false, platform: "node", format: "cjs", jsx: "automatic", plugins: [stubs],
      stdin: { loader: "tsx", resolveDir: process.cwd(), contents: `
        import { renderToPipeableStream } from 'react-dom/server'; import { PassThrough } from 'node:stream';
        import Layout from './app/lol/layout'; import ChampionsPage from './app/lol/kr/champions/page';
        import DetailPage from './app/lol/kr/champions/[champion]/page';
        export async function render(path, champions, stats, detail) {
          const [pathname, search = ''] = path.split('?');
          globalThis.__lolFixturePath = pathname;
          globalThis.__lolChampions = path.includes('error') ? null : { version: '16.21.1', champions };
          globalThis.__lolStats = path.includes('stats') ? stats : { patch: null, patches: [], matches: 0, rows: [] };
          globalThis.__lolDetail = path.includes('stats') ? detail : { patch: null, patches: [], matches: 0, timelineMatches: 0, bans: 0, positions: [], builds: [], matchups: [] };
          const searchParams = Promise.resolve(Object.fromEntries(new URLSearchParams(search)));
          const slug = pathname.split('/')[4];
          const element = slug ? await DetailPage({ params: Promise.resolve({ champion: slug }), searchParams }) : await ChampionsPage({ searchParams });
          return new Promise((resolve, reject) => {
            let html = ''; const output = new PassThrough(); output.on('data', chunk => html += chunk); output.on('end', () => resolve(html));
            const stream = renderToPipeableStream(<div style={{ height: '100dvh' }}><Layout>{element}</Layout></div>, {
              onAllReady() { stream.pipe(output); }, onError: reject
            });
          });
        }
      ` },
    });
    // 클라이언트 필터 동작을 확인하려면 브라우저에서 같은 컴포넌트를 hydrate해야 한다.
    const client = await build({ bundle: true, write: false, platform: "browser", format: "iife", jsx: "automatic", minify: true, plugins: [stubs],
      define: { "process.env.NODE_ENV": '"production"' },
      stdin: { loader: "tsx", resolveDir: process.cwd(), contents: `
        import { hydrateRoot } from 'react-dom/client'; import List from './components/lol/LolChampionList';
        const root = document.getElementById('champion-root');
        const props = JSON.parse(document.getElementById('champion-props').textContent);
        hydrateRoot(root, <List {...props} />);
      ` },
    });
    const fixture = { exports: {} as { render: (path: string, list: unknown, stats: unknown, detail: unknown) => Promise<string> } };
    new Function("require", "module", "exports", bundle.outputFiles[0].text)(createRequire(import.meta.url), fixture, fixture.exports);
    const css = await postcss([tailwind()]).process(await readFile("app/globals.css", "utf8"), { from: "app/globals.css" });
    const { renderToString } = await import("react-dom/server");
    const { createElement } = await import("react");
    const List = (await import("../components/lol/LolChampionList")).default;
    server = createServer((req, res) => {
      if (req.url === "/style.css") { res.setHeader("Content-Type", "text/css"); res.end(css.css); return; }
      if (req.url === "/client.js") { res.setHeader("Content-Type", "text/javascript"); res.end(client.outputFiles[0].text); return; }
      if (req.url === "/interactive" || req.url === "/interactive-stats") {
        const props = req.url === "/interactive" ? { champions, version: "16.21.1", error: false }
          : { champions, version: "16.21.1", error: false, stats: { patch: stats.patch, matches: stats.matches, rows: stats.rows, tierFilter: "emerald_plus" } };
        res.setHeader("Content-Type", "text/html");
        res.end('<!doctype html><html lang="ko"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">'
          + '<link rel="stylesheet" href="/style.css"></head><body class="bg-zinc-950"><div id="champion-root">'
          + renderToString(createElement(List, props as Parameters<typeof List>[0])) + '</div><script type="application/json" id="champion-props">'
          + JSON.stringify(props).replace(/</g, "\\u003c") + '</script><script src="/client.js"></script></body></html>');
        return;
      }
      void fixture.exports.render(req.url ?? "/lol/kr/champions", champions, stats, detail).then(html => {
        res.setHeader("Content-Type", "text/html"); res.end('<!doctype html><html lang="ko"><head><meta charset="utf-8">'
          + '<meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/style.css"></head><body>' + html + '</body></html>');
      }).catch(error => { res.statusCode = 500; res.end(String(error)); });
    });
    await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
    const address = server.address(); if (!address || typeof address === "string") throw new Error("fixture 주소 확인 실패");
    base = `http://127.0.0.1:${address.port}`; browser = await puppeteer.launch({ headless: true });
    await mkdir("tmp/lol-champions-review", { recursive: true });
  }, 90_000);
  afterAll(async () => { await browser?.close(); if (server) await new Promise<void>(resolve => server.close(() => resolve())); });

  it.each([[375, 667], [390, 844], [430, 932], [1440, 900]])("%ix%i에서 헤더 메뉴 4개·그리드·오류 상태가 넘치지 않는다", async (width, height) => {
    const page = await browser.newPage(); await page.setViewport({ width, height });
    const errors: string[] = []; page.on("pageerror", error => errors.push(String(error)));
    await page.setRequestInterception(true);
    page.on("request", request => { if (request.url().startsWith(base)) void request.continue(); else void request.abort(); });
    for (const route of ["champions", "champions?error"]) {
      expect((await page.goto(`${base}/lol/kr/${route}`, { waitUntil: "networkidle0" }))?.status()).toBe(200);
      expect(await page.$eval("main h1", element => element.textContent)).toBe("챔피언");
      expect(await page.$eval('[data-testid="lol-header"] [aria-current="page"]', element => element.textContent)).toBe("챔피언");
      expect(await page.$$eval('[data-testid="lol-header"] nav a', links => links.map(link => link.getAttribute("href"))))
        .toEqual(["/lol/kr", "/lol/kr/champions", "/lol/kr/ladder", "/lol/kr/status"]);
      // 좁은 화면에서도 헤더 메뉴가 줄바꿈되거나 잘리지 않는다.
      expect(await page.$$eval('[data-testid="lol-header"] nav a', links => links.every(link => {
        const rect = link.getBoundingClientRect(); return rect.left >= 0 && rect.right <= innerWidth && rect.height <= 48;
      }))).toBe(true);
      // 로고와 첫 메뉴가 붙어 보이지 않도록 간격을 둔다.
      expect(await page.$eval('[data-testid="lol-header"]', header => header.querySelector("nav a")!.getBoundingClientRect().left
        - header.querySelector("a")!.getBoundingClientRect().right)).toBeGreaterThanOrEqual(8);
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
      expect(await page.$$eval("main, li", elements => elements.every(element => {
        const rect = element.getBoundingClientRect(); return rect.left >= 0 && rect.right <= innerWidth + 1;
      }))).toBe(true);
      if (route === "champions") {
        expect(await page.$$('ul[aria-label="챔피언 목록"] li')).toHaveLength(champions.length);
        expect(await page.$eval("main", element => element.textContent)).toContain("승률·픽률·밴률은 표본을 모으는 중");
        await page.screenshot({ path: `tmp/lol-champions-review/champions-${width}.png` });
      } else {
        expect(await page.$eval("main", element => element.textContent)).toContain("챔피언 목록을 불러오지 못했습니다");
        expect(await page.$('ul[aria-label="챔피언 목록"]')).toBeNull();
      }
    }
    expect(errors).toEqual([]); await page.close();
  });

  it.each([[375, 667], [390, 844], [430, 932], [1440, 900]])("%ix%i에서 통계 표·상세 페이지가 넘치지 않는다", async (width, height) => {
    const page = await browser.newPage(); await page.setViewport({ width, height });
    const errors: string[] = []; page.on("pageerror", error => errors.push(String(error)));
    await page.setRequestInterception(true);
    page.on("request", request => { if (request.url().startsWith(base)) void request.continue(); else void request.abort(); });
    const fits = () => page.evaluate(() => document.documentElement.scrollWidth <= innerWidth
      && [...document.querySelectorAll("main, section, table")].every(element => { const rect = element.getBoundingClientRect(); return rect.left >= 0 && rect.right <= innerWidth + 1; }));

    expect((await page.goto(`${base}/lol/kr/champions?stats&tier=diamond_plus&position=TOP`, { waitUntil: "networkidle0" }))?.status()).toBe(200);
    expect(await page.$eval("main header p", element => element.textContent)).toContain("16.21 패치 · 솔로 랭크 2,000경기");
    expect(await page.$eval('nav[aria-label="티어"] [aria-current="true"]', element => element.textContent)).toBe("다이아몬드+");
    const rows = await page.$$eval('section[aria-label="챔피언 통계"] tbody tr', trs => trs.map(tr => [...tr.querySelectorAll("td")].map(td => td.textContent?.trim())));
    expect(rows).toHaveLength(63);
    // 기본 정렬은 픽률이며, 20판 미만 표본은 승률 대신 표본 부족으로 맨 아래에 둔다.
    expect(rows[0].slice(1, 5)).toEqual(["아트록스400판", "53.0%", "20.0%", "6.0%"]);
    expect(rows.at(-1)![2]).toBe("표본 부족");
    expect(await page.$eval('section[aria-label="챔피언 통계"] tbody a', link => link.getAttribute("href"))).toBe("/lol/kr/champions/aatrox?tier=diamond_plus&position=TOP");
    expect(await fits()).toBe(true);
    await page.screenshot({ path: `tmp/lol-champions-review/stats-${width}.png` });

    expect((await page.goto(`${base}/lol/kr/champions/aatrox?stats&tier=diamond_plus&position=TOP`, { waitUntil: "networkidle0" }))?.status()).toBe(200);
    expect(await page.$eval("main h1", element => element.textContent)).toBe("아트록스");
    expect(await page.$eval('[data-testid="lol-header"] [aria-current="page"]', element => element.textContent)).toBe("챔피언");
    expect(await page.$eval('nav[aria-label="포지션"] [aria-current="page"]', element => element.textContent)).toContain("탑");
    const summary = await page.$eval('section[aria-label="요약"]', element => element.textContent);
    for (const text of ["53.0%", "20.0%", "6.0%", "400", "5.0 / 4.5 / 6.0", "6.3", "750", "+300"]) expect(summary).toContain(text);
    for (const title of ["룬", "소환사 주문", "시작 아이템", "코어 빌드", "스킬 순서", "신발", "많이 가는 아이템", "라인 상대"]) {
      expect(await page.$(`section[aria-label="${title}"]`)).not.toBeNull();
    }
    expect(await page.$$eval('section[aria-label="코어 빌드"] img', images => images.map(image => image.getAttribute("alt")))).toEqual(["월식", "칠흑의 양날 도끼", "죽음의 무도"]);
    expect(await page.$eval('section[aria-label="스킬 순서"]', element => element.textContent)).toContain("Q›E›W");
    expect(await page.$eval('section[aria-label="라인 상대"]', element => element.textContent)).toContain("65.0%");
    expect(await fits()).toBe(true);
    await page.screenshot({ path: `tmp/lol-champions-review/detail-${width}.png`, fullPage: true });

    // 표본이 없으면 수집 중 안내만 보여 준다.
    await page.goto(`${base}/lol/kr/champions/ahri`, { waitUntil: "networkidle0" });
    expect(await page.$eval("main", element => element.textContent)).toContain("이 조건의 표본을 모으는 중입니다");
    expect(errors).toEqual([]); await page.close();
  });

  it("통계 표에서 포지션·정렬·검색을 바꾼다", async () => {
    const page = await browser.newPage(); await page.setViewport({ width: 390, height: 844 });
    const errors: string[] = []; page.on("pageerror", error => errors.push(String(error)));
    await page.goto(`${base}/interactive-stats`, { waitUntil: "networkidle0" });
    const first = () => page.$eval('section[aria-label="챔피언 통계"] tbody tr td:nth-child(2) span span', element => element.textContent);
    expect(await first()).toBe("아트록스");
    await page.click('[role="group"][aria-label="포지션"] button:nth-child(3)');
    expect(await first()).toBe("아리");
    await page.click('[role="group"][aria-label="포지션"] button:nth-child(1)');
    await page.click('thead button:nth-child(1)');
    expect(await page.$eval('thead [aria-pressed="true"]', element => element.textContent)).toBe("승률");
    expect(await first()).toBe("아트록스");
    await page.type("#lol-champion-search", "아주긴챔피언이름테스트0");
    expect(await first()).toBe("아주긴챔피언이름테스트0");
    expect(errors).toEqual([]); await page.close();
  });

  it("검색어·초성·역할군으로 목록을 거른다", async () => {
    const page = await browser.newPage(); await page.setViewport({ width: 390, height: 844 });
    const errors: string[] = []; page.on("pageerror", error => errors.push(String(error)));
    await page.goto(`${base}/interactive`, { waitUntil: "networkidle0" });
    const names = () => page.$$eval('ul[aria-label="챔피언 목록"] li p:first-of-type', items => items.map(item => item.textContent));
    await page.type("#lol-champion-search", "아리");
    expect(await names()).toEqual(["아리"]);
    await page.$eval("#lol-champion-search", element => { (element as HTMLInputElement).select(); });
    await page.keyboard.press("Backspace");
    await page.type("#lol-champion-search", "ㅇㅅ");
    expect(await names()).toEqual(["애쉬"]);
    await page.$eval("#lol-champion-search", element => { (element as HTMLInputElement).select(); });
    await page.keyboard.press("Backspace");
    await page.click('[role="group"][aria-label="역할군"] button:nth-child(7)');
    expect(await page.$eval('[aria-pressed="true"]', element => element.textContent)).toBe("서포터");
    expect(await names()).toEqual(["애쉬"]);
    await page.type("#lol-champion-search", "없는챔피언");
    expect(await page.$eval("main", element => element.textContent)).toContain("조건에 맞는 챔피언이 없습니다");
    expect(errors).toEqual([]); await page.close();
  });
});
