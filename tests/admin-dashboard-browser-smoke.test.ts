import { createServer, type Server } from "node:http";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import puppeteer, { type Browser, type Page } from "puppeteer";
import type { AgentApproval } from "@/types/admin-bot";
import type { StorageHealthSummary } from "@/types/storage-health";
import { startOwnedStatsDevServer, type OwnedStatsDevServer } from "./helpers/statsBrowserHarness";

const enabled = process.env.RUN_ADMIN_BROWSER_SMOKE === "true";
const viewports = [
  { width: 375, height: 667 },
  { width: 390, height: 844 },
  { width: 430, height: 932 },
  { width: 1440, height: 900 },
];
const user = {
  id: "00000000-0000-4000-8000-000000000001",
  aud: "authenticated", role: "authenticated", email: "admin-fixture@example.invalid",
  app_metadata: {}, user_metadata: {}, created_at: "2026-01-01T00:00:00Z",
};

function approval(id: string): AgentApproval {
  return {
    id, tool_name: "save_agent_memory", action_type: "save_agent_memory", status: "pending",
    payload: { title: `화면 검증용 운영 기록 ${id}` }, created_at: new Date().toISOString(),
    impact: { risk: "low", summary: "비공개 운영 기록 저장", details: {},
      executionGate: { status: "pass", label: "수락 가능", reasons: [], requiredBeforeApproval: [] } },
  };
}

function health(candidateRows: number): StorageHealthSummary {
  return {
    generatedAt: new Date().toISOString(),
    database: { usedBytes: 100_000, limitBytes: 1_000_000, usagePercent: 10, status: "ok", error: null },
    r2: { bucketName: "fixture", fileCount: 0, totalSizeBytes: 0, limitBytes: 1_000_000,
      usagePercent: 0, scannedPages: 1, truncated: false, configured: true, status: "ok", error: null },
    tables: [],
    reclaimable: [{ target: "pubg_player_cache", label: "자동완성 후보 정리", candidateRows,
      estimatedBytes: 100_000, detail: "최근 15만 건과 조회 이력·시즌 통계는 보존합니다.", error: null }],
    recommendations: [],
  };
}

async function clickText(page: Page, label: string, selector = "button") {
  const handle = await page.waitForFunction((text, query) =>
    Array.from(document.querySelectorAll<HTMLElement>(query))
      .find((element) => element.textContent?.trim() === text && element.getClientRects().length > 0),
  { timeout: 20_000 }, label, selector);
  const element = handle.asElement();
  if (!element) throw new Error(`버튼을 찾을 수 없습니다: ${label}`);
  await (await element.toElement("button")).click();
  await handle.dispose();
}

async function waitText(page: Page, text: string) {
  await page.waitForFunction((value) => document.body.innerText.includes(value), { timeout: 20_000 }, text);
}

describe.skipIf(!enabled)("관리자 대시보드 격리 브라우저 검증", () => {
  let stub: Server;
  let server: OwnedStatsDevServer;
  let browser: Browser;
  const unexpected: string[] = [];

  beforeAll(async () => {
    // 서버 인증도 로컬 fixture로 격리하고 GET 이외의 Supabase 요청은 거부한다.
    stub = createServer((request, response) => {
      response.setHeader("Access-Control-Allow-Origin", "*");
      response.setHeader("Access-Control-Allow-Headers", "*");
      response.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
      response.setHeader("Content-Type", "application/json");
      if (request.method === "OPTIONS") { response.end(); return; }
      if (request.method !== "GET") {
        unexpected.push(`Supabase ${request.method} ${request.url}`);
        response.writeHead(405); response.end("{}"); return;
      }
      if (request.url?.startsWith("/auth/v1/user")) {
        response.end(JSON.stringify(user)); return;
      }
      if (request.url?.startsWith("/rest/v1/profiles")) {
        const profile = { id: user.id, role: "admin", nickname: "화면 검증 관리자" };
        response.end(JSON.stringify(request.headers.accept?.includes("object") ? profile : [profile]));
        return;
      }
      response.end("[]");
    });
    await new Promise<void>((resolve) => stub.listen(0, "127.0.0.1", resolve));
    const address = stub.address();
    if (!address || typeof address === "string") throw new Error("인증 fixture 포트를 찾을 수 없습니다.");
    vi.stubEnv("NEXT_PUBLIC_SUPABASE_URL", `http://127.0.0.1:${address.port}`);
    vi.stubEnv("NEXT_PUBLIC_SUPABASE_ANON_KEY", "local-browser-qa-anon-key");
    vi.stubEnv("SUPABASE_SERVICE_ROLE_KEY", "local-browser-qa-service-key");
    server = await startOwnedStatsDevServer();
    browser = await puppeteer.launch({ headless: true });
    await mkdir(join(process.cwd(), "tmp", "admin-browser-qa"), { recursive: true });
  }, 180_000);

  afterAll(async () => {
    await browser?.close();
    await server?.stop();
    await new Promise<void>((resolve) => stub ? stub.close(() => resolve()) : resolve());
    vi.unstubAllEnvs();
  }, 30_000);

  it.each(viewports)("정리·승인·거절 및 결과 기록 오류 $width × $height", async (viewport) => {
    const context = await browser.createBrowserContext();
    const page = await context.newPage();
    const errors: string[] = [];
    const requests: Array<{ path: string; method: string; body: Record<string, unknown> }> = [];
    const approvals = ["accept", "reject", "record-error", "draft", "verify-error", "gate-blocked", "draft-update", "network-error", "success-refresh-error"].map(approval);
    approvals[3].action_type = "create_board_post";
    approvals[6].action_type = "update_board_post";
    let candidateRows = 25_000;
    let failCompaction = false;
    let failedApprovalReads = 0;
    page.on("pageerror", (error) => errors.push(String(error)));
    await page.setViewport(viewport);
    const expiresAt = Math.floor(Date.now() / 1000) + 3600;
    const token = [
      Buffer.from(JSON.stringify({ alg: "HS256", typ: "JWT" })).toString("base64url"),
      Buffer.from(JSON.stringify({ sub: user.id, aud: "authenticated", role: "authenticated", exp: expiresAt })).toString("base64url"),
      "fixture-signature",
    ].join(".");
    await context.setCookie({
      name: "sb-127-auth-token", domain: "127.0.0.1", path: "/",
      value: `base64-${Buffer.from(JSON.stringify({
        access_token: token, refresh_token: "fixture-refresh-token", token_type: "bearer",
        expires_in: 3600, expires_at: expiresAt, user,
      })).toString("base64url")}`,
    });
    await page.evaluateOnNewDocument((id) => {
      localStorage.setItem(`last_active_tracked_${id}`, String(Date.now()));
    }, user.id);
    await page.setRequestInterception(true);
    page.on("request", async (request) => {
      if (request.isInterceptResolutionHandled()) return;
      const url = new URL(request.url());
      if (url.origin !== server.baseUrl && url.origin !== process.env.NEXT_PUBLIC_SUPABASE_URL) {
        await request.abort(); return;
      }
      if (!url.pathname.startsWith("/api/")) { await request.continue(); return; }
      const body = JSON.parse(request.postData() || "{}") as Record<string, unknown>;
      requests.push({ path: url.pathname, method: request.method(), body });
      let result: unknown = {};
      let status = 200;
      if (url.pathname === "/api/admin/agent/command-center") result = null;
      else if (url.pathname === "/api/admin/agent/memories") result = { memories: [] };
      else if (url.pathname === "/api/admin/agent/approvals") {
        if (failedApprovalReads > 0) {
          failedApprovalReads -= 1;
          await request.abort("failed"); return;
        }
        result = { approvals };
      }
      else if (url.pathname === "/api/admin/dashboard") result = { storageHealth: health(candidateRows) };
      else if (url.pathname === "/api/admin/storage/compact") {
        const apply = body.apply === true;
        if (apply && failCompaction) {
          candidateRows -= 1_000; status = 500;
          result = { error: "정리가 중단되었습니다. 확인된 삭제는 1,000건이며 대상을 다시 확인하세요.",
            deletedCount: 1_000, partialExecution: true };
        } else {
          if (apply) candidateRows -= 20_000;
          result = { target: "pubg_player_cache", label: "자동완성 후보 정리", detail: "",
          dryRun: !apply, candidateCount: apply ? 25_000 : candidateRows,
          deletedCount: apply ? 20_000 : 0, remainingCount: candidateRows, totalCount: 200_000,
          hasRemaining: true, message: apply ? "20,000건을 정리했습니다. 5,000건이 남아 다시 실행하면 이어서 정리합니다." : `${candidateRows.toLocaleString()}건이 정리 대상입니다.` };
        }
      } else if (url.pathname.match(/^\/api\/admin\/agent\/approvals\/[^/]+\/(approve|reject)$/)) {
        const id = url.pathname.split("/").at(-2);
        const item = approvals.find((value) => value.id === id)!;
        if (id === "record-error" || id === "verify-error") {
          item.status = "approved"; status = 500;
          if (id === "verify-error") failedApprovalReads = 1;
          result = { error: "작업은 실행되었지만 결과 기록에 실패했습니다. 다시 실행하지 마세요." };
        } else if (id === "network-error") {
          item.status = "approved";
          failedApprovalReads = 1;
          await request.abort("failed"); return;
        } else if (id === "success-refresh-error") {
          item.status = "executed";
          failedApprovalReads = 2;
          result = { success: true, result: { execution: { message: "검증 기록을 저장했습니다." } } };
        } else if (id === "gate-blocked") {
          item.impact!.executionGate!.status = "block"; status = 400;
          result = { error: "승인 실행 조건을 통과하지 못했습니다." };
        } else if (url.pathname.endsWith("/reject")) {
          item.status = "rejected";
          item.result = JSON.stringify({ rejected: true, reason: body.reason });
          result = { success: true, result: { reason: body.reason } };
        } else {
          item.status = "executed";
          item.result = JSON.stringify({ execution: { message: "검증 기록을 저장했습니다." } });
          result = { success: true, result: { execution: { message: "검증 기록을 저장했습니다." } } };
        }
      } else if (url.pathname.startsWith("/api/admin/")) {
        unexpected.push(`${request.method()} ${url.pathname}`); status = 503;
      }
      await request.respond({ status, contentType: "application/json", body: JSON.stringify(result) });
    });

    try {
      await page.goto(`${server.baseUrl}/admin/dashboard?section=data`, { waitUntil: "domcontentloaded" });
      await waitText(page, "자동완성 후보 정리");
      expect(page.url()).toContain("/admin/dashboard");
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
      await clickText(page, "대상 확인");
      await clickText(page, "정리 실행");
      await waitText(page, "이번 실행에서는 최대 20,000건");
      expect(requests.filter((request) => request.body.apply === true)).toHaveLength(0);
      expect(await page.evaluate(() => document.body.innerText)).toContain("25,000건이 정리 대상입니다.");
      await page.screenshot({ path: join(process.cwd(), "tmp", "admin-browser-qa", `confirm-${viewport.width}x${viewport.height}.png`) });
      await clickText(page, "취소");
      expect(requests.filter((request) => request.body.apply === true)).toHaveLength(0);
      await clickText(page, "정리 실행");
      await clickText(page, "삭제 실행");
      await waitText(page, "5,000건이 남아");
      expect(requests.filter((request) => request.body.apply === true)).toEqual([
        { path: "/api/admin/storage/compact", method: "POST", body: { target: "pubg_player_cache", apply: true } },
      ]);
      failCompaction = true;
      await clickText(page, "대상 확인");
      await clickText(page, "정리 실행");
      await clickText(page, "삭제 실행");
      await waitText(page, "정리가 중단되었습니다.");
      await page.waitForFunction(() => !Array.from(document.querySelectorAll("button"))
        .some((button) => button.textContent?.trim() === "정리 실행"));
      expect(candidateRows).toBe(4_000);

      await page.goto(`${server.baseUrl}/admin/dashboard?section=approvals&approval=accept`, { waitUntil: "domcontentloaded" });
      await clickText(page, "수락하고 실행");
      await waitText(page, "검증 기록을 저장했습니다.");
      expect(requests.filter((request) => request.path.endsWith("/accept/approve"))).toEqual([
        { path: "/api/admin/agent/approvals/accept/approve", method: "POST", body: {} },
      ]);
      await page.goto(`${server.baseUrl}/admin/dashboard?section=approvals&approval=reject`, { waitUntil: "domcontentloaded" });
      await clickText(page, "거절");
      await page.type('input[placeholder="거절 사유 입력"]', "검증용 거절 사유");
      await clickText(page, "거절", 'form button[type="submit"]');
      await waitText(page, "거절됨: 검증용 거절 사유");
      expect(requests.find((request) => request.path.endsWith("/reject"))?.body.reason).toBe("검증용 거절 사유");
      expect(requests.find((request) => request.path.endsWith("/reject"))?.method).toBe("POST");
      await page.goto(`${server.baseUrl}/admin/dashboard?section=approvals&approval=record-error`, { waitUntil: "domcontentloaded" });
      await clickText(page, "수락하고 실행");
      await waitText(page, "실행 상태 확인");
      await waitText(page, "실제 결과를 확인하고 재실행하지 마세요.");
      expect(requests.filter((request) => request.path.includes("/record-error/approve"))).toHaveLength(1);
      await page.goto(`${server.baseUrl}/admin/dashboard?section=approvals&approval=draft`, { waitUntil: "domcontentloaded" });
      await waitText(page, "비공개 게시글 초안이 저장됩니다.");
      await page.goto(`${server.baseUrl}/admin/dashboard?section=approvals&approval=draft-update`, { waitUntil: "domcontentloaded" });
      await waitText(page, "비공개 수정 초안이 저장됩니다.");
      await page.goto(`${server.baseUrl}/admin/dashboard?section=approvals&approval=gate-blocked`, { waitUntil: "domcontentloaded" });
      await clickText(page, "수락하고 실행");
      await waitText(page, "승인 실행 조건을 통과하지 못했습니다.");
      await waitText(page, "수락 불가");
      expect(await page.evaluate(() => document.body.innerText)).toContain("화면 검증용 운영 기록 gate-blocked");
      await page.goto(`${server.baseUrl}/admin/dashboard?section=approvals&approval=verify-error`, { waitUntil: "domcontentloaded" });
      await clickText(page, "수락하고 실행");
      await waitText(page, "실제 결과를 확인하고 새로고침 전에는 재실행하지 마세요.");
      expect(await page.evaluate(() => Array.from(document.querySelectorAll("button"))
        .find((button) => button.textContent?.trim() === "상태 확인 필요")?.disabled)).toBe(true);
      expect(await page.evaluate(() => document.body.innerText)).toContain("작업은 실행되었지만 결과 기록에 실패했습니다.");
      await clickText(page, "새로고침");
      await waitText(page, "실행 상태 확인");
      expect(requests.filter((request) => request.path.endsWith("/verify-error/approve"))).toHaveLength(1);
      for (const id of ["network-error", "success-refresh-error"]) {
        await page.goto(`${server.baseUrl}/admin/dashboard?section=approvals&approval=${id}`, { waitUntil: "domcontentloaded" });
        await clickText(page, "수락하고 실행");
        await page.waitForFunction(() => Array.from(document.querySelectorAll("button"))
          .some((button) => button.textContent?.trim() === "상태 확인 필요" && button.disabled), { timeout: 3_000 });
        await waitText(page, "실제 결과를 확인하고 새로고침 전에는 재실행하지 마세요.");
        await clickText(page, "새로고침");
        await waitText(page, "화면 검증용 운영 기록 " + id);
        expect(requests.filter((request) => request.path.endsWith(`/${id}/approve`))).toHaveLength(1);
      }
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
      await page.screenshot({ path: join(process.cwd(), "tmp", "admin-browser-qa", `approval-${viewport.width}x${viewport.height}.png`), fullPage: true });
      expect(errors).toEqual([]);
      expect(unexpected).toEqual([]);
    } finally {
      await context.close();
    }
  }, 90_000);

  it("패치된 sharp로 Next 이미지 최적화를 실행한다", async () => {
    const response = await fetch(`${server.baseUrl}/_next/image?url=%2Ficon-512.png&w=64&q=75`, {
      headers: { Accept: "image/webp" },
    });
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("image/webp");
    expect((await response.arrayBuffer()).byteLength).toBeGreaterThan(0);
  }, 30_000);
});
