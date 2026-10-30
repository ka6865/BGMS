import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { mockRequireAdmin } = vi.hoisted(() => ({ mockRequireAdmin: vi.fn() }));

vi.mock("@/lib/server/adminGuard", () => ({ requireAdmin: mockRequireAdmin }));

import { buildApprovalExecutionGate } from "@/lib/admin-agent/impact";
import { isAdminAgentCronRequest } from "@/lib/admin-agent/cron-auth";
import { recordAdminAudit } from "@/lib/server/adminAudit";
import { parseManualPatchSource } from "@/lib/server/patchNoteSource";
import { DELETE as postsDELETE } from "../app/api/admin/posts/delete/route";
import { GET as reportsGET } from "../app/api/admin/reports/route";

describe("Execution Gate 고위험 warning 차단", () => {
  const warningImpact = {
    risk: "high" as const,
    summary: "",
    details: {},
    checklist: [{ label: "영향 범위", status: "warning" as const, message: "현재 재검증된 mismatch target: 0개" }]
  };

  it("고위험 작업의 checklist warning 은 block 과 사전 조치를 만든다", () => {
    const gate = buildApprovalExecutionGate(
      "repair_processed_telemetry_identity",
      { targets: [{ match_id: "m", platform: "steam", player_id: "p" }] },
      warningImpact as any
    );

    expect(gate.status).toBe("block");
    expect(gate.requiredBeforeApproval.join(" ")).toContain("warning");
  });

  it("고위험이 아닌 작업의 warning 은 기존처럼 review 로 남는다", () => {
    const gate = buildApprovalExecutionGate(
      "save_agent_report",
      { title: "리포트", body: "본문" },
      { ...warningImpact, risk: "medium" } as any
    );

    expect(gate.status).toBe("review");
  });
});

describe("패치노트 수동 URL 검증", () => {
  it.each([
    ["https://pubg.com/ko/news/1234", "official"],
    ["https://www.pubg.com/ko/news/1234", "official"],
    ["https://pubg.game.daum.net/pubg/notice?articleId=1", "kakao"]
  ])("%s 는 허용한다", (url, kind) => {
    expect(parseManualPatchSource(url)?.kind).toBe(kind);
  });

  it.each([
    "http://pubg.com/ko/news/1",
    "https://pubg.com.evil.example/news",
    "https://evilpubg.com/news",
    "https://user:pw@pubg.com/news",
    "https://pubg.com:8443/news",
    "https://169.254.169.254/latest/meta-data",
    "ftp://pubg.com/x",
    "not a url",
    "",
    42
  ])("%s 는 거부한다", (url) => {
    expect(parseManualPatchSource(url)).toBeNull();
  });
});

describe("관리자 감사 로그 헬퍼", () => {
  it("insert 실패나 예외에도 throw 하지 않는다", async () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const failing = { from: () => ({ insert: async () => ({ error: { message: "relation does not exist" } }) }) };
    const throwing = { from: () => { throw new Error("network"); } };

    await expect(recordAdminAudit(failing, { actorId: "a", action: "users.delete" })).resolves.toBe(false);
    await expect(recordAdminAudit(throwing, { actorId: "a", action: "users.delete" })).resolves.toBe(false);
    await expect(recordAdminAudit(undefined, { actorId: "a", action: "users.delete" })).resolves.toBe(false);
    errorSpy.mockRestore();
  });

  it("단계와 대상 식별자를 문자열로 저장한다", async () => {
    const insert = vi.fn(async () => ({ error: null }));
    const ok = await recordAdminAudit({ from: () => ({ insert }) }, {
      actorId: "admin-1",
      action: "posts.force_delete",
      targetType: "post",
      targetId: 42,
      phase: "requested"
    });

    expect(ok).toBe(true);
    expect(insert).toHaveBeenCalledWith({
      actor_id: "admin-1",
      action: "posts.force_delete",
      target_type: "post",
      target_id: "42",
      detail: { phase: "requested" }
    });
  });
});

describe("Admin Agent cron 비밀 인증", () => {
  beforeEach(() => {
    delete process.env.ADMIN_AGENT_CRON_SECRET;
    delete process.env.CRON_SECRET;
  });
  afterEach(() => {
    delete process.env.ADMIN_AGENT_CRON_SECRET;
    delete process.env.CRON_SECRET;
  });

  const request = (headers: Record<string, string>) => new Request("http://localhost/api/admin/agent/monitor", { headers });

  it("비밀값이 설정되지 않으면 어떤 요청도 통과시키지 않는다", () => {
    expect(isAdminAgentCronRequest(request({ Authorization: "Bearer " }))).toBe(false);
    expect(isAdminAgentCronRequest(request({}))).toBe(false);
  });

  it("Bearer 와 x-admin-agent-secret 헤더를 상수 시간 비교로 확인한다", () => {
    process.env.ADMIN_AGENT_CRON_SECRET = "agent-secret";
    expect(isAdminAgentCronRequest(request({ Authorization: "Bearer agent-secret" }))).toBe(true);
    expect(isAdminAgentCronRequest(request({ "x-admin-agent-secret": "agent-secret" }))).toBe(true);
    expect(isAdminAgentCronRequest(request({ Authorization: "Bearer agent-secreT" }))).toBe(false);
    expect(isAdminAgentCronRequest(request({ Authorization: "Bearer agent" }))).toBe(false);
  });

  it("ADMIN_AGENT_CRON_SECRET 이 있으면 CRON_SECRET 은 쓰지 않는다", () => {
    process.env.ADMIN_AGENT_CRON_SECRET = "agent-secret";
    process.env.CRON_SECRET = "generic-secret";
    expect(isAdminAgentCronRequest(request({ Authorization: "Bearer generic-secret" }))).toBe(false);
  });

  it("monitor 와 rollout 라우트가 공용 판정을 쓴다", async () => {
    const { readFileSync } = await import("node:fs");
    for (const path of ["app/api/admin/agent/monitor/route.ts", "app/api/admin/agent/rollout/route.ts"]) {
      const source = readFileSync(path, "utf8");
      expect(source).toContain("isAdminAgentCronRequest(request)");
      expect(source).not.toContain("providedSecret === cronSecret");
      expect(source).not.toContain("providedSecret !== cronSecret");
    }
  });
});

function createPostsAdmin(deleteResult: { data: any; error: any }) {
  const audit = vi.fn(async () => ({ error: null }));
  const select = vi.fn(async () => deleteResult);
  const eq = vi.fn(() => ({ select }));
  const del = vi.fn(() => ({ eq }));
  const from = vi.fn((table: string) => table === "admin_audit_events" ? { insert: audit } : { delete: del });
  return { client: { from }, from, del, eq, audit };
}

describe("게시글 강제 삭제 API", () => {
  beforeEach(() => mockRequireAdmin.mockReset());

  it.each(["abc", "0", "-1", "1.5", "1e3", "99999999999999999"])("postId=%s 는 400 으로 거부한다", async (postId) => {
    mockRequireAdmin.mockResolvedValue({ ok: true, user: { id: "admin-1" }, supabaseAdmin: createPostsAdmin({ data: [], error: null }).client });
    const response = await postsDELETE(new Request(`http://localhost/api/admin/posts/delete?postId=${postId}`, { method: "DELETE" }));

    expect(response.status).toBe(400);
    expect(mockRequireAdmin).not.toHaveBeenCalled();
  });

  it("FK cascade 에 맡기고 posts 한 건만 삭제하며 감사 로그를 전후로 남긴다", async () => {
    const admin = createPostsAdmin({ data: [{ id: 7 }], error: null });
    mockRequireAdmin.mockResolvedValue({ ok: true, user: { id: "admin-1" }, supabaseAdmin: admin.client });

    const response = await postsDELETE(new Request("http://localhost/api/admin/posts/delete?postId=7", { method: "DELETE" }));

    expect(response.status).toBe(200);
    expect(admin.from).not.toHaveBeenCalledWith("comments");
    expect(admin.from).not.toHaveBeenCalledWith("post_likes");
    expect(admin.eq).toHaveBeenCalledWith("id", 7);
    expect(admin.audit.mock.calls.map(([row]: any[]) => row.detail.phase)).toEqual(["requested", "succeeded"]);
  });

  it("권한 거부 응답에 호출자 역할을 싣지 않는다", async () => {
    const { NextResponse } = await import("next/server");
    mockRequireAdmin.mockResolvedValue({ ok: false, error: NextResponse.json({ error: "관리자 권한이 없습니다." }, { status: 403 }) });

    const response = await postsDELETE(new Request("http://localhost/api/admin/posts/delete?postId=7", { method: "DELETE" }));
    const body = await response.json();

    expect(response.status).toBe(403);
    expect(body.error).not.toContain("현재:");
  });

  it("DB 오류 원문을 응답에 싣지 않는다", async () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const admin = createPostsAdmin({ data: null, error: { message: "permission denied for table posts" } });
    mockRequireAdmin.mockResolvedValue({ ok: true, user: { id: "admin-1" }, supabaseAdmin: admin.client });

    const response = await postsDELETE(new Request("http://localhost/api/admin/posts/delete?postId=7", { method: "DELETE" }));
    const body = await response.json();

    expect(response.status).toBe(500);
    expect(body.error).not.toContain("permission denied");
    errorSpy.mockRestore();
  });
});

describe("신고 목록 API", () => {
  beforeEach(() => mockRequireAdmin.mockReset());

  it("허용되지 않은 status 는 400 으로 거부한다", async () => {
    mockRequireAdmin.mockResolvedValue({ ok: true, user: { id: "admin-1" }, supabaseAdmin: { from: vi.fn() } });

    const response = await reportsGET(new Request("http://localhost/api/admin/reports?status=all"));

    expect(response.status).toBe(400);
  });

  it("목록 조회에 상한을 둔다", async () => {
    const limit = vi.fn(async () => ({ data: [], error: null }));
    const chain: any = { select: vi.fn(() => chain), eq: vi.fn(() => chain), order: vi.fn(() => chain), limit };
    mockRequireAdmin.mockResolvedValue({ ok: true, user: { id: "admin-1" }, supabaseAdmin: { from: vi.fn(() => chain) } });

    const response = await reportsGET(new Request("http://localhost/api/admin/reports?status=resolved"));

    expect(response.status).toBe(200);
    expect(chain.eq).toHaveBeenCalledWith("status", "resolved");
    expect(limit).toHaveBeenCalledWith(200);
  });
});

describe("Admin Agent 도구의 승인 요청 생성 실패", () => {
  it("승인 행을 만들지 못하면 approval_required 대신 failed 를 돌려준다", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const { adminAgentTools } = await import("@/lib/admin-agent/tools");
    const single = vi.fn(async () => ({ data: null, error: { message: "insert denied" } }));
    const supabase = { from: vi.fn(() => ({ insert: vi.fn(() => ({ select: vi.fn(() => ({ single })) })) })) };

    const result = await adminAgentTools.request_agent_memory.run(
      { category: "policy", title: "정책", body: "본문", reason: "보존" },
      { supabase, userId: "admin-1", runId: "run-1", stepId: "step-1" }
    );

    expect(result.status).toBe("failed");
    expect(result.approvalId).toBeUndefined();
    const parsed = JSON.parse(result.result);
    expect(parsed).toMatchObject({ approvalRequired: false, approvalCreated: false, approvalId: null });
    expect(parsed.message).toContain("등록하지 못했습니다");
    warnSpy.mockRestore();
  });
});
