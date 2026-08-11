import "@testing-library/jest-dom/vitest";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import puppeteer, { type Browser, type Page } from "puppeteer";
import {
  buildStatsApiRequest,
  createStatsQaClock,
  type StatsQaClock,
} from "./fixtures/stats/browserScenarios";
import {
  gotoStatsPage,
  startOwnedStatsDevServer,
  waitForStatsSelector,
  waitForStatsText,
  withStatsBrowserPage,
  type InstalledStatsDispatcher,
  type OwnedStatsDevServer,
} from "./helpers/statsBrowserHarness";

const describeBrowser = process.env.RUN_STATS_BROWSER_SMOKE === "true" ? describe : describe.skip;

type Viewport = { width: number; height: number };
type RuntimeLog = { consoleErrors: string[]; pageErrors: string[] };

const FUNCTIONAL_VIEWPORTS: readonly Viewport[] = [
  { width: 390, height: 844 },
  { width: 1440, height: 900 },
];
const LAYOUT_VIEWPORTS: readonly Viewport[] = [
  { width: 375, height: 667 },
  { width: 390, height: 844 },
  { width: 430, height: 932 },
  { width: 768, height: 1024 },
  { width: 1440, height: 900 },
  { width: 1600, height: 900 },
];
const SCREENSHOT_VIEWPORTS: readonly Viewport[] = [
  { width: 375, height: 812 },
  { width: 1280, height: 720 },
  { width: 1920, height: 1080 },
];
const SEASON_ID = "division.bro.official.pc-2026-07";
const LONG_NICKNAME = `LongFixturePlayer-${"VeryLongNickname".repeat(12)}`;
type ControlState = "ready" | "detail-error" | "detail-expanded" | "squad";

function screenshotPath(name: string, viewport: Viewport): string {
  return join(process.cwd(), "tmp", "stats-browser-qa", `${name}-${viewport.width}x${viewport.height}.png`);
}

function playerSemanticKey(input: {
  nickname: string;
  platform: "steam" | "kakao";
  season?: string;
  refresh?: boolean;
}): string {
  const params = new URLSearchParams({ nickname: input.nickname, platform: input.platform });
  if (input.season) params.set("season", input.season);
  if (input.refresh) params.set("refresh", "true");
  return buildStatsApiRequest({
    recordId: 0,
    method: "GET",
    url: `/api/pubg/player?${params.toString()}`,
  }).semanticKey;
}

function summarySemanticKey(input: {
  matchIds: readonly string[];
  nickname: string;
  platform: "steam" | "kakao";
}): string {
  return buildStatsApiRequest({
    recordId: 0,
    method: "POST",
    url: "/api/pubg/matches-summary",
    body: input,
  }).semanticKey;
}

function detailSemanticKey(input: {
  matchId: string;
  nickname: string;
  platform: "steam" | "kakao";
}): string {
  const params = new URLSearchParams(input);
  return buildStatsApiRequest({
    recordId: 0,
    method: "GET",
    url: `/api/pubg/match?${params.toString()}`,
  }).semanticKey;
}

async function waitUntil(
  dispatcher: InstalledStatsDispatcher,
  predicate: () => boolean,
  label: string,
  timeoutMs = 30_000,
): Promise<void> {
  await dispatcher.withFatal(new Promise<void>((resolve, reject) => {
    const deadline = Date.now() + timeoutMs;
    const check = () => {
      try {
        if (predicate()) {
          resolve();
          return;
        }
        if (Date.now() >= deadline) {
          reject(new Error(`Timed out waiting for ${label}`));
          return;
        }
        setTimeout(check, 25);
      } catch (error) {
        reject(error);
      }
    };
    check();
  }));
}

async function waitForWallClock(
  dispatcher: InstalledStatsDispatcher,
  durationMs: number,
): Promise<number> {
  const startedAt = Date.now();
  await dispatcher.withFatal(new Promise<void>((resolve) => {
    setTimeout(resolve, durationMs);
  }));
  return Date.now() - startedAt;
}

async function clickButtonText(page: Page, text: string): Promise<void> {
  await page.evaluate((expected) => {
    const buttons = [...document.querySelectorAll("button")]
      .filter((candidate) => candidate.textContent?.trim().includes(expected));
    const button = buttons.find((candidate) => candidate.textContent?.trim() === expected) ?? buttons[0];
    if (!(button instanceof HTMLButtonElement)) throw new Error(`Button not found: ${expected}`);
    button.click();
  }, text);
}

async function clickLastButtonText(page: Page, text: string): Promise<void> {
  await page.evaluate((expected) => {
    const buttons = [...document.querySelectorAll("button")]
      .filter((candidate) => candidate.textContent?.trim().includes(expected));
    const button = buttons.at(-1);
    if (!(button instanceof HTMLButtonElement)) throw new Error(`Button not found: ${expected}`);
    button.click();
  }, text);
}

async function isButtonDisabled(page: Page, text: string, last = false): Promise<boolean> {
  return page.evaluate(({ expected, useLast }) => {
    const buttons = [...document.querySelectorAll("button")]
      .filter((candidate) => candidate.textContent?.trim().includes(expected));
    const button = useLast ? buttons.at(-1) : buttons[0];
    if (!(button instanceof HTMLButtonElement)) throw new Error(`Button not found: ${expected}`);
    return button.disabled;
  }, { expected: text, useLast: last });
}

async function waitForButtonEnabled(
  page: Page,
  dispatcher: InstalledStatsDispatcher,
  text: string,
  last = false,
  timeoutMs = 30_000,
): Promise<void> {
  await dispatcher.withFatal(page.waitForFunction(({ expected, useLast }) => {
    const buttons = [...document.querySelectorAll("button")]
      .filter((candidate) => candidate.textContent?.trim().includes(expected));
    const button = useLast ? buttons.at(-1) : buttons[0];
    return button instanceof HTMLButtonElement && !button.disabled;
  }, { timeout: timeoutMs }, { expected: text, useLast: last }));
}

async function clickRefresh(page: Page): Promise<void> {
  await page.click('button[aria-label="전적 갱신"], button[aria-label="최신 전적"]');
}

async function waitForSearchCooldownReleased(
  page: Page,
  dispatcher: InstalledStatsDispatcher,
): Promise<void> {
  await dispatcher.withFatal(page.waitForFunction(() => ![...document.querySelectorAll("button")]
    .some((button) => button.textContent?.trim() === "쿨타임")));
}

async function fillNickname(page: Page, dispatcher: InstalledStatsDispatcher, nickname: string): Promise<void> {
  await page.$eval('input[name="nickname"]', (element) => {
    const input = element as HTMLInputElement;
    input.focus();
    input.select();
  });
  await page.keyboard.press("Backspace");
  await dispatcher.withFatal(page.waitForFunction(() => (
    document.querySelector<HTMLInputElement>('input[name="nickname"]')?.value === ""
  )));
  await page.keyboard.type(nickname);
  await dispatcher.withFatal(page.waitForFunction((expected) => (
    document.querySelector<HTMLInputElement>('input[name="nickname"]')?.value === expected
  ), {}, nickname));
}

async function goToLanding(page: Page, dispatcher: InstalledStatsDispatcher, baseUrl: string): Promise<void> {
  await gotoStatsPage({ dispatcher, page, url: `${baseUrl}/stats` });
  await waitForStatsSelector({ dispatcher, page, selector: 'select[name="platform"]' });
  await waitForStatsSelector({ dispatcher, page, selector: 'input[name="nickname"]' });
}

async function goToPlayer(
  page: Page,
  dispatcher: InstalledStatsDispatcher,
  baseUrl: string,
  platform: "steam" | "kakao",
  nickname: string,
  query = "",
): Promise<void> {
  await gotoStatsPage({
    dispatcher,
    page,
    url: `${baseUrl}/stats/${platform}/${encodeURIComponent(nickname)}${query}`,
  });
  await waitForStatsSelector({ dispatcher, page, selector: ".stats-page" });
}

async function searchStatsClientRoute(
  page: Page,
  dispatcher: InstalledStatsDispatcher,
  nickname: string,
  pathname: string,
): Promise<void> {
  await waitForSearchCooldownReleased(page, dispatcher);
  await fillNickname(page, dispatcher, nickname);
  await waitForButtonEnabled(page, dispatcher, "검색");
  await clickButtonText(page, "검색");
  await dispatcher.withFatal(page.waitForFunction(
    (expectedPathname) => location.pathname === expectedPathname,
    {},
    pathname,
  ));
  await waitForStatsSelector({ dispatcher, page, selector: ".stats-page" });
}

async function backStatsClientRoute(
  page: Page,
  dispatcher: InstalledStatsDispatcher,
  pathname: string,
): Promise<void> {
  const response = await dispatcher.withFatal(page.goBack({ waitUntil: "domcontentloaded" }));
  expect(response, "same-document App Router history back response").toBeNull();
  await dispatcher.withFatal(page.waitForFunction(
    (expectedPathname) => location.pathname === expectedPathname,
    {},
    pathname,
  ));
  await waitForStatsSelector({ dispatcher, page, selector: ".stats-page" });
}

async function waitForPlayerSuccess(
  dispatcher: InstalledStatsDispatcher,
  nickname: string,
  platform: "steam" | "kakao",
  options: { season?: string; refresh?: boolean; afterRecordId?: number } = {},
): Promise<void> {
  await dispatcher.waitForTerminal({
    selector: {
      pathname: "/api/pubg/player",
      method: "GET",
      semanticKey: playerSemanticKey({ nickname, platform, ...options }),
      state: "completed",
      successful: true,
      afterRecordId: options.afterRecordId,
    },
    count: 1,
  });
}

async function waitForPlayerTerminal(
  dispatcher: InstalledStatsDispatcher,
  nickname: string,
  platform: "steam" | "kakao",
  options: { season?: string; refresh?: boolean } = {},
): Promise<void> {
  await dispatcher.waitForTerminal({
    selector: {
      pathname: "/api/pubg/player",
      method: "GET",
      semanticKey: playerSemanticKey({ nickname, platform, ...options }),
      state: "completed",
    },
    count: 1,
  });
}

async function waitForSummarySuccess(
  dispatcher: InstalledStatsDispatcher,
  nickname: string,
  platform: "steam" | "kakao",
  matchIds: readonly string[] = ["match-fixture-1"],
  afterRecordId?: number,
): Promise<void> {
  await dispatcher.waitForTerminal({
    selector: {
      pathname: "/api/pubg/matches-summary",
      method: "POST",
      semanticKey: summarySemanticKey({ matchIds, nickname, platform }),
      state: "completed",
      successful: true,
      afterRecordId,
    },
    count: 1,
  });
}

async function waitForDetailSuccess(
  dispatcher: InstalledStatsDispatcher,
  nickname: string,
  platform: "steam" | "kakao",
  matchId = "match-fixture-1",
  afterRecordId?: number,
): Promise<void> {
  await dispatcher.waitForTerminal({
    selector: {
      pathname: "/api/pubg/match",
      method: "GET",
      semanticKey: detailSemanticKey({ matchId, nickname, platform }),
      state: "completed",
      successful: true,
      afterRecordId,
    },
    count: 1,
  });
}

function attachRuntimeLog(page: Page): RuntimeLog {
  const log: RuntimeLog = { consoleErrors: [], pageErrors: [] };
  page.on("console", (message) => {
    if (["error", "warning"].includes(message.type())) log.consoleErrors.push(message.text());
  });
  page.on("pageerror", (error) => log.pageErrors.push(error instanceof Error ? error.message : String(error)));
  return log;
}

async function assertNoOverlay(page: Page): Promise<void> {
  const overlay = await page.evaluate(() => Boolean(document.querySelector(
    "[data-nextjs-dialog], .next-error-h1, .nextjs-container-errors, [data-nextjs-toast]",
  )));
  expect(overlay, "Next error overlay").toBe(false);
}

function playerRecords(dispatcher: InstalledStatsDispatcher, nickname: string, platform: string) {
  return dispatcher.ledger.records.filter((record) =>
    record.pathname === "/api/pubg/player"
    && record.query.nickname === nickname
    && record.query.platform === platform,
  );
}

async function markStableStatsShell(page: Page): Promise<void> {
  await page.evaluate(() => {
    const shell = document.querySelector<HTMLElement>(".stats-page");
    if (!shell) throw new Error("Stats Shell marker target is missing");
    const marker = "stats-route-race-shell";
    shell.dataset.statsRouteRaceMarker = marker;
    const raceWindow = window as typeof window & {
      __statsRouteRaceWitness?: {
        shell: HTMLElement;
        document: Document;
        marker: string;
        navigationEntryCount: number;
      };
    };
    raceWindow.__statsRouteRaceWitness = {
      shell,
      document,
      marker,
      navigationEntryCount: performance.getEntriesByType("navigation").length,
    };
  });
}

async function assertStatsShellRemounted(page: Page) {
  const evidence = await page.evaluate(() => {
    const raceWindow = window as typeof window & {
      __statsRouteRaceWitness?: {
        shell: HTMLElement;
        document: Document;
        marker: string;
        navigationEntryCount: number;
      };
    };
    const witness = raceWindow.__statsRouteRaceWitness;
    const shell = document.querySelector<HTMLElement>(".stats-page");
    return {
      witnessPresent: Boolean(witness),
      sameDocument: witness?.document === document,
      sameShell: witness?.shell === shell,
      markerPreserved: shell?.dataset.statsRouteRaceMarker === witness?.marker,
      navigationEntryCount: performance.getEntriesByType("navigation").length,
      initialNavigationEntryCount: witness?.navigationEntryCount ?? null,
    };
  });
  expect(evidence).toMatchObject({
    witnessPresent: true,
    sameDocument: true,
    sameShell: false,
    markerPreserved: false,
    navigationEntryCount: 1,
    initialNavigationEntryCount: 1,
  });
  return evidence;
}

function latestRecordId(dispatcher: InstalledStatsDispatcher): number {
  return Math.max(0, ...dispatcher.ledger.records.map((record) => record.id));
}

async function assertRouteRaceSettledOnB(
  page: Page,
  dispatcher: InstalledStatsDispatcher,
  label: string,
  input: { raceAfterRecordId: number; returningBAfterRecordId: number },
): Promise<void> {
  const observedMs = await waitForWallClock(dispatcher, 800);
  expect(observedMs).toBeGreaterThanOrEqual(800);
  await waitUntil(
    dispatcher,
    () => {
      const records = playerRecords(dispatcher, "PlayerA", "steam")
        .filter((record) => record.id > input.raceAfterRecordId);
      return records.length > 0 && records.every((record) => record.terminal);
    },
    `${label} PlayerA terminal after delayed response window`,
  );
  const aRecords = playerRecords(dispatcher, "PlayerA", "steam")
    .filter((record) => record.id > input.raceAfterRecordId);
  const bRecords = playerRecords(dispatcher, "PlayerB", "steam")
    .filter((record) => record.id > input.returningBAfterRecordId);
  expect(aRecords).toHaveLength(1);
  expect(aRecords.every((record) => ["aborted", "completed"].includes(record.state))).toBe(true);
  expect(aRecords.filter((record) => record.successful)).toHaveLength(0);
  for (const record of aRecords) {
    if (record.state === "aborted") {
      expect(["fetch-signal", "request-failed"]).toContain(record.terminalSource);
    } else {
      expect(record).toMatchObject({ successful: false, terminalSource: "response" });
    }
    expect(record.terminalSource).not.toBe("main-frame-navigation");
  }
  expect(bRecords.filter((record) => record.state === "completed" && record.successful)).toHaveLength(1);
  await waitForStatsSelector({ dispatcher, page, selector: 'h2[title="PlayerB"]' });
  expect(await page.$('h2[title="PlayerA"]')).toBeNull();
  expect(page.url()).toContain("/stats/steam/PlayerB");
  console.log(JSON.stringify({ kind: "stats-browser-route-race-terminal", label, observedMs, aRecords, bRecords }));
}

async function executeRouteRemountRace(input: {
  page: Page;
  dispatcher: InstalledStatsDispatcher;
  baseUrl: string;
  label: string;
}): Promise<void> {
  const { page, dispatcher, baseUrl, label } = input;
  await goToPlayer(page, dispatcher, baseUrl, "steam", "PlayerB");
  await waitForPlayerSuccess(dispatcher, "PlayerB", "steam");
  await waitForSummarySuccess(dispatcher, "PlayerB", "steam");
  await waitForStatsSelector({ dispatcher, page, selector: 'h2[title="PlayerB"]' });
  expect(playerRecords(dispatcher, "PlayerB", "steam").filter((record) => record.successful)).toHaveLength(1);
  await markStableStatsShell(page);
  const initialBLastRecordId = latestRecordId(dispatcher);
  const raceAfterRecordId = initialBLastRecordId;

  await searchStatsClientRoute(page, dispatcher, "PlayerA", "/stats/steam/PlayerA");
  await waitUntil(
    dispatcher,
    () => playerRecords(dispatcher, "PlayerA", "steam")
      .some((record) => record.id > raceAfterRecordId && record.state === "started"),
    `${label} PlayerA client-route request start`,
  );
  const atA = await assertStatsShellRemounted(page);
  const returningBAfterRecordId = latestRecordId(dispatcher);

  await backStatsClientRoute(page, dispatcher, "/stats/steam/PlayerB");
  await waitForPlayerSuccess(dispatcher, "PlayerB", "steam", { afterRecordId: returningBAfterRecordId });
  await waitForSummarySuccess(dispatcher, "PlayerB", "steam", ["match-fixture-1"], returningBAfterRecordId);
  const atB = await assertStatsShellRemounted(page);
  await assertRouteRaceSettledOnB(page, dispatcher, label, {
    raceAfterRecordId,
    returningBAfterRecordId,
  });
  console.log(JSON.stringify({
    kind: "stats-browser-route-remount-race",
    label,
    transition: "initial B ready -> actual search button router.push A -> Puppeteer page.goBack B",
    initialBLastRecordId,
    raceAfterRecordId,
    returningBAfterRecordId,
    atA,
    atB,
  }));
}

async function recordScenarioEvidence(
  label: string,
  viewport: Viewport,
  dispatcher: InstalledStatsDispatcher,
  log: RuntimeLog,
): Promise<void> {
  dispatcher.ledger.throwIfUnexpected();
  const records = dispatcher.ledger.records;
  const adExternal = records.filter((record) => record.category === "ad-external");
  expect(adExternal, `${label} local advertising external requests`).toHaveLength(0);
  console.log(JSON.stringify({
    kind: "stats-browser-scenario",
    label,
    viewport,
    records,
    consoleErrors: log.consoleErrors,
    pageErrors: log.pageErrors,
    external: {
      ad: adExternal.length,
      analytics: records.filter((record) => record.category === "analytics-external").length,
      other: records.filter((record) => record.category === "other").length,
    },
  }));
}

async function controlEvidence(page: Page, state: ControlState) {
  return page.evaluate((currentState) => {
    type Group = { name: string; elements: Element[] };
    const groups: Group[] = [];
    const add = (name: string, elements: Iterable<Element>) => {
      groups.push({ name, elements: [...elements] });
    };
    const query = (selector: string, root: ParentNode = document) => root.querySelectorAll(selector);
    const commonGroups = () => {
      add("search-platform", query('select[name="platform"]'));
      add("search-nickname", query('input[name="nickname"]'));
      add("search-submit", [...query("button")].filter((element) => /^(검색|쿨타임|검색중\.\.\.)$/.test(element.textContent?.trim() ?? "")));
      add("profile-refresh", query('button[aria-label="전적 갱신"], button[aria-label="최신 전적"]'));
      add("profile-favorite", query('header[aria-label="플레이어 프로필"] button[aria-label*="즐겨찾기"]'));
      add("profile-compare", query('button[aria-label="전적 비교"]'));
      add("profile-weapons", query('button[aria-label="무기 분석"]'));
      add("profile-season", query('select[aria-label="시즌 선택"]'));
      add("section-tab", query('[role="group"][aria-label="전적 분석 섹션"] button'));
      add("stats-mode", query('[role="group"][aria-label="통계 모드"] button'));
      add("party-size", query('[role="group"][aria-label="파티 인원"] button'));
      add("match-filter", query('[role="group"][aria-label="매치 유형 필터"] button'));
      add("match-expand", query('button[aria-label="매치 상세 펼치기"], button[aria-label="매치 상세 접기"]'));
      add("overview-ai-open", query('button[aria-label="최근 10경기 AI 분석으로 이동"]'));
      add("bottom-nav", query('nav[class*="fixed"][class*="bottom-0"] button'));
    };

    commonGroups();
    if (currentState === "ready") {
      const deleteButtons = [...query('button[aria-label*="최근 검색 삭제"]')];
      add("recent-remove", deleteButtons);
      add("recent-quick", deleteButtons.flatMap((button) => {
        const row = button.parentElement;
        const candidate = row?.querySelector("button:not([aria-label])");
        return candidate ? [candidate] : [];
      }));
      add("recent-favorite", deleteButtons.flatMap((button) => {
        const row = button.parentElement;
        const candidate = row?.querySelector('button[aria-label*="즐겨찾기"]');
        return candidate ? [candidate] : [];
      }));
    }
    if (currentState === "detail-error") {
      const alert = document.querySelector('[data-testid="expanded-match-details"] [role="alert"]');
      add("detail-retry", alert ? query("button", alert) : []);
    }
    if (currentState === "detail-expanded") {
      const detail = document.querySelector('[data-testid="expanded-match-details"]');
      add("detail-control", detail ? query("button", detail) : []);
      add("replay-control", query('button[aria-label="3D 전술 리플레이"], button[aria-label="2D 맵 리플레이"], button[aria-label="고정밀 리플레이"]'));
    }
    if (currentState === "squad") {
      const selector = document.querySelector('select[aria-label="스쿼드 그룹"]');
      const squadRoot = selector?.closest("div.space-y-6") ?? selector?.parentElement?.parentElement?.parentElement;
      add("squad-group", selector ? [selector] : []);
      add("squad-control", squadRoot ? query("button", squadRoot) : []);
    }

    const records = groups.flatMap((group) => group.elements.map((element, index) => {
      const rect = element.getBoundingClientRect();
      const style = getComputedStyle(element);
      const visible = style.display !== "none"
        && style.visibility !== "hidden"
        && rect.width > 0
        && rect.height > 0;
      const label = element.getAttribute("aria-label")
        ?? element.textContent?.replace(/\s+/g, " ").trim()
        ?? element.tagName.toLowerCase();
      return {
        name: `${group.name}:${index + 1}:${label}`,
        group: group.name,
        index,
        label,
        role: element.getAttribute("role") ?? element.tagName.toLowerCase(),
        visible,
        width: visible ? Math.round(rect.width * 100) / 100 : 0,
        height: visible ? Math.round(rect.height * 100) / 100 : 0,
        violates44: visible && (rect.width < 44 || rect.height < 44),
      };
    }));
    return {
      state: currentState,
      records,
      groups: groups.map((group) => ({
        name: group.name,
        matchedCount: group.elements.length,
        visibleCount: records.filter((record) => record.group === group.name && record.visible).length,
      })),
    };
  }, state);
}

function assertControlEvidence(input: {
  evidence: Awaited<ReturnType<typeof controlEvidence>>;
  requiredGroups: readonly string[];
  allowedLegacyViolationGroups: readonly string[];
  viewport: Viewport;
}): void {
  const { evidence, requiredGroups, allowedLegacyViolationGroups, viewport } = input;
  for (const groupName of requiredGroups) {
    const group = evidence.groups.find((candidate) => candidate.name === groupName);
    expect(group?.visibleCount, `${evidence.state} visible control group ${groupName}`).toBeGreaterThan(0);
  }
  const visibleRecords = evidence.records.filter((record) => record.visible);
  expect(new Set(visibleRecords.map((record) => record.name)).size).toBe(visibleRecords.length);
  const violations = visibleRecords.filter((record) => record.violates44);
  const primaryViolations = violations.filter((record) => !allowedLegacyViolationGroups.includes(record.group));
  expect(primaryViolations, `${evidence.state} primary 44px violations`).toEqual([]);
  console.log(JSON.stringify({
    kind: "stats-browser-controls",
    viewport,
    state: evidence.state,
    groups: evidence.groups,
    records: visibleRecords,
    classification: {
      primaryViolations,
      legacyViolations: violations.filter((record) => allowedLegacyViolationGroups.includes(record.group)),
      hiddenOrMissing: evidence.groups.filter((group) => group.visibleCount === 0),
    },
  }));
}

async function layoutEvidence(page: Page) {
  return page.evaluate(() => {
    const shell = document.querySelector<HTMLElement>(".stats-page");
    const grid = document.querySelector<HTMLElement>(".stats-result-grid");
    const topSlot = document.querySelector<HTMLElement>('[data-ad-placement="stats-top"]');
    const nav = document.querySelector<HTMLElement>('nav[class*="fixed"][class*="bottom-0"]');
    const shellRect = shell?.getBoundingClientRect();
    const visible = (element: HTMLElement) => {
      const rect = element.getBoundingClientRect();
      const style = getComputedStyle(element);
      return !element.classList.contains("sr-only")
        && style.display !== "none"
        && style.visibility !== "hidden"
        && rect.width > 0
        && rect.height > 0;
    };
    const internalOverflow = [...(shell?.querySelectorAll<HTMLElement>("*") ?? [])]
      .filter(visible)
      .flatMap((element) => {
        const rect = element.getBoundingClientRect();
        const overScroll = element.scrollWidth - element.clientWidth;
        const overRight = rect.right - (shellRect?.right ?? rect.right);
        return overScroll > 1 || overRight > 1
          ? [{ tag: element.tagName, className: element.className, overScroll, overRight }]
          : [];
      })
      .slice(0, 20);
    const sequenceSpecs = [
      ["profile", '[aria-label="플레이어 프로필"]'],
      ["top-ad", '[data-ad-placement="stats-top"]'],
      ["tabs", '[aria-label="전적 분석 섹션"]'],
      ["overview", ".stats-overview-rail"],
      ["match", '[aria-label="최근 매치"]'],
    ] as const;
    const sequence = sequenceSpecs.flatMap(([name, selector]) => {
      const element = shell?.querySelector<HTMLElement>(selector);
      if (!element) return [];
      const rect = element.getBoundingClientRect();
      return [{
        name,
        top: Math.round(rect.top * 100) / 100,
        bottom: Math.round(rect.bottom * 100) / 100,
        inFirstViewport: rect.top < window.innerHeight && rect.bottom > 0,
      }];
    });
    const bottomPadding = shell ? Number.parseFloat(getComputedStyle(shell).paddingBottom) : 0;
    const navRect = nav?.getBoundingClientRect();
    const gridColumns = grid ? getComputedStyle(grid).gridTemplateColumns : "missing";
    return {
      viewport: { width: window.innerWidth, height: window.innerHeight },
      scrollY: window.scrollY,
      globalOverflow: document.documentElement.scrollWidth - document.documentElement.clientWidth,
      internalOverflow,
      shellWidth: shellRect?.width ?? 0,
      shellCapOk: (shellRect?.width ?? 0) <= 1200.5,
      gridColumns,
      gridColumnCount: gridColumns === "missing" ? 0 : gridColumns.trim().split(/\s+/).length,
      topReservation: topSlot?.getBoundingClientRect().height ?? 0,
      topProvider: topSlot?.getAttribute("data-ad-provider") ?? "missing",
      topState: topSlot?.getAttribute("data-ad-state") ?? "missing",
      topPlacement: topSlot?.getAttribute("data-ad-placement") ?? "missing",
      fluidReservations: [...(shell?.querySelectorAll<HTMLElement>(".stats-ad-slot--fluid-infeed") ?? [])]
        .filter(visible)
        .map((element) => Math.round(element.getBoundingClientRect().height)),
      adEvidence: [...(shell?.querySelectorAll<HTMLElement>("[data-ad-placement]") ?? [])]
        .map((element) => ({
          placement: element.getAttribute("data-ad-placement"),
          provider: element.getAttribute("data-ad-provider"),
          state: element.getAttribute("data-ad-state"),
          visibility: element.getAttribute("data-ad-visibility"),
          display: getComputedStyle(element).display,
          childOwnerKeys: [...element.querySelectorAll<HTMLElement>("[data-ad-owner-key]")]
            .map((child) => child.getAttribute("data-ad-owner-key")),
        })),
      feedSequence: [...(shell?.querySelectorAll<HTMLElement>("[data-feed-sequence]") ?? [])]
        .map((element) => element.getAttribute("data-feed-sequence")),
      mobileBottomNavVisible: Boolean(nav && navRect && navRect.height > 0),
      bottomPadding,
      bottomNavHeight: navRect?.height ?? 0,
      bottomSafePaddingOk: !navRect || bottomPadding >= navRect.height,
      sequence,
      nicknameOverflow: [...(shell?.querySelectorAll<HTMLElement>("h2[title]") ?? [])].map((element) => ({
        title: element.getAttribute("title"),
        scrollWidth: element.scrollWidth,
        clientWidth: element.clientWidth,
        textOverflow: getComputedStyle(element).textOverflow,
        whiteSpace: getComputedStyle(element).whiteSpace,
        overflowX: getComputedStyle(element).overflowX,
      })),
    };
  });
}

function assertMountedCreativeEvidence(
  evidence: Awaited<ReturnType<typeof layoutEvidence>>,
  width: number,
): void {
  const expected = width < 768
    ? [
        ["stats-top", "adfit"],
        ["stats-mobile-after-6", "adsense"],
      ]
    : [
        ["stats-top", "adfit"],
        ["stats-after-5", "adsense"],
        ["stats-after-10", "adfit"],
        ["stats-after-15", "adsense"],
      ];
  expect(evidence.adEvidence.map(({ placement, provider }) => [placement, provider])).toEqual(expected);
  for (const creative of evidence.adEvidence) {
    expect(creative.state, `${creative.placement} mounted state`).toBe("mounted");
    expect(creative.display, `${creative.placement} active display`).not.toBe("none");
    expect(creative.childOwnerKeys, `${creative.placement} provider child`).toHaveLength(1);
    expect(creative.childOwnerKeys[0], `${creative.placement} owner key`).toContain(`${creative.placement}:`);
  }
  const topOwner = evidence.adEvidence.find((creative) => creative.placement === "stats-top")?.childOwnerKeys[0];
  expect(topOwner).toContain(width < 768 ? "320x100" : "728x90");
}

function assertLayoutContract(
  evidence: Awaited<ReturnType<typeof layoutEvidence>>,
  width: number,
): void {
  expect(evidence.globalOverflow).toBe(0);
  expect(evidence.internalOverflow).toEqual([]);
  expect(evidence.shellCapOk).toBe(true);
  expect(evidence.gridColumnCount).toBe(width < 1024 ? 1 : 2);
  expect(evidence.sequence.map((item) => item.name)).toEqual([
    "profile",
    "top-ad",
    "tabs",
    "overview",
    "match",
  ]);
  expect(evidence.sequence[0].top).toBeLessThan(evidence.sequence[1].top);
  expect(evidence.sequence[1].top).toBeLessThan(evidence.sequence[2].top);
  expect(evidence.sequence[2].top).toBeLessThan(evidence.sequence[3].top);
  if (width < 1024) {
    expect(evidence.sequence[3].top).toBeLessThan(evidence.sequence[4].top);
  } else {
    expect(Math.abs(evidence.sequence[3].top - evidence.sequence[4].top)).toBeLessThanOrEqual(1);
  }
  expect(evidence.topReservation).toBe(width < 768 ? 100 : 90);
  expect(evidence.topState).toBe("mounted");
  expect(evidence.bottomSafePaddingOk).toBe(true);
  expect(evidence.fluidReservations.every((height) => height >= 130)).toBe(true);
  assertMountedCreativeEvidence(evidence, width);
}

async function setStatsViewportAndWait(
  page: Page,
  dispatcher: InstalledStatsDispatcher,
  viewport: Viewport,
): Promise<void> {
  await page.setViewport(viewport);
  const expectedPlacements = viewport.width < 768
    ? ["stats-top", "stats-mobile-after-6"]
    : ["stats-top", "stats-after-5", "stats-after-10", "stats-after-15"];
  await dispatcher.withFatal(page.waitForFunction((expected) => {
    const grid = document.querySelector<HTMLElement>(".stats-result-grid");
    const top = document.querySelector<HTMLElement>('[data-ad-placement="stats-top"]');
    const placements = [...document.querySelectorAll<HTMLElement>("[data-ad-placement]")]
      .map((element) => element.getAttribute("data-ad-placement"));
    const childrenReady = [...document.querySelectorAll<HTMLElement>("[data-ad-placement]")]
      .every((element) => element.querySelectorAll("[data-ad-owner-key]").length === 1);
    const columns = grid ? getComputedStyle(grid).gridTemplateColumns.trim().split(/\s+/).length : 0;
    return window.innerWidth === expected.width
      && top?.getBoundingClientRect().height === expected.topHeight
      && JSON.stringify(placements) === JSON.stringify(expected.placements)
      && columns === expected.columns
      && childrenReady;
  }, {}, {
    width: viewport.width,
    topHeight: viewport.width < 768 ? 100 : 90,
    placements: expectedPlacements,
    columns: viewport.width < 1024 ? 1 : 2,
  }));
}

describeBrowser("stats browser smoke", () => {
  let browser: Browser;
  let ownedServer: OwnedStatsDevServer | undefined;
  let baseUrl = "";
  let clock: StatsQaClock;

  beforeAll(async () => {
    mkdirSync(join(process.cwd(), "tmp", "stats-browser-qa"), { recursive: true });
    clock = createStatsQaClock();
    if (process.env.STATS_BASE_URL) {
      baseUrl = process.env.STATS_BASE_URL.replace(/\/$/, "");
    } else {
      ownedServer = await startOwnedStatsDevServer();
      baseUrl = ownedServer.baseUrl;
    }
    browser = await puppeteer.launch({
      headless: true,
      args: ["--no-sandbox", "--disable-setuid-sandbox"],
    });
    console.log(JSON.stringify({ kind: "stats-browser-clock", nowIso: clock.nowIso, baseUrl, ownedPid: ownedServer?.pid ?? null }));
  }, 130_000);

  afterAll(async () => {
    try {
      await browser?.close();
    } finally {
      await ownedServer?.stop();
    }
  }, 30_000);

  it("dev-server readiness gate captures landing screenshot and clean document boundary", async () => {
    await withStatsBrowserPage({
      browser,
      baseUrl,
      scenarioName: "ready",
      clock,
      viewport: { width: 1440, height: 900 },
      run: async ({ page, dispatcher }) => {
        const log = attachRuntimeLog(page);
        await goToLanding(page, dispatcher, baseUrl);
        await page.screenshot({ path: join(process.cwd(), "tmp", "stats-browser-qa", "dev-server-check.png"), fullPage: true });
        const bodyText = await page.$eval("body", (body) => body.innerText.trim());
        expect(bodyText.length).toBeGreaterThan(30);
        await assertNoOverlay(page);
        expect(log.pageErrors).toEqual([]);
        expect(log.consoleErrors.filter((message) => /hydration|text content|mismatch/i.test(message))).toEqual([]);
        expect(await page.$('select[name="platform"]')).not.toBeNull();
        expect(await page.$('input[name="nickname"]')).not.toBeNull();
        expect(await page.$('button:not([disabled])')).not.toBeNull();
        dispatcher.ledger.throwIfUnexpected();
        console.log(JSON.stringify({ kind: "stats-browser-dev-check", bodyLength: bodyText.length, log }));
      },
    });
  }, 60_000);

  it.each(FUNCTIONAL_VIEWPORTS)("functional ready/double-submit/control flow at %sx%s", async (viewport) => {
    await withStatsBrowserPage({
      browser,
      baseUrl,
      scenarioName: "ready",
      clock,
      viewport,
      run: async ({ page, dispatcher }) => {
        const log = attachRuntimeLog(page);
        await goToPlayer(page, dispatcher, baseUrl, "steam", "FixturePlayer");
        await waitForPlayerSuccess(dispatcher, "FixturePlayer", "steam");
        await waitForSummarySuccess(dispatcher, "FixturePlayer", "steam");
        await waitForStatsSelector({ dispatcher, page, selector: 'h2[title="FixturePlayer"]' });
        await waitForStatsSelector({ dispatcher, page, selector: '[data-compact-match-id="match-fixture-1"]' });
        expect(await page.$eval('h2[title="FixturePlayer"]', (node) => node.textContent)).toBe("FixturePlayer");
        expect(await page.$eval('[data-ad-placement="stats-top"]', (node) => node.getAttribute("data-ad-state"))).toBe("mounted");
        const before = playerRecords(dispatcher, "FixturePlayer", "steam").filter((record) => record.successful).length;
        await fillNickname(page, dispatcher, "FixturePlayer");
        await page.evaluate(() => {
          const search = [...document.querySelectorAll("button")].find((button) => button.textContent?.trim() === "검색");
          search?.click();
          search?.click();
        });
        expect(playerRecords(dispatcher, "FixturePlayer", "steam").filter((record) => record.successful)).toHaveLength(before);
        await page.focus('input[name="nickname"]');
        await waitForStatsSelector({ dispatcher, page, selector: 'button[aria-label*="최근 검색 삭제"]' });
        const controls = await controlEvidence(page, "ready");
        assertControlEvidence({
          evidence: controls,
          requiredGroups: [
            "search-platform",
            "search-nickname",
            "search-submit",
            "recent-quick",
            "recent-favorite",
            "recent-remove",
            "profile-refresh",
            "profile-favorite",
            "profile-compare",
            "profile-weapons",
            "profile-season",
            "section-tab",
            "stats-mode",
            "party-size",
            "match-filter",
            "match-expand",
            "overview-ai-open",
            ...(viewport.width < 768 ? ["bottom-nav"] : []),
          ],
          allowedLegacyViolationGroups: ["match-filter", "bottom-nav"],
          viewport,
        });
        if (viewport.width >= 768) {
          expect(controls.groups.find((group) => group.name === "bottom-nav")?.visibleCount).toBe(0);
        }
        await page.click('button[aria-label="최근 10경기 AI 분석으로 이동"]');
        await dispatcher.withFatal(page.waitForFunction(() => {
          const region = document.querySelector<HTMLElement>('[role="region"][aria-label="AI 분석"]');
          const firstButton = region?.querySelector<HTMLButtonElement>("button");
          const rect = region?.getBoundingClientRect();
          return Boolean(
            region
            && firstButton
            && document.activeElement === firstButton
            && rect
            && rect.top < window.innerHeight
            && rect.bottom > 0,
          );
        }));
        const aiTarget = await page.$eval('[role="region"][aria-label="AI 분석"]', (region) => {
          const rect = region.getBoundingClientRect();
          const firstButton = region.querySelector<HTMLButtonElement>("button");
          return {
            top: rect.top,
            bottom: rect.bottom,
            viewportHeight: window.innerHeight,
            focusedFirstButton: document.activeElement === firstButton,
            firstButtonText: firstButton?.textContent?.replace(/\s+/g, " ").trim() ?? null,
          };
        });
        expect(aiTarget.focusedFirstButton).toBe(true);
        expect(aiTarget.top).toBeLessThan(aiTarget.viewportHeight);
        expect(aiTarget.bottom).toBeGreaterThan(0);
        expect(dispatcher.ledger.count({ pathname: "/api/pubg/ai-summary" })).toBe(0);
        expect(dispatcher.ledger.count({ pathname: "/api/pubg/ai-analyze" })).toBe(0);
        expect(dispatcher.ledger.count({ pathname: "/api/pubg/ai-squad" })).toBe(0);
        console.log(JSON.stringify({ kind: "stats-browser-ai-focus-scroll", viewport, aiTarget }));
        await recordScenarioEvidence("ready", viewport, dispatcher, log);
      },
    });
  }, 60_000);

  it.each(FUNCTIONAL_VIEWPORTS)("Steam/Kakao identity and dynamic route at %sx%s", async (viewport) => {
    for (const identity of [
      { platform: "steam" as const, nickname: "FixturePlayer", label: "Steam" },
      { platform: "kakao" as const, nickname: "KakaoPlayer", label: "Kakao" },
    ]) {
      await withStatsBrowserPage({
        browser,
        baseUrl,
        scenarioName: "ready",
        clock,
        viewport,
        run: async ({ page, dispatcher }) => {
          const log = attachRuntimeLog(page);
          await goToPlayer(page, dispatcher, baseUrl, identity.platform, identity.nickname);
          await waitForPlayerSuccess(dispatcher, identity.nickname, identity.platform);
          await waitForSummarySuccess(dispatcher, identity.nickname, identity.platform);
          await waitForStatsSelector({ dispatcher, page, selector: `h2[title="${identity.nickname}"]` });
        expect(await page.$eval(".stats-page", (node, expectedLabel) => node.textContent?.includes(expectedLabel), identity.label)).toBe(true);
          await recordScenarioEvidence(`identity-${identity.platform}`, viewport, dispatcher, log);
        },
      });
    }
  }, 120_000);

  it.each(FUNCTIONAL_VIEWPORTS)("empty submit sends zero player requests at %sx%s", async (viewport) => {
    await withStatsBrowserPage({
      browser,
      baseUrl,
      scenarioName: "ready",
      clock,
      viewport,
      run: async ({ page, dispatcher }) => {
        await goToLanding(page, dispatcher, baseUrl);
        expect(await page.evaluate(() => {
          const button = [...document.querySelectorAll("button")]
            .find((candidate) => candidate.textContent?.trim() === "검색");
          return button instanceof HTMLButtonElement && button.disabled;
        })).toBe(true);
        await page.evaluate(() => {
          const button = [...document.querySelectorAll("button")]
            .find((candidate) => candidate.textContent?.trim() === "검색");
          (button as HTMLButtonElement | undefined)?.click();
        });
        expect(dispatcher.ledger.count({ pathname: "/api/pubg/player" })).toBe(0);
        await recordScenarioEvidence("empty-submit", viewport, dispatcher, { consoleErrors: [], pageErrors: [] });
      },
    });
  }, 60_000);

  it.each(FUNCTIONAL_VIEWPORTS)("404 suggestion A→B uses returned Kakao identity at %sx%s", async (viewport) => {
    await withStatsBrowserPage({
      browser,
      baseUrl,
      scenarioName: "not-found-then-ready",
      clock,
      viewport,
      run: async ({ page, dispatcher }) => {
        const log = attachRuntimeLog(page);
        await goToLanding(page, dispatcher, baseUrl);
        await fillNickname(page, dispatcher, "MissingPlayer");
        await clickButtonText(page, "검색");
        await waitForPlayerTerminal(dispatcher, "MissingPlayer", "steam");
        await waitForStatsText({ dispatcher, page, text: "플레이어를 찾을 수 없습니다" });
        expect(playerRecords(dispatcher, "MissingPlayer", "steam").some((record) => record.status === 404)).toBe(true);
        await waitForStatsSelector({ dispatcher, page, selector: 'button[aria-label="KakaoPlayer 카카오로 검색"]' });
        await page.click('button[aria-label="KakaoPlayer 카카오로 검색"]');
        await waitForPlayerSuccess(dispatcher, "KakaoPlayer", "kakao");
        await waitForSummarySuccess(dispatcher, "KakaoPlayer", "kakao");
        await waitForStatsSelector({ dispatcher, page, selector: 'h2[title="KakaoPlayer"]' });
        await recordScenarioEvidence("not-found-then-ready", viewport, dispatcher, log);
      },
    });
  }, 60_000);

  it.each(FUNCTIONAL_VIEWPORTS)("429 Retry-After blocks success until deadline at %sx%s", async (viewport) => {
    await withStatsBrowserPage({
      browser,
      baseUrl,
      scenarioName: "rate-limit",
      clock,
      viewport,
      run: async ({ page, dispatcher }) => {
        const log = attachRuntimeLog(page);
        const observationStartedAt = Date.now();
        await goToPlayer(page, dispatcher, baseUrl, "steam", "FixturePlayer");
        await waitForPlayerTerminal(dispatcher, "FixturePlayer", "steam");
        await waitForStatsText({ dispatcher, page, text: "전적을 불러오지 못했습니다" });
        const rateLimit = playerRecords(dispatcher, "FixturePlayer", "steam").find((record) => record.status === 429);
        expect(rateLimit?.status).toBe(429);
        expect(rateLimit?.successful).toBe(false);
        expect(dispatcher.ledger.records.filter((record) => record.pathname === "/api/pubg/player" && record.successful)).toHaveLength(0);
        expect(await isButtonDisabled(page, "다시 시도", true)).toBe(true);
        const remainingObservationMs = Math.max(0, 900 - (Date.now() - observationStartedAt));
        await waitForWallClock(dispatcher, remainingObservationMs);
        const observedMs = Date.now() - observationStartedAt;
        expect(observedMs).toBeGreaterThanOrEqual(900);
        expect(dispatcher.ledger.records.filter((record) => record.pathname === "/api/pubg/player" && record.successful)).toHaveLength(0);
        expect(await isButtonDisabled(page, "다시 시도", true)).toBe(true);
        await waitForButtonEnabled(page, dispatcher, "다시 시도", true, 5_000);
        await clickLastButtonText(page, "다시 시도");
        await waitForPlayerSuccess(dispatcher, "FixturePlayer", "steam");
        await waitForSummarySuccess(dispatcher, "FixturePlayer", "steam");
        await recordScenarioEvidence("rate-limit", viewport, dispatcher, log);
      },
    });
  }, 60_000);

  it.each(FUNCTIONAL_VIEWPORTS)("500 player retry is query-aware 500→200 at %sx%s", async (viewport) => {
    await withStatsBrowserPage({
      browser,
      baseUrl,
      scenarioName: "player-retry",
      clock,
      viewport,
      run: async ({ page, dispatcher }) => {
        const log = attachRuntimeLog(page);
        await goToPlayer(page, dispatcher, baseUrl, "steam", "FixturePlayer");
        await waitForStatsSelector({ dispatcher, page, selector: '[role="status"]' });
        await waitForPlayerTerminal(dispatcher, "FixturePlayer", "steam");
        await waitForStatsText({ dispatcher, page, text: "전적을 불러오지 못했습니다" });
        expect(playerRecords(dispatcher, "FixturePlayer", "steam").some((record) => record.status === 500)).toBe(true);
        await waitForButtonEnabled(page, dispatcher, "다시 시도", true);
        await clickLastButtonText(page, "다시 시도");
        await waitForPlayerSuccess(dispatcher, "FixturePlayer", "steam");
        await waitForSummarySuccess(dispatcher, "FixturePlayer", "steam");
        expect(playerRecords(dispatcher, "FixturePlayer", "steam").filter((record) => record.successful)).toHaveLength(1);
        await recordScenarioEvidence("player-retry", viewport, dispatcher, log);
      },
    });
  }, 60_000);

  it.each(FUNCTIONAL_VIEWPORTS)("summary inline retry is query-aware 500→200 at %sx%s", async (viewport) => {
    await withStatsBrowserPage({
      browser,
      baseUrl,
      scenarioName: "summary-retry",
      clock,
      viewport,
      run: async ({ page, dispatcher }) => {
        const log = attachRuntimeLog(page);
        await goToPlayer(page, dispatcher, baseUrl, "steam", "FixturePlayer");
        await waitForPlayerSuccess(dispatcher, "FixturePlayer", "steam");
        await dispatcher.waitForTerminal({
          selector: { pathname: "/api/pubg/matches-summary", method: "POST", semanticKey: summarySemanticKey({ matchIds: ["match-fixture-1"], nickname: "FixturePlayer", platform: "steam" }), state: "completed" },
          count: 1,
        });
        await waitForStatsText({ dispatcher, page, text: "최근 매치 요약을 불러오지 못했습니다." });
        await clickButtonText(page, "매치 요약 다시 시도");
        await waitForSummarySuccess(dispatcher, "FixturePlayer", "steam");
        await waitForStatsSelector({ dispatcher, page, selector: '[data-compact-match-id="match-fixture-1"]' });
        await recordScenarioEvidence("summary-retry", viewport, dispatcher, log);
      },
    });
  }, 60_000);

  it.each(FUNCTIONAL_VIEWPORTS)("detail expand error and row-local retry recover at %sx%s", async (viewport) => {
    await withStatsBrowserPage({
      browser,
      baseUrl,
      scenarioName: "detail-retry",
      clock,
      viewport,
      run: async ({ page, dispatcher }) => {
        const log = attachRuntimeLog(page);
        await goToPlayer(page, dispatcher, baseUrl, "steam", "FixturePlayer");
        await waitForPlayerSuccess(dispatcher, "FixturePlayer", "steam");
        await waitForSummarySuccess(dispatcher, "FixturePlayer", "steam");
        const detailButtonSelector = '[data-compact-match-id="match-fixture-1"] button[aria-label="매치 상세 펼치기"]';
        await page.$eval(detailButtonSelector, (button) => button.scrollIntoView({ block: "center", inline: "center" }));
        await page.click(detailButtonSelector);
        await dispatcher.waitForTerminal({
          selector: { pathname: "/api/pubg/match", method: "GET", semanticKey: detailSemanticKey({ matchId: "match-fixture-1", nickname: "FixturePlayer", platform: "steam" }), state: "completed" },
          count: 1,
        });
        await waitForStatsText({ dispatcher, page, text: "상세 정보를 불러오지 못했습니다" });
        await waitForStatsSelector({ dispatcher, page, selector: '[data-testid="expanded-match-details"] [role="alert"]' });
        const errorControls = await controlEvidence(page, "detail-error");
        assertControlEvidence({
          evidence: errorControls,
          requiredGroups: ["detail-retry"],
          allowedLegacyViolationGroups: ["match-filter", "bottom-nav", "detail-retry"],
          viewport,
        });
        await clickButtonText(page, "상세 다시 시도");
        await waitForDetailSuccess(dispatcher, "FixturePlayer", "steam");
        await waitForStatsSelector({ dispatcher, page, selector: '[data-testid="expanded-match-details"]' });
        await recordScenarioEvidence("detail-retry", viewport, dispatcher, log);
      },
    });
  }, 60_000);

  it.each(FUNCTIONAL_VIEWPORTS)("favorite and recent storage stay inside a fresh scenario at %sx%s", async (viewport) => {
    await withStatsBrowserPage({
      browser,
      baseUrl,
      scenarioName: "ready",
      clock,
      viewport,
      run: async ({ page, dispatcher }) => {
        const log = attachRuntimeLog(page);
        await goToPlayer(page, dispatcher, baseUrl, "steam", "FixturePlayer");
        await waitForPlayerSuccess(dispatcher, "FixturePlayer", "steam");
        await waitForSummarySuccess(dispatcher, "FixturePlayer", "steam");
        await page.click('button[aria-label="즐겨찾기 추가"]');
        const storage = await page.evaluate(() => ({
          recent: localStorage.getItem("pubg_recent_searches_v2"),
          favorites: localStorage.getItem("pubg_favorites_v2"),
        }));
        expect(storage.recent).toContain("FixturePlayer");
        expect(storage.favorites).toContain("FixturePlayer");
        await recordScenarioEvidence("storage", viewport, dispatcher, log);
      },
    });
    await withStatsBrowserPage({
      browser,
      baseUrl,
      scenarioName: "ready",
      clock,
      viewport,
      run: async ({ page, dispatcher }) => {
        await goToLanding(page, dispatcher, baseUrl);
        const storage = await page.evaluate(() => ({
          recent: localStorage.getItem("pubg_recent_searches_v2"),
          favorites: localStorage.getItem("pubg_favorites_v2"),
        }));
        expect(storage.recent).toBeNull();
        expect(storage.favorites).toBeNull();
        await recordScenarioEvidence("storage-fresh-context", viewport, dispatcher, { consoleErrors: [], pageErrors: [] });
      },
    });
  }, 60_000);

  it.each(FUNCTIONAL_VIEWPORTS)("autocomplete aborts stale q and renders latest q at %sx%s", async (viewport) => {
    await withStatsBrowserPage({
      browser,
      baseUrl,
      scenarioName: "autocomplete-abort",
      clock,
      viewport,
      run: async ({ page, dispatcher }) => {
        const log = attachRuntimeLog(page);
        await goToLanding(page, dispatcher, baseUrl);
        await fillNickname(page, dispatcher, "Old");
        await waitUntil(dispatcher, () => dispatcher.ledger.records.some((record) => record.pathname === "/api/pubg/suggest" && record.query.q === "Old"), "old autocomplete request start");
        await fillNickname(page, dispatcher, "Latest");
        await waitForStatsSelector({ dispatcher, page, selector: 'button[aria-label="LatestPlayer 카카오로 검색"]' });
        expect(await page.$('button[aria-label="OldPlayer 스팀으로 검색"]')).toBeNull();
        await waitUntil(dispatcher, () => dispatcher.ledger.records.some((record) => record.pathname === "/api/pubg/suggest" && record.query.q === "Old" && record.state === "aborted"), "old autocomplete abort");
        await recordScenarioEvidence("autocomplete-abort", viewport, dispatcher, log);
      },
    });
  }, 60_000);

  it.each(FUNCTIONAL_VIEWPORTS)("season and force refresh use distinct query-aware responses at %sx%s", async (viewport) => {
    await withStatsBrowserPage({
      browser,
      baseUrl,
      scenarioName: "season-refresh",
      clock,
      viewport,
      run: async ({ page, dispatcher }) => {
        const log = attachRuntimeLog(page);
        await goToPlayer(page, dispatcher, baseUrl, "steam", "FixturePlayer");
        await waitForPlayerSuccess(dispatcher, "FixturePlayer", "steam");
        await waitForSummarySuccess(dispatcher, "FixturePlayer", "steam");
        const beforeSeason = dispatcher.ledger.records.at(-1)?.id ?? 0;
        await page.select('select[aria-label="시즌 선택"]', SEASON_ID);
        await waitForPlayerSuccess(dispatcher, "FixturePlayer", "steam", { season: SEASON_ID, afterRecordId: beforeSeason });
        const beforeRefresh = dispatcher.ledger.records.at(-1)?.id ?? 0;
        await dispatcher.withFatal(page.waitForFunction(() => {
          const button = document.querySelector<HTMLButtonElement>('button[aria-label="전적 갱신"], button[aria-label="최신 전적"]');
          return Boolean(button && !button.disabled);
        }));
        await waitForSearchCooldownReleased(page, dispatcher);
        await clickRefresh(page);
        await waitForPlayerSuccess(dispatcher, "FixturePlayer", "steam", {
          season: SEASON_ID,
          refresh: true,
          afterRecordId: beforeRefresh,
        });
        const semanticKeys = dispatcher.ledger.records
          .filter((record) => record.pathname === "/api/pubg/player" && record.successful)
          .map((record) => record.semanticKey);
        expect(new Set(semanticKeys).size).toBe(3);
        await recordScenarioEvidence("season-refresh", viewport, dispatcher, log);
      },
    });
  }, 60_000);

  it.each(FUNCTIONAL_VIEWPORTS)("squad list/groupKey/history and unauthenticated AI boundaries at %sx%s", async (viewport) => {
    await withStatsBrowserPage({
      browser,
      baseUrl,
      scenarioName: "squad",
      clock,
      viewport,
      run: async ({ page, dispatcher }) => {
        const log = attachRuntimeLog(page);
        await goToPlayer(page, dispatcher, baseUrl, "steam", "FixturePlayer", "?tab=squad&groupKey=g2");
        await waitForPlayerSuccess(dispatcher, "FixturePlayer", "steam");
        await dispatcher.waitForTerminal({ selector: { pathname: "/api/pubg/squad-analyze", method: "GET", query: { nickname: "FixturePlayer", platform: "steam" }, state: "completed", successful: true }, count: 1 });
        await dispatcher.waitForTerminal({ selector: { pathname: "/api/pubg/squad-analyze", method: "GET", query: { nickname: "FixturePlayer", platform: "steam", groupKey: "g2" }, state: "completed", successful: true }, count: 1 });
        await waitForStatsSelector({ dispatcher, page, selector: 'select[aria-label="스쿼드 그룹"]' });
        expect(await page.$eval('select[aria-label="스쿼드 그룹"]', (node) => (node as HTMLSelectElement).value)).toBe("g2");
        await page.select('select[aria-label="스쿼드 그룹"]', "g1");
        await dispatcher.waitForTerminal({ selector: { pathname: "/api/pubg/squad-analyze", method: "GET", query: { nickname: "FixturePlayer", platform: "steam", groupKey: "g1" }, state: "completed", successful: true }, count: 1 });
        expect(dispatcher.ledger.count({ pathname: "/api/pubg/squad-analyze", query: { nickname: "FixturePlayer", platform: "steam" } })).toBeGreaterThanOrEqual(1);
        const squadControls = await controlEvidence(page, "squad");
        assertControlEvidence({
          evidence: squadControls,
          requiredGroups: ["squad-group", "squad-control"],
          allowedLegacyViolationGroups: ["bottom-nav", "squad-group", "squad-control"],
          viewport,
        });
        expect(squadControls.records.some((record) => (
          record.visible
          && record.group === "squad-control"
          && record.label.includes("AI 코칭 보고서 생성")
        ))).toBe(true);
        await clickButtonText(page, "AI 코칭 보고서 생성");
        expect(dispatcher.ledger.count({ pathname: "/api/pubg/ai-squad" })).toBe(0);
        await clickButtonText(page, "개인 분석 개요");
        await waitForStatsSelector({ dispatcher, page, selector: '[aria-label="최근 매치"]' });
        await clickButtonText(page, "스쿼드 시너지");
        await waitForStatsSelector({ dispatcher, page, selector: 'select[aria-label="스쿼드 그룹"]' });
        dispatcher.ledger.assertNoUnauthenticatedAi();
        await recordScenarioEvidence("squad", viewport, dispatcher, log);
      },
    });
  }, 90_000);

  it.each(FUNCTIONAL_VIEWPORTS)("13/15/91-day rows keep product expiry behavior at %sx%s", async (viewport) => {
    await withStatsBrowserPage({
      browser,
      baseUrl,
      scenarioName: "expired",
      clock,
      viewport,
      run: async ({ page, dispatcher }) => {
        const log = attachRuntimeLog(page);
        await goToPlayer(page, dispatcher, baseUrl, "steam", "ExpiredPlayer");
        await waitForPlayerSuccess(dispatcher, "ExpiredPlayer", "steam");
        await waitForSummarySuccess(dispatcher, "ExpiredPlayer", "steam", ["match-age-13", "match-age-15", "match-age-91"]);
        await waitForStatsSelector({ dispatcher, page, selector: '[data-compact-match-id="match-age-13"]' });
        for (const matchId of ["match-age-13", "match-age-15", "match-age-91"]) {
          await page.click(`[data-compact-match-id="${matchId}"] button[aria-label="매치 상세 펼치기"]`);
        }
        await waitForStatsText({ dispatcher, page, text: "14일이 경과된 과거 전적입니다" });
        await waitForDetailSuccess(dispatcher, "ExpiredPlayer", "steam", "match-age-13");
        expect(dispatcher.ledger.records.filter((record) => record.pathname === "/api/pubg/match" && record.successful)).toHaveLength(1);
        await recordScenarioEvidence("expired", viewport, dispatcher, log);
      },
    });
  }, 60_000);

  it.each(FUNCTIONAL_VIEWPORTS)("controls preserve match filters, replay controls availability, and AI zero-request boundary at %sx%s", async (viewport) => {
    await withStatsBrowserPage({
      browser,
      baseUrl,
      scenarioName: "ready",
      clock,
      viewport,
      run: async ({ page, dispatcher }) => {
        const log = attachRuntimeLog(page);
        await goToPlayer(page, dispatcher, baseUrl, "steam", "FixturePlayer");
        await waitForPlayerSuccess(dispatcher, "FixturePlayer", "steam");
        await waitForSummarySuccess(dispatcher, "FixturePlayer", "steam");
        await page.click('[role="group"][aria-label="통계 모드"] button:nth-child(2)');
        await page.click('[role="group"][aria-label="파티 인원"] button:nth-child(1)');
        await dispatcher.withFatal(page.waitForFunction(() => (
          document.querySelector('[role="group"][aria-label="통계 모드"] button:nth-child(2)')?.getAttribute("aria-pressed") === "true"
          && document.querySelector('[role="group"][aria-label="파티 인원"] button:nth-child(1)')?.getAttribute("aria-pressed") === "true"
        )));
        expect(await page.$$('[data-compact-match-id="match-fixture-1"]')).toHaveLength(1);
        expect(dispatcher.ledger.count({ pathname: "/api/pubg/player", successful: true })).toBe(1);
        expect(await page.$eval('[role="group"][aria-label="매치 유형 필터"] button[aria-pressed="true"]', (button) => button.textContent?.trim())).toBe("전체");
        await recordScenarioEvidence("controls-overview", viewport, dispatcher, log);
      },
    });

    await withStatsBrowserPage({
      browser,
      baseUrl,
      scenarioName: "ready",
      clock,
      viewport,
      run: async ({ page, dispatcher }) => {
        const log = attachRuntimeLog(page);
        await goToPlayer(page, dispatcher, baseUrl, "steam", "FixturePlayer");
        await waitForPlayerSuccess(dispatcher, "FixturePlayer", "steam");
        await waitForSummarySuccess(dispatcher, "FixturePlayer", "steam");
        await page.click('[data-compact-match-id="match-fixture-1"] button[aria-label="매치 상세 펼치기"]');
        await waitForDetailSuccess(dispatcher, "FixturePlayer", "steam");
        await waitForStatsSelector({ dispatcher, page, selector: 'section[aria-label="매치 성과 및 티어 근거"]' });
        await clickButtonText(page, "무기 사용 및 고정밀 교전 분석");
        await waitForStatsText({ dispatcher, page, text: "내 무기 상세 스탯" });
        await waitForStatsText({ dispatcher, page, text: "전술 위치 분석 및 타임라인" });
        await clickButtonText(page, "팀원 교전 성적");
        await waitForStatsText({ dispatcher, page, text: "팀원 교전 성적" });
        await clickButtonText(page, "AI 전술 코칭");
        await waitForStatsSelector({ dispatcher, page, selector: 'button[aria-label="이 매치 정밀 분석 시작하기"]' });
        await page.click('button[aria-label="이 매치 정밀 분석 시작하기"]');
        expect(dispatcher.ledger.count({ pathname: "/api/pubg/ai-analyze" })).toBe(0);
        await page.click('button[aria-label="리플레이 분석"]');
        await waitForStatsSelector({ dispatcher, page, selector: 'button[aria-label="3D 전술 리플레이"]' });
        const replayControls = await page.evaluate(() => [
          "3D 전술 리플레이",
          "2D 맵 리플레이",
          "고정밀 리플레이",
        ].map((label) => {
          const button = document.querySelector<HTMLButtonElement>(`button[aria-label="${label}"]`);
          return { label, present: Boolean(button), disabled: button?.disabled ?? false };
        }));
        expect(replayControls).toEqual([
          { label: "3D 전술 리플레이", present: true, disabled: false },
          { label: "2D 맵 리플레이", present: true, disabled: false },
          { label: "고정밀 리플레이", present: true, disabled: false },
        ]);
        const detailControls = await controlEvidence(page, "detail-expanded");
        assertControlEvidence({
          evidence: detailControls,
          requiredGroups: ["detail-control", "replay-control"],
          allowedLegacyViolationGroups: ["match-filter", "bottom-nav", "detail-control", "replay-control"],
          viewport,
        });
        for (const label of [
          "이 매치 정밀 분석 시작하기",
          "리플레이 분석",
          "3D 전술 리플레이",
          "2D 맵 리플레이",
          "고정밀 리플레이",
        ]) {
          expect(detailControls.records.some((record) => record.visible && record.label.includes(label)), label).toBe(true);
        }
        console.log(JSON.stringify({
          kind: "stats-browser-replay-controls",
          viewport,
          controls: replayControls,
          navigation: "unverified: telemetry-backed replay routes are outside the deterministic fixture contract",
        }));
        await recordScenarioEvidence("controls-replay-ai", viewport, dispatcher, log);
      },
    });
  }, 60_000);

  it.each(FUNCTIONAL_VIEWPORTS)("invalid platform redirects without player request and client route remount race keeps B at %sx%s", async (viewport) => {
    await withStatsBrowserPage({
      browser,
      baseUrl,
      scenarioName: "ready",
      clock,
      viewport,
      run: async ({ page, dispatcher }) => {
        const log = attachRuntimeLog(page);
        await gotoStatsPage({ dispatcher, page, url: `${baseUrl}/stats/xbox/FixturePlayer` });
        await dispatcher.withFatal(page.waitForFunction(() => location.pathname === "/stats"));
        expect(dispatcher.ledger.count({ pathname: "/api/pubg/player" })).toBe(0);
        await recordScenarioEvidence("invalid-platform", viewport, dispatcher, log);
      },
    });
    await withStatsBrowserPage({
      browser,
      baseUrl,
      scenarioName: "route-race",
      clock,
      viewport,
      run: async ({ page, dispatcher }) => {
        const log = attachRuntimeLog(page);
        await executeRouteRemountRace({
          page,
          dispatcher,
          baseUrl,
          label: `route-race-${viewport.width}x${viewport.height}`,
        });
        await recordScenarioEvidence("route-race", viewport, dispatcher, log);
      },
    });
  }, 90_000);

  it("browser-only regression audit rows STATS-011/012/013/014/016 execute with exact ledger evidence", async () => {
    await withStatsBrowserPage({
      browser,
      baseUrl,
      scenarioName: "ready",
      clock,
      viewport: { width: 1440, height: 900 },
      run: async ({ page, dispatcher }) => {
        const log = attachRuntimeLog(page);
        await goToLanding(page, dispatcher, baseUrl);
        await page.evaluate(() => localStorage.setItem("pubg_recent_searches_v2", JSON.stringify(["StoredPlayer"])));
        await page.reload({ waitUntil: "domcontentloaded" });
        await waitForStatsSelector({ dispatcher, page, selector: 'input[name="nickname"]' });
        expect(log.pageErrors.filter((message) => /hydration|mismatch/i.test(message))).toEqual([]);
        await gotoStatsPage({ dispatcher, page, url: `${baseUrl}/stats/steam/FixturePlayer` });
        await waitForPlayerSuccess(dispatcher, "FixturePlayer", "steam");
        const firstDynamicUrl = page.url();
        await dispatcher.withFatal(page.waitForFunction(() => document.title.includes("FixturePlayer")));
        await page.goBack({ waitUntil: "domcontentloaded" });
        await dispatcher.withFatal(page.waitForFunction(() => location.pathname === "/stats"));
        await page.goForward({ waitUntil: "domcontentloaded" });
        await dispatcher.withFatal(page.waitForFunction(() => location.pathname.includes("/stats/steam/FixturePlayer")));
        const canonical = await page.$eval('link[rel="canonical"]', (node) => node.getAttribute("href"));
        const ogUrl = await page.$eval('meta[property="og:url"]', (node) => node.getAttribute("content"));
        expect(canonical).toContain("/stats/steam/FixturePlayer");
        expect(ogUrl).toBe(canonical);
        expect(firstDynamicUrl).toContain("/stats/steam/FixturePlayer");
        await recordScenarioEvidence("STATS-011-012", { width: 1440, height: 900 }, dispatcher, log);
      },
    });

    await withStatsBrowserPage({
      browser,
      baseUrl,
      scenarioName: "ready",
      clock,
      viewport: { width: 1440, height: 900 },
      run: async ({ page, dispatcher }) => {
        await gotoStatsPage({ dispatcher, page, url: `${baseUrl}/stats/xbox/FixturePlayer` });
        await dispatcher.withFatal(page.waitForFunction(() => location.pathname === "/stats"));
        expect(dispatcher.ledger.count({ pathname: "/api/pubg/player" })).toBe(0);
        await recordScenarioEvidence("STATS-013", { width: 1440, height: 900 }, dispatcher, { consoleErrors: [], pageErrors: [] });
      },
    });

    await withStatsBrowserPage({
      browser,
      baseUrl,
      scenarioName: "season-refresh",
      clock,
      viewport: { width: 1440, height: 900 },
      run: async ({ page, dispatcher }) => {
        await goToPlayer(page, dispatcher, baseUrl, "steam", "SeasonFailurePlayer");
        await waitForPlayerSuccess(dispatcher, "SeasonFailurePlayer", "steam");
        await waitForSummarySuccess(dispatcher, "SeasonFailurePlayer", "steam");
        const beforeFailure = await page.evaluate(() => {
          const profile = document.querySelector<HTMLElement>('header[aria-label="플레이어 프로필"]');
          const row = document.querySelector<HTMLElement>('[data-compact-match-id="match-fixture-1"]');
          return {
            profileTitle: profile?.querySelector("h2")?.getAttribute("title") ?? null,
            profileNickname: profile?.querySelector("h2")?.textContent?.trim() ?? null,
            platformLabel: profile?.querySelector("span")?.textContent?.trim() ?? null,
            matchId: row?.getAttribute("data-compact-match-id") ?? null,
            matchRowText: row?.textContent?.replace(/\s+/g, " ").trim() ?? null,
          };
        });
        await page.select('select[aria-label="시즌 선택"]', SEASON_ID);
        await dispatcher.waitForTerminal({ selector: { pathname: "/api/pubg/player", method: "GET", semanticKey: playerSemanticKey({ nickname: "SeasonFailurePlayer", platform: "steam", season: SEASON_ID }), state: "completed" }, count: 1 });
        await waitForStatsText({ dispatcher, page, text: "전적을 불러오지 못했습니다" });
        const afterFailure = await page.evaluate(() => {
          const profile = document.querySelector<HTMLElement>('header[aria-label="플레이어 프로필"]');
          const row = document.querySelector<HTMLElement>('[data-compact-match-id="match-fixture-1"]');
          return {
            profileTitle: profile?.querySelector("h2")?.getAttribute("title") ?? null,
            profileNickname: profile?.querySelector("h2")?.textContent?.trim() ?? null,
            platformLabel: profile?.querySelector("span")?.textContent?.trim() ?? null,
            matchId: row?.getAttribute("data-compact-match-id") ?? null,
            matchRowText: row?.textContent?.replace(/\s+/g, " ").trim() ?? null,
          };
        });
        expect(beforeFailure).toEqual({
          profileTitle: "SeasonFailurePlayer",
          profileNickname: "SeasonFailurePlayer",
          platformLabel: "Steam",
          matchId: "match-fixture-1",
          matchRowText: expect.any(String),
        });
        expect(afterFailure).toEqual(beforeFailure);
        await recordScenarioEvidence("STATS-014", { width: 1440, height: 900 }, dispatcher, { consoleErrors: [], pageErrors: [] });
      },
    });

    await withStatsBrowserPage({
      browser,
      baseUrl,
      scenarioName: "route-race",
      clock,
      viewport: { width: 1440, height: 900 },
      run: async ({ page, dispatcher }) => {
        await executeRouteRemountRace({ page, dispatcher, baseUrl, label: "STATS-016" });
        await recordScenarioEvidence("STATS-016", { width: 1440, height: 900 }, dispatcher, { consoleErrors: [], pageErrors: [] });
      },
    });
  }, 120_000);

  it.each(LAYOUT_VIEWPORTS)("layout/ad evidence at %sx%s", async (viewport) => {
    await withStatsBrowserPage({
      browser,
      baseUrl,
      scenarioName: "ready",
      clock,
      viewport,
      run: async ({ page, dispatcher }) => {
        const log = attachRuntimeLog(page);
        await goToPlayer(page, dispatcher, baseUrl, "steam", "ManyMatches");
        await waitForPlayerSuccess(dispatcher, "ManyMatches", "steam");
        await waitForSummarySuccess(dispatcher, "ManyMatches", "steam", Array.from({ length: 16 }, (_, index) => `match-many-${index + 1}`));
        await waitForStatsSelector({ dispatcher, page, selector: '[data-compact-match-id="match-many-1"]' });
        const evidence = await layoutEvidence(page);
        assertLayoutContract(evidence, viewport.width);
        if (viewport.width < 768) {
          expect(evidence.feedSequence).toContain("ad-stats-mobile-after-6");
          expect(evidence.feedSequence).not.toContain("ad-stats-after-5");
        } else {
          expect(evidence.feedSequence).toContain("ad-stats-after-5");
          expect(evidence.feedSequence).toContain("ad-stats-after-15");
        }
        if (viewport.width === 1440 && viewport.height === 900) {
          expect(evidence.scrollY).toBe(0);
          expect(evidence.sequence.every((item) => item.inFirstViewport)).toBe(true);
        }
        console.log(JSON.stringify({ kind: "stats-browser-layout", evidence }));
        await recordScenarioEvidence(`layout-${viewport.width}x${viewport.height}`, viewport, dispatcher, log);
      },
    });
    if ([390, 1440].includes(viewport.width)) {
      await withStatsBrowserPage({
        browser,
        baseUrl,
        scenarioName: "ready",
        clock,
        viewport,
        run: async ({ page, dispatcher }) => {
          const log = attachRuntimeLog(page);
          await goToPlayer(page, dispatcher, baseUrl, "steam", LONG_NICKNAME);
          await waitForPlayerSuccess(dispatcher, LONG_NICKNAME, "steam");
          await waitForSummarySuccess(dispatcher, LONG_NICKNAME, "steam");
          await waitForStatsSelector({ dispatcher, page, selector: `h2[title="${LONG_NICKNAME}"]` });
          const evidence = await layoutEvidence(page);
          expect(evidence.nicknameOverflow).toHaveLength(1);
          expect(evidence.nicknameOverflow[0]).toMatchObject({
            title: LONG_NICKNAME,
            textOverflow: "ellipsis",
            whiteSpace: "nowrap",
            overflowX: "hidden",
          });
          expect(evidence.nicknameOverflow[0].scrollWidth).toBeGreaterThan(evidence.nicknameOverflow[0].clientWidth);
          console.log(JSON.stringify({ kind: "stats-browser-long-nickname", viewport, evidence: evidence.nicknameOverflow[0] }));
          await recordScenarioEvidence(`long-nickname-${viewport.width}x${viewport.height}`, viewport, dispatcher, log);
        },
      });
    }
  }, 60_000);

  it.each([
    { label: "767→768→767", from: { width: 767, height: 900 }, to: { width: 768, height: 900 } },
    { label: "1023→1024→1023", from: { width: 1023, height: 900 }, to: { width: 1024, height: 900 } },
  ])("fresh bidirectional resize evidence $label", async ({ from, to }) => {
    await withStatsBrowserPage({
      browser,
      baseUrl,
      scenarioName: "ready",
      clock,
      viewport: from,
      run: async ({ page, dispatcher }) => {
        await goToPlayer(page, dispatcher, baseUrl, "steam", "ManyMatches");
        await waitForPlayerSuccess(dispatcher, "ManyMatches", "steam");
        await waitForSummarySuccess(dispatcher, "ManyMatches", "steam", Array.from({ length: 16 }, (_, index) => `match-many-${index + 1}`));
        const before = await layoutEvidence(page);
        assertLayoutContract(before, from.width);
        await setStatsViewportAndWait(page, dispatcher, to);
        const after = await layoutEvidence(page);
        assertLayoutContract(after, to.width);
        await setStatsViewportAndWait(page, dispatcher, from);
        const returned = await layoutEvidence(page);
        assertLayoutContract(returned, from.width);
        expect(returned.adEvidence).toEqual(before.adEvidence);
        if (from.width === 767) {
          expect(before.adEvidence.some((creative) => creative.placement === "stats-mobile-after-6")).toBe(true);
          expect(after.adEvidence.some((creative) => creative.placement === "stats-mobile-after-6")).toBe(false);
          expect(after.adEvidence.some((creative) => creative.placement === "stats-after-10" && creative.provider === "adfit")).toBe(true);
          expect(returned.adEvidence.some((creative) => creative.placement === "stats-after-10")).toBe(false);
        } else {
          expect(after.adEvidence).toEqual(before.adEvidence);
          expect(before.gridColumnCount).toBe(1);
          expect(after.gridColumnCount).toBe(2);
          expect(returned.gridColumnCount).toBe(1);
        }
        console.log(JSON.stringify({ kind: "stats-browser-resize", from, to, returnedTo: from, before, after, returned }));
        dispatcher.ledger.throwIfUnexpected();
      },
    });
  }, 60_000);

  it.each(SCREENSHOT_VIEWPORTS)("screenshot-only evidence at %sx%s", async (viewport) => {
    await withStatsBrowserPage({
      browser,
      baseUrl,
      scenarioName: "ready",
      clock,
      viewport,
      run: async ({ page, dispatcher }) => {
        await goToPlayer(page, dispatcher, baseUrl, "steam", "ManyMatches");
        await waitForPlayerSuccess(dispatcher, "ManyMatches", "steam");
        await waitForSummarySuccess(dispatcher, "ManyMatches", "steam", Array.from({ length: 16 }, (_, index) => `match-many-${index + 1}`));
        await page.screenshot({ path: screenshotPath("stats-screenshot", viewport), fullPage: true });
        const evidence = await layoutEvidence(page);
        expect(evidence.globalOverflow).toBe(0);
        expect(evidence.internalOverflow).toEqual([]);
        console.log(JSON.stringify({ kind: "stats-browser-screenshot", viewport, path: screenshotPath("stats-screenshot", viewport), evidence }));
        dispatcher.ledger.throwIfUnexpected();
      },
    });
  }, 60_000);
});
