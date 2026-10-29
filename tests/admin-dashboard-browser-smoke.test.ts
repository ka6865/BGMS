import type { Server } from "node:http";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import puppeteer, { type Browser } from "puppeteer";
import type { AgentApproval } from "@/types/admin-bot";
import type { StorageHealthSummary } from "@/types/storage-health";
import { startOwnedStatsDevServer, type OwnedStatsDevServer } from "./helpers/statsBrowserHarness";
import {
  CONFIRM_MODAL_BUTTON,
  clickText,
  hasNoHorizontalOverflow,
  mascotOverlaps,
  openAdminPage,
  pendingMarkerFixtures,
  readAdminNav,
  startSupabaseStub,
  waitText,
} from "./helpers/adminBrowserHarness";

const enabled = process.env.RUN_ADMIN_BROWSER_SMOKE === "true";
const viewports = [
  { width: 375, height: 667 },
  { width: 390, height: 844 },
  { width: 430, height: 932 },
  { width: 1440, height: 900 },
];
const REPORT_CARD_BUTTON = '[data-testid="admin-reports"] article button';
const ADMIN_NAV_LABELS = ["운영 대시보드", "AI 비서", "데이터 관리", "지도 제보 심사", "맵 설정", "고객센터", "AI 코칭 품질"];
const shotDir = () => join(process.cwd(), "tmp", "admin-browser-qa");
const shot = (name: string, viewport: { width: number; height: number }) =>
  join(shotDir(), `${name}-${viewport.width}x${viewport.height}.png`);

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

function report(id: number, targetType: "post" | "comment", targetId: number, reason: string) {
  return {
    id, target_type: targetType, target_id: targetId, reason, detail: "화면 검증용 신고 상세",
    status: "pending", created_at: "2026-10-29T00:00:00Z", reporter_id: null, reporter_nickname: null,
    reporter_ip: "203.0.113.10", admin_note: null,
  };
}

describe.skipIf(!enabled)("관리자 대시보드 격리 브라우저 검증", () => {
  let stub: Server;
  let supabaseUrl: string;
  let server: OwnedStatsDevServer;
  let browser: Browser;
  const unexpected: string[] = [];

  beforeAll(async () => {
    // 서버 인증도 로컬 fixture로 격리한다. 읽기 전용 RPC get_my_profile 외 Supabase 쓰기는 거부한다.
    const started = await startSupabaseStub(unexpected);
    stub = started.server;
    supabaseUrl = started.url;
    vi.stubEnv("NEXT_PUBLIC_SUPABASE_URL", supabaseUrl);
    vi.stubEnv("NEXT_PUBLIC_SUPABASE_ANON_KEY", "local-browser-qa-anon-key");
    vi.stubEnv("SUPABASE_SERVICE_ROLE_KEY", "local-browser-qa-service-key");
    server = await startOwnedStatsDevServer();
    browser = await puppeteer.launch({ headless: true });
    await mkdir(shotDir(), { recursive: true });
  }, 180_000);

  afterAll(async () => {
    await browser?.close();
    await server?.stop();
    await new Promise<void>((resolve) => stub ? stub.close(() => resolve()) : resolve());
    vi.unstubAllEnvs();
  }, 30_000);

  it.each(viewports)("정리·승인·거절 및 결과 기록 오류 $width × $height", async (viewport) => {
    const approvals = ["accept", "reject", "record-error", "draft", "verify-error", "gate-blocked", "draft-update", "network-error", "success-refresh-error"].map(approval);
    approvals[3].action_type = "create_board_post";
    approvals[6].action_type = "update_board_post";
    let candidateRows = 25_000;
    let failCompaction = false;
    let failedApprovalReads = 0;
    const { context, page, errors, requests } = await openAdminPage({
      browser, baseUrl: server.baseUrl, supabaseUrl, viewport, unexpected,
      handler: ({ path, body }) => {
        if (path === "/api/admin/agent/command-center") return { body: null };
        if (path === "/api/admin/agent/memories") return { body: { memories: [] } };
        if (path === "/api/admin/agent/approvals") {
          if (failedApprovalReads > 0) {
            failedApprovalReads -= 1;
            return { abort: true };
          }
          return { body: { approvals } };
        }
        if (path === "/api/admin/dashboard") return { body: { storageHealth: health(candidateRows) } };
        if (path === "/api/admin/storage/compact") {
          const apply = body.apply === true;
          if (apply && failCompaction) {
            candidateRows -= 1_000;
            return { status: 500, body: { error: "정리가 중단되었습니다. 확인된 삭제는 1,000건이며 대상을 다시 확인하세요.",
              deletedCount: 1_000, partialExecution: true } };
          }
          if (apply) candidateRows -= 20_000;
          return { body: { target: "pubg_player_cache", label: "자동완성 후보 정리", detail: "",
            dryRun: !apply, candidateCount: apply ? 25_000 : candidateRows,
            deletedCount: apply ? 20_000 : 0, remainingCount: candidateRows, totalCount: 200_000,
            hasRemaining: true, message: apply ? "20,000건을 정리했습니다. 5,000건이 남아 다시 실행하면 이어서 정리합니다." : `${candidateRows.toLocaleString()}건이 정리 대상입니다.` } };
        }
        if (path.match(/^\/api\/admin\/agent\/approvals\/[^/]+\/(approve|reject)$/)) {
          const id = path.split("/").at(-2);
          const item = approvals.find((value) => value.id === id)!;
          if (id === "record-error" || id === "verify-error") {
            item.status = "approved";
            if (id === "verify-error") failedApprovalReads = 1;
            return { status: 500, body: { error: "작업은 실행되었지만 결과 기록에 실패했습니다. 다시 실행하지 마세요." } };
          }
          if (id === "network-error") {
            item.status = "approved";
            failedApprovalReads = 1;
            return { abort: true };
          }
          if (id === "success-refresh-error") {
            item.status = "executed";
            failedApprovalReads = 2;
            return { body: { success: true, result: { execution: { message: "검증 기록을 저장했습니다." } } } };
          }
          if (id === "gate-blocked") {
            item.impact!.executionGate!.status = "block";
            return { status: 400, body: { error: "승인 실행 조건을 통과하지 못했습니다." } };
          }
          if (path.endsWith("/reject")) {
            item.status = "rejected";
            item.result = JSON.stringify({ rejected: true, reason: body.reason });
            return { body: { success: true, result: { reason: body.reason } } };
          }
          item.status = "executed";
          item.result = JSON.stringify({ execution: { message: "검증 기록을 저장했습니다." } });
          return { body: { success: true, result: { execution: { message: "검증 기록을 저장했습니다." } } } };
        }
        return undefined;
      },
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
      await page.screenshot({ path: shot("confirm", viewport) });
      await clickText(page, "취소");
      expect(requests.filter((request) => request.body.apply === true)).toHaveLength(0);
      await clickText(page, "정리 실행");
      await clickText(page, "삭제 실행");
      await waitText(page, "5,000건이 남아");
      expect(requests.filter((request) => request.body.apply === true).map(({ path, method, body }) => ({ path, method, body }))).toEqual([
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
      expect(requests.filter((request) => request.path.endsWith("/accept/approve")).map(({ path, method, body }) => ({ path, method, body }))).toEqual([
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
      await page.screenshot({ path: shot("approval", viewport), fullPage: true });
      expect(errors).toEqual([]);
      expect(unexpected).toEqual([]);
    } finally {
      await context.close();
    }
  }, 90_000);

  it.each(viewports)("공통 메뉴·신고 처리 확인·병아리 겹침 $width × $height", async (viewport) => {
    const isMobile = viewport.width < 640;
    let pendingReports = [
      report(101, "post", 11, "욕설"),
      report(102, "post", 11, "도배"),
      report(103, "comment", 7, "광고"),
      report(104, "comment", 8, "분란 조장"),
    ];
    let reportReads = 0;
    const actionResults: Record<string, { status: number; body: unknown }> = {
      dismiss: { status: 500, body: { error: "서버 오류가 발생했습니다." } },
    };
    const { context, page, errors, requests } = await openAdminPage({
      browser, baseUrl: server.baseUrl, supabaseUrl, viewport, unexpected,
      handler: ({ path, method, search, body }) => {
        if (path === "/api/admin/agent/command-center") return { body: null };
        if (path === "/api/admin/agent/memories") return { body: { memories: [] } };
        if (path === "/api/admin/agent/approvals") return { body: { approvals: [approval("sticky-check")] } };
        if (path === "/api/admin/reports" && method === "GET") {
          reportReads += 1;
          // 첫 조회는 실패시켜 오류 상태와 재시도를 확인한다.
          if (reportReads === 1) return { status: 500, body: { error: "신고 목록 조회 중 오류가 발생했습니다." } };
          // 처리 완료 탭 응답은 늦게 도착시켜, 그 사이 대기 탭으로 돌아간 결과를 덮지 않는지 본다.
          if (search.get("status") === "resolved") return { delayMs: 1_500, body: { success: true, data: [report(900, "post", 99, "늦게 도착한 처리 완료 응답")] } };
          return { body: { success: true, data: pendingReports } };
        }
        if (path === "/api/admin/reports" && method === "POST") {
          const action = String(body.action);
          const forced = actionResults[action];
          if (forced) return forced;
          const target = pendingReports.find((item) => item.id === body.reportId)!;
          pendingReports = pendingReports.filter((item) => !(item.target_type === target.target_type && item.target_id === target.target_id));
          return { body: { success: true } };
        }
        return undefined;
      },
    });
    const reportPosts = () => requests.filter((request) => request.path === "/api/admin/reports" && request.method === "POST");

    try {
      await page.goto(`${server.baseUrl}/admin/dashboard`, { waitUntil: "domcontentloaded" });
      await waitText(page, "오늘 할 일");
      const nav = await readAdminNav(page);
      expect(nav.labels.slice(0, ADMIN_NAV_LABELS.length)).toEqual(ADMIN_NAV_LABELS);
      expect(nav.current).toEqual(["운영 대시보드"]);
      expect(nav.minHeight).toBeGreaterThanOrEqual(44);
      expect(nav.wraps).toBe(false);
      expect(nav.listOverflowX).toBe("auto");
      expect(await hasNoHorizontalOverflow(page)).toBe(true);
      expect(await page.$('a[aria-label="사이트 홈으로 나가기"][href="/"]')).not.toBeNull();
      expect(await page.$('button[aria-label="AI 비서 열기"]')).not.toBeNull();
      expect(await page.$('button[aria-label="새로고침"]')).not.toBeNull();
      await page.screenshot({ path: shot("dashboard-today", viewport) });

      // 승인 상세의 고정 버튼 막대가 떠 있는 병아리에 가리지 않는지 본다.
      await page.goto(`${server.baseUrl}/admin/dashboard?section=approvals&approval=sticky-check`, { waitUntil: "domcontentloaded" });
      await waitText(page, "화면 검증용 운영 기록 sticky-check");
      for (const position of ["top", "bottom"] as const) {
        await page.evaluate((where) => {
          const scroller = document.querySelector<HTMLElement>('[data-testid="admin-dashboard-scroll"]');
          if (scroller) scroller.scrollTop = where === "top" ? 0 : scroller.scrollHeight;
        }, position);
        await new Promise((resolve) => setTimeout(resolve, 150));
        // 스크롤 중간에는 콘텐츠가 병아리 아래로 지나갈 수 있다. 항상 보이는 고정 버튼 막대와, 끝까지 내렸을 때의 모든 버튼을 본다.
        const overlap = await mascotOverlaps(page, position === "top"
          ? '[data-testid="approval-action-bar"] button'
          : "main button:not([aria-label^='BGMS AI 비서']), main a");
        expect(overlap.dockFound).toBe(true);
        expect(overlap.overlaps, `승인 화면 ${position}`).toEqual([]);
      }
      await page.screenshot({ path: shot("dashboard-approvals-bottom", viewport) });

      await page.goto(`${server.baseUrl}/admin/dashboard?section=reports`, { waitUntil: "domcontentloaded" });
      await waitText(page, "신고 목록 조회 중 오류가 발생했습니다.");
      expect(await page.evaluate(() => document.body.innerText)).not.toContain("상태의 신고가 없습니다");
      await page.screenshot({ path: shot("reports-error", viewport) });
      await clickText(page, "다시 시도");
      await waitText(page, "신고 사유: 욕설");

      // 늦게 도착한 처리 완료 응답이 대기 목록을 덮지 않는다.
      await clickText(page, "처리 완료");
      await clickText(page, "대기");
      await waitText(page, "신고 사유: 광고");
      await new Promise((resolve) => setTimeout(resolve, 1_800));
      expect(await page.evaluate(() => document.body.innerText)).not.toContain("늦게 도착한 처리 완료 응답");
      expect(await page.evaluate(() => document.body.innerText)).toContain("신고 사유: 욕설");

      if (isMobile) {
        const heights = await page.evaluate(() => Array.from(document.querySelectorAll<HTMLElement>('[data-testid="admin-reports"] button'))
          .filter((button) => button.getClientRects().length > 0)
          .map((button) => button.getBoundingClientRect().height));
        expect(Math.min(...heights)).toBeGreaterThanOrEqual(44);
      }

      // IP 차단: 설명 확인 → 취소하면 요청이 없다.
      await clickText(page, "IP 차단", REPORT_CARD_BUTTON);
      await waitText(page, "신고자가 아니라 신고된 게시글 작성자의 IP");
      await page.screenshot({ path: shot("reports-confirm", viewport) });
      await clickText(page, "취소", CONFIRM_MODAL_BUTTON);
      expect(reportPosts()).toHaveLength(0);

      // IP 차단 실행: 같은 게시글의 신고 두 건이 함께 빠진다.
      await clickText(page, "IP 차단", REPORT_CARD_BUTTON);
      await clickText(page, "IP 차단", CONFIRM_MODAL_BUTTON);
      await waitText(page, "작성자 IP를 차단 목록에 추가했습니다.");
      await page.waitForFunction(() => !document.body.innerText.includes("신고 사유: 욕설"));
      expect(await page.evaluate(() => document.body.innerText)).not.toContain("신고 사유: 도배");
      expect(reportPosts().map((request) => request.body)).toEqual([{ reportId: 101, action: "ban_ip" }]);

      // 기각 실패: 서버 메시지를 보여주고 목록은 그대로 둔다.
      await clickText(page, "기각", REPORT_CARD_BUTTON);
      await waitText(page, "신고를 기각하고 내용은 그대로 둡니다.");
      await clickText(page, "기각", CONFIRM_MODAL_BUTTON);
      await waitText(page, "서버 오류가 발생했습니다.");
      expect(await page.evaluate(() => document.body.innerText)).toContain("신고 사유: 광고");

      // 댓글 숨김: 원문 복구 불가 안내 후 실행.
      await clickText(page, "내용 숨김", REPORT_CARD_BUTTON);
      await waitText(page, "원래 댓글 내용은 복구할 수 없습니다.");
      await clickText(page, "숨김 처리", CONFIRM_MODAL_BUTTON);
      await waitText(page, "신고된 내용을 숨겼습니다.");
      await page.waitForFunction(() => !document.body.innerText.includes("신고 사유: 광고"));
      expect(reportPosts().map((request) => request.body.action)).toEqual(["ban_ip", "dismiss", "blind"]);

      // 마지막 카드 버튼이 떠 있는 병아리에 가리지 않는다.
      await page.evaluate(() => {
        const scroller = document.querySelector<HTMLElement>('[data-testid="admin-dashboard-scroll"]');
        if (scroller) scroller.scrollTop = scroller.scrollHeight;
      });
      await new Promise((resolve) => setTimeout(resolve, 150));
      const reportOverlap = await mascotOverlaps(page, '[data-testid="admin-reports"] button');
      expect(reportOverlap.overlaps).toEqual([]);
      expect(await hasNoHorizontalOverflow(page)).toBe(true);
      await page.screenshot({ path: shot("reports-bottom", viewport) });
      expect(errors).toEqual([]);
      expect(unexpected).toEqual([]);
    } finally {
      await context.close();
    }
  }, 90_000);

  it.each(viewports)("지도 제보 심사·맵 설정·데이터 관리 화면 $width × $height", async (viewport) => {
    const markerId = pendingMarkerFixtures[0].id;
    const { context, page, errors, requests } = await openAdminPage({
      browser, baseUrl: server.baseUrl, supabaseUrl, viewport, unexpected,
      handler: ({ path, method }) => {
        if (path === "/api/admin/approve" && method === "POST") return { delayMs: 600, body: { success: true, newId: 1 } };
        if (path === "/api/admin/reject" && method === "POST") return { body: { success: true } };
        if (path === "/api/admin/dashboard") return { body: {} };
        if (path === "/api/admin/settings") return { body: { success: true, settings: {} } };
        return undefined;
      },
    });
    const markerPosts = () => requests.filter((request) => request.path === "/api/admin/approve" || request.path === "/api/admin/reject");

    try {
      await page.goto(`${server.baseUrl}/admin/review`, { waitUntil: "domcontentloaded" });
      await waitText(page, "Erangel · Garage");
      let nav = await readAdminNav(page);
      expect(nav.current).toEqual(["지도 제보 심사"]);
      expect(await page.evaluate(() => document.body.innerText)).not.toContain("관제탑");
      expect(await hasNoHorizontalOverflow(page)).toBe(true);
      await page.screenshot({ path: shot("review-list", viewport), fullPage: true });

      await page.goto(`${server.baseUrl}/admin/review?id=${markerId}`, { waitUntil: "domcontentloaded" });
      await waitText(page, "제보 거절(삭제)");
      await clickText(page, "제보 거절(삭제)");
      await waitText(page, "삭제한 제보는 되돌릴 수 없습니다.");
      await clickText(page, "취소", CONFIRM_MODAL_BUTTON);
      expect(markerPosts()).toHaveLength(0);
      await clickText(page, "승인(지도 반영)");
      await waitText(page, "모든 사용자 지도에 반영합니다.");
      await page.screenshot({ path: shot("review-confirm", viewport) });
      await clickText(page, "지도에 반영", CONFIRM_MODAL_BUTTON);
      // 요청 중에는 확인 버튼과 심사 버튼이 모두 잠겨 두 번 보낼 수 없다.
      await page.waitForFunction(() => Array.from(document.querySelectorAll("button"))
        .some((button) => button.textContent?.trim() === "처리 중..." && button.disabled), { timeout: 3_000 });
      expect(await page.evaluate(() => Array.from(document.querySelectorAll("button"))
        .filter((button) => ["승인(지도 반영)", "제보 거절(삭제)"].includes(button.textContent?.trim() || ""))
        .every((button) => button.disabled))).toBe(true);
      await page.waitForFunction(() => !location.search.includes("id="), { timeout: 10_000 });
      await waitText(page, "Miramar · Boat");
      expect(markerPosts().map(({ path, method, body }) => ({ path, method, body }))).toEqual([
        { path: "/api/admin/approve", method: "POST", body: { id: markerId } },
      ]);

      await page.goto(`${server.baseUrl}/admin/map-settings`, { waitUntil: "domcontentloaded" });
      await waitText(page, "맵 노출 설정");
      nav = await readAdminNav(page);
      expect(nav.current).toEqual(["맵 설정"]);
      // 가로 스크롤 메뉴에서 현재 항목이 화면 안에 보인다.
      expect(await page.evaluate(() => {
        const link = document.querySelector<HTMLElement>('[data-testid="admin-nav"] a[aria-current="page"]');
        const rect = link?.getBoundingClientRect();
        return Boolean(rect && rect.left >= 0 && rect.right <= innerWidth);
      })).toBe(true);
      expect(await hasNoHorizontalOverflow(page)).toBe(true);
      await page.screenshot({ path: shot("map-settings", viewport), fullPage: true });
      await clickText(page, "카테고리 마스터 관리", 'button[role="tab"]');
      await waitText(page, "새 카테고리 추가");
      await clickText(page, "+ 새 카테고리 추가");
      await page.waitForSelector("#category-form-label");
      expect(await hasNoHorizontalOverflow(page)).toBe(true);
      await page.screenshot({ path: shot("map-settings-category", viewport), fullPage: true });

      await page.goto(`${server.baseUrl}/admin/game-data`, { waitUntil: "domcontentloaded" });
      await waitText(page, "데이터 관리자");
      nav = await readAdminNav(page);
      expect(nav.current).toEqual(["데이터 관리"]);
      await waitText(page, "M416");
      expect(await hasNoHorizontalOverflow(page)).toBe(true);
      if (viewport.width < 768) expect(await page.$('select[aria-label="편집할 데이터 분류"]')).not.toBeNull();
      // 편집기 높이가 관리자 영역 안에 들어와 하단이 잘리지 않는다.
      const editorFits = await page.evaluate(() => {
        const root = document.querySelector<HTMLElement>('[data-testid="game-data-editor"]');
        if (!root) return false;
        const rect = root.getBoundingClientRect();
        return rect.bottom <= innerHeight + 1;
      });
      expect(editorFits).toBe(true);
      await page.screenshot({ path: shot("game-data", viewport) });
      expect(errors).toEqual([]);
      expect(unexpected).toEqual([]);
    } finally {
      await context.close();
    }
  }, 120_000);

  it.each(viewports)("일부 운영 정보 조회 실패를 확인 불가로 표시 $width × $height", async (viewport) => {
    // 서버가 일부 집계를 읽지 못해 기본값(0)으로 채운 응답. 화면은 0건을 정상으로 보여주면 안 된다.
    const degradedPayload = {
      generatedAt: new Date().toISOString(),
      severity: "warn",
      degradedSources: [
        { source: "failedRuns", message: "이 항목을 불러오지 못해 기본값으로 대체했습니다." },
        { source: "apiErrors", message: "이 항목을 불러오지 못해 기본값으로 대체했습니다." },
      ],
      failedRuns: { count: 0, error: "이 항목을 불러오지 못해 기본값으로 대체했습니다." },
      apiErrors: { total: 0, latest: [], error: "이 항목을 불러오지 못해 기본값으로 대체했습니다." },
      aiUsage: { totalRequests: 3, totalCostUsd: 0.0123 },
      pendingApprovals: { count: 0, highRiskCount: 0, staleCount: 0, items: [] },
    };
    const { context, page, errors } = await openAdminPage({
      browser, baseUrl: server.baseUrl, supabaseUrl, viewport, unexpected,
      handler: ({ path }) => {
        if (path === "/api/admin/agent/command-center") return { body: degradedPayload };
        if (path === "/api/admin/agent/memories") return { body: { memories: [] } };
        if (path === "/api/admin/agent/approvals") return { body: { approvals: [] } };
        return undefined;
      },
    });
    try {
      await page.goto(`${server.baseUrl}/admin/dashboard`, { waitUntil: "domcontentloaded" });
      await page.waitForSelector('[data-testid="dashboard-degraded-sources"]', { timeout: 20_000 });
      await waitText(page, "확인 불가: 실패한 실행, PUBG API 에러");
      await waitText(page, "실패한 Agent 실행 확인 불가");
      await waitText(page, "PUBG API 에러 확인 불가");
      expect(await hasNoHorizontalOverflow(page)).toBe(true);
      await page.screenshot({ path: shot("dashboard-degraded", viewport) });

      await page.goto(`${server.baseUrl}/admin/dashboard?section=status`, { waitUntil: "domcontentloaded" });
      // 운영 상태 지표는 응답이 도착한 뒤 채워지므로 값이 나타날 때까지 기다린다.
      await waitText(page, "$0.0123");
      const statusText = await page.evaluate(() => document.body.innerText);
      expect(statusText).toMatch(/실패한 실행\s*확인 불가/);
      expect(statusText).toMatch(/PUBG API 에러\s*확인 불가/);
      expect(errors).toEqual([]);
      expect(unexpected).toEqual([]);
    } finally {
      await context.close();
    }
  }, 90_000);

  it.each(viewports)("AI 코칭·AI 비서 화면이 메뉴 아래에서 이중 스크롤되지 않음 $width × $height", async (viewport) => {
    const { context, page, errors } = await openAdminPage({
      browser, baseUrl: server.baseUrl, supabaseUrl, viewport, unexpected,
      handler: ({ path }) => {
        // 레이아웃 높이만 확인하므로 데이터는 빈 응답이나 실패로 둔다.
        if (path.startsWith("/api/admin/ai-coaching/cases")) return { body: { cases: [], page: 1, pageSize: 20, total: 0, counts: {} } };
        if (path.startsWith("/api/admin/agent/")) return { status: 503, body: { code: "fixture_unavailable" } };
        if (path.startsWith("/api/admin/")) return { status: 503, body: {} };
        return undefined;
      },
    });
    // 화면 루트가 min-h-screen(100vh)이면 메뉴 아래 스크롤 영역보다 커져 메뉴 높이만큼 빈 스크롤이 생긴다.
    // 루트 최소 높이가 스크롤 영역 높이를 넘지 않는지 본다.
    const rootMinHeightFits = () => page.evaluate(() => {
      const scroller = document.querySelector<HTMLElement>('[data-testid="admin-scroll-area"]');
      const root = scroller?.querySelector<HTMLElement>("main");
      if (!scroller || !root) return null;
      return parseFloat(getComputedStyle(root).minHeight || "0") <= scroller.clientHeight + 1;
    });
    const layoutOverflow = () => page.evaluate(() => {
      const scroller = document.querySelector<HTMLElement>('[data-testid="admin-scroll-area"]');
      if (!scroller) return null;
      return scroller.scrollHeight - scroller.clientHeight;
    });
    try {
      await page.goto(`${server.baseUrl}/admin/ai-coaching`, { waitUntil: "domcontentloaded" });
      await waitText(page, "아직 사례가 없습니다");
      await page.waitForSelector('[data-testid="admin-nav"]', { timeout: 20_000 });
      await new Promise((resolve) => setTimeout(resolve, 500));
      expect(await hasNoHorizontalOverflow(page)).toBe(true);
      expect(await rootMinHeightFits()).toBe(true);
      await page.screenshot({ path: shot("ai-coaching", viewport) });

      await page.goto(`${server.baseUrl}/admin/bot?tab=community`, { waitUntil: "domcontentloaded" });
      await page.waitForSelector('[data-testid="admin-nav"]', { timeout: 20_000 });
      await new Promise((resolve) => setTimeout(resolve, 1_000));
      expect(await hasNoHorizontalOverflow(page)).toBe(true);
      expect(await rootMinHeightFits()).toBe(true);
      await page.screenshot({ path: shot("bot-community", viewport) });

      await page.goto(`${server.baseUrl}/admin/bot`, { waitUntil: "domcontentloaded" });
      await page.waitForSelector('[data-testid="admin-nav"]', { timeout: 20_000 });
      await new Promise((resolve) => setTimeout(resolve, 1_000));
      // AI 비서 채팅은 화면 높이 안에서 입력창이 보여야 한다.
      const botFits = await layoutOverflow();
      expect(botFits).not.toBeNull();
      expect(botFits!).toBeLessThanOrEqual(1);
      // 화면 탭은 채팅 헤더 안에 들어가 별도 줄을 차지하지 않고, 헤더 버튼과 함께 화면 폭 안에 보인다.
      const botHeader = await page.evaluate(() => {
        const tabs = document.querySelector<HTMLElement>('nav[aria-label="관리 비서 화면"]');
        const header = tabs?.closest("header");
        const visible = (element: Element | null) => {
          if (!element) return false;
          const rect = element.getBoundingClientRect();
          return rect.width > 0 && rect.left >= 0 && rect.right <= innerWidth + 1;
        };
        const messageInput = document.querySelector('input[aria-label="AI 비서에게 보낼 메시지"]');
        return {
          tabsInHeader: Boolean(header),
          headerHeight: header?.getBoundingClientRect().height ?? 0,
          tabButtonsVisible: Array.from(tabs?.querySelectorAll("button") || []).every(visible),
          actionButtonsVisible: ["대화 리셋", "봇 설정"].every((label) => visible(document.querySelector(`button[aria-label="${label}"]`))),
          inputVisible: messageInput ? messageInput.getBoundingClientRect().bottom <= innerHeight + 1 : false,
        };
      });
      expect(botHeader.tabsInHeader).toBe(true);
      expect(botHeader.tabButtonsVisible).toBe(true);
      expect(botHeader.actionButtonsVisible).toBe(true);
      expect(botHeader.inputVisible).toBe(true);
      // 휴대폰에서는 사이트 헤더 + 관리자 메뉴 + 탭을 품은 채팅 헤더 한 줄만 위에 쌓인다.
      if (viewport.width < 640) expect(botHeader.headerHeight).toBeLessThanOrEqual(56);
      await page.screenshot({ path: shot("bot-chat", viewport) });
      expect(errors).toEqual([]);
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
