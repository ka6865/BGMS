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
  builder.onResolve({ filter: /^(server-only|next\/link|next\/navigation|@\/lib\/lol\/(publicAccess|status|champions)\.server)$/ }, args => ({ path: args.path, namespace: "fixture" }));
  builder.onLoad({ filter: /.*/, namespace: "fixture" }, args => ({ loader: "tsx", resolveDir: process.cwd(), contents:
    args.path === "next/link" ? "export default ({ children, ...props }) => <a {...props}>{children}</a>;"
      : args.path === "next/navigation" ? "export const usePathname = () => globalThis.__lolFixturePath ?? null;"
      : args.path.includes("publicAccess") ? "export const requireLolPublicPage = () => {};"
        : args.path.includes("status.server") ? "export const getLolPlatformStatus = async () => ({ available: true, stale: false, fetchedAt: new Date().toISOString(), items: [] });"
          : args.path.includes("champions.server") ? `export const getLolChampions = async () => globalThis.__lolChampions;` : "",
  }));
} };

const champions: LolChampion[] = [
  { id: 266, imageId: "Aatrox", name: "아트록스", title: "다르킨의 검", tags: ["Fighter"] },
  { id: 103, imageId: "Ahri", name: "아리", title: "구미호", tags: ["Mage", "Assassin"] },
  { id: 22, imageId: "Ashe", name: "애쉬", title: "서리 궁수", tags: ["Marksman", "Support"] },
  ...Array.from({ length: 160 }, (_, i) => ({ id: 1000 + i, imageId: `Champ${i}`, name: `아주긴챔피언이름테스트${i}`, title: "", tags: ["Tank" as const] })),
];

describe.skipIf(process.env.RUN_LOL_DEV_BROWSER !== "true")("LoL 챔피언 공개 페이지 브라우저 fixture", { timeout: 30_000 }, () => {
  let server: Server; let browser: Browser; let base: string;
  beforeAll(async () => {
    const bundle = await build({ bundle: true, write: false, platform: "node", format: "cjs", jsx: "automatic", plugins: [stubs],
      stdin: { loader: "tsx", resolveDir: process.cwd(), contents: `
        import { renderToPipeableStream } from 'react-dom/server'; import { PassThrough } from 'node:stream';
        import Layout from './app/lol/layout'; import ChampionsPage from './app/lol/kr/champions/page';
        export async function render(path, champions) {
          globalThis.__lolFixturePath = path.split('?')[0];
          globalThis.__lolChampions = path.includes('error') ? null : { version: '16.21.1', champions };
          const element = await ChampionsPage();
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
    const client = await build({ bundle: true, write: false, platform: "browser", format: "iife", jsx: "automatic", minify: true,
      define: { "process.env.NODE_ENV": '"production"' },
      stdin: { loader: "tsx", resolveDir: process.cwd(), contents: `
        import { hydrateRoot } from 'react-dom/client'; import List from './components/lol/LolChampionList';
        const root = document.getElementById('champion-root');
        const props = JSON.parse(document.getElementById('champion-props').textContent);
        hydrateRoot(root, <List {...props} />);
      ` },
    });
    const fixture = { exports: {} as { render: (path: string, list: unknown) => Promise<string> } };
    new Function("require", "module", "exports", bundle.outputFiles[0].text)(createRequire(import.meta.url), fixture, fixture.exports);
    const css = await postcss([tailwind()]).process(await readFile("app/globals.css", "utf8"), { from: "app/globals.css" });
    const { renderToString } = await import("react-dom/server");
    const { createElement } = await import("react");
    const List = (await import("../components/lol/LolChampionList")).default;
    server = createServer((req, res) => {
      if (req.url === "/style.css") { res.setHeader("Content-Type", "text/css"); res.end(css.css); return; }
      if (req.url === "/client.js") { res.setHeader("Content-Type", "text/javascript"); res.end(client.outputFiles[0].text); return; }
      if (req.url === "/interactive") {
        const props = { champions, version: "16.21.1", error: false };
        res.setHeader("Content-Type", "text/html");
        res.end('<!doctype html><html lang="ko"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">'
          + '<link rel="stylesheet" href="/style.css"></head><body class="bg-zinc-950"><div id="champion-root">'
          + renderToString(createElement(List, props)) + '</div><script type="application/json" id="champion-props">'
          + JSON.stringify(props).replace(/</g, "\\u003c") + '</script><script src="/client.js"></script></body></html>');
        return;
      }
      void fixture.exports.render(req.url ?? "/lol/kr/champions", champions).then(html => {
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
        expect(await page.$eval("main", element => element.textContent)).toContain("승률·픽률·밴률은 표본을 충분히 모은 뒤 공개");
        await page.screenshot({ path: `tmp/lol-champions-review/champions-${width}.png` });
      } else {
        expect(await page.$eval("main", element => element.textContent)).toContain("챔피언 목록을 불러오지 못했습니다");
        expect(await page.$('ul[aria-label="챔피언 목록"]')).toBeNull();
      }
    }
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
