import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createServer, type Server } from "node:http";
import { readFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { build } from "esbuild";
import postcss from "postcss";
import tailwind from "@tailwindcss/postcss";
import puppeteer, { type Browser } from "puppeteer";
import type { AugmentAdminData } from "../lib/lol/augments/admin";

const runId = "11111111-1111-4111-8111-111111111111";
const changeId = "22222222-2222-4222-8222-222222222222";
function fixture(): AugmentAdminData {
  return {
    runs: [{ id: runId, client_patch: "16.21", status: "review", counts: { augments: 2 }, error_code: null, started_at: "2026-10-23T00:00:00Z" }],
    patches: [{ client_patch: "16.21", display_patch: "26.21", published_at: null }],
    detail: { patch: "16.21", published: false, runId, warnings: ["설명 완전 치환 비율 검토"],
      notes: [{ url: "https://www.leagueoflegends.com/ko-kr/news/game-updates/league-of-legends-patch-26-21-notes/",
        published_at: "2026-10-20T18:00:00Z", added_names: ["푸른 방어막"], removed_names: [], parse_status: "partial" }],
      changes: [{ id: changeId, platform_id: 3051, change_type: "added", official: false, summary_ko: "푸른 방어막: 신규 · 공식 대조 확인 필요", review_status: "pending" }],
      augments: [{ platformId: 3051, name: "푸른 방어막", rarity: "silver", icon: "assets/ux/kiwi/augments/icons/bluebarrier.png",
        text: "스킬을 사용하면 보호막을 얻습니다. 모바일에서 긴 한국어 설명이 자연스럽게 줄바꿈되어야 합니다.", displaySource: "desc",
        tokens: [{ text: "보호막 흡수량: ", style: [] }, { text: "", label: "주문력", style: ["statIcon"], icon: "scaleAP" },
          { text: " 100 + 주문력의 30%", style: ["shield"], formula: true },
          { text: "증강", label: "증강", style: ["statIcon"], icon: "Augment" },
          { text: " 모바일에서 긴 한국어 설명이 자연스럽게 줄바꿈되어야 합니다.", style: [] }] },
      { platformId: 3052, name: "아티스트 보호", rarity: "gold", icon: null,
        text: "적에게 (수치 미확인)의 추가 피해를 입힙니다.", displaySource: "desc_partial" }] },
  };
}

describe.skipIf(process.env.RUN_LOL_DEV_BROWSER !== "true")("증강 관리자 반응형 fixture", { timeout: 30_000 }, () => {
  let server: Server;
  let browser: Browser;
  let base: string;
  const writes: Array<Record<string, unknown>> = [];
  beforeAll(async () => {
    const js = await build({ stdin: { contents: `import React from 'react';import {createRoot} from 'react-dom/client';
      import Panel from './app/admin/lol/augments/AugmentReviewPanel';createRoot(document.getElementById('root')).render(<Panel/>);`,
      resolveDir: process.cwd(), loader: "tsx" }, bundle: true, write: false, platform: "browser", jsx: "automatic", tsconfig: "tsconfig.json" });
    const css = await postcss([tailwind()]).process(await readFile("app/globals.css", "utf8"), { from: join(process.cwd(), "app/globals.css") });
    server = createServer((request, response) => {
      if (request.url === "/app.js") { response.setHeader("Content-Type", "text/javascript"); response.end(js.outputFiles[0].text); return; }
      if (request.url === "/style.css") { response.setHeader("Content-Type", "text/css"); response.end(css.css); return; }
      if (request.url?.startsWith("/api/admin/lol/augments")) {
        response.setHeader("Content-Type", "application/json");
        if (request.method === "POST") {
          let text = "";
          request.on("data", chunk => { text += chunk; });
          request.on("end", () => { writes.push(JSON.parse(text)); response.end('{"ok":true}'); });
        } else {
          const data = fixture();
          if (writes.some(w => w.action === "review")) data.detail!.changes[0].review_status = "approved";
          if (writes.some(w => w.action === "publish")) data.detail!.published = true;
          response.end(JSON.stringify(data));
        }
        return;
      }
      if (request.url?.startsWith("/api/lol/augment-icons/")) {
        response.setHeader("Content-Type", "image/png");
        response.end(Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQEBAF8L9xkAAAAASUVORK5CYII=", "base64"));
        return;
      }
      if (request.url?.startsWith("/api/")) { response.writeHead(404).end(); return; }
      response.setHeader("Content-Type", "text/html");
      response.end(`<!doctype html><html lang="ko"><head><meta name="viewport" content="width=device-width,initial-scale=1">
        <link rel="stylesheet" href="/style.css"></head><body style="background:#0f172a"><div id="root"></div><script src="/app.js"></script></body></html>`);
    });
    await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("fixture_address");
    base = `http://127.0.0.1:${address.port}`;
    browser = await puppeteer.launch({ headless: true, args: ["--no-sandbox"] });
    await mkdir("tmp/lol-augment-review", { recursive: true });
  }, 60_000);
  afterAll(async () => { await browser?.close(); if (server) await new Promise<void>(resolve => server.close(() => resolve())); });

  it.each([{ width: 375, height: 667 }, { width: 390, height: 844 }, { width: 430, height: 932 }, { width: 1440, height: 1000 }])(
    "$width × $height에서 검토·확인·게시와 줄바꿈을 확인한다", async viewport => {
      writes.length = 0;
      const page = await browser.newPage();
      try {
        await page.setViewport(viewport);
        await page.goto(base);
        await page.waitForSelector('[aria-label="증강 목록 미리보기"]');
        expect(await page.$eval('[data-stat-icon="scaleAP"]', el => el.textContent)).toBe("");
        expect(await page.$eval('[data-stat-icon="scaleAP"]', el => el.getAttribute("aria-label"))).toBe("주문력");
        expect(await page.$eval('[data-stat-icon="Augment"]', el => el.textContent)).toBe("증강");
        expect(await page.$eval('[aria-label="증강 목록 미리보기"]', el => el.textContent)).not.toContain("%i:");
        expect(await page.$eval('[aria-label="증강 목록 미리보기"]', el => el.textContent)).toContain("100 + 주문력의 30%");
        const publish = await page.$('button::-p-text(게시)');
        expect(await publish!.evaluate(el => (el as HTMLButtonElement).disabled)).toBe(true);
        await page.click('button::-p-text(변경 승인)');
        await page.waitForFunction(() => (document.querySelector('input[type="checkbox"]') as HTMLInputElement)?.disabled === false);
        expect(writes[0]).toMatchObject({ action: "review", patch: "16.21", confirm: true, id: changeId, runId });
        expect(await publish!.evaluate(el => (el as HTMLButtonElement).disabled)).toBe(true);
        await page.click('input[type="checkbox"]');
        await page.waitForFunction(() => [...document.querySelectorAll("button")].some(b => b.textContent === "게시" && !b.disabled));
        const overflow = await page.evaluate(() => ({ width: innerWidth, document: document.documentElement.scrollWidth,
          bad: [...document.querySelectorAll("main p, main h3, main button")].filter(el => el.getBoundingClientRect().right > innerWidth + 1).length }));
        expect(overflow.document).toBeLessThanOrEqual(overflow.width);
        expect(overflow.bad).toBe(0);
        expect(await page.$eval("img", el => el.getAttribute("src"))).toMatch(/^\/api\/lol\/augment-icons\/16\.21\//);
        await page.screenshot({ path: `tmp/lol-augment-review/${viewport.width}x${viewport.height}.png`, fullPage: true });
        await page.click('button::-p-text(게시)');
        await page.waitForFunction(() => document.body.textContent?.includes("이미 게시된 패치입니다."));
        expect(writes[1]).toMatchObject({ action: "publish", patch: "16.21", confirm: true });
      } finally { await page.close(); }
    },
  );
  it("빈 실행·오류·로딩 상태를 표시한다", async () => {
    const page = await browser.newPage();
    try {
      await page.setViewport({ width: 375, height: 667 });
      await page.setRequestInterception(true);
      page.on("request", request => {
        if (request.url().includes("/api/admin/lol/augments")) void request.respond({ status: 200, contentType: "application/json",
          body: JSON.stringify({ runs: [], patches: [], detail: null }) });
        else void request.continue();
      });
      await page.goto(base);
      await page.waitForFunction(() => document.body.textContent?.includes("수집 실행이 없습니다."));
      await page.screenshot({ path: "tmp/lol-augment-review/empty.png", fullPage: true });
      page.removeAllListeners("request");
      page.on("request", request => {
        if (request.url().includes("/api/admin/lol/augments")) void request.respond({ status: 503, body: "{}" });
        else void request.continue();
      });
      await page.click('button::-p-text(새로고침)');
      await page.waitForSelector('[role="alert"]');
      expect(await page.$eval('[role="alert"]', el => el.textContent)).toContain("불러오지 못했습니다");
    } finally { await page.close(); }
  });
});
