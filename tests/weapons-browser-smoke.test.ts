import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { createServer, type Server } from "node:http";
import { mkdir } from "node:fs/promises";
import puppeteer, { type Browser, type Page } from "puppeteer";
import { startOwnedStatsDevServer } from "./helpers/statsBrowserHarness";
import type { OfficialItem } from "@/lib/patch-notes/officialCatalog";
import officialWeapons from "./fixtures/catalog/simulator-weapons.json";
import storedAttachments from "./fixtures/catalog/simulator-attachments.json";

const viewports = [{ width: 375, height: 667 }, { width: 390, height: 844 }, { width: 430, height: 932 }, { width: 1440, height: 1000 }];
const m416 = { ...officialWeapons.find((item) => item.key === "m416")!, category: { key: "ar", name: "돌격소총" } };
const akm = { ...officialWeapons.find((item) => item.key === "akm")!, category: { key: "ar", name: "돌격소총" } };
const items: OfficialItem[] = [m416, akm,
  ...Array.from({ length: 24 }, (_, index) => ({ ...m416, key: `fixture-${index}`, name: `연습 무기 ${index + 1}` })),
  { ...m416, key: "unlinked", name: "미연결 무기", category: { key: "etc", name: "기타" }, ammunition: null },
  { ...m416, key: "legacy", name: "분류 없는 구형 무기", category: undefined },
];
const weaponRows = [
  { id: "ar_m416", name: "M416", type: "AR", ammo: "5.56mm", damage: 41, bullet_speed: 880, patch_version: "업데이트 42.1", patch_applied_at: "2026-07-30T12:00:00Z" },
  { id: "ar_akm", name: "AKM", type: "AR", ammo: "7.62mm", damage: 48, bullet_speed: 715 },
];
const attachments = storedAttachments.map((part) => ({ type: "attachment", r2_key: null, ...part }));

describe.skipIf(process.env.RUN_WEAPONS_BROWSER_SMOKE !== "true")("도감 실제 Next 페이지 fixture 브라우저", { timeout: 45_000 }, () => {
  let stub: Server;
  let server: Awaited<ReturnType<typeof startOwnedStatsDevServer>>;
  let browser: Browser;
  let failCatalog = false;
  let emptyCatalog = false;
  const writes: string[] = [];

  beforeAll(async () => {
    stub = createServer((request, response) => {
      response.setHeader("Access-Control-Allow-Origin", "*");
      response.setHeader("Access-Control-Allow-Headers", "*");
      if (request.method === "OPTIONS") { response.end(); return; }
      if (request.method !== "GET") { writes.push(`${request.method} ${request.url}`); response.writeHead(405); response.end("{}"); return; }
      const url = new URL(request.url ?? "/", "http://localhost");
      let value: unknown = [];
      if (url.pathname === "/rest/v1/official_game_catalog") {
        if (failCatalog) { response.writeHead(503, { "Content-Type": "application/json" }); response.end(JSON.stringify({ message: "fixture error" })); return; }
        const vehicles = url.searchParams.get("category") === "eq.vehicles";
        const rows = vehicles ? [
          { ...m416, key: "buggy", name: "버기", ammunition: null, category: { key: "land", name: "지상" }, official: {} },
          { ...m416, key: "boat", name: "보트", ammunition: null, category: { key: "water", name: "수상" }, official: {} },
        ] : items;
        value = { items: emptyCatalog ? [] : rows, source_url: `https://pubg.com/ko/game-info/${vehicles ? "vehicles/land" : "weapons/etc"}`, fetched_at: "2026-11-15T01:02:03Z" };
      } else if (url.pathname === "/rest/v1/weapons") value = weaponRows;
      else if (url.pathname === "/rest/v1/attachments") value = attachments;
      if (!Array.isArray(value) && !request.headers.accept?.includes("object")) value = [value];
      response.setHeader("Content-Type", "application/json");
      response.end(JSON.stringify(value));
    });
    await new Promise<void>((resolve) => stub.listen(0, "127.0.0.1", resolve));
    const address = stub.address();
    if (!address || typeof address === "string") throw new Error("fixture 포트 없음");
    vi.stubEnv("NEXT_PUBLIC_SUPABASE_URL", `http://127.0.0.1:${address.port}`);
    vi.stubEnv("NEXT_PUBLIC_SUPABASE_ANON_KEY", "local-browser-qa-anon-key");
    server = await startOwnedStatsDevServer();
    browser = await puppeteer.launch({ headless: true });
    await mkdir("tmp/weapons-browser-qa", { recursive: true });
  }, 180_000);
  afterAll(async () => {
    await browser?.close();
    await server?.stop();
    if (stub) await new Promise<void>((resolve) => stub.close(() => resolve()));
    vi.unstubAllEnvs();
    expect(writes).toEqual([]);
  }, 30_000);

  async function open(viewport: { width: number; height: number }) {
    const page = await browser.newPage();
    await page.setViewport(viewport);
    page.setDefaultTimeout(12_000);
    await page.setRequestInterception(true);
    page.on("request", async (request) => {
      if (request.isInterceptResolutionHandled()) return;
      const url = new URL(request.url());
      if (url.origin !== server.baseUrl && url.origin !== process.env.NEXT_PUBLIC_SUPABASE_URL) { await request.abort(); return; }
      if (url.pathname.startsWith("/api/")) {
        await request.respond({ status: 200, contentType: "application/json", body: "{}" }); return;
      }
      await request.continue();
    });
    await page.goto(`${server.baseUrl}/weapons`, { waitUntil: "domcontentloaded" });
    return page;
  }
  const catalog = 'section[aria-label="무기 목록"]';
  const list = `${catalog} [aria-label="항목 선택"]`;
  const search = `${catalog} input[type="search"]`;
  async function input(page: Page, value: string) {
    await page.$eval(search, (element, value) => {
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
      setter.call(element, value); element.dispatchEvent(new Event("input", { bubbles: true }));
    }, value);
  }
  async function button(page: Page, text: string, scope = "") {
    const element = await page.waitForSelector(`${scope}::-p-text(${text})`);
    if (!element) throw new Error(`button 없음: ${text}`);
    await element.evaluate((element) => element.scrollIntoView({ block: "center", behavior: "instant" }));
    await element.click();
  }
  async function checkLayout(page: Page) {
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    expect(await page.$$eval('button,select,input', (elements) => elements.filter((element) => {
      const rect = element.getBoundingClientRect();
      return rect.width > 0 && rect.height > 0 && rect.left < -1;
    }).map((element) => element.textContent))).toEqual([]);
  }

  it.each(viewports)("검색·필터·복귀·선택 연결·키보드·스크롤 $width×$height", async (viewport) => {
    failCatalog = false; emptyCatalog = false;
    const page = await open(viewport);
    try {
      await page.waitForSelector(`${list} button`);
      await input(page, "결과없음");
      await page.waitForFunction(() => document.body.innerText.includes("검색·필터 결과가 없습니다."));
      await input(page, "");
      const type = `${catalog} select`;
      await page.select(type, "ar");
      await page.select(`${catalog} label:nth-child(2) select`, "5.56mm");
      await page.waitForFunction((selector: string) => document.querySelectorAll(selector + " button").length === 25, {}, list);
      if (viewport.width < 1024) {
        await page.$eval(list, (element) => { element.scrollTop = 300; });
        await page.$eval(`${list} button:nth-child(12)`, (element) => element.scrollIntoView({ block: "center" }));
        const before = await page.$eval(list, (element) => ({ top: element.scrollTop, page: scrollY }));
        await page.click(`${list} button:nth-child(12)`);
        await page.waitForSelector(`${catalog} article`, { visible: true });
        await page.waitForFunction(() => document.activeElement?.tagName === "ARTICLE");
        expect(await page.$eval(list, (element) => getComputedStyle(element).display)).toBe("none");
        await button(page, "목록으로 돌아가기", catalog);
        await page.waitForSelector(`${list} button`, { visible: true });
        expect(await page.$eval(list, (element) => element.scrollTop)).toBe(before.top);
        expect(await page.evaluate(() => scrollY)).toBe(before.page);
        expect(await page.$eval(`${list} button:nth-child(12)`, (element) => element === document.activeElement && element.getAttribute("aria-pressed") === "true")).toBe(true);
      }
      await page.select(type, "");
      await page.select(`${catalog} label:nth-child(2) select`, "");
      await input(page, "M416");
      await page.waitForFunction((selector: string) => document.querySelectorAll(selector + " button").length === 1, {}, list);
      await page.focus(`${list} button`); await page.keyboard.press("Enter");
      await page.waitForSelector(`${catalog} article`, { visible: true });
      await button(page, "이 무기로 파츠 설정", catalog);
      await page.waitForSelector('[aria-label="탄창 파츠 선택"]');
      expect(await page.$eval('[aria-label="무기 파츠 조작 영역"] h2', (element) => element.textContent)).toContain("M416");
      expect(await page.$eval('#weapon-simulator', (element) => element.getBoundingClientRect().top)).toBeGreaterThanOrEqual(0);
      expect(await page.$$eval('[data-slot]', (elements) => elements.map((element) => element.getAttribute("data-slot")))).toEqual(["sight", "muzzle", "grip", "magazine", "stock"]);
      await page.click('[aria-label="총구 파츠 선택"]');
      await button(page, "AR 보정기", "button");
      await page.waitForFunction(() => document.querySelector('#weapon-simulator')?.textContent?.includes("수직 반동 지표85"));
      await page.click('[aria-label="조준경 파츠 선택"]');
      expect(await page.$('button::-p-text(8배율 CQBSS 스코프)')).toBeNull();
      await button(page, "4배율 ACOG 스코프", "button");
      await page.focus('[aria-label="탄창 파츠 선택"]'); await page.keyboard.press("Enter");
      await button(page, "대용량 퀵드로우 탄창", "button");
      await page.waitForSelector('[aria-label="탄창 파츠 선택"][aria-expanded="false"]');
      await page.waitForFunction(() => document.querySelector('#weapon-simulator')?.textContent?.includes("40발"));
      expect(await page.$eval('#weapon-simulator', (element) => element.textContent)).toContain("재장전 시간 지표70");
      await checkLayout(page);
      await page.screenshot({ path: `tmp/weapons-browser-qa/simulator-${viewport.width}.png`, fullPage: true });
      await button(page, "다른 무기 선택·BGMS 수치 보기", "summary");
      await checkLayout(page);
      const choose = await page.waitForSelector('details button[aria-label="AKM 파츠 설정"]', { visible: true });
      await choose!.focus(); await page.keyboard.press("Enter");
      await page.waitForFunction(() => document.querySelector('[aria-label="무기 파츠 조작 영역"] h2')?.textContent?.includes("AKM"));
      await page.waitForFunction(() => document.activeElement?.getAttribute("aria-label") === "무기 파츠 조작 영역");
      expect(await page.$eval('[aria-label="무기 파츠 조작 영역"]', (element) => element.getBoundingClientRect().top)).toBeGreaterThanOrEqual(60);
      const restore = await page.waitForSelector('details button[aria-label="M416 파츠 설정"]', { visible: true });
      await restore!.focus(); await page.keyboard.press("Enter");
      await page.waitForFunction(() => document.querySelector('[aria-label="무기 파츠 조작 영역"] h2')?.textContent?.includes("M416"));
      expect(await page.$eval('#weapon-simulator', (element) => element.textContent)).toContain("40발");
      await button(page, "다른 무기 선택·BGMS 수치 보기", "summary");
      // 탭을 왕복해도 도감 검색/필터와 파츠 선택을 보존한다.
      await button(page, "탈것", 'nav[aria-label="도감 분류"] button');
      await page.waitForSelector('section[aria-label="탈것 목록"] select');
      await page.select('section[aria-label="탈것 목록"] select', "water");
      expect(await page.$$eval('section[aria-label="탈것 목록"] [aria-label="항목 선택"] button', (elements) => elements.map((element) => element.textContent?.trim()))).toEqual(["보트"]);
      await button(page, "무기", 'nav[aria-label="도감 분류"] button');
      expect(await page.$eval(search, (element) => (element as HTMLInputElement).value)).toBe("M416");
      if (viewport.width < 1024) await button(page, "목록으로 돌아가기", catalog);
      await input(page, "미연결");
      await page.click(`${list} button`);
      await button(page, "이 무기로 파츠 설정", catalog);
      await page.waitForFunction(() => document.querySelector('#weapon-simulator [role="status"]')?.textContent?.includes("미연결 무기"));
      expect(await page.$('[aria-label="무기 파츠 조작 영역"] h2')).toBeNull();
      await checkLayout(page);
      await page.screenshot({ path: `tmp/weapons-browser-qa/unlinked-${viewport.width}.png`, fullPage: true });
    } catch (error) {
      await page.screenshot({ path: `tmp/weapons-browser-qa/failure-${viewport.width}.png`, fullPage: true });
      throw error;
    } finally { await page.close(); }
  });

  it.each(viewports)("오류 재시도·미등록 빈 상태 $width×$height", async (viewport) => {
    failCatalog = true; emptyCatalog = false;
    const page = await open(viewport);
    try {
      await page.waitForSelector(`${catalog} [role="alert"]`);
      await checkLayout(page);
      failCatalog = false;
      await button(page, "다시 시도", catalog);
      await page.waitForSelector(`${list} button`);
      emptyCatalog = true;
      await page.reload({ waitUntil: "domcontentloaded" });
      await page.waitForFunction(() => document.body.innerText.includes("아직 등록된 공식 정보가 없습니다."));
      await checkLayout(page);
    } finally { emptyCatalog = false; failCatalog = false; await page.close(); }
  });
});
