import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createServer, type Server } from "node:http";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { build } from "esbuild";
import postcss from "postcss";
import tailwind from "@tailwindcss/postcss";
import puppeteer, { type Browser, type Page } from "puppeteer";
import { buildSummaryCards } from "@/lib/pubg-analysis/aiSummaryCards";
import { createStatsRequestLedger } from "./helpers/statsBrowserHarness";

const enabled = process.env.RUN_SUMMARY_PARTIAL_BROWSER === "true";
const message = "일부 해석을 보류했습니다. 확인된 경기 기록과 분석을 표시합니다.";
const cards = buildSummaryCards({
  topics: ["화력", "교전 주도권", "포지셔닝"],
  context: { contextId: "partial-browser", gameMode: "squad", matchType: "competitive", tier: "A",
    userMatchCount: 5, benchmarkSampleCount: 12, filterVersion: 1, populationVersion: 1 },
  evidence: [
    { metricId: "damage_average", label: "평균 피해량", userValue: "300", benchmarkValue: "250", benchmarkLabel: "상위권 평균", unit: "", sampleCount: 5 },
    { metricId: "initiative_rate", label: "교전 주도권 비율", userValue: "60%", benchmarkValue: null, benchmarkLabel: "비교 자료 없음", unit: "%", sampleCount: 5 },
    { metricId: "isolation_average", label: "평균 고립 거리", userValue: null, benchmarkValue: null, benchmarkLabel: "상위권 평균", unit: "", sampleCount: null },
  ],
});
const finalCards = cards.map((card, index) => index === 0
  ? { ...card, analysisStatus: "ready", winner: "kind", kindOpinion: "확인된 화력 해석입니다.", spicyOpinion: "교전 선택을 점검하세요.", evaluation: "정상", reason: "확인된 근거" }
  : { ...card, analysisStatus: "unavailable", analysisReason: "해석 보류" });

async function clickText(page: Page, text: string) {
  await page.evaluate((label) => {
    const button = [...document.querySelectorAll("button")].find((entry) => entry.textContent?.includes(label));
    if (!button) throw new Error(`Button missing: ${label}`);
    button.click();
  }, text);
}

(enabled ? describe : describe.skip)("RecentAISummary isolated authenticated browser", () => {
  let server: Server;
  let browser: Browser;
  let baseUrl: string;

  beforeAll(async () => {
    const mocks: Record<string, string> = {
      "next/navigation": "export const useRouter=()=>({push:()=>{}})",
      "@/components/AuthProvider": "export const useAuth=()=>({user:{id:'fixture-user'}})",
      "@/lib/supabase": "export const supabase={auth:{getSession:async()=>({data:{}})}}",
      "@/lib/analytics": "export const trackEvent=()=>{}",
      "@/lib/ai-management": "export const useAIStatus=()=>({isAnalyzing:false});let active=false;export const aiManager={startAnalysis:()=>{if(active)return false;active=true;return true},stopAnalysis:()=>{active=false}}",
      "sonner": "export const toast={error:()=>{}}",
    };
    const bundle = await build({
      stdin: { contents: `import React from 'react';import {createRoot} from 'react-dom/client';
        import {RecentAISummary} from './components/stat/RecentAISummary';
        import {MatchPerformancePanel} from './components/stat/matches/MatchPerformancePanel';
        const root=createRoot(document.getElementById('root'));let nickname='FixturePlayer';let pending=0;window.pendingApplied=0;
        const state=new URLSearchParams(location.search).get('panel');
        const firstReplyEvidence=state==='raw'?undefined:{version:1,eligibleCount:1,alreadyFiringCount:0,unknownCount:0,within3sCount:state==='noReply'?0:1,latencySumMs:state==='noReply'?0:903,noReplyCount:state==='noReply'?1:0};
        const matchData={stats:{timeSurvived:1200,winPlace:5,deathType:'alive'},gameMode:'squad',totalTeams:25,tradeStats:{reactionLatencyMs:3},duelStats:{firstReplyEvidence},benchmark:{score:80,tier:'A',breakdown:{combat:30,tactical:30,survival:20}}};
        const render=()=>root.render(state?<MatchPerformancePanel matchData={matchData} isMobile={innerWidth<768} showTierDetails={true} onToggleTierDetails={()=>{}}/>:<RecentAISummary nickname={nickname} platform="steam" matchIds={['match-1','match-2']} isMobile={innerWidth<768} pendingMatchCount={pending} onApplyPendingMatches={()=>{window.pendingApplied++}}/>);
        window.resetSummary=()=>{nickname='OtherPlayer';render()};
        window.setPendingMatches=(count)=>{pending=count;render()};
        const realNow=Date.now;let offset=0;Date.now=()=>realNow()+offset;
        window.advanceSummaryTime=(seconds)=>{offset+=seconds*1000};render();`, resolveDir: process.cwd(), loader: "tsx" },
      bundle: true, write: false, platform: "browser", jsx: "automatic", tsconfig: "tsconfig.json",
      define: { "process.env.NODE_ENV": '"production"' },
      plugins: [{ name: "summary-fixture-mocks", setup(builder) {
        builder.onResolve({ filter: /^(next\/navigation|@\/components\/AuthProvider|@\/lib\/(supabase|analytics|ai-management)|sonner)$/ }, (args) => ({ path: args.path, namespace: "summary-mock" }));
        builder.onLoad({ filter: /.*/, namespace: "summary-mock" }, (args) => ({ contents: mocks[args.path], loader: "js" }));
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
  }, 90_000);

  afterAll(async () => {
    await browser?.close();
    if (server) await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  it.each([{ width: 375, height: 667 }, { width: 390, height: 844 }, { width: 430, height: 932 }, { width: 1440, height: 900 }])("expired and pending data errors fit at $width", async (viewport) => {
    for (const errorCode of ["PUBG_MATCH_DETAIL_EXPIRED", "PUBG_AI_CANONICAL_NOT_READY"]) {
      const page = await browser.newPage();
      await page.setViewport(viewport);
      const errors: string[] = [];
      page.on("pageerror", error => errors.push(String(error)));
      await page.setRequestInterception(true);
      page.on("request", async request => {
        if (!request.url().endsWith("/api/pubg/ai-summary")) return void await request.continue();
        await request.respond({status:errorCode === "PUBG_MATCH_DETAIL_EXPIRED" ? 410 : 409,contentType:"application/json",body:JSON.stringify({errorCode,error:"data unavailable"})});
      });
      try {
        await page.goto(baseUrl, {waitUntil:"networkidle0"});
        await clickText(page, "최근 최대 10경기 AI 끝장 토론 시작");
        const title = errorCode === "PUBG_MATCH_DETAIL_EXPIRED" ? "분석할 경기의 상세 제공 기간이 지났습니다." : "최근 경기의 분석 데이터가 아직 준비되지 않았습니다.";
        await page.waitForFunction(text => document.body.innerText.includes(text), {}, title);
        expect(await page.evaluate(() => document.body.innerText)).not.toContain("서버가 바쁘거나 네트워크가 불안정");
        expect(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth)).toBe(false);
        expect(errors).toEqual([]);
        if (process.env.SUMMARY_BROWSER_SCREENSHOT_DIR) await page.screenshot({path:join(process.env.SUMMARY_BROWSER_SCREENSHOT_DIR,`data-error-${errorCode}-${viewport.width}.png`)});
      } finally {await page.close();}
    }
  }, 30_000);

  it.each([{ width: 375, height: 667 }, { width: 390, height: 844 }, { width: 430, height: 932 }, { width: 1440, height: 900 }])("partial success, cooldown, facts, identity and overflow at $width", async (viewport) => {
    const page = await browser.newPage();
    const ledger = createStatsRequestLedger();
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(String(error)));
    await page.setViewport(viewport);
    await page.setRequestInterception(true);
    page.on("request", async (request) => {
      if (!request.url().endsWith("/api/pubg/ai-summary")) {
        await request.continue();
        return;
      }
      const record = ledger.start({ method: request.method(), url: request.url(), pathname: "/api/pubg/ai-summary", query: {}, body: JSON.parse(request.postData() ?? "{}"), semanticKey: "summary", category: "stats-api" });
      const lines = [
        { type: "visuals", data: { overallTier: "A" } },
        { type: "cards", data: cards },
        { type: "final", data: JSON.stringify({ schemaVersion: 2, analysisStatus: "partial", cards: finalCards, retryAfterSeconds: 300, signature: null, actionItems: null, finalVerdict: "확인된 항목만 평가했습니다." }) },
        { type: "done", valid: true, partial: true, retryAfterSeconds: 300 },
      ];
      await request.respond({ status: 200, contentType: "application/x-ndjson", body: lines.map((line) => JSON.stringify(line)).join("\n") });
      ledger.complete(record, 200, true);
    });
    try {
      await page.goto(baseUrl, { waitUntil: "networkidle0" });
      await clickText(page, "최근 최대 10경기 AI 끝장 토론 시작");
      await page.waitForFunction((text) => document.body.innerText.includes(text), {}, message);
      expect(ledger.records).toHaveLength(1);
      expect(await page.$eval('[role="status"] button', (button) => (button as HTMLButtonElement).disabled)).toBe(true);
      await clickText(page, "300초 후 다시 시도하기");
      expect(ledger.records).toHaveLength(1);
      expect(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth)).toBe(false);
      await clickText(page, "상세 분석 리포트 펼치기");
      await clickText(page, "화력은 비슷한 조건 평균과 비교해 어떤가");
      await page.waitForFunction(() => document.body.innerText.includes("확인된 화력 해석입니다."));
      expect(await page.evaluate(() => document.body.innerText)).toContain("300");
      expect(await page.evaluate(() => document.body.innerText)).toContain("250");
      expect(await page.evaluate(() => document.body.innerText)).toContain("착한맛 지지 항목");
      expect(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth)).toBe(false);
      await page.evaluate(() => (window as unknown as { advanceSummaryTime(seconds: number): void }).advanceSummaryTime(300));
      await page.waitForFunction(() => !(document.querySelector('[role="status"] button') as HTMLButtonElement)?.disabled);
      expect(ledger.records).toHaveLength(1);
      await clickText(page, "다시 시도하기");
      await page.waitForFunction(() => (document.querySelector('[role="status"] button') as HTMLButtonElement)?.disabled);
      expect(ledger.records).toHaveLength(2);
      await page.evaluate(() => (window as unknown as { resetSummary(): void }).resetSummary());
      await page.waitForFunction(() => document.body.innerText.includes("최근 최대 10경기 AI 끝장 토론 시작"));
      expect(await page.$('[role="status"]')).toBeNull();
      expect(await page.evaluate(() => document.body.innerText)).not.toContain("확인된 화력 해석입니다.");
      expect(errors).toEqual([]);
      ledger.assertNoUnexpected();
    } finally {
      await page.close();
    }
  }, 30_000);

  it.each([{ width: 375, height: 667 }, { width: 390, height: 844 }, { width: 430, height: 932 }, { width: 1440, height: 900 }])("new recent match notice keeps the shown result and fits at $width", async (viewport) => {
    const page = await browser.newPage();
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(String(error)));
    await page.setViewport(viewport);
    await page.setRequestInterception(true);
    let requests = 0;
    page.on("request", async (request) => {
      if (!request.url().endsWith("/api/pubg/ai-summary")) {
        await request.continue();
        return;
      }
      requests += 1;
      const lines = [
        { type: "visuals", data: { overallTier: "A" } },
        { type: "cards", data: cards },
        { type: "final", data: JSON.stringify({ schemaVersion: 2, analysisStatus: "partial", cards: finalCards, retryAfterSeconds: 300, signature: null, actionItems: null, finalVerdict: "확인된 항목만 평가했습니다." }) },
        { type: "done", valid: true, partial: true, retryAfterSeconds: 300 },
      ];
      await request.respond({ status: 200, contentType: "application/x-ndjson", body: lines.map((line) => JSON.stringify(line)).join("\n") });
    });
    try {
      await page.goto(baseUrl, { waitUntil: "networkidle0" });
      await clickText(page, "최근 최대 10경기 AI 끝장 토론 시작");
      await page.waitForFunction((text) => document.body.innerText.includes(text), {}, message);
      await page.evaluate(() => (window as unknown as { setPendingMatches(count: number): void }).setPendingMatches(3));
      const notice = "새로 저장된 최근 경기 3개가 있습니다. 현재 분석은 이전 경기 목록 기준이며, 반영하면 현재 결과를 닫고 다시 분석할 수 있습니다.";
      await page.waitForFunction((text) => document.body.innerText.includes(text), {}, notice);
      expect(await page.evaluate(() => document.body.innerText)).toContain(message);
      expect(await page.evaluate(() => (window as unknown as { pendingApplied: number }).pendingApplied)).toBe(0);
      expect(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth)).toBe(false);
      if (process.env.SUMMARY_BROWSER_SCREENSHOT_DIR) await page.screenshot({ path: join(process.env.SUMMARY_BROWSER_SCREENSHOT_DIR, `pending-notice-${viewport.width}.png`) });
      await clickText(page, "최신 경기 반영하기");
      expect(await page.evaluate(() => (window as unknown as { pendingApplied: number }).pendingApplied)).toBe(1);
      expect(requests).toBe(1);
      expect(errors).toEqual([]);
    } finally {
      await page.close();
    }
  }, 30_000);

  it.each([{ width: 375, height: 667 }, { width: 390, height: 844 }, { width: 430, height: 932 }, { width: 1440, height: 900 }])("role identity evidence and badges fit at $width", async (viewport) => {
    const page = await browser.newPage();
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(String(error)));
    await page.setViewport(viewport);
    await page.setRequestInterception(true);
    page.on("request", async (request) => {
      if (!request.url().endsWith("/api/pubg/ai-summary")) {
        await request.continue();
        return;
      }
      const roleInfo = {
        primaryRole: "executor", secondaryRole: "pointMan", title: "선봉의 심판자", roleLabel: "처형자 (Executor) · 보조: 선봉대",
        description: "1:1 교전을 끝까지 이겨 내고, 불리한 교전도 뒤집습니다.",
        evidence: ["1:1 승률 상위 3%", "역전 승률 상위 12%"], badges: ["차량 교전", "Mk14 EBR 주력"],
        signatureWeapon: "Mk14 EBR", signatureWeaponStats: { kills: 12, dbnos: 9 }, scores: { executor: 97.5 },
      };
      const lines = [
        { type: "visuals", data: { overallTier: "A", roleInfo, reactionLatency:"측정 불가", reactionTier:"측정 불가" } },
        { type: "cards", data: cards },
        { type: "final", data: JSON.stringify({ schemaVersion: 2, analysisStatus: "partial", cards: finalCards, retryAfterSeconds: 300, signature: null, actionItems: null, finalVerdict: "확인된 항목만 평가했습니다." }) },
        { type: "done", valid: true, partial: true, retryAfterSeconds: 300 },
      ];
      await request.respond({ status: 200, contentType: "application/x-ndjson", body: lines.map((line) => JSON.stringify(line)).join("\n") });
    });
    try {
      await page.goto(baseUrl, { waitUntil: "networkidle0" });
      await clickText(page, "최근 최대 10경기 AI 끝장 토론 시작");
      await page.waitForFunction((text) => document.body.innerText.includes(text), {}, message);
      await clickText(page, "상세 분석 리포트 펼치기");
      // 상세 리포트는 펼침 애니메이션이 끝나야 보인다.
      await page.waitForSelector('[aria-label="칭호 근거"]', { visible: true });
      const text = await page.evaluate(() => document.body.innerText);
      expect(text).toContain("1:1 승률 상위 3% · 역전 승률 상위 12%");
      expect(text).toContain("Mk14 EBR 주력");
      await page.click('[aria-label="반격 소요 시간 측정 불가 사유"]');
      await page.waitForFunction(() => document.body.innerText.includes("측정 불가는 느린 반응이나 실력 부족을 뜻하지 않습니다."));
      expect(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth)).toBe(false);
      if (process.env.SUMMARY_BROWSER_SCREENSHOT_DIR) {
        await page.$eval('[aria-label="칭호 근거"]', (element) => element.scrollIntoView({ block: "center" }));
        await page.screenshot({ path: join(process.env.SUMMARY_BROWSER_SCREENSHOT_DIR, `role-identity-${viewport.width}.png`) });
      }
      expect(errors).toEqual([]);
    } finally {
      await page.close();
    }
  }, 30_000);
  it.each([{width:375,height:667},{width:390,height:844},{width:430,height:932},{width:1440,height:900}])('qualified single-match reply states at $width', async (viewport) => {
    const page=await browser.newPage();
    const errors:string[]=[];
    page.on('pageerror',error=>errors.push(String(error)));
    await page.setViewport(viewport);
    try {
      for (const state of ['raw','valid','noReply']) {
        await page.goto(`${baseUrl}?panel=${state}`,{waitUntil:'networkidle0'});
        await page.waitForFunction(()=>document.body.innerText.includes('반격 소요 시간'));
        const text=await page.evaluate(()=>document.body.innerText);
        expect(text).toContain(state==='valid'?'0.90초':'측정 불가');
        expect(text).not.toContain('0.00초');
        expect(text).not.toContain('선제공격률');
        expect(text).toContain('선제 타격 성공률');
        expect(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth)).toBe(false);
        if(process.env.SUMMARY_BROWSER_SCREENSHOT_DIR) await page.screenshot({path:join(process.env.SUMMARY_BROWSER_SCREENSHOT_DIR,`reply-${state}-${viewport.width}.png`),fullPage:true});
      }
      expect(errors).toEqual([]);
    } finally {await page.close();}
  },30_000);

});
