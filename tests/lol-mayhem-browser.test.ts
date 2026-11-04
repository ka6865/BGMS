import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createServer, type Server } from "node:http";
import { mkdir, readFile } from "node:fs/promises";
import { build } from "esbuild";
import postcss from "postcss";
import tailwind from "@tailwindcss/postcss";
import puppeteer, { type Browser } from "puppeteer";
import type { LolMayhemCatalog } from "../lib/lol/augments/catalog";
import type { MayhemDatasetAdminData, PublicMayhemDataset } from "../lib/lol/mayhemDatasetView";
import type { ChampionDatasetAdminData, ChampionDatasetManifest, PublicChampionStats } from "../lib/lol/mayhemChampionDataset";

const catalog: LolMayhemCatalog = {
  clientPatch: "16.21", displayPatch: "26.21", releasedAt: "2026-10-20T18:00:00Z", notesUrl: "https://example.test/notes",
  removed: ["타오르는 이자", "Hide on bush"],
  augments: Array.from({ length: 12 }, (_, index) => ({
    id: index + 1, name: index === 0 ? "아주 긴 이름을 가진 증강으로 줄바꿈을 확인합니다" : index === 11 ? "큰 표본 숫자와 나란히 표시되는 아주 긴 증강 이름 줄바꿈 검증 항목" : `증강 ${index + 1}`, nameEn: `Augment ${index + 1}`,
    rarity: (["prismatic", "gold", "silver"] as const)[index % 3], icon: index === 1 ? null : `assets/ux/kiwi/augments/icons/a${index}.png`,
    text: "공격 사거리가 원거리 100 / 근접 150 증가합니다. ".repeat(index === 0 ? 8 : 1), notice: index === 0 ? "스킬 이름은 챔피언마다 다릅니다" : null, isNew: index % 4 === 0,
  })),
};

const dataset: PublicMayhemDataset = { patch: "16.21", publishedAt: "2026-11-04T00:00:00Z", sourceStatsDate: "2026-11-02", sourcePatch: "26.21",
  rates: [{ augmentId: 1, pickRate: 12.34, rank: 1 }],
  combos: [{ id: 10, championId: 63, augmentIds: [1, 2], types: ["god"], sourceUrl: "https://arammayhem.com/combos/test" }] };
const championStats: PublicChampionStats = { schemaVersion: 1, source: "champion_api_v1", clientPatch: "16.20", cohort: "source_default", upstreamVersion: "16.20.1", sourceDataDate: "2026-11-02", fetchedAt: "2026-11-03T00:00:00Z", championId: 63, catalogHash: "a".repeat(64), attribution: "Data provider", publishedAt: "2026-11-04T00:00:00Z",
  rows: [
    { augmentPlatformId: 1, reportedPickRate: "0.0697", reportedSampleCount: null, rateSource: "tencent", rateRegion: "CN", countSource: null, countRegion: null, countMeaning: null, denominatorKind: "unverified_source_definition", denominatorCount: null, selectionEvidence: "reported_rate", offerEligibility: "unknown" },
    { augmentPlatformId: 12, reportedPickRate: "0.12", reportedSampleCount: 123456789012, rateSource: "iesdev", rateRegion: "WORLD", countSource: "iesdev", countRegion: "WORLD", countMeaning: "source_reported_games", denominatorKind: "unverified_source_definition", denominatorCount: null, selectionEvidence: "reported_count", offerEligibility: "unknown" },
    ...[2, 3].map(id => ({ augmentPlatformId: id, reportedPickRate: id === 2 ? "0" : null, reportedSampleCount: null, rateSource: "tencent", rateRegion: "CN", countSource: null, countRegion: null, countMeaning: null, denominatorKind: "unverified_source_definition" as const, denominatorCount: null, selectionEvidence: "reported_rate" as const, offerEligibility: "unknown" as const })),
  ] };
const championManifest: ChampionDatasetManifest = { schemaVersion: 1, source: "champion_api_v1", cohort: "source_default", clientPatch: "16.21", upstreamVersion: "16.21.1", sourceDataDate: "2026-11-03", catalogHash: "b".repeat(64), expectedChampionIds: [63], files: [], attribution: "Data provider", rightsBasis: "Documented permission basis", normalizerVersion: 1 };
const championAdminFixture = (): ChampionDatasetAdminData => ({ releases: [{ id: 2, status: "pending", client_patch: "16.21", source_data_date: "2026-11-03", upstream_version: "16.21.1", fetched_at: "2026-11-04T00:00:00Z", metadata: championManifest }], publications: [], sync: [], readiness: { apiKeyConfigured: true, reuseConfirmed: true, enabled: true, persistenceEnabled: true } });
const adminFixture = (): MayhemDatasetAdminData => ({ releases: [{ id: 1, verified_client_patch: "16.22", upstream_release_id: "source:" + "x".repeat(100), status: "pending", fetched_at: "2026-11-04T00:00:00Z",
  metadata: { unknown_count: 1, unknownExternalIds: ["augment!"], sourceStatsDate: "2026-11-02", sourceClientPatch: "16.21" } }], publications: [], mappings: [],
  augments: [{ platformId: 1, name: "아주 긴 공식 증강 이름으로 줄바꿈을 확인합니다", patch: "16.21" }, { platformId: 2, name: "검수 패치 전용 증강", patch: "16.22" }],
  sync: [{ job_key: "champion-stats", last_checked_at: "2026-11-04T00:00:00Z", last_success_at: null, last_error_code: "key_or_permission", consecutive_failures: 2, counts: {} }] });

describe.skipIf(process.env.RUN_LOL_DEV_BROWSER !== "true")("LoL 증바람 공개 페이지 브라우저 fixture", { timeout: 30_000 }, () => {
  let server: Server; let browser: Browser; let base: string;
  beforeAll(async () => {
    const client = await build({ bundle: true, write: false, platform: "browser", format: "iife", jsx: "automatic", tsconfig: "tsconfig.json",
      define: { "process.env.NODE_ENV": '"production"' },
      stdin: { loader: "tsx", resolveDir: process.cwd(), contents: `
        import { hydrateRoot } from 'react-dom/client'; import View from './components/lol/LolMayhemView';
        import Admin from './app/admin/lol/mayhem-datasets/MayhemDatasetReviewPanel';
        hydrateRoot(document.getElementById('root'), location.pathname === '/admin' ? <Admin /> : <View {...JSON.parse(document.getElementById('props').textContent)} />);
      ` },
    });
    const css = await postcss([tailwind()]).process(await readFile("app/globals.css", "utf8"), { from: "app/globals.css" });
    const { renderToString } = await import("react-dom/server");
    const { createElement } = await import("react");
    const View = (await import("../components/lol/LolMayhemView")).default;
    const Admin = (await import("../app/admin/lol/mayhem-datasets/MayhemDatasetReviewPanel")).default;
    let admin = adminFixture(); let statsMode: "success" | "empty" | "error" | "race" = "success";
    server = createServer((req, res) => {
      if (req.url === "/style.css") { res.setHeader("Content-Type", "text/css"); res.end(css.css); return; }
      if (req.url === "/client.js") { res.setHeader("Content-Type", "text/javascript"); res.end(client.outputFiles[0].text); return; }
      if (req.url === "/api/admin/lol/mayhem-datasets") {
        res.setHeader("Content-Type", "application/json");
        if (req.method === "POST") {
          let body = ""; req.on("data", chunk => { body += chunk; }); req.on("end", () => {
            const payload = JSON.parse(body); const action = payload.action;
            if (action === "map" && payload.patch !== "16.21") { res.statusCode = 400; res.end(JSON.stringify({ error: "선택률 원본 패치가 아닙니다." })); return; }
            if (action === "map") admin.releases[0].metadata = { ...admin.releases[0].metadata, unknown_count: 0, unknownExternalIds: [] };
            if (action === "approve") admin.releases[0].status = "approved";
            res.end(JSON.stringify({ ok: true }));
          });
        } else res.end(JSON.stringify(admin));
        return;
      }
      if (req.url === "/admin") admin = adminFixture();
      if (req.url === "/stats-empty") statsMode = "empty";
      else if (req.url === "/stats-error") statsMode = "error";
      else if (req.url === "/stats-race") statsMode = "race";
      else if (req.url === "/stats") statsMode = "success";
      if (req.url?.startsWith("/api/admin/lol/mayhem-champion-datasets")) {
        res.setHeader("Content-Type", "application/json");
        if (req.method === "POST") { res.end(JSON.stringify({ ok: true })); return; }
        res.end(JSON.stringify({ ...championAdminFixture(), databaseAvailable: true })); return;
      }
      if (req.url?.startsWith("/api/lol/mayhem/champion-stats/")) {
        if (statsMode === "error") { res.statusCode = 503; res.end(JSON.stringify({ error: "unavailable" })); return; }
        const id = Number(req.url.split("/").at(-1)?.split("?")[0]);
        if (statsMode === "empty") { res.end(JSON.stringify({ dataset: null })); return; }
        const payload = { ...championStats, championId: id, rows: championStats.rows.map(row => statsMode === "race" && id === 64 ? { ...row, reportedPickRate: "0.8888" } : row) };
        const send = () => { res.setHeader("Content-Type", "application/json"); res.end(JSON.stringify({ dataset: payload })); };
        if (id === 63 && statsMode === "race") {
          server.emit("delayed-stats-started");
          setTimeout(() => { send(); server.emit("delayed-stats-sent"); }, 700);
        } else if (id === 63) setTimeout(send, 300); else send();
        return;
      }
      const champs = [{ id: 63, imageId: "Brand", name: "브랜드", title: "", tags: [] }, { id: 64, imageId: "Lux", name: "럭스", title: "", tags: [] }];
      const isStats = req.url?.startsWith("/stats");
      const props = req.url === "/error" ? { catalog: null, error: true } : req.url === "/empty" ? { catalog: null } : req.url === "/dataset"
        ? { catalog, dataset, champions: champs, championStatsEnabled: true } : isStats ? { catalog, champions: champs, championStatsEnabled: true } : { catalog };
      res.setHeader("Content-Type", "text/html");
      res.end('<!doctype html><html lang="ko"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">'
        + `<link rel="stylesheet" href="/style.css"></head><body class="bg-zinc-950"><div id="root">${req.url === "/admin" ? renderToString(createElement(Admin)) : renderToString(createElement(View, props))}</div>`
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
    page.on("request", request => { if (request.url().startsWith(base) && (!request.url().includes("/api/lol/") || request.url().includes("/api/lol/mayhem/champion-stats/"))) void request.continue(); else void request.abort(); });
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

  it.each([[375, 667], [390, 844], [430, 932], [1440, 900]])("%ix%i에서 조합과 전체 선택률을 구분하고 미매핑 승인을 막는다", async (width, height) => {
    const page = await browser.newPage(); await page.setViewport({ width, height });
    await page.setRequestInterception(true);
    page.on("request", request => { if (request.url().startsWith(base) && (!request.url().includes("/api/lol/") || request.url().includes("/api/lol/mayhem/champion-stats/"))) void request.continue(); else void request.abort(); });
    await page.goto(`${base}/dataset`, { waitUntil: "networkidle0" });
    await page.click("main > details > summary");
    await page.select('section[aria-label="해외 증바람 자료"] select', "63");
    expect(await page.$eval('[aria-label="해외 증바람 자료"]', node => node.textContent)).toContain(" + 증강 2");
    expect(await page.$eval('[aria-label="해외 증바람 자료"]', node => node.textContent)).toContain("등장 확률을 뜻하지 않습니다");
    await page.click('[aria-label="해외 증바람 자료"] details > summary');
    expect(await page.$eval('[aria-label="해외 증바람 자료"] details', node => node.textContent)).toContain("12.34%");
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await page.screenshot({ path: `tmp/lol-mayhem-review/dataset-${width}x${height}.png`, fullPage: true });
    await page.goto(`${base}/admin`, { waitUntil: "networkidle0" });
    await page.waitForSelector('select[aria-label="외부 증강 ID"]');
    const disabled = () => page.$eval('[aria-label="데이터셋 승인과 공개"] button', node => (node as HTMLButtonElement).disabled);
    await page.click('[aria-label="데이터셋 승인과 공개"] input[type="checkbox"]'); expect(await disabled()).toBe(true);
    await page.select('select[aria-label="외부 증강 ID"]', "augment!");
    await page.select('select[aria-label="매핑 패치"]', "16.21");
    await page.select('select[aria-label="공식 증강"]', "1");
    await page.type("form textarea", "공식 이름·등급·효과를 원본과 대조했습니다.");
    await page.click('button[type="submit"]');
    await page.waitForFunction(() => document.querySelector('[aria-label="수집본 정보"]')?.textContent?.includes("미매핑 0개"));
    await page.click('[aria-label="데이터셋 승인과 공개"] input[type="checkbox"]'); expect(await disabled()).toBe(false);
    expect(await page.$$eval("button, select, textarea", nodes => nodes.every(node => node.getBoundingClientRect().height >= 44))).toBe(true);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await page.screenshot({ path: `tmp/lol-mayhem-review/admin-${width}x${height}.png`, fullPage: true });
    await page.close();
  });

  it.each([[375, 667], [390, 844], [430, 932], [1440, 900]])("%ix%i에서 챔피언 통계 상태·표시·빠른 선택 전환을 확인한다", async (width, height) => {
    const page = await browser.newPage(); await page.setViewport({ width, height });
    const errors: string[] = []; page.on("pageerror", error => errors.push(String(error)));
    await page.setRequestInterception(true);
    page.on("request", request => { if (request.url().startsWith(base) && (!request.url().includes("/api/lol/") || request.url().includes("/api/lol/mayhem/champion-stats/"))) void request.continue(); else void request.abort(); });
    const noOverflow = () => page.evaluate(() => document.documentElement.scrollWidth <= innerWidth);
    await page.goto(`${base}/stats`, { waitUntil: "networkidle0" });
    const select = 'select[aria-label="통계 챔피언 선택"]';
    expect(await page.$('ul[aria-label="증강 목록"]')).toBeNull();
    await page.waitForFunction(() => document.querySelector('[aria-label="챔피언별 선택 통계"]')?.textContent?.includes("6.97%"));
    expect(await page.$eval(select, node => (node as HTMLSelectElement).getBoundingClientRect().height)).toBeGreaterThanOrEqual(44);
    await page.focus(select); await page.keyboard.press("ArrowDown"); await page.keyboard.press("Enter");
    await page.select(select, "63");
    await page.select(select, "64");
    await page.waitForFunction(() => document.querySelector('[aria-label="챔피언별 선택 통계"]')?.textContent?.includes("6.97%"));
    const text = await page.$eval('[aria-label="챔피언별 선택 통계"]', node => node.textContent ?? "");
    expect(text).toContain("CN"); expect(text).toContain("WORLD"); expect(text).toContain("이전 패치 통계");
    const rows = await page.$$eval('[aria-label="챔피언별 선택 통계"] ul > li', items => items.map(item => item.textContent ?? ""));
    expect(rows[0]).toContain("123,456,789,012"); expect(rows[1]).not.toContain("출처 제공 표본");
    expect(rows[2]).toContain("0.00%"); expect(rows[3]).toContain("미제공");
    expect(rows[0]).toContain("공격 사거리");
    await page.click('[aria-label="통계 증강 등급"] button[data-rarity="gold"]');
    expect(await page.$$eval('[aria-label="챔피언별 선택 통계"] ul > li', items => items.length)).toBe(1);
    await page.click('[aria-label="통계 증강 등급"] button:first-child');
    await page.type('input[aria-label="통계 증강 검색"]', "없는증강");
    expect(await page.$eval('[aria-label="챔피언별 선택 통계"]', node => node.textContent)).toContain("조건에 맞는 증강이 없습니다");
    await page.click('[aria-label="통계 필터 초기화"]');
    expect(await page.$$eval('[aria-label="챔피언별 선택 통계"] ul > li', items => items.length)).toBe(4);
    await page.type('input[aria-label="통계 챔피언 검색"]', "ㄹㅅ");
    expect(await page.$eval(select, node => (node as HTMLSelectElement).value)).toBe("64");
    expect(await page.$$eval(`${select} option`, items => items.length)).toBe(1);
    expect(await noOverflow()).toBe(true);
    await page.screenshot({ path: `tmp/lol-mayhem-review/champion-stats-${width}x${height}.png`, fullPage: true });
    await page.click('[aria-label="증바람 보기"] button:nth-child(2)');
    expect(await page.$$eval('ul[aria-label="증강 목록"] > li', items => items.length)).toBe(12);
    await page.click('[aria-label="증바람 보기"] button:first-child');
    expect(await page.$(select)).not.toBeNull();
    await page.goto(`${base}/stats-empty`, { waitUntil: "networkidle0" }); await page.select(select, "63");
    await page.waitForFunction(() => document.querySelector('[aria-label="챔피언별 선택 통계"]')?.textContent?.includes("아직 없습니다"));
    await page.goto(`${base}/stats-error`, { waitUntil: "networkidle0" }); await page.select(select, "63");
    await page.waitForSelector('[aria-label="챔피언별 선택 통계"] [role="alert"]');
    expect(await page.$eval('[aria-label="챔피언별 선택 통계"]', node => node.textContent)).toContain("다시 시도");
    expect(errors).toEqual([]); await page.close();
  });

  it("이전 챔피언의 응답이 늦게 도착해도 현재 챔피언의 통계를 유지한다", async () => {
    const page = await browser.newPage();
    const started = new Promise<void>(resolve => server.once("delayed-stats-started", resolve));
    const sent = new Promise<void>(resolve => server.once("delayed-stats-sent", resolve));
    await page.goto(`${base}/stats-race`, { waitUntil: "domcontentloaded" });
    await started;
    await page.select('select[aria-label="통계 챔피언 선택"]', "64");
    await page.waitForFunction(() => document.querySelector('[aria-label="챔피언별 선택 통계"]')?.textContent?.includes("88.88%"));
    await sent;
    const text = await page.$eval('[aria-label="챔피언별 선택 통계"]', node => node.textContent);
    expect(text).toContain("럭스"); expect(text).toContain("88.88%"); expect(text).not.toContain("6.97%");
    await page.close();
  });
});
