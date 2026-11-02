import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createServer, type Server } from "node:http";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { build } from "esbuild";
import postcss from "postcss";
import tailwind from "@tailwindcss/postcss";
import puppeteer, { type Browser } from "puppeteer";
import squadReady from "./fixtures/stats/squad-ready.json";
import { SQUAD_AI_FACTS_ONLY_ERROR_CODE, SQUAD_AI_TOO_FEW_MATCHES_ERROR_CODE } from "@/lib/pubg-analysis/squadAiContract";

// 스쿼드 AI 패널의 사실 응답·경기 부족 상태를 실제 브라우저 레이아웃으로 확인한다. 외부 요청은 모두 fixture로 응답한다.
const enabled = process.env.RUN_SQUAD_PANEL_BROWSER === "true";
const viewports = [{ width: 375, height: 667 }, { width: 390, height: 844 }, { width: 430, height: 932 }, { width: 1440, height: 900 }];

(enabled ? describe : describe.skip)("SquadAnalysisPanel isolated browser", () => {
  let server: Server;
  let browser: Browser;
  let baseUrl: string;

  beforeAll(async () => {
    const mocks: Record<string, string> = {
      "next/navigation": "export const useRouter=()=>({push:()=>{}})",
      "next/dynamic": "export default function dynamic(){return function Empty(){return null}}",
      "@/components/AuthProvider": "export const useAuth=()=>({user:{id:'fixture-user'}})",
      "@/lib/supabase": "export const supabase={auth:{getSession:async()=>({data:{}})}}",
      "@/lib/analytics": "export const trackEvent=()=>{}",
      "@/lib/ai-management": "export const useAIStatus=()=>({isAnalyzing:false});let active=false;export const aiManager={startAnalysis:()=>{if(active)return false;active=true;return true},stopAnalysis:()=>{active=false}}",
      "sonner": "export const toast={error:()=>{},success:()=>{}}",
      "squad-2d-map": "export default function Squad2DMap(){return null}",
    };
    const bundle = await build({
      stdin: { contents: `import React from 'react';import {createRoot} from 'react-dom/client';
        import SquadAnalysisPanel from './components/stat/SquadAnalysisPanel';
        createRoot(document.getElementById('root')).render(<SquadAnalysisPanel nickname="FixturePlayer" platform="steam" groupKey="g1" onGroupKeyChange={()=>{}}/>);`,
        resolveDir: process.cwd(), loader: "tsx" },
      bundle: true, write: false, platform: "browser", jsx: "automatic", tsconfig: "tsconfig.json",
      define: { "process.env.NODE_ENV": '"production"' },
      plugins: [{ name: "squad-fixture-mocks", setup(builder) {
        builder.onResolve({ filter: /^(next\/navigation|next\/dynamic|@\/components\/AuthProvider|@\/lib\/(supabase|analytics|ai-management)|sonner)$/ }, (args) => ({ path: args.path, namespace: "squad-mock" }));
        // 2D 지도는 동적 import라 이 확인과 무관하다. leaflet CSS·이미지를 번들하지 않게 빈 모듈로 대신한다.
        builder.onResolve({ filter: /\/Squad2DMap$/ }, () => ({ path: "squad-2d-map", namespace: "squad-mock" }));
        builder.onLoad({ filter: /.*/, namespace: "squad-mock" }, (args) => ({ contents: mocks[args.path], loader: "js" }));
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
    browser = await puppeteer.launch({ headless: true, args: ["--no-sandbox", "--disable-setuid-sandbox"] });
  }, 120_000);

  afterAll(async () => {
    await browser?.close();
    if (server) await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  it.each(viewports)("facts-only and too-few states fit at $width", async (viewport) => {
    for (const name of ["facts-only", "too-few"] as const) {
      const page = await browser.newPage();
      const errors: string[] = [];
      page.on("pageerror", (error) => errors.push(String(error)));
      await page.setViewport(viewport);
      await page.setRequestInterception(true);
      page.on("request", async (request) => {
        const url = new URL(request.url());
        if (url.pathname === "/api/pubg/squad-analyze") {
          const groupKey = url.searchParams.get("groupKey");
          const body = groupKey ? (squadReady.details as Record<string, unknown>)[groupKey] : { groups: squadReady.groups };
          await request.respond({ status: 200, contentType: "application/json", body: JSON.stringify(body) });
          return;
        }
        if (url.pathname === "/api/pubg/ai-squad") {
          const response = name === "facts-only"
            ? { status: 200, body: { mode: "facts_only", reason: "timeout", errorCode: SQUAD_AI_FACTS_ONLY_ERROR_CODE, message: "AI 해석을 완료하지 못했습니다. 계산된 팀 지표는 그대로 확인할 수 있습니다. 잠시 후 다시 시도해 주세요.", retryable: true } }
            : { status: 409, body: { error: "too few", errorCode: SQUAD_AI_TOO_FEW_MATCHES_ERROR_CODE, retryable: false } };
          await request.respond({ status: response.status, contentType: "application/json", body: JSON.stringify(response.body) });
          return;
        }
        await request.continue();
      });
      try {
        await page.goto(baseUrl, { waitUntil: "networkidle0" });
        await page.waitForFunction(() => [...document.querySelectorAll("button")].some((b) => b.textContent?.includes("AI 코칭 보고서 생성")), { timeout: 15_000 });
        await page.evaluate(() => [...document.querySelectorAll("button")].find((b) => b.textContent?.includes("AI 코칭 보고서 생성"))!.click());
        const expected = name === "facts-only" ? "계산된 팀 지표는 그대로" : "3경기 이상 함께 플레이하면";
        await page.waitForFunction((text) => document.body.innerText.includes(text), { timeout: 15_000 }, expected);
        // 경기 부족은 다시 눌러도 같은 결과라 생성 버튼을 막고, 사실 응답은 다시 시도할 수 있게 둔다.
        const generateDisabled = await page.evaluate(() => (([...document.querySelectorAll("button")].find((b) => b.textContent?.includes("AI 코칭 보고서 생성")) as HTMLButtonElement | undefined)?.disabled));
        expect(generateDisabled).toBe(name === "too-few");
        if (name === "facts-only") expect(await page.evaluate(() => document.body.innerText.includes("다시 시도"))).toBe(true);
        expect(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth)).toBe(false);
        if (process.env.SQUAD_PANEL_SCREENSHOT_DIR) {
          await page.evaluate((text) => [...document.querySelectorAll("p")].find((p) => p.textContent?.includes(text))?.scrollIntoView({ block: "center" }), expected);
          await page.screenshot({ path: join(process.env.SQUAD_PANEL_SCREENSHOT_DIR, `squad-${name}-${viewport.width}.png`) });
        }
        expect(errors).toEqual([]);
      } finally {
        await page.close();
      }
    }
  }, 90_000);
});
