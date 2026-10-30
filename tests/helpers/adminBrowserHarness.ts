import { createServer, type IncomingMessage, type Server } from "node:http";
import type { Browser, BrowserContext, ElementHandle, HTTPRequest, Page } from "puppeteer";

// 관리자 화면 격리 브라우저 검증용 공통 도구.
// Supabase는 로컬 stub으로 대신하고, Next API는 puppeteer 요청 가로채기로 fixture 응답을 준다.

export const adminFixtureUser = {
  id: "00000000-0000-4000-8000-000000000001",
  aud: "authenticated", role: "authenticated", email: "admin-fixture@example.invalid",
  app_metadata: {}, user_metadata: {}, created_at: "2026-01-01T00:00:00Z",
};

export const adminFixtureProfile = {
  id: adminFixtureUser.id,
  role: "admin",
  nickname: "화면 검증 관리자",
};

export const pendingMarkerFixtures = [
  {
    id: "11111111-1111-4111-8111-111111111111",
    map_name: "Erangel", marker_type: "Garage", x: 512.25, y: 384.5, weight: 7,
    contributor_ids: [adminFixtureUser.id, "00000000-0000-4000-8000-0000000000ff"],
    created_at: "2026-10-29T00:00:00Z",
  },
  {
    id: "22222222-2222-4222-8222-222222222222",
    map_name: "Miramar", marker_type: "Boat", x: 100, y: 200, weight: 3,
    contributor_ids: [adminFixtureUser.id],
    created_at: "2026-10-28T00:00:00Z",
  },
];

export const weaponFixtures = [
  { id: "m416", name: "M416", type: "AR", ammo: "5.56mm", damage: 40, bullet_speed: 880, weight: 5, patch_notes: "", can_be_in_backpack: false, availability: "월드 스폰" },
  { id: "beryl", name: "Beryl M762", type: "AR", ammo: "7.62mm", damage: 44, bullet_speed: 715, weight: 5, patch_notes: "", can_be_in_backpack: false, availability: "월드 스폰" },
];

function wantsSingleObject(request: IncomingMessage) {
  return Boolean(request.headers.accept?.includes("vnd.pgrst.object"));
}

/**
 * Supabase REST/Auth stub.
 * 쓰기는 모두 거부하고 기록한다. 예외는 GlobalHeader가 호출하는 읽기 전용 RPC get_my_profile 하나뿐이다.
 */
export async function startSupabaseStub(unexpected: string[]): Promise<{ server: Server; url: string }> {
  const server = createServer((request, response) => {
    response.setHeader("Access-Control-Allow-Origin", "*");
    response.setHeader("Access-Control-Allow-Headers", "*");
    response.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
    response.setHeader("Content-Type", "application/json");
    if (request.method === "OPTIONS") { response.end(); return; }
    const url = request.url || "";
    if (request.method === "POST" && url.split("?")[0] === "/rest/v1/rpc/get_my_profile") {
      // 읽기 전용 RPC다. 요청 본문은 쓰지 않고 fixture 프로필만 돌려준다.
      request.resume();
      response.end(JSON.stringify(wantsSingleObject(request) ? adminFixtureProfile : [adminFixtureProfile]));
      return;
    }
    if (request.method !== "GET") {
      unexpected.push(`Supabase ${request.method} ${url}`);
      response.writeHead(405); response.end("{}"); return;
    }
    if (url.startsWith("/auth/v1/user")) {
      response.end(JSON.stringify(adminFixtureUser)); return;
    }
    if (url.startsWith("/rest/v1/profiles")) {
      response.end(JSON.stringify(wantsSingleObject(request) ? adminFixtureProfile : [adminFixtureProfile]));
      return;
    }
    if (url.startsWith("/rest/v1/pending_markers")) {
      const idMatch = url.match(/[?&]id=eq\.([^&]+)/);
      if (idMatch) {
        const marker = pendingMarkerFixtures.find((item) => item.id === decodeURIComponent(idMatch[1]));
        if (!marker) { response.writeHead(406); response.end(JSON.stringify({ code: "PGRST116", message: "not found" })); return; }
        response.end(JSON.stringify(wantsSingleObject(request) ? marker : [marker]));
        return;
      }
      response.end(JSON.stringify(pendingMarkerFixtures));
      return;
    }
    if (url.startsWith("/rest/v1/weapons")) {
      response.end(JSON.stringify(weaponFixtures)); return;
    }
    response.end(wantsSingleObject(request) ? "null" : "[]");
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("인증 fixture 포트를 찾을 수 없습니다.");
  return { server, url: `http://127.0.0.1:${address.port}` };
}

export type AdminApiResult = { status?: number; body?: unknown; abort?: boolean; delayMs?: number } | undefined;
export type AdminApiHandler = (input: {
  path: string;
  method: string;
  search: URLSearchParams;
  body: Record<string, unknown>;
}) => AdminApiResult | Promise<AdminApiResult>;

export interface AdminRequestRecord {
  path: string;
  method: string;
  search: string;
  body: Record<string, unknown>;
}

/**
 * 관리자 세션 쿠키를 심고 Next API 요청을 fixture handler로 돌려주는 페이지를 연다.
 * handler가 undefined를 반환한 /api/admin/* 요청은 예상하지 못한 요청으로 기록한다.
 */
export async function openAdminPage(input: {
  browser: Browser;
  baseUrl: string;
  supabaseUrl: string;
  viewport: { width: number; height: number };
  unexpected: string[];
  handler: AdminApiHandler;
}): Promise<{ context: BrowserContext; page: Page; errors: string[]; requests: AdminRequestRecord[] }> {
  const context = await input.browser.createBrowserContext();
  const page = await context.newPage();
  const errors: string[] = [];
  const requests: AdminRequestRecord[] = [];
  page.on("pageerror", (error) => errors.push(String(error)));
  await page.setViewport(input.viewport);
  const expiresAt = Math.floor(Date.now() / 1000) + 3600;
  const token = [
    Buffer.from(JSON.stringify({ alg: "HS256", typ: "JWT" })).toString("base64url"),
    Buffer.from(JSON.stringify({ sub: adminFixtureUser.id, aud: "authenticated", role: "authenticated", exp: expiresAt })).toString("base64url"),
    "fixture-signature",
  ].join(".");
  await context.setCookie({
    name: "sb-127-auth-token", domain: "127.0.0.1", path: "/",
    value: `base64-${Buffer.from(JSON.stringify({
      access_token: token, refresh_token: "fixture-refresh-token", token_type: "bearer",
      expires_in: 3600, expires_at: expiresAt, user: adminFixtureUser,
    })).toString("base64url")}`,
  });
  await page.evaluateOnNewDocument((id) => {
    localStorage.setItem(`last_active_tracked_${id}`, String(Date.now()));
  }, adminFixtureUser.id);
  await page.setRequestInterception(true);
  page.on("request", async (request: HTTPRequest) => {
    if (request.isInterceptResolutionHandled()) return;
    const url = new URL(request.url());
    if (url.origin !== input.baseUrl && url.origin !== input.supabaseUrl) {
      await request.abort(); return;
    }
    if (!url.pathname.startsWith("/api/")) { await request.continue(); return; }
    let body: Record<string, unknown> = {};
    try { body = JSON.parse(request.postData() || "{}") as Record<string, unknown>; } catch { body = {}; }
    requests.push({ path: url.pathname, method: request.method(), search: url.search, body });
    const result = await input.handler({ path: url.pathname, method: request.method(), search: url.searchParams, body });
    if (result?.delayMs) await new Promise((resolve) => setTimeout(resolve, result.delayMs));
    if (result?.abort) { await request.abort("failed"); return; }
    if (!result) {
      if (url.pathname.startsWith("/api/admin/")) input.unexpected.push(`${request.method()} ${url.pathname}`);
      await request.respond({ status: url.pathname.startsWith("/api/admin/") ? 503 : 200, contentType: "application/json", body: "{}" });
      return;
    }
    await request.respond({ status: result.status ?? 200, contentType: "application/json", body: JSON.stringify("body" in result ? result.body : {}) });
  });
  return { context, page, errors, requests };
}

export async function clickText(page: Page, label: string, selector = "button") {
  const handle = await page.waitForFunction((text, query) =>
    Array.from(document.querySelectorAll<HTMLElement>(query))
      .find((element) => element.textContent?.trim() === text && element.getClientRects().length > 0),
  { timeout: 20_000 }, label, selector);
  const element = handle.asElement();
  if (!element) throw new Error(`버튼을 찾을 수 없습니다: ${label}`);
  await (element as ElementHandle<Element>).click();
  await handle.dispose();
}

export async function waitText(page: Page, text: string, timeout = 20_000) {
  await page.waitForFunction((value) => document.body.innerText.includes(value), { timeout }, text);
}

// ConfirmModal은 인라인 스타일(z-index 99999)로 그려진다. 같은 문구의 카드 버튼과 구분할 때 쓴다.
export const CONFIRM_MODAL_BUTTON = 'div[style*="z-index: 99999"] button';

export async function hasNoHorizontalOverflow(page: Page) {
  return page.evaluate(() => document.documentElement.scrollWidth <= innerWidth);
}

/** 관리자 공통 메뉴가 보이고, 현재 화면 항목이 aria-current로 표시되며, 터치 높이가 44px 이상인지 확인한다. */
export async function readAdminNav(page: Page) {
  try {
    await page.waitForSelector('[data-testid="admin-nav"] a', { timeout: 20_000 });
  } catch (error) {
    const snapshot = await page.evaluate(() => `${location.href}\nnav=${document.querySelectorAll('[data-testid="admin-nav"]').length} navs=${Array.from(document.querySelectorAll("nav")).map((n) => n.getAttribute("aria-label")).join("|")}\n${document.body.innerText.slice(0, 1500)}`);
    throw new Error(`관리자 메뉴를 찾지 못했습니다.\n${snapshot}`, { cause: error });
  }
  return page.evaluate(() => {
    const nav = document.querySelector<HTMLElement>('[data-testid="admin-nav"]');
    const links = Array.from(nav?.querySelectorAll<HTMLAnchorElement>("a") || []);
    const list = nav?.querySelector<HTMLElement>("ul");
    return {
      labels: links.map((link) => link.textContent?.trim() || ""),
      current: links.filter((link) => link.getAttribute("aria-current") === "page").map((link) => link.textContent?.trim() || ""),
      minHeight: Math.min(...links.map((link) => link.getBoundingClientRect().height)),
      navHeight: nav?.getBoundingClientRect().height ?? 0,
      listScrollable: list ? list.scrollWidth > list.clientWidth : false,
      listOverflowX: list ? getComputedStyle(list).overflowX : "",
      wraps: links.length > 1 ? new Set(links.map((link) => Math.round(link.getBoundingClientRect().top))).size > 1 : false,
    };
  });
}

/** 떠 있는 병아리(말풍선 포함)와 지정한 요소들이 겹치는지 계산한다. */
export async function mascotOverlaps(page: Page, targetSelector: string) {
  return page.evaluate((selector) => {
    const dock = document.querySelector<HTMLElement>('[data-testid="admin-mascot-dock"]');
    if (!dock) return { overlaps: [] as string[], dockFound: false };
    const dockRects = [dock, ...Array.from(dock.querySelectorAll<HTMLElement>("*"))]
      .map((element) => element.getBoundingClientRect())
      .filter((rect) => rect.width > 0 && rect.height > 0);
    const overlaps: string[] = [];
    for (const target of Array.from(document.querySelectorAll<HTMLElement>(selector))) {
      const rect = target.getBoundingClientRect();
      if (rect.width === 0 || rect.height === 0) continue;
      if (rect.bottom <= 0 || rect.top >= innerHeight) continue;
      const hit = dockRects.some((box) => rect.left < box.right && rect.right > box.left && rect.top < box.bottom && rect.bottom > box.top);
      if (hit) overlaps.push(`${target.textContent?.trim()} @${Math.round(rect.left)},${Math.round(rect.top)}`);
    }
    return { overlaps, dockFound: true };
  }, targetSelector);
}
