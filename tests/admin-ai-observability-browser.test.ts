import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createServer, type Server } from "node:http";
import { mkdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { build } from "esbuild";
import postcss from "postcss";
import tailwind from "@tailwindcss/postcss";
import puppeteer, { type Browser } from "puppeteer";

// Isolated rendering of the real component and aggregation; no DB or AI calls.
describe.skipIf(process.env.RUN_ADMIN_AI_BROWSER !== "true")("AI 부분 완료 관제 브라우저", () => {
  let server: Server;
  let browser: Browser;
  let baseUrl: string;
  beforeAll(async () => {
    const bundle = await build({
      stdin: { contents: `import React from 'react';import {createRoot} from 'react-dom/client';
        import {AdminUserCommandCenter} from './components/admin/AdminUserCommandCenter';
        import {buildAiObservability} from './lib/admin-agent/ai-observability';
        const {windows}=buildAiObservability([{user_id:'fixture',status:'partial',error_code:'validation',error_message:'utility:conclusion',created_at:new Date().toISOString()},{user_id:'fixture',status:'cancelled',error_code:'cancelled',cost_usd:0.01,created_at:new Date().toISOString()}],[]);
        const summary=windows.hours24;
        const user={id:'fixture',nickname:'부분완료회원',role:'user',pubg_nickname:null,pubg_platform:null,updated_at:null,activity7d:{totalEvents:0,lastEventAt:null,statsSearchCount:0,topPages:[],summaryBadges:[],events:[],aiRequests:2,aiSuccessCount:1,aiPartialCount:1,aiCancelledCount:1,aiFailedCount:0,aiSuccessRate:50,aiCostUsd:0.01,aiErrors:summary.errorsByReason,aiRecentErrors:[{status:'partial',code:'validation',label:'AI 응답 내용 검증 실패',message:'utility:conclusion',createdAt:new Date().toISOString()}]}};
        createRoot(document.getElementById('root')).render(<AdminUserCommandCenter users={[user]} metrics={{active7dUsers:1,topSearchUsers:[],topPages:[],providers:{},ai24h:summary,ai7d:windows.days7}}/>);`, resolveDir: process.cwd(), loader: "tsx" },
      bundle: true, write: false, platform: "browser", jsx: "automatic", tsconfig: "tsconfig.json",
      define: { "process.env.NODE_ENV": '"production"' },
      plugins: [{ name: "private-player-fixture", setup(builder) {
        builder.onResolve({ filter: /^@\/components\/admin\/AdminPrivatePlayersSection$/ }, () => ({ path: "private", namespace: "fixture" }));
        builder.onLoad({ filter: /.*/, namespace: "fixture" }, () => ({ contents: "export const AdminPrivatePlayersSection=()=>null", loader: "js" }));
      } }],
    });
    const css = await postcss([tailwind()]).process(await readFile("app/globals.css", "utf8"), { from: join(process.cwd(), "app/globals.css") });
    const html = '<!doctype html><html lang="ko"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/style.css"><style>body{margin:0;padding:12px;background:#09090b;color:white}</style><div id="root"></div><script src="/app.js"></script></html>';
    server = createServer((request, response) => {
      response.setHeader("Content-Type", request.url === "/app.js" ? "application/javascript" : request.url === "/style.css" ? "text/css" : "text/html");
      response.end(request.url === "/app.js" ? bundle.outputFiles[0].text : request.url === "/style.css" ? css.css : html);
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Fixture port unavailable");
    baseUrl = `http://127.0.0.1:${address.port}`;
    browser = await puppeteer.launch({ headless: true });
    await mkdir("tmp/admin-ai-observability", { recursive: true });
  }, 90_000);
  afterAll(async () => {
    await browser?.close();
    if (server) await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  it.each([{ width: 375, height: 667 }, { width: 390, height: 844 }, { width: 430, height: 932 }, { width: 1440, height: 900 }])("부분 완료 사유·회원 상세·가로 넘침 $width × $height", async (viewport) => {
    const page = await browser.newPage();
    const errors: string[] = [];
    page.on("pageerror", error => errors.push(String(error)));
    await page.setViewport(viewport);
    await page.setRequestInterception(true);
    page.on("request", request => {
      if (request.url().startsWith(baseUrl + "/")) void request.continue();
      else { errors.push(`Unexpected request: ${request.url()}`); void request.abort(); }
    });
    await page.goto(baseUrl);
    await page.waitForSelector('[aria-label="AI 및 API 오류 관제"]');
    const panel = await page.$('[aria-label="AI 및 API 오류 관제"]');
    expect(await panel!.evaluate(element => element.textContent)).toContain("AI 부분 완료 · AI 응답 내용 검증 실패");
    expect(await panel!.evaluate(element => element.textContent)).toContain("utility:conclusion");
    expect(await panel!.evaluate(element => [...element.querySelectorAll("span")].find(item => item.textContent === "사용자 취소")?.parentElement?.textContent)).toBe("사용자 취소1");
    await page.select('[aria-label="AI 관제 기간"]', "ai7d");
    await page.evaluate(() => {
      const name = [...document.querySelectorAll("strong")].find(element => element.textContent === "부분완료회원");
      if (!name) throw new Error("회원 이름 없음");
      name.click();
    });
    await page.waitForFunction(() => document.body.innerText.includes("최근 7일 AI 사용"));
    const detail = await page.evaluate(() => {
      const title = [...document.querySelectorAll("span")].find(element => element.textContent === "최근 7일 AI 사용");
      return title?.parentElement?.parentElement?.textContent;
    });
    expect(detail).toContain("부분 완료");
    expect(detail).toContain("utility:conclusion");
    expect(detail).toContain("완전 성공");
    expect(detail).toContain("1사용자 취소");
    const overflow = await page.evaluate(() => [...document.querySelectorAll('body *')].filter(element => element.getBoundingClientRect().right > innerWidth + 1).map(element => ({ tag: element.tagName, className: element.className, text: element.textContent?.slice(0, 70), right: element.getBoundingClientRect().right })).slice(0, 12));
    expect(overflow).toEqual([]);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await page.screenshot({ path: `tmp/admin-ai-observability/${viewport.width}.png`, fullPage: true });
    expect(errors).toEqual([]);
    await page.close();
  }, 30_000);
});
