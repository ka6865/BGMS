import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createServer, type Server } from "node:http";
import { readFile } from "node:fs/promises";
import { build } from "esbuild";
import postcss from "postcss";
import tailwind from "@tailwindcss/postcss";
import puppeteer, { type Browser, type Page } from "puppeteer";

// 진행 중 경기 패널을 fixture 응답으로 띄워 375~1440 폭에서 넘침과 터치 크기를 확인한다.
// 실제 Riot 호출은 하지 않는다. 실행: RUN_LOL_DEV_BROWSER=true npx vitest run tests/lol-live-browser.test.ts
const base = {
  lookedUpAt: "2026-10-30T11:00:00.000Z",
  riotId: "홍길동#KR1",
};
const icon = (label: string) => `data:image/svg+xml;utf8,${encodeURIComponent(`<svg xmlns='http://www.w3.org/2000/svg' width='44' height='44'><rect width='44' height='44' fill='#3f3f46'/><text x='4' y='26' font-size='9' fill='#fff'>${label}</text></svg>`)}`;
const participant = (n: number, extra: Record<string, unknown> = {}) => ({
  teamId: n < 5 ? 100 : 200,
  championId: 100 + n,
  championName: `챔피언${n}`,
  championIconUrl: icon(`C${n}`),
  spells: [{ name: "점멸", iconUrl: icon("S") }, { name: "점화", iconUrl: icon("S") }],
  keystone: { name: "정복자", iconUrl: icon("K") },
  primaryPath: null,
  secondaryPath: null,
  identity: n === 1 ? { status: "private" } : n === 3 ? { status: "bot" } : { status: "visible", riotId: `아주아주긴이름플레이어${n}#KR${n}` },
  rank: n === 2 ? { status: "failed", reason: "rate_limited" } : n === 4 ? { status: "unranked" } : { status: "ranked", tier: "EMERALD", rank: "II", leaguePoints: 45, wins: 30, losses: 25, winRate: 0.545 },
  champion: n === 0 ? { status: "ok", games: 25, winRate: 0.6, pickRate: 0.025, banRate: 0.04 } : { status: "small_sample", games: 5, pickRate: 0.005, banRate: 0.002 },
  ...extra,
});
const ready = {
  ...base, status: "ready", queue: { id: 420, label: "솔로 랭크" }, gameLengthSeconds: 312,
  bans: [{ teamId: 100, championId: 9, championName: "밴챔피언", championIconUrl: icon("B") }],
  participants: Array.from({ length: 10 }, (_, n) => participant(n)),
  rankFailureCount: 1,
  championStats: { status: "ok", patch: "16.21", matches: 12000, tierFilter: "emerald_plus", tierLabel: "에메랄드+" },
  notice: "진행 중 경기 정보는 Riot Spectator API 기준이며 지연될 수 있습니다.",
};
const responseFor = (riotId: string) => {
  if (riotId.startsWith("미게임#")) return { status: 200, body: { ...base, riotId, status: "not_in_game" } };
  if (riotId.startsWith("커스텀#")) return { status: 200, body: { ...base, riotId, status: "unsupported_mode", queue: { id: 0, label: null } } };
  if (riotId.startsWith("오류#")) return { status: 429, body: { error: "일시적으로 요청이 많습니다. 잠시 후 다시 시도해 주세요." }, headers: { "Retry-After": "7" } };
  if (riotId.startsWith("키#")) return { status: 503, body: { error: "키", reasonCode: "riot_key_renewal", detail: "renew" } };
  return { status: 200, body: { ...ready, riotId } };
};

const panel = `
  import React from 'react'; import { createRoot } from 'react-dom/client';
  import Panel from './components/lol/LolLiveGamePanel';
  const id = decodeURIComponent(location.pathname.slice('/lol/kr/'.length, -'/live'.length));
  createRoot(document.getElementById('root')).render(<Panel publicView apiBase="/api/lol" backHref="/lol/kr" initialRiotId={id} />);
`;

const enabled = process.env.RUN_LOL_DEV_BROWSER === "true";
describe.skipIf(!enabled)("진행 중 경기 패널 fixture", { timeout: 60_000 }, () => {
  let server: Server; let browser: Browser; let base_url: string;
  beforeAll(async () => {
    const bundle = await build({ bundle: true, write: false, platform: "browser", format: "iife", jsx: "automatic", tsconfig: "tsconfig.json",
      define: { "process.env.NODE_ENV": '"production"', "process.env": "{}" },
      stdin: { loader: "tsx", resolveDir: process.cwd(), contents: panel } });
    // 실제 Tailwind 빌드 결과를 쓴다(min-h-11 같은 터치 크기 클래스가 적용돼야 검증이 의미 있다).
    const css = await postcss([tailwind()]).process(await readFile("app/globals.css", "utf8"), { from: "app/globals.css" });
    server = createServer((req, res) => {
      if (req.url === "/app.js") { res.setHeader("Content-Type", "text/javascript"); res.end(bundle.outputFiles![0].text); return; }
      if (req.url === "/style.css") { res.setHeader("Content-Type", "text/css"); res.end(css.css); return; }
      if (req.url === "/api/lol/live" && req.method === "POST") {
        let body = ""; req.on("data", chunk => { body += chunk; }); req.on("end", () => {
          const { riotId } = JSON.parse(body) as { riotId: string };
          const out = responseFor(riotId);
          res.statusCode = out.status; res.setHeader("Content-Type", "application/json");
          for (const [key, value] of Object.entries(out.headers ?? {})) res.setHeader(key, value);
          res.end(JSON.stringify(out.body));
        });
        return;
      }
      res.setHeader("Content-Type", "text/html");
      res.end('<!doctype html><html lang="ko"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/style.css"></head><body><div id="root"></div><script defer src="/app.js"></script></body></html>');
    });
    await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
    const address = server.address(); if (!address || typeof address === "string") throw new Error("fixture 서버 시작 실패");
    base_url = `http://127.0.0.1:${address.port}`;
    browser = await puppeteer.launch({ headless: true });
  }, 120_000);
  afterAll(async () => { await browser?.close(); if (server) await new Promise<void>(resolve => server.close(() => resolve())); });

  async function open(width: number, height: number, riotId: string): Promise<Page> {
    const page = await browser.newPage();
    await page.setViewport({ width, height });
    page.setDefaultTimeout(5000);
    await page.goto(`${base_url}/lol/kr/${encodeURIComponent(riotId)}/live`, { waitUntil: "domcontentloaded" });
    return page;
  }

  it.each([[375, 667], [390, 844], [430, 932], [1440, 900]])("준비 상태가 %ix%i에서 넘치지 않고 안내를 보여 준다", async (width, height) => {
    const page = await open(width, height, "홍길동#KR1");
    await page.waitForSelector('section[aria-label="진행 중인 경기"]');
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
    expect(overflow).toBeLessThanOrEqual(0);
    const text = await page.evaluate(() => document.body.innerText);
    expect(text).toContain("진행 중 경기 정보는 Riot Spectator API 기준이며 지연될 수 있습니다.");
    expect(text).toContain("비공개 참가자");
    expect(text).toContain("불러오지 못함");
    expect(text).not.toContain("puuid");
    const targets = await page.$$eval("select, button, a", nodes => nodes.map(node => node.getBoundingClientRect().height));
    expect(Math.min(...targets)).toBeGreaterThanOrEqual(44);
    await page.close();
  });

  it("빈 상태·커스텀·오류·키 만료 상태를 각각 보여 준다", async () => {
    const page375 = await open(375, 667, "미게임#KR1");
    await page375.waitForSelector("text/지금 진행 중인 게임이 없습니다");
    await page375.close();
    const custom = await open(375, 667, "커스텀#KR1");
    await custom.waitForSelector("text/이 경기 유형은 표시하지 않습니다");
    expect(await custom.evaluate(() => document.body.innerText)).not.toContain("챔피언1");
    await custom.close();
    const rate = await open(375, 667, "오류#KR1");
    await rate.waitForSelector('[role="alert"]');
    expect(await rate.evaluate(() => document.body.innerText)).toContain("7초 후 다시 시도");
    await rate.close();
    const key = await open(375, 667, "키#KR1");
    await key.waitForSelector('[role="status"]');
    expect(await key.evaluate(() => document.body.innerText)).toContain("Riot API 키");
    await key.close();
  });
});
