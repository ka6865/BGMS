import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createServer, type Server } from "node:http";
import { mkdir, readFile } from "node:fs/promises";
import { build } from "esbuild";
import postcss from "postcss";
import tailwind from "@tailwindcss/postcss";
import puppeteer, { type Browser } from "puppeteer";
import type { LolMayhemCatalog } from "../lib/lol/augments/catalog";

const catalog: LolMayhemCatalog = {
  clientPatch: "16.21", displayPatch: "26.21", releasedAt: "2026-10-20T18:00:00Z", notesUrl: "https://example.test/notes",
  removed: ["타오르는 이자", "Hide on bush"],
  augments: Array.from({ length: 12 }, (_, index) => ({
    id: index + 1, name: index === 0 ? "아주 긴 이름을 가진 증강으로 줄바꿈을 확인합니다" : `증강 ${index + 1}`, nameEn: `Augment ${index + 1}`,
    rarity: (["prismatic", "gold", "silver"] as const)[index % 3], icon: index === 1 ? null : `assets/ux/kiwi/augments/icons/a${index}.png`,
    text: "공격 사거리가 원거리 100 / 근접 150 증가합니다. ".repeat(index === 0 ? 8 : 1), notice: index === 0 ? "스킬 이름은 챔피언마다 다릅니다" : null, isNew: index % 4 === 0,
  })),
};

describe.skipIf(process.env.RUN_LOL_DEV_BROWSER !== "true")("LoL 증바람 공개 페이지 브라우저 fixture", { timeout: 30_000 }, () => {
  let server: Server; let browser: Browser; let base: string;
  beforeAll(async () => {
    const client = await build({ bundle: true, write: false, platform: "browser", format: "iife", jsx: "automatic", tsconfig: "tsconfig.json",
      define: { "process.env.NODE_ENV": '"production"' },
      stdin: { loader: "tsx", resolveDir: process.cwd(), contents: `
        import { hydrateRoot } from 'react-dom/client'; import View from './components/lol/LolMayhemView';
        hydrateRoot(document.getElementById('root'), <View {...JSON.parse(document.getElementById('props').textContent)} />);
      ` },
    });
    const css = await postcss([tailwind()]).process(await readFile("app/globals.css", "utf8"), { from: "app/globals.css" });
    const { renderToString } = await import("react-dom/server");
    const { createElement } = await import("react");
    const View = (await import("../components/lol/LolMayhemView")).default;
    server = createServer((req, res) => {
      if (req.url === "/style.css") { res.setHeader("Content-Type", "text/css"); res.end(css.css); return; }
      if (req.url === "/client.js") { res.setHeader("Content-Type", "text/javascript"); res.end(client.outputFiles[0].text); return; }
      const props = req.url === "/error" ? { catalog: null, error: true } : req.url === "/empty" ? { catalog: null } : { catalog };
      res.setHeader("Content-Type", "text/html");
      res.end('<!doctype html><html lang="ko"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">'
        + `<link rel="stylesheet" href="/style.css"></head><body class="bg-zinc-950"><div id="root">${renderToString(createElement(View, props))}</div>`
        + `<script type="application/json" id="props">${JSON.stringify(props).replace(/</g, "\\u003c")}</script><script src="/client.js"></script></body></html>`);
    });
    await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
    const address = server.address(); if (!address || typeof address === "string") throw new Error("fixture 주소 확인 실패");
    base = `http://127.0.0.1:${address.port}`; browser = await puppeteer.launch({ headless: true });
    await mkdir("tmp/lol-mayhem-review", { recursive: true });
  }, 90_000);
  afterAll(async () => { await browser?.close(); if (server) await new Promise<void>(resolve => server.close(() => resolve())); });

  it.each([[375, 667], [390, 844], [430, 932], [1440, 900]])("%ix%i에서 검색·등급·신규 필터와 빈·오류 상태가 넘치지 않는다", async (width, height) => {
    const page = await browser.newPage(); await page.setViewport({ width, height });
    const errors: string[] = []; page.on("pageerror", error => errors.push(String(error)));
    await page.setRequestInterception(true);
    page.on("request", request => { if (request.url().startsWith(base) && !request.url().includes("/api/lol/")) void request.continue(); else void request.abort(); });
    const noOverflow = () => page.evaluate(() => document.documentElement.scrollWidth <= innerWidth);
    const count = () => page.$$eval('ul[aria-label="증강 목록"] > li', items => items.length);
    const press = (label: string) => page.$$eval('[role="group"] button', (buttons, text) => (buttons as HTMLElement[]).find(button => button.textContent === text)!.click(), label);

    await page.goto(base, { waitUntil: "networkidle0" });
    expect(await count()).toBe(12); expect(await noOverflow()).toBe(true);
    expect(await page.$eval('ul[aria-label="증강 목록"] img', image => image.getAttribute("src"))).toBe("/api/lol/augment-icons/16.21/assets/ux/kiwi/augments/icons/a0.png");
    await page.screenshot({ path: `tmp/lol-mayhem-review/${width}x${height}.png` });
    await press("프리즘");
    expect(await page.$$eval('ul[aria-label="증강 목록"] > li', items => items.every(item => item.getAttribute("data-rarity") === "prismatic"))).toBe(true);
    await press("신규만"); expect(await count()).toBe(1);
    await press("전체"); await press("신규만");
    await page.type('input[type="search"]', "Augment 2"); expect(await count()).toBe(1);
    await page.type('input[type="search"]', "없는이름");
    expect(await page.$eval("main", main => main.textContent)).toContain("조건에 맞는 증강이 없습니다.");
    expect(await noOverflow()).toBe(true);
    expect(await page.$$eval("button, input", items => items.every(item => item.getBoundingClientRect().height >= 44))).toBe(true);

    await page.goto(`${base}/error`, { waitUntil: "networkidle0" });
    expect(await page.$eval('[role="alert"]', alert => alert.textContent)).toContain("불러오지 못했습니다");
    await page.goto(`${base}/empty`, { waitUntil: "networkidle0" });
    expect(await page.$eval("main", main => main.textContent)).toContain("아직 게시된 증강 정보가 없습니다.");
    expect(await noOverflow()).toBe(true); expect(errors).toEqual([]);
    await page.close();
  });
});
