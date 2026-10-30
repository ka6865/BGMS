import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createServer, type Server } from "node:http";
import { mkdir, readFile } from "node:fs/promises";
import postcss from "postcss";
import tailwind from "@tailwindcss/postcss";
import puppeteer, { type Browser } from "puppeteer";
import type { LolMasterBoardView, LolRankingBoard } from "../lib/lol/ranking";

const observedAt = "2026-10-30T20:41:00.000Z";
const ranking: LolRankingBoard = {
  playerCount: 1000, observedAt,
  rows: Array.from({ length: 30 }, (_, index) => ({
    rank: index + 1, riotId: index === 0 ? `${"아주긴소환사이름".repeat(2)}#KR1` : `소환사${index + 1}#KR1`,
    tier: index < 20 ? "CHALLENGER" as const : "GRANDMASTER" as const, leaguePoints: 2000 - index * 10, wins: 300 + index, losses: 250 + index,
  })),
};
const masterRows = Array.from({ length: 10 }, (_, index) => ({ rank: index + 1, riotId: `장인${index + 1}#KR1`, tier: index < 5 ? "CHALLENGER" as const : "GRANDMASTER" as const,
  leaguePoints: 900 - index * 10, games: 40 - index, wins: 25 }));

describe.skipIf(process.env.RUN_LOL_DEV_BROWSER !== "true")("LoL 랭킹·장인 브라우저 fixture", { timeout: 30_000 }, () => {
  let server: Server; let browser: Browser; let base: string;
  beforeAll(async () => {
    const { renderToString } = await import("react-dom/server");
    const { createElement } = await import("react");
    const Ladder = (await import("../components/lol/LolLadderView")).default;
    const Masters = (await import("../components/lol/LolMastersView")).default;
    const champions = [{ id: 266, slug: "aatrox", name: "아트록스", title: "다르킨의 검", imageId: "Aatrox", tags: ["Fighter"] }, { id: 103, slug: "ahri", name: "아리", title: "구미호", imageId: "Ahri", tags: ["Mage"] }];
    const css = await postcss([tailwind()]).process(await readFile("app/globals.css", "utf8"), { from: "app/globals.css" });
    const empty = { rows: [], today: "2026-10-31" };
    const pages: Record<string, () => unknown> = {
      "/ranking": () => createElement(Ladder, { ...empty, ranking }),
      "/ranking-empty": () => createElement(Ladder, { ...empty, ranking: null }),
      "/ranking-error": () => createElement(Ladder, { ...empty, ranking: null, rankingError: true }),
      "/masters": () => createElement(Masters, { champions: champions as never, version: "16.21.1", championsError: false, boardError: false, selectedId: 266,
        board: { observedAt, season: "2026-01-08", coverage: 60, playerCount: 1000, champions: [{ championId: 266, eligibleCount: 10, rows: masterRows }, { championId: 103, eligibleCount: 0, rows: [] }] } satisfies LolMasterBoardView }),
      "/masters-sparse": () => createElement(Masters, { champions: champions as never, championsError: false, boardError: false, selectedId: 103,
        board: { observedAt, season: "2026-01-08", coverage: 100, playerCount: 1000, champions: [{ championId: 266, eligibleCount: 10, rows: masterRows }] } satisfies LolMasterBoardView }),
      "/masters-empty": () => createElement(Masters, { champions: champions as never, championsError: false, boardError: false, board: null }),
      "/masters-error": () => createElement(Masters, { champions: [], championsError: true, boardError: true, board: null }),
    };
    server = createServer((req, res) => {
      if (req.url === "/style.css") { res.setHeader("Content-Type", "text/css"); res.end(css.css); return; }
      const page = pages[req.url ?? ""];
      if (!page) { res.statusCode = 404; res.end(); return; }
      res.setHeader("Content-Type", "text/html");
      res.end('<!doctype html><html lang="ko"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">'
        + `<link rel="stylesheet" href="/style.css"></head><body class="bg-zinc-950">${renderToString(page() as never)}</body></html>`);
    });
    await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
    const address = server.address(); if (!address || typeof address === "string") throw new Error("fixture 주소 확인 실패");
    base = `http://127.0.0.1:${address.port}`; browser = await puppeteer.launch({ headless: true });
    await mkdir("tmp/lol-ranking-review", { recursive: true });
  }, 90_000);
  afterAll(async () => { await browser?.close(); if (server) await new Promise<void>(resolve => server.close(() => resolve())); });

  it.each([[375, 667], [390, 844], [430, 932], [1440, 900]])("%ix%i에서 순위표·장인과 빈·오류 상태가 넘치지 않는다", async (width, height) => {
    const page = await browser.newPage(); await page.setViewport({ width, height });
    await page.setRequestInterception(true);
    page.on("request", request => { if (request.url().startsWith(base)) void request.continue(); else void request.abort(); });
    const noOverflow = () => page.evaluate(() => document.documentElement.scrollWidth <= innerWidth);
    const text = () => page.$eval("body", body => body.textContent ?? "");
    for (const route of ["ranking", "ranking-empty", "ranking-error", "masters", "masters-sparse", "masters-empty", "masters-error"]) {
      expect((await page.goto(`${base}/${route}`, { waitUntil: "networkidle0" }))?.status(), route).toBe(200);
      expect(await noOverflow(), route).toBe(true);
    }
    await page.goto(`${base}/ranking`, { waitUntil: "networkidle0" });
    expect(await text()).toContain("소환사2#KR1");
    // 행 전체가 링크 영역이므로 행 높이로 터치 영역을 확인한다.
    expect(await page.$$eval('ol[aria-label="4위 이하"] > li:has(a)', rows => rows.every(row => row.getBoundingClientRect().height >= 44))).toBe(true);
    expect(await page.$$eval('ol[aria-label="상위 3명"] a', links => links.every(link => link.getBoundingClientRect().height >= 44))).toBe(true);
    await page.screenshot({ path: `tmp/lol-ranking-review/ranking-${width}x${height}.png` });
    await page.goto(`${base}/masters`, { waitUntil: "networkidle0" });
    const masters = await text();
    expect(masters).toContain("장인1#KR1"); expect(masters).toContain("수집 범위");
    expect(masters).toContain("수집 중, 판수가 실제보다 적을 수 있습니다");
    expect(masters).toContain("조건: 이번 시즌 솔로 랭크 15판 이상");
    expect(masters).not.toMatch(/점수|실력|1등|숙련도/);
    expect(await page.$$eval('main ol > li:has(a)', rows => rows.every(row => row.getBoundingClientRect().height >= 44))).toBe(true);
    expect(await page.$$eval('section[aria-label="챔피언 선택"] a', links => links.every(link => link.getBoundingClientRect().height >= 44))).toBe(true);
    await page.screenshot({ path: `tmp/lol-ranking-review/masters-${width}x${height}.png` });
    await page.close();
  });
});
