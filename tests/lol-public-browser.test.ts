import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createServer, type Server } from "node:http";
import { mkdir, readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { build, type Plugin } from "esbuild";
import postcss from "postcss";
import tailwind from "@tailwindcss/postcss";
import puppeteer, { type Browser, type Page } from "puppeteer";
import { fixtureResult } from "./fixtures/lol/browserScenario";

const navigation = `
  import { useSyncExternalStore } from 'react';
  const subscribe = cb => { addEventListener('fixture-nav', cb); return () => removeEventListener('fixture-nav', cb); };
  export const usePathname = () => useSyncExternalStore(subscribe, () => location.pathname, () => '/lol/kr');
  export const useSearchParams = () => new URLSearchParams();
  export const useRouter = () => ({ push(path) { history.pushState(null, '', path); dispatchEvent(new Event('fixture-nav')); } });
  export const notFound = () => { throw new Error('404'); };
`;
const stubs: Plugin = { name: "lol-public-fixture", setup(builder) {
  builder.onResolve({ filter: /^(next\/navigation|next\/script|server-only|@\/lib\/lol\/publicAccess\.server|@\/components\/common\/Footer)$/ }, args => ({ path: args.path, namespace: "fixture" }));
  builder.onLoad({ filter: /.*/, namespace: "fixture" }, args => ({ loader: "js", resolveDir: process.cwd(), contents:
    args.path === "@/lib/lol/publicAccess.server" ? "export const requireLolPublicPage = () => {};"
      : args.path === "next/navigation" ? navigation : args.path === "next/script"
      ? "import React from 'react'; export default props => React.createElement('script', props);"
      : "export default () => null;",
  }));
} };

describe.skipIf(process.env.RUN_LOL_PUBLIC_BROWSER !== "true")("LoL 공개 페이지 fixture", { timeout: 30_000 }, () => {
  let server: Server; let browser: Browser; let base: string;
  beforeAll(async () => {
    const shared = { bundle: true, write: false, jsx: "automatic" as const, tsconfig: "tsconfig.json", plugins: [stubs] };
    const ssr = await build({ ...shared, platform: "node", format: "cjs", define: { "process.env.LOL_PUBLIC_ENABLED": '"true"', "process.env.NODE_ENV": '"production"', "process.env": "{}" },
      stdin: { loader: "tsx", resolveDir: process.cwd(), contents: `
        import React from 'react'; import { renderToString } from 'react-dom/server';
        import Layout from './app/lol/layout'; import Page from './app/lol/kr/page';
        import Wrapper from './components/layout/SidebarFooterWrapper';
        export const render = () => renderToString(<Wrapper><Layout><Page /></Layout></Wrapper>);
      ` },
    });
    const fixtureModule = { exports: {} as { render: () => string } };
    new Function("require", "module", "exports", ssr.outputFiles![0].text)(createRequire(import.meta.url), fixtureModule, fixtureModule.exports);
    const html = fixtureModule.exports.render();
    const client = await build({ ...shared, platform: "browser", format: "iife", metafile: true,
      define: { "process.env.NODE_ENV": '"production"', "process.env": "{}" },
      stdin: { loader: "tsx", resolveDir: process.cwd(), contents: `
        import React from 'react'; import { hydrateRoot } from 'react-dom/client'; import { usePathname } from 'next/navigation';
        import Panel from './components/lol/LolSearchPanel'; import Wrapper from './components/layout/SidebarFooterWrapper';
        import { parseLolRiotIdParam } from './lib/lol/riotId';
        function App() {
          React.useEffect(() => { document.documentElement.dataset.lolFixtureHydrated = "true"; }, []);
          const path = usePathname();
          const id = path === '/lol/kr' ? undefined : parseLolRiotIdParam(path.slice('/lol/kr/'.length));
          return <Wrapper><Panel publicView initialRiotId={id ?? undefined} /></Wrapper>;
        }
        hydrateRoot(document.getElementById('root'), <App />);
      ` },
    });
    expect(Object.keys(client.metafile!.inputs).filter(path => /Lol(?:Ops|Collection)Panel/.test(path))).toEqual([]);
    const css = await postcss([tailwind()]).process(await readFile("app/globals.css", "utf8"), { from: "app/globals.css" });
    server = createServer((req, res) => {
      if (req.url === "/app.js") { res.setHeader("Content-Type", "text/javascript"); res.end(client.outputFiles![0].text); return; }
      if (req.url === "/style.css") { res.setHeader("Content-Type", "text/css"); res.end(css.css); return; }
      if (req.url === "/api/lol/search") {
        let body = ""; req.on("data", chunk => { body += chunk; }); req.on("end", () => {
          const { riotId } = JSON.parse(body);
          res.setHeader("Content-Type", "application/json");
          if (riotId.startsWith("오류#")) { res.statusCode = 429; res.end(JSON.stringify({ error: "요청이 많습니다. 잠시 후 다시 시도해 주세요." })); }
          else res.end(JSON.stringify({ ...fixtureResult, account: { gameName: "홍길동", tagLine: "KR1" } }));
        }); return;
      }
      res.setHeader("Content-Type", "text/html");
      res.end('<!doctype html><html lang="ko"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">'
        + '<link rel="stylesheet" href="/style.css"></head><body><div id="root">' + html + '</div><script defer src="/app.js"></script></body></html>');
    });
    await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
    const address = server.address(); if (!address || typeof address === "string") throw new Error("fixture 서버 시작 실패");
    base = `http://127.0.0.1:${address.port}`;
    browser = await puppeteer.launch({ headless: true });
    await mkdir("tmp/lol-public-review", { recursive: true });
  }, 90_000);
  afterAll(async () => { await browser?.close(); if (server) await new Promise<void>(resolve => server.close(() => resolve())); });

  async function open(width: number, height: number) {
    const page = await browser.newPage();
    await page.setViewport({ width, height });
    page.setDefaultTimeout(5000); page.setDefaultNavigationTimeout(10000);
    await page.setRequestInterception(true);
    page.on("request", req => { if (req.url().startsWith(base)) void req.continue(); else void req.abort(); });
    await page.goto(`${base}/lol/kr`, { waitUntil: "domcontentloaded" }); await page.waitForFunction(() => document.documentElement.dataset.lolFixtureHydrated === "true"); return page;
  }
  async function search(page: Page, name: string) {
    await page.type("#lol-riot-id", name); await page.click('form button[type="submit"]');
  }
  it.each([[375, 667], [390, 844], [430, 932], [1440, 900]])("공개 검색·전적·상세와 고지가 %ix%i에서 표시된다", async (width, height) => {
    const page = await open(width, height); const calls: string[] = []; const errors: string[] = [];
    page.on("request", req => { if (req.url().includes("/api/")) calls.push(req.url()); });
    page.on("pageerror", error => errors.push(String(error)));
    await search(page, "홍길동#KR1"); await page.waitForSelector('section[aria-label="최근 경기"] article');
    expect(page.url()).toBe(`${base}/lol/kr/${encodeURIComponent("홍길동-KR1")}`);
    await page.click('button[aria-label="경기 상세 보기"]');
    await page.waitForSelector('[data-testid="lol-player-row"]');
    const body = await page.$eval("body", element => element.textContent ?? "");
    for (const text of ["운영 상태", "계정 데이터 삭제", "수집 시작", "관리자 전용"]) expect(body).not.toContain(text);
    expect(body).toContain("BGMS isn't endorsed by Riot Games"); expect(body).toContain("상표 또는 등록 상표");
    expect(await page.$$eval('script[src*="googlesyndication"], ins.adsbygoogle', nodes => nodes.length)).toBe(0);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    expect(calls).toEqual([`${base}/api/lol/search`]); expect(errors).toEqual([]);
    await page.screenshot({ path: `tmp/lol-public-review/${width}x${height}.png`, fullPage: true }); await page.close();
  });
  it("모바일 빈 화면·429 안내가 표시된다", async () => {
    const page = await open(390, 844); expect(await page.$('section[aria-label="최근 경기"]')).toBeNull();
    await search(page, "오류#KR1"); await page.waitForSelector('[role="alert"]');
    expect(await page.$eval('[role="alert"]', element => element.textContent)).toContain("잠시 후"); await page.close();
  });
});
