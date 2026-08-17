import { describe, it, expect, vi, beforeEach } from "vitest";
import { GET as briefingGET, POST as briefingPOST } from "../app/api/admin/agent/briefing/route";
import { GET as commandCenterGET, POST as commandCenterPOST } from "../app/api/admin/agent/command-center/route";
import { GET as contentPerformanceGET } from "../app/api/admin/agent/content-performance/route";
import { GET as contentDraftGET, POST as contentDraftPOST } from "../app/api/admin/agent/content-drafts/route";
import { GET as handoffGET, POST as handoffPOST } from "../app/api/admin/agent/handoff/route";
import { GET as memoriesGET, POST as memoriesPOST } from "../app/api/admin/agent/memories/route";
import { POST as memoryDeactivatePOST } from "../app/api/admin/agent/memories/[id]/deactivate/route";
import { GET as incidentsGET, POST as incidentsPOST } from "../app/api/admin/agent/incidents/route";
import { GET as selfTestGET } from "../app/api/admin/agent/self-test/route";
import { GET as rolloutGET } from "../app/api/admin/agent/rollout/route";
import { POST as monitorPOST } from "../app/api/admin/agent/monitor/route";
import { GET as toolsGET } from "../app/api/admin/agent/tools/route";
import { GET as runDetailGET } from "../app/api/admin/agent/runs/[id]/route";
import { GET as runTimelineGET } from "../app/api/admin/agent/runs/[id]/timeline/route";
import { GET as approvalsGET } from "../app/api/admin/agent/approvals/route";
import { POST as approvalApprovePOST } from "../app/api/admin/agent/approvals/[id]/approve/route";
import { POST as approvalRejectPOST } from "../app/api/admin/agent/approvals/[id]/reject/route";
import { completeAgentStep, createAgentStep } from "../lib/admin-agent/logging";
import { redactForAgentLog } from "../lib/admin-agent/redaction";
import { adminAgentTools } from "../lib/admin-agent/tools";
import { fetchVercelDeploymentHealth } from "../lib/admin-agent/deployments";
import { withAuthGuard } from "../utils/supabase/guard";
import { NextResponse } from "next/server";

const { mockCreateSupabaseClient } = vi.hoisted(() => ({
  mockCreateSupabaseClient: vi.fn()
}));

vi.mock("../utils/supabase/guard", () => ({
  withAuthGuard: vi.fn()
}));

vi.mock("@supabase/supabase-js", () => ({
  createClient: mockCreateSupabaseClient
}));

describe("🚦 Admin Agent Deployment Health", () => {
  beforeEach(() => {
    vi.unstubAllGlobals();
    delete process.env.VERCEL_TOKEN;
    delete process.env.VERCEL_PROJECT_ID;
  });

  it("Vercel env가 없으면 배포 감시를 조용히 skip한다", async () => {
    const health = await fetchVercelDeploymentHealth();

    expect(health.configured).toBe(false);
    expect(health.severity).toBe("ok");
    expect(health.message).toContain("건너뜁니다");
  });

  it("최근 Vercel 배포 실패를 critical 상태로 요약한다", async () => {
    process.env.VERCEL_TOKEN = "vercel-token";
    process.env.VERCEL_PROJECT_ID = "project-id";
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        deployments: [
          { uid: "dep-error", state: "ERROR", url: "bgms.kr", created: Date.now(), creator: { username: "admin" } },
          { uid: "dep-ready", state: "READY", url: "bgms.kr", created: Date.now() - 60000 }
        ]
      })
    }));

    const health = await fetchVercelDeploymentHealth();

    expect(health.configured).toBe(true);
    expect(health.severity).toBe("critical");
    expect(health.latest?.uid).toBe("dep-error");
    expect(health.recentFailures).toHaveLength(1);
  });
});

describe("🧠 Admin Agent Memory/Briefing APIs", () => {
  let mockSupabaseAdmin: any;
  let tables: Record<string, any>;

  beforeEach(() => {
    vi.clearAllMocks();
    process.env.NEXT_PUBLIC_SUPABASE_URL = "https://example.supabase.co";
    process.env.SUPABASE_SERVICE_ROLE_KEY = "service-role";
    process.env.GOOGLE_GEMINI_API_KEY = "gemini";
    process.env.ADMIN_AGENT_CRON_SECRET = "cron";
    delete process.env.DISCORD_WEBHOOK_URL;
    delete process.env.TAVILY_API_KEY;
    delete process.env.VERCEL_TOKEN;
    delete process.env.VERCEL_PROJECT_ID;
    delete process.env.ADMIN_AGENT_WINDOW_HOURS;
    delete process.env.ADMIN_AGENT_API_ERRORS_CRITICAL;
    delete process.env.ADMIN_AGENT_AI_COST_WARN_USD;
    delete process.env.ADMIN_AGENT_AI_COST_CRITICAL_USD;
    delete process.env.ADMIN_AGENT_PUBG_QUOTA_WARN;
    delete process.env.ADMIN_AGENT_PUBG_QUOTA_CRITICAL;
    delete process.env.ADMIN_AGENT_APPROVAL_STALE_HOURS;
    tables = {};

    tables.profiles = chain({
      maybeSingle: { data: { role: "admin" }, error: null }
    });

    tables.agent_approvals = chain({
      count: 1,
      insertSingle: { data: { id: "approval-1" }, error: null }
    });

    tables.agent_runs = chain({ count: 0 });
    tables.agent_steps = chain({
      data: [{
        id: "step-1",
        run_id: "run-1",
        tool_name: "inspect_operations",
        safety_level: "read",
        status: "success",
        params: { focus: "overview" },
        result: "{\"message\":\"ok\"}",
        error: null,
        started_at: new Date().toISOString(),
        completed_at: new Date().toISOString()
      }],
      error: null
    });
    tables.pubg_api_errors = chain({
      data: [{ route: "/api/pubg/player", status: 429, message: "Rate limit", created_at: new Date().toISOString() }],
      error: null
    });
    tables.posts = chain({
      data: [{ id: "post-1", title: "최근 공지", category: "자유", views: 100, likes: 5, created_at: new Date().toISOString() }],
      insertSingle: { data: { id: "published-post" }, error: null },
      error: null
    });
    tables.sync_history = chain({
      data: [{ type: "patch_notes", last_url: "https://pubg.com/ko/news/123?category=patch_notes", updated_at: new Date().toISOString() }],
      error: null
    });
    tables.match_stats_raw = chain({
      data: [
        { map_name: "Erangel", kills: 3, damage: 420 },
        { map_name: "Erangel", kills: 1, damage: 120 },
        { map_name: "Miramar", kills: 2, damage: 260 }
      ],
      error: null
    });
    tables.ai_usage_logs = chain({
      data: [{ cost_usd: 0.25, model_name: "gemini-test", analysis_type: "summary" }],
      error: null
    });
    tables.agent_memories = chain({
      data: [
        {
          id: "memory-1",
          category: "incident",
          title: "PUBG 429 대응",
          body: "수집량을 줄이고 캐시 우선으로 전환한다.",
          metadata: { active: true, tags: ["pubg", "429"] },
          created_at: new Date().toISOString(),
          updated_at: new Date().toISOString()
        }
      ],
      maybeSingle: {
        data: { metadata: { active: true, tags: ["pubg"] } },
        error: null
      },
      insertSingle: { data: { id: "saved-memory" }, error: null },
      updateResult: { data: null, error: null }
    });

    mockSupabaseAdmin = {
      from: vi.fn((table: string) => tables[table] || chain({ data: [], error: null }))
    };
    mockCreateSupabaseClient.mockReturnValue(mockSupabaseAdmin);
  });

  it("비로그인 요청은 briefing API에서 auth guard 응답을 그대로 반환한다", async () => {
    (withAuthGuard as any).mockResolvedValue({
      error: NextResponse.json({ error: "로그인이 필요합니다." }, { status: 401 })
    });

    const response = await briefingGET(new Request("http://localhost/api/admin/agent/briefing"));

    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({ error: "로그인이 필요합니다." });
  });

  it("GET /self-test는 agent readiness를 반환한다", async () => {
    mockAdminAuth();

    const response = await selfTestGET();
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.selfTest.status).toBe("warn");
    expect(body.selfTest.toolCount).toBeGreaterThanOrEqual(9);
    expect(body.selfTest.checks).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: "table:agent_runs", status: "ok" }),
      expect.objectContaining({ id: "security:log-redaction", status: "ok" }),
      expect.objectContaining({ id: "tools:registry", status: "ok" }),
      expect.objectContaining({ id: "tools:safety-classification", status: "ok" }),
      expect.objectContaining({ id: "workflow:approval-loop", status: "ok" }),
      expect.objectContaining({ id: "workflow:report-approval", status: "ok" }),
      expect.objectContaining({ id: "workflow:decision-support", status: "ok" }),
      expect.objectContaining({ id: "workflow:today-action-board", status: "ok" }),
      expect.objectContaining({ id: "workflow:memory-learning", status: "ok" }),
      expect.objectContaining({ id: "workflow:api-surface", status: "ok" })
    ]));
    expect(body.selfTest.checks.find((check: any) => check.id === "workflow:report-approval").message).toContain("command-center digests");
    expect(body.selfTest.checks.find((check: any) => check.id === "workflow:decision-support").message).toContain("daily checkout");
    expect(body.selfTest.checks.find((check: any) => check.id === "workflow:today-action-board").message).toContain("do-now");
    expect(body.selfTest.checks.find((check: any) => check.id === "workflow:memory-learning").message).toContain("approval-backed memories");
    expect(body.selfTest.checks.find((check: any) => check.id === "security:log-redaction").message).toContain("redact");
    expect(body.selfTest.checks.find((check: any) => check.id === "tools:registry").message).toContain("dangerous");
  });

  it("agent log 저장 경로는 secret/token/password 값을 redact한다", async () => {
    const redacted = redactForAgentLog({
      apiKey: "secret-value-123",
      message: "token=abcdef1234567890 password=hunter2",
      nested: {
        authorization: "Bearer abcdefghijklmnopqrstuvwxyz",
        db: "postgresql://postgres:plain-password@example.supabase.co:5432/postgres"
      }
    });
    expect(JSON.stringify(redacted)).not.toContain("secret-value-123");
    expect(JSON.stringify(redacted)).not.toContain("abcdef1234567890");
    expect(JSON.stringify(redacted)).not.toContain("hunter2");
    expect(JSON.stringify(redacted)).not.toContain("plain-password");

    tables.agent_steps = chain({
      insertSingle: { data: { id: "step-secret" }, error: null },
      updateResult: { data: null, error: null }
    });

    const stepId = await createAgentStep(mockSupabaseAdmin, {
      runId: "run-secret",
      toolName: "inspect_operations",
      safetyLevel: "read",
      params: {
        apiKey: "secret-value-123",
        text: "Authorization: Bearer abcdefghijklmnopqrstuvwxyz",
        db: "postgresql://postgres:plain-password@example.supabase.co:5432/postgres"
      }
    });
    await completeAgentStep(mockSupabaseAdmin, stepId, {
      status: "success",
      result: "token=abcdef1234567890",
      error: "password=hunter2"
    });

    const inserted = JSON.stringify(tables.agent_steps.insert.mock.calls[0][0]);
    const updated = JSON.stringify(tables.agent_steps.update.mock.calls[0][0]);
    expect(inserted).not.toContain("secret-value-123");
    expect(inserted).not.toContain("plain-password");
    expect(updated).not.toContain("abcdef1234567890");
    expect(updated).not.toContain("hunter2");
    expect(inserted + updated).toContain("[REDACTED]");
  });

  it("GET /tools는 tool safety catalog를 반환한다", async () => {
    mockAdminAuth();

    const response = await toolsGET();
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.catalog.total).toBeGreaterThanOrEqual(9);
    expect(body.catalog.counts.read).toBeGreaterThan(0);
    expect(body.catalog.counts.dangerous).toBeGreaterThan(0);
    expect(body.catalog.tools).toEqual(expect.arrayContaining([
      expect.objectContaining({ name: "create_board_post", safetyLevel: "dangerous", approvalRequired: true }),
      expect.objectContaining({ name: "update_board_post", safetyLevel: "dangerous", approvalRequired: true }),
      expect.objectContaining({ name: "inspect_operations", safetyLevel: "read", approvalRequired: false }),
      expect.objectContaining({ name: "inspect_agent_readiness", safetyLevel: "read", approvalRequired: false }),
      expect.objectContaining({ name: "inspect_approval_queue", safetyLevel: "read", approvalRequired: false }),
      expect.objectContaining({ name: "inspect_incident_timeline", safetyLevel: "read", approvalRequired: false }),
      expect.objectContaining({ name: "inspect_handoff_packet", safetyLevel: "read", approvalRequired: false }),
      expect.objectContaining({ name: "inspect_operator_value", safetyLevel: "read", approvalRequired: false }),
      expect.objectContaining({ name: "inspect_owner_brief", safetyLevel: "read", approvalRequired: false }),
      expect.objectContaining({ name: "inspect_monitor_trend", safetyLevel: "read", approvalRequired: false }),
      expect.objectContaining({ name: "inspect_automation_contract", safetyLevel: "read", approvalRequired: false }),
      expect.objectContaining({ name: "inspect_user_metrics", safetyLevel: "read", approvalRequired: false }),
      expect.objectContaining({ name: "inspect_capability_matrix", safetyLevel: "read", approvalRequired: false }),
      expect.objectContaining({ name: "inspect_growth_roadmap", safetyLevel: "read", approvalRequired: false }),
      expect.objectContaining({ name: "inspect_today_action_board", safetyLevel: "read", approvalRequired: false }),
      expect.objectContaining({ name: "inspect_daily_checkout", safetyLevel: "read", approvalRequired: false }),
      expect.objectContaining({ name: "inspect_operating_sop", safetyLevel: "read", approvalRequired: false }),
      expect.objectContaining({ name: "inspect_risk_radar", safetyLevel: "read", approvalRequired: false }),
      expect.objectContaining({ name: "inspect_decision_trace", safetyLevel: "read", approvalRequired: false }),
      expect.objectContaining({ name: "inspect_safety_audit", safetyLevel: "read", approvalRequired: false }),
      expect.objectContaining({ name: "inspect_approval_advisor", safetyLevel: "read", approvalRequired: false }),
      expect.objectContaining({ name: "inspect_mission_control", safetyLevel: "read", approvalRequired: false }),
      expect.objectContaining({ name: "inspect_owner_inbox", safetyLevel: "read", approvalRequired: false }),
      expect.objectContaining({ name: "inspect_outcome_review", safetyLevel: "read", approvalRequired: false }),
      expect.objectContaining({ name: "inspect_operator_coach", safetyLevel: "read", approvalRequired: false }),
      expect.objectContaining({ name: "inspect_launch_kit", safetyLevel: "read", approvalRequired: false }),
      expect.objectContaining({ name: "inspect_final_readiness", safetyLevel: "read", approvalRequired: false })
    ]));
  });

  it("GET /rollout은 배포 전 readiness checklist를 반환한다", async () => {
    mockAdminAuth();

    const response = await rolloutGET(new Request("http://localhost/api/admin/agent/rollout"));
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.rollout.checks).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: "self-test" }),
      expect.objectContaining({ id: "dangerous-tools", status: "pass" }),
      expect.objectContaining({ id: "log-redaction", status: "pass" }),
      expect.objectContaining({ id: "action-board", status: "pass" }),
      expect.objectContaining({ id: "memory-learning", status: "pass" }),
      expect.objectContaining({ id: "monitor-secret", status: "pass" })
    ]));
    expect(["pass", "warn", "fail"]).toContain(body.rollout.status);
  });

  it("GET /rollout은 cron secret 인증으로도 readiness snapshot을 반환한다", async () => {
    const response = await rolloutGET(new Request("http://localhost/api/admin/agent/rollout", {
      headers: { Authorization: "Bearer cron" }
    }));
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.source).toBe("cron");
    expect(body.rollout.checks).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: "monitor-secret", status: "pass" })
    ]));
    expect(withAuthGuard).not.toHaveBeenCalled();
    expect(mockCreateSupabaseClient).toHaveBeenCalledWith("https://example.supabase.co", "service-role");
  });

  it("GET /runs/:id는 run과 step 상세를 반환한다", async () => {
    tables.agent_runs = chain({
      singleResult: {
        data: {
          id: "run-1",
          user_id: "admin-id",
          status: "completed",
          message: "운영 진단",
          summary: "ok",
          error: null,
          started_at: new Date().toISOString(),
          completed_at: new Date().toISOString()
        },
        error: null
      }
    });
    mockAdminAuth();

    const response = await runDetailGET(
      new Request("http://localhost/api/admin/agent/runs/run-1"),
      { params: Promise.resolve({ id: "run-1" }) }
    );
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.run.id).toBe("run-1");
    expect(body.steps).toHaveLength(1);
    expect(body.steps[0]).toEqual(expect.objectContaining({
      tool_name: "inspect_operations",
      safety_level: "read"
    }));
  });

  it("GET /runs/:id/timeline은 run, steps, approvals를 markdown으로 반환한다", async () => {
    tables.agent_runs = chain({
      singleResult: {
        data: {
          id: "run-1",
          user_id: "admin-id",
          status: "completed",
          message: "운영 진단",
          summary: "ok",
          error: null,
          started_at: new Date().toISOString(),
          completed_at: new Date().toISOString()
        },
        error: null
      }
    });
    tables.agent_approvals = chain({
      data: [{
        id: "approval-1",
        run_id: "run-1",
        action_type: "create_board_post",
        status: "executed",
        payload: { title: "공지" },
        result: JSON.stringify({
          decision: {
            approvedBy: "admin-id",
            approvalNote: "공지 발행 확인",
            highRisk: false,
            confirmedImpact: false
          },
          execution: { success: true },
          postExecution: {
            outcome: "자유게시판에 글이 발행되었습니다.",
            followUp: ["게시판에서 렌더링 확인"],
            audit: { relatedResource: "/board/published-post" }
          }
        }),
        created_at: new Date().toISOString()
      }],
      error: null
    });
    mockAdminAuth();

    const response = await runTimelineGET(
      new Request("http://localhost/api/admin/agent/runs/run-1/timeline"),
      { params: Promise.resolve({ id: "run-1" }) }
    );
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.markdown).toContain("BGMS Agent Run Timeline");
    expect(body.markdown).toContain("inspect_operations");
    expect(body.markdown).toContain("create_board_post");
    expect(body.markdown).toContain("Approval Note: 공지 발행 확인");
    expect(body.markdown).toContain("Impact Confirmed: no");
    expect(body.markdown).toContain("Outcome: 자유게시판에 글이 발행되었습니다.");
    expect(body.markdown).toContain("Follow-up: 게시판에서 렌더링 확인");
    expect(body.markdown).toContain("Related Resource: /board/published-post");
    expect(body.approvals).toHaveLength(1);
  });

  it("GET /incidents?format=markdown은 최근 운영 사고 타임라인을 반환한다", async () => {
    tables.agent_runs = chain({
      data: [{
        id: "run-failed",
        status: "failed",
        message: "운영 점검 실패",
        summary: null,
        error: "monitor failed",
        started_at: new Date().toISOString(),
        completed_at: new Date().toISOString()
      }],
      error: null
    });
    tables.agent_steps = chain({
      data: [{
        id: "step-failed",
        run_id: "run-failed",
        tool_name: "inspect_operations",
        safety_level: "read",
        status: "failed",
        error: "query failed",
        started_at: new Date().toISOString(),
        completed_at: new Date().toISOString()
      }],
      error: null
    });
    tables.agent_approvals = chain({
      data: [{
        id: "approval-cache",
        run_id: "run-failed",
        action_type: "flush_old_cache",
        status: "pending",
        payload: { reason: "캐시 정리 검토" },
        created_at: new Date().toISOString()
      }],
      error: null
    });
    tables.pubg_api_errors = chain({
      data: [{
        route: "/api/pubg/player",
        status: 429,
        message: "Rate limit",
        created_at: new Date().toISOString()
      }],
      error: null
    });
    mockAdminAuth();

    const response = await incidentsGET(new Request("http://localhost/api/admin/agent/incidents?hours=24&format=markdown"));
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.timeline.severity).toBe("critical");
    expect(body.timeline.summary.apiErrors).toBe(1);
    expect(body.markdown).toContain("BGMS Incident Timeline");
    expect(body.markdown).toContain("운영 점검 실패");
    expect(body.markdown).toContain("/api/pubg/player");
    expect(body.markdown).toContain("/admin/bot?run=run-failed");
    expect(body.markdown).toContain("/admin/bot?approval=approval-cache");
    expect(body.markdown).toContain("Recommended Follow-up");
  });

  it("inspect_incident_timeline 도구는 최근 사고 흐름을 read-only로 분석한다", async () => {
    tables.agent_runs = chain({
      data: [{
        id: "run-failed",
        status: "failed",
        message: "운영 점검 실패",
        error: "monitor failed",
        started_at: new Date().toISOString()
      }],
      error: null
    });
    tables.agent_steps = chain({
      data: [{
        id: "step-failed",
        run_id: "run-failed",
        tool_name: "inspect_operations",
        safety_level: "read",
        status: "failed",
        error: "query failed",
        started_at: new Date().toISOString()
      }],
      error: null
    });
    tables.agent_approvals = chain({
      data: [{
        id: "approval-cache",
        action_type: "flush_old_cache",
        status: "pending",
        payload: { reason: "캐시 정리 검토" },
        created_at: new Date().toISOString()
      }],
      error: null
    });
    tables.pubg_api_errors = chain({
      data: [{
        route: "/api/pubg/player",
        status: 429,
        message: "Rate limit",
        created_at: new Date().toISOString()
      }],
      error: null
    });

    const result = await adminAgentTools.inspect_incident_timeline.run(
      { hours: 24, includeMarkdown: true },
      { supabase: mockSupabaseAdmin, userId: "admin-id" }
    );
    const parsed = JSON.parse(result.result);

    expect(result.status).toBe("success");
    expect(parsed.severity).toBe("critical");
    expect(parsed.summary.apiErrors).toBe(1);
    expect(parsed.events).toEqual(expect.arrayContaining([
      expect.objectContaining({ source: "pubg_api_error" }),
      expect.objectContaining({ source: "agent_run" })
    ]));
    expect(parsed.markdown).toContain("BGMS Incident Timeline");
    expect(tables.agent_runs.update).not.toHaveBeenCalled();
    expect(tables.agent_approvals.insert).not.toHaveBeenCalled();
  });

  it("POST /incidents는 사고 타임라인을 직접 저장하지 않고 report 저장 승인 요청을 만든다", async () => {
    tables.agent_runs = chain({
      data: [{
        id: "run-failed",
        status: "failed",
        message: "운영 점검 실패",
        error: "monitor failed",
        started_at: new Date().toISOString()
      }],
      error: null
    });
    tables.agent_steps = chain({ data: [], error: null });
    tables.agent_approvals = chain({
      data: [],
      insertSingle: { data: { id: "approval-incident" }, error: null },
      error: null
    });
    tables.pubg_api_errors = chain({
      data: [{
        route: "/api/pubg/player",
        status: 429,
        message: "Rate limit",
        created_at: new Date().toISOString()
      }],
      error: null
    });
    mockAdminAuth();

    const response = await incidentsPOST(new Request("http://localhost/api/admin/agent/incidents", {
      method: "POST",
      body: JSON.stringify({
        hours: 24,
        title: "사고 타임라인 저장",
        reason: "장애 회고 기록"
      })
    }));
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.approvalId).toBe("approval-incident");
    expect(tables.agent_approvals.insert).toHaveBeenCalledWith(expect.objectContaining({
      action_type: "save_agent_report",
      tool_name: "request_incident_timeline_report",
      payload: expect.objectContaining({
        title: "사고 타임라인 저장",
        body: expect.stringContaining("BGMS Incident Timeline"),
        metadata: expect.objectContaining({
          source: "incident-timeline",
          reason: "장애 회고 기록",
          timeline: expect.objectContaining({
            severity: "critical"
          })
        })
      })
    }));
  });

  it("GET /handoff?format=markdown은 운영 인수인계 패킷을 반환한다", async () => {
    tables.agent_runs = chain({
      data: [{
        id: "run-failed",
        status: "failed",
        message: "운영 점검 실패",
        error: "monitor failed",
        started_at: new Date().toISOString()
      }],
      maybeSingle: {
        data: {
          id: "run-failed",
          status: "failed",
          message: "운영 점검 실패",
          error: "monitor failed",
          started_at: new Date().toISOString()
        },
        error: null
      },
      error: null
    });
    tables.agent_steps = chain({
      data: [{
        id: "step-failed",
        run_id: "run-failed",
        tool_name: "inspect_operations",
        safety_level: "read",
        status: "failed",
        error: "query failed",
        started_at: new Date().toISOString()
      }],
      error: null
    });
    tables.agent_approvals = chain({
      data: [{
        id: "approval-cache",
        action_type: "flush_old_cache",
        status: "pending",
        payload: { reason: "캐시 정리 검토" },
        created_at: new Date().toISOString()
      }],
      error: null
    });
    tables.agent_memories = chain({
      maybeSingle: {
        data: {
          id: "report-1",
          category: "report",
          title: "최근 운영 리포트",
          body: "운영 상태 공유",
          metadata: { active: true },
          updated_at: new Date().toISOString()
        },
        error: null
      },
      data: [],
      error: null
    });
    tables.pubg_api_errors = chain({
      data: [{
        route: "/api/pubg/player",
        status: 429,
        message: "Rate limit",
        created_at: new Date().toISOString()
      }],
      error: null
    });
    mockAdminAuth();

    const response = await handoffGET(new Request("http://localhost/api/admin/agent/handoff?hours=24&format=markdown"));
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.packet.severity).toBe("critical");
    expect(body.markdown).toContain("BGMS Agent Handoff Packet");
    expect(body.markdown).toContain("Approval Queue");
    expect(body.markdown).toContain("/admin/bot?approval=approval-cache");
    expect(body.markdown).toContain("/admin/bot?run=run-failed");
    expect(body.markdown).toContain("Incident Timeline");
  });

  it("POST /handoff는 인수인계 패킷을 직접 저장하지 않고 report 저장 승인 요청을 만든다", async () => {
    tables.agent_runs = chain({
      data: [{
        id: "run-failed",
        status: "failed",
        message: "운영 점검 실패",
        error: "monitor failed",
        started_at: new Date().toISOString()
      }],
      maybeSingle: {
        data: {
          id: "run-failed",
          status: "failed",
          message: "운영 점검 실패",
          error: "monitor failed",
          started_at: new Date().toISOString()
        },
        error: null
      },
      error: null
    });
    tables.agent_steps = chain({ data: [], error: null });
    tables.agent_approvals = chain({
      data: [],
      insertSingle: { data: { id: "approval-handoff" }, error: null },
      error: null
    });
    tables.agent_memories = chain({
      maybeSingle: { data: null, error: null },
      data: [],
      error: null
    });
    tables.pubg_api_errors = chain({
      data: [{
        route: "/api/pubg/player",
        status: 429,
        message: "Rate limit",
        created_at: new Date().toISOString()
      }],
      error: null
    });
    mockAdminAuth();

    const response = await handoffPOST(new Request("http://localhost/api/admin/agent/handoff", {
      method: "POST",
      body: JSON.stringify({
        hours: 24,
        title: "운영 인수인계 저장",
        reason: "교대 기록"
      })
    }));
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.approvalId).toBe("approval-handoff");
    expect(tables.agent_approvals.insert).toHaveBeenCalledWith(expect.objectContaining({
      action_type: "save_agent_report",
      tool_name: "request_handoff_report",
      payload: expect.objectContaining({
        title: "운영 인수인계 저장",
        body: expect.stringContaining("BGMS Agent Handoff Packet"),
        metadata: expect.objectContaining({
          source: "handoff-packet",
          reason: "교대 기록",
          handoff: expect.objectContaining({
            severity: "critical"
          })
        })
      })
    }));
  });

  it("inspect_handoff_packet 도구는 운영 인수인계 패킷을 read-only로 생성한다", async () => {
    tables.agent_runs = chain({
      data: [{
        id: "run-failed",
        status: "failed",
        message: "운영 점검 실패",
        error: "monitor failed",
        started_at: new Date().toISOString()
      }],
      maybeSingle: {
        data: {
          id: "run-failed",
          status: "failed",
          message: "운영 점검 실패",
          error: "monitor failed",
          started_at: new Date().toISOString()
        },
        error: null
      },
      error: null
    });
    tables.agent_steps = chain({ data: [], error: null });
    tables.agent_approvals = chain({
      data: [{
        id: "approval-cache",
        action_type: "flush_old_cache",
        status: "pending",
        payload: { reason: "캐시 정리 검토" },
        created_at: new Date().toISOString()
      }],
      error: null
    });
    tables.agent_memories = chain({
      maybeSingle: { data: null, error: null },
      data: [],
      error: null
    });
    tables.pubg_api_errors = chain({
      data: [{
        route: "/api/pubg/player",
        status: 429,
        message: "Rate limit",
        created_at: new Date().toISOString()
      }],
      error: null
    });

    const result = await adminAgentTools.inspect_handoff_packet.run(
      { hours: 24, includeMarkdown: true },
      { supabase: mockSupabaseAdmin, userId: "admin-id" }
    );
    const parsed = JSON.parse(result.result);

    expect(result.status).toBe("success");
    expect(parsed.severity).toBe("critical");
    expect(parsed.summary.pendingApprovals).toBe(1);
    expect(parsed.markdown).toContain("BGMS Agent Handoff Packet");
    expect(parsed.markdown).toContain("/admin/bot?approval=approval-cache");
    expect(tables.agent_approvals.insert).not.toHaveBeenCalled();
  });

  it("inspect_operator_value 도구는 운영 가치 scorecard를 read-only로 생성한다", async () => {
    tables.agent_runs = chain({
      data: [{
        id: "monitor-run",
        status: "completed",
        system_prompt: "admin-agent-monitor",
        message: "scheduled operational monitor",
        summary: JSON.stringify({
          generatedAt: new Date().toISOString(),
          severity: "warn",
          alerts: [{ type: "pending_approvals", severity: "warn", message: "승인 대기" }]
        }),
        started_at: new Date().toISOString(),
        completed_at: new Date().toISOString()
      }],
      maybeSingle: {
        data: {
          id: "monitor-run",
          summary: JSON.stringify({
            generatedAt: new Date().toISOString(),
            severity: "warn",
            alerts: [{ type: "pending_approvals", severity: "warn", message: "승인 대기" }]
          }),
          completed_at: new Date().toISOString()
        },
        error: null
      },
      error: null
    });
    tables.agent_approvals = chain({
      data: [{
        id: "approval-executed",
        action_type: "save_agent_report",
        status: "executed",
        payload: { title: "리포트 저장" },
        created_at: new Date().toISOString(),
        executed_at: new Date().toISOString()
      }],
      error: null
    });

    const result = await adminAgentTools.inspect_operator_value.run(
      { hours: 24, includeContent: true },
      { supabase: mockSupabaseAdmin, userId: "admin-id" }
    );
    const parsed = JSON.parse(result.result);

    expect(result.status).toBe("success");
    expect(parsed.scorecard).toEqual(expect.objectContaining({
      score: expect.any(Number),
      metrics: expect.arrayContaining([
        expect.objectContaining({ id: "time_saved" }),
        expect.objectContaining({ id: "risk_prevented" })
      ]),
      nextLeverage: expect.any(Array)
    }));
    expect(parsed.recommendations.length).toBeGreaterThan(0);
    expect(tables.agent_approvals.insert).not.toHaveBeenCalled();
  });

  it("inspect_owner_brief 도구는 30초 운영자 브리핑을 read-only로 생성한다", async () => {
    tables.agent_runs = chain({
      data: [{
        id: "monitor-run",
        status: "completed",
        system_prompt: "admin-agent-monitor",
        message: "scheduled operational monitor",
        summary: JSON.stringify({
          generatedAt: new Date().toISOString(),
          severity: "critical",
          alerts: [{ type: "approval_gate_block", severity: "critical", message: "Execution Gate block 1건" }],
          approvalGateSummary: { passCount: 0, reviewCount: 0, blockCount: 1 },
          dailyCheckout: {
            status: "blocked",
            label: "마감 차단",
            score: 48,
            summary: "Execution Gate block 때문에 마감 전 승인 요청 재검토가 필요합니다.",
            handoffPrompt: "Execution Gate block 승인 요청을 원인과 재생성 기준으로 정리해줘"
          },
          nextActions: [{
            id: "review-risky-approvals",
            priority: "high",
            title: "오래된/위험 승인 먼저 검토",
            reason: "high risk 1건",
            prompt: "승인 대기 작업을 impact와 체크리스트 기준으로 우선순위 정리해줘",
            expectedOutcome: "승인 대기열을 위험도 기준으로 정리합니다."
          }]
        }),
        started_at: new Date().toISOString(),
        completed_at: new Date().toISOString()
      }],
      maybeSingle: {
        data: {
          id: "monitor-run",
          summary: JSON.stringify({
            generatedAt: new Date().toISOString(),
            severity: "critical",
            alerts: [{ type: "approval_gate_block", severity: "critical", message: "Execution Gate block 1건" }],
            approvalGateSummary: { passCount: 0, reviewCount: 0, blockCount: 1 },
            dailyCheckout: {
              status: "blocked",
              label: "마감 차단",
              score: 48,
              summary: "Execution Gate block 때문에 마감 전 승인 요청 재검토가 필요합니다.",
              handoffPrompt: "Execution Gate block 승인 요청을 원인과 재생성 기준으로 정리해줘"
            },
            nextActions: [{
              id: "review-risky-approvals",
              priority: "high",
              title: "오래된/위험 승인 먼저 검토",
              reason: "high risk 1건",
              prompt: "승인 대기 작업을 impact와 체크리스트 기준으로 우선순위 정리해줘",
              expectedOutcome: "승인 대기열을 위험도 기준으로 정리합니다."
            }]
          }),
          completed_at: new Date().toISOString()
        },
        error: null
      },
      error: null
    });
    tables.agent_approvals = chain({
      data: [{
        id: "approval-cache",
        action_type: "flush_match_cache",
        status: "pending",
        payload: {},
        created_at: new Date().toISOString()
      }],
      error: null
    });

    const result = await adminAgentTools.inspect_owner_brief.run(
      { hours: 24 },
      { supabase: mockSupabaseAdmin, userId: "admin-id" }
    );
    const parsed = JSON.parse(result.result);

    expect(result.status).toBe("success");
    expect(parsed.ownerBrief).toEqual(expect.objectContaining({
      status: "act_now",
      headline: expect.any(String),
      doNow: expect.objectContaining({ prompt: expect.any(String) }),
      needsOwnerReview: expect.any(Array)
    }));
    expect(parsed.growthRoadmap).toEqual(expect.objectContaining({
      primaryPrompt: expect.any(String)
    }));
    expect(parsed.recommendations.length).toBeGreaterThan(0);
    expect(tables.agent_approvals.insert).not.toHaveBeenCalled();
  });

  it("inspect_monitor_trend 도구는 monitor snapshot 추세를 read-only로 계산한다", async () => {
    tables.agent_runs = chain({
      data: [
        {
          summary: JSON.stringify({
            generatedAt: new Date().toISOString(),
            severity: "ok",
            alerts: [],
            approvalGateSummary: { passCount: 2, reviewCount: 0, blockCount: 0 },
            dailyCheckout: { status: "clear", label: "마감 가능", score: 92 }
          }),
          completed_at: new Date().toISOString()
        },
        {
          summary: JSON.stringify({
            generatedAt: new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString(),
            severity: "critical",
            alerts: [{ type: "api_errors", severity: "critical", message: "API error" }],
            approvalGateSummary: { passCount: 0, reviewCount: 0, blockCount: 1 },
            dailyCheckout: { status: "blocked", label: "마감 차단", score: 44 }
          }),
          completed_at: new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString()
        }
      ],
      error: null
    });

    const result = await adminAgentTools.inspect_monitor_trend.run(
      { limit: 7 },
      { supabase: mockSupabaseAdmin, userId: "admin-id" }
    );
    const parsed = JSON.parse(result.result);

    expect(result.status).toBe("success");
    expect(parsed.trend).toEqual(expect.objectContaining({
      direction: "improving",
      label: "개선 중",
      sampleSize: 2,
      recommendation: expect.any(String)
    }));
    expect(parsed.trend.deltas).toEqual(expect.objectContaining({
      alertCount: -1,
      gateBlockCount: -1
    }));
    expect(tables.agent_approvals.insert).not.toHaveBeenCalled();
  });

  it("inspect_automation_contract 도구는 자동화 경계를 read-only로 설명한다", async () => {
    tables.agent_runs = chain({
      maybeSingle: {
        data: {
          summary: JSON.stringify({
            generatedAt: new Date().toISOString(),
            severity: "warn",
            alerts: [{ type: "pending_approvals", severity: "warn", message: "승인 대기" }]
          }),
          completed_at: new Date().toISOString()
        },
        error: null
      },
      data: [],
      error: null
    });

    const result = await adminAgentTools.inspect_automation_contract.run(
      { includeContracts: true },
      { supabase: mockSupabaseAdmin, userId: "admin-id" }
    );
    const parsed = JSON.parse(result.result);

    expect(result.status).toBe("success");
    expect(parsed.freePlanMode).toBe(true);
    expect(parsed.summary).toContain("자동 실행");
    expect(parsed.guardrails).toEqual(expect.arrayContaining([
      expect.stringContaining("Vercel cron")
    ]));
    expect(parsed.contracts).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: "monitor-snapshot", risk: "safe" }),
      expect.objectContaining({ id: "approval-impact", risk: "approval_required" }),
      expect.objectContaining({ id: "github-heavy-work", status: "external" })
    ]));
    expect(tables.agent_approvals.insert).not.toHaveBeenCalled();
  });

  it("inspect_capability_matrix 도구는 현재 에이전트 능력을 read-only로 점검한다", async () => {
    tables.agent_runs = chain({
      maybeSingle: {
        data: {
          id: "monitor-run",
          summary: JSON.stringify({
            generatedAt: new Date().toISOString(),
            severity: "warn",
            alerts: [{ type: "pending_approvals", severity: "warn", message: "승인 대기" }],
            approvalGateSummary: { passCount: 1, reviewCount: 0, blockCount: 0 },
            dailyCheckout: {
              status: "attention",
              label: "관찰 필요",
              score: 72,
              summary: "승인 대기열 확인 필요",
              openRisks: ["승인 대기"],
              tomorrowFocus: ["승인 정리"],
              handoffPrompt: "승인 대기 작업을 정리해줘"
            },
            nextActions: []
          }),
          completed_at: new Date().toISOString()
        },
        error: null
      },
      data: [],
      count: 0,
      error: null
    });

    const result = await adminAgentTools.inspect_capability_matrix.run(
      { includeDetails: false },
      { supabase: mockSupabaseAdmin, userId: "admin-id" }
    );
    const parsed = JSON.parse(result.result);

    expect(result.status).toBe("success");
    expect(parsed).toEqual(expect.objectContaining({
      score: expect.any(Number),
      label: expect.any(String),
      summary: expect.any(String),
      items: expect.arrayContaining([
        expect.objectContaining({ id: "observe", label: "운영 관찰" }),
        expect.objectContaining({ id: "approve", label: "승인 기반 실행" }),
        expect.objectContaining({ id: "free_plan", label: "무료 플랜 보호" })
      ]),
      recommendations: expect.any(Array)
    }));
    expect(tables.agent_approvals.insert).not.toHaveBeenCalled();
  });

  it("inspect_growth_roadmap 도구는 다음 업그레이드 로드맵을 read-only로 생성한다", async () => {
    tables.agent_runs = chain({
      maybeSingle: {
        data: {
          id: "monitor-run",
          summary: JSON.stringify({
            generatedAt: new Date().toISOString(),
            severity: "warn",
            alerts: [{ type: "pending_approvals", severity: "warn", message: "승인 대기" }],
            approvalGateSummary: { passCount: 1, reviewCount: 0, blockCount: 0 },
            dailyCheckout: {
              status: "attention",
              label: "관찰 필요",
              score: 72,
              summary: "승인 대기열 확인 필요",
              openRisks: ["승인 대기"],
              tomorrowFocus: ["승인 정리"],
              handoffPrompt: "승인 대기 작업을 정리해줘"
            },
            nextActions: [{
              id: "review-risky-approvals",
              priority: "high",
              title: "승인 대기 정리",
              reason: "승인 대기열 확인 필요",
              prompt: "승인 대기 작업을 impact 기준으로 검토해줘",
              expectedOutcome: "승인 리스크를 줄입니다."
            }]
          }),
          completed_at: new Date().toISOString()
        },
        error: null
      },
      data: [],
      count: 0,
      error: null
    });

    const result = await adminAgentTools.inspect_growth_roadmap.run(
      { hours: 24 },
      { supabase: mockSupabaseAdmin, userId: "admin-id" }
    );
    const parsed = JSON.parse(result.result);

    expect(result.status).toBe("success");
    expect(parsed.roadmap).toEqual(expect.objectContaining({
      status: expect.any(String),
      summary: expect.any(String),
      primaryPrompt: expect.any(String),
      lanes: expect.objectContaining({
        now: expect.any(Array),
        thisWeek: expect.any(Array),
        later: expect.any(Array)
      })
    }));
    expect(parsed.capability.score).toEqual(expect.any(Number));
    expect(parsed.operatorValue.score).toEqual(expect.any(Number));
    expect(parsed.recommendations.length).toBeGreaterThan(0);
    expect(tables.agent_approvals.insert).not.toHaveBeenCalled();
  });

  it("inspect_today_action_board 도구는 오늘 액션 보드를 read-only로 생성한다", async () => {
    tables.agent_runs = chain({
      maybeSingle: {
        data: {
          id: "monitor-run",
          summary: JSON.stringify({
            generatedAt: new Date().toISOString(),
            severity: "warn",
            approvalGateSummary: { passCount: 1, reviewCount: 0, blockCount: 0 },
            dailyCheckout: {
              status: "attention",
              label: "관찰 필요",
              score: 72,
              summary: "승인 대기열 확인 필요",
              openRisks: ["승인 대기"],
              tomorrowFocus: ["승인 정리"],
              handoffPrompt: "승인 대기 작업을 정리해줘"
            },
            nextActions: [{
              id: "review-risky-approvals",
              priority: "high",
              category: "approval",
              urgencyScore: 91,
              title: "승인 대기 정리",
              reason: "승인 대기열 확인 필요",
              prompt: "승인 대기 작업을 impact 기준으로 검토해줘",
              expectedOutcome: "승인 리스크를 줄입니다.",
              checklist: ["impact 확인"]
            }]
          }),
          completed_at: new Date().toISOString()
        },
        error: null
      },
      data: [],
      count: 0,
      error: null
    });

    const result = await adminAgentTools.inspect_today_action_board.run(
      { includeChecklist: false },
      { supabase: mockSupabaseAdmin, userId: "admin-id" }
    );
    const parsed = JSON.parse(result.result);

    expect(result.status).toBe("success");
    expect(parsed.board).toEqual(expect.objectContaining({
      status: "attention",
      summary: expect.any(String),
      primaryPrompt: expect.any(String),
      lanes: expect.objectContaining({
        doNow: expect.any(Array),
        review: expect.any(Array),
        watch: expect.any(Array),
        save: expect.any(Array)
      })
    }));
    expect(parsed.counts).toEqual(expect.objectContaining({
      doNow: expect.any(Number),
      review: expect.any(Number)
    }));
    expect(parsed.recommendations.length).toBeGreaterThan(0);
    expect(tables.agent_approvals.insert).not.toHaveBeenCalled();
  });

  it("inspect_daily_checkout 도구는 마감 상태와 남은 위험을 read-only로 계산한다", async () => {
    tables.agent_runs = chain({
      maybeSingle: {
        data: {
          id: "monitor-run",
          summary: JSON.stringify({
            generatedAt: new Date().toISOString(),
            severity: "warn",
            dailyCheckout: {
              status: "attention",
              label: "주의 후 마감",
              score: 72,
              summary: "승인 대기열 확인 필요",
              completedSignals: ["PUBG API 에러 없음"],
              openRisks: ["승인 대기"],
              tomorrowFocus: ["승인 정리"],
              handoffPrompt: "승인 대기 작업을 정리해줘"
            }
          }),
          completed_at: new Date().toISOString()
        },
        error: null
      },
      data: [],
      count: 0,
      error: null
    });

    const result = await adminAgentTools.inspect_daily_checkout.run(
      { hours: 24 },
      { supabase: mockSupabaseAdmin, userId: "admin-id" }
    );
    const parsed = JSON.parse(result.result);

    expect(result.status).toBe("success");
    expect(parsed.checkout).toEqual(expect.objectContaining({
      status: "attention",
      label: "주의 후 마감",
      score: 72,
      openRisks: expect.arrayContaining(["승인 대기"]),
      handoffPrompt: expect.any(String)
    }));
    expect(parsed.source).toBe("latest-monitor-snapshot");
    expect(parsed.recommendations.length).toBeGreaterThan(0);
    expect(tables.agent_approvals.insert).not.toHaveBeenCalled();
  });

  it("inspect_operating_sop 도구는 현재 운영 절차를 read-only로 계산한다", async () => {
    tables.agent_runs = chain({
      maybeSingle: {
        data: {
          id: "monitor-run",
          summary: JSON.stringify({
            generatedAt: new Date().toISOString(),
            severity: "warn",
            dailyCheckout: {
              status: "attention",
              label: "주의 후 마감",
              score: 72,
              summary: "승인 대기열 확인 필요",
              completedSignals: ["PUBG API 에러 없음"],
              openRisks: ["승인 대기"],
              tomorrowFocus: ["승인 정리"],
              handoffPrompt: "승인 대기 작업을 정리해줘"
            },
            nextActions: [{
              id: "approval-review",
              priority: "medium",
              title: "승인 검토",
              reason: "대기열 확인 필요",
              prompt: "승인 대기 작업을 impact 기준으로 검토해줘",
              expectedOutcome: "위험 요청 정리"
            }]
          }),
          completed_at: new Date().toISOString()
        },
        error: null
      },
      data: [],
      count: 0,
      error: null
    });

    const result = await adminAgentTools.inspect_operating_sop.run(
      { hours: 24 },
      { supabase: mockSupabaseAdmin, userId: "admin-id" }
    );
    const parsed = JSON.parse(result.result);

    expect(result.status).toBe("success");
    expect(parsed.sop).toEqual(expect.objectContaining({
      status: expect.any(String),
      title: expect.any(String),
      primaryPrompt: expect.any(String),
      procedures: expect.any(Array)
    }));
    expect(parsed.sop.procedures[0]).toEqual(expect.objectContaining({
      title: expect.any(String),
      steps: expect.any(Array),
      doneWhen: expect.any(Array),
      nextPrompt: expect.any(String)
    }));
    expect(parsed.signals).toEqual(expect.objectContaining({
      pendingApprovals: expect.any(Number),
      gateBlockCount: expect.any(Number)
    }));
    expect(parsed.recommendations.length).toBeGreaterThan(0);
    expect(tables.agent_approvals.insert).not.toHaveBeenCalled();
  });

  it("inspect_risk_radar 도구는 다음 운영 위험을 read-only로 예측한다", async () => {
    tables.agent_runs = chain({
      maybeSingle: {
        data: {
          id: "monitor-run",
          summary: JSON.stringify({
            generatedAt: new Date().toISOString(),
            severity: "warn",
            dailyCheckout: {
              status: "attention",
              label: "주의 후 마감",
              score: 72,
              summary: "승인 대기열 확인 필요",
              openRisks: ["승인 대기"],
              tomorrowFocus: ["승인 정리"],
              handoffPrompt: "승인 대기 작업을 정리해줘"
            }
          }),
          completed_at: new Date().toISOString()
        },
        error: null
      },
      data: [],
      count: 0,
      error: null
    });

    const result = await adminAgentTools.inspect_risk_radar.run(
      { hours: 24 },
      { supabase: mockSupabaseAdmin, userId: "admin-id" }
    );
    const parsed = JSON.parse(result.result);

    expect(result.status).toBe("success");
    expect(parsed.radar).toEqual(expect.objectContaining({
      status: expect.any(String),
      score: expect.any(Number),
      summary: expect.any(String),
      primaryPrompt: expect.any(String),
      items: expect.any(Array)
    }));
    expect(parsed.radar.items[0]).toEqual(expect.objectContaining({
      category: expect.any(String),
      severity: expect.any(String),
      score: expect.any(Number),
      prevention: expect.any(String),
      prompt: expect.any(String)
    }));
    expect(parsed.signals).toEqual(expect.objectContaining({
      pendingApprovals: expect.any(Number),
      gateBlockCount: expect.any(Number)
    }));
    expect(parsed.recommendations.length).toBeGreaterThan(0);
    expect(tables.agent_approvals.insert).not.toHaveBeenCalled();
  });

  it("inspect_decision_trace 도구는 판단 근거와 불확실성을 read-only로 추적한다", async () => {
    tables.agent_runs = chain({
      maybeSingle: {
        data: {
          id: "monitor-run",
          summary: JSON.stringify({
            generatedAt: new Date().toISOString(),
            severity: "warn",
            dailyCheckout: {
              status: "attention",
              label: "주의 후 마감",
              score: 72,
              summary: "승인 대기열 확인 필요",
              openRisks: ["승인 대기"],
              tomorrowFocus: ["승인 정리"],
              handoffPrompt: "승인 대기 작업을 정리해줘"
            }
          }),
          completed_at: new Date().toISOString()
        },
        error: null
      },
      data: [],
      count: 0,
      error: null
    });

    const result = await adminAgentTools.inspect_decision_trace.run(
      { hours: 24 },
      { supabase: mockSupabaseAdmin, userId: "admin-id" }
    );
    const parsed = JSON.parse(result.result);

    expect(result.status).toBe("success");
    expect(parsed.trace).toEqual(expect.objectContaining({
      confidence: expect.any(String),
      summary: expect.any(String),
      observations: expect.any(Array),
      decisions: expect.any(Array),
      blindSpots: expect.any(Array),
      verifyNext: expect.any(Array)
    }));
    expect(parsed.trace.observations).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: "severity" }),
      expect.objectContaining({ id: "approvals" })
    ]));
    expect(parsed.trace.decisions[0]).toEqual(expect.objectContaining({
      title: expect.any(String),
      basedOn: expect.any(Array),
      prompt: expect.any(String)
    }));
    expect(parsed.recommendations.length).toBeGreaterThan(0);
    expect(tables.agent_approvals.insert).not.toHaveBeenCalled();
  });

  it("inspect_safety_audit 도구는 안전 경계를 read-only로 감사한다", async () => {
    tables.agent_runs = chain({
      maybeSingle: {
        data: {
          id: "monitor-run",
          summary: JSON.stringify({
            generatedAt: new Date().toISOString(),
            severity: "warn",
            dailyCheckout: {
              status: "attention",
              label: "주의 후 마감",
              score: 72,
              summary: "승인 대기열 확인 필요",
              openRisks: ["승인 대기"],
              tomorrowFocus: ["승인 정리"],
              handoffPrompt: "승인 대기 작업을 정리해줘"
            }
          }),
          completed_at: new Date().toISOString()
        },
        error: null
      },
      data: [],
      count: 0,
      error: null
    });

    const result = await adminAgentTools.inspect_safety_audit.run(
      { hours: 24 },
      { supabase: mockSupabaseAdmin, userId: "admin-id" }
    );
    const parsed = JSON.parse(result.result);

    expect(result.status).toBe("success");
    expect(parsed.audit).toEqual(expect.objectContaining({
      status: expect.any(String),
      score: expect.any(Number),
      summary: expect.any(String),
      invariants: expect.any(Array),
      requiredFixes: expect.any(Array),
      recommendedChecks: expect.any(Array),
      primaryPrompt: expect.any(String)
    }));
    expect(parsed.audit.invariants).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: "dangerous-tools-approval" }),
      expect.objectContaining({ id: "execution-gate" }),
      expect.objectContaining({ id: "log-redaction" }),
      expect.objectContaining({ id: "free-plan-guardrail" })
    ]));
    expect(parsed.recommendations.length).toBeGreaterThan(0);
    expect(tables.agent_approvals.insert).not.toHaveBeenCalled();
  });

  it("inspect_approval_advisor 도구는 승인 대기 요청을 read-only로 권고 분류한다", async () => {
    tables.agent_approvals = chain({
      data: [{
        id: "approval-1",
        action_type: "flush_match_cache",
        status: "pending",
        payload: {},
        created_at: new Date().toISOString()
      }],
      count: 1,
      error: null
    });
    tables.agent_runs = chain({
      maybeSingle: {
        data: {
          id: "monitor-run",
          summary: JSON.stringify({
            generatedAt: new Date().toISOString(),
            severity: "warn",
            dailyCheckout: {
              status: "attention",
              label: "주의 후 마감",
              score: 72,
              summary: "승인 대기열 확인 필요",
              openRisks: ["승인 대기"],
              tomorrowFocus: ["승인 정리"],
              handoffPrompt: "승인 대기 작업을 정리해줘"
            }
          }),
          completed_at: new Date().toISOString()
        },
        error: null
      },
      data: [],
      count: 0,
      error: null
    });

    const result = await adminAgentTools.inspect_approval_advisor.run(
      { hours: 24 },
      { supabase: mockSupabaseAdmin, userId: "admin-id" }
    );
    const parsed = JSON.parse(result.result);

    expect(result.status).toBe("success");
    expect(parsed.advisor).toEqual(expect.objectContaining({
      status: expect.any(String),
      summary: expect.any(String),
      counts: expect.objectContaining({
        approve: expect.any(Number),
        defer: expect.any(Number),
        reject: expect.any(Number)
      }),
      items: expect.arrayContaining([
        expect.objectContaining({
          id: "approval-1",
          decision: expect.any(String),
          reason: expect.any(String),
          checklist: expect.any(Array),
          prompt: expect.any(String)
        })
      ]),
      primaryPrompt: expect.any(String)
    }));
    expect(parsed.signals).toEqual(expect.objectContaining({
      pendingApprovals: expect.any(Number),
      gateBlockCount: expect.any(Number),
      safetyStatus: expect.any(String),
      riskStatus: expect.any(String)
    }));
    expect(parsed.recommendations.length).toBeGreaterThan(0);
    expect(tables.agent_approvals.insert).not.toHaveBeenCalled();
  });

  it("inspect_mission_control 도구는 현재 운영 실행 순서를 read-only로 정리한다", async () => {
    tables.agent_approvals = chain({
      data: [{
        id: "approval-1",
        action_type: "flush_match_cache",
        status: "pending",
        payload: {},
        created_at: new Date().toISOString()
      }],
      count: 1,
      error: null
    });
    tables.agent_runs = chain({
      maybeSingle: {
        data: {
          id: "monitor-run",
          summary: JSON.stringify({
            generatedAt: new Date().toISOString(),
            severity: "warn",
            nextActions: [{
              id: "diagnose-api",
              title: "PUBG API 에러 확인",
              priority: "high",
              category: "stability",
              reason: "에러 증가",
              prompt: "최근 PUBG API 에러 원인을 분석해줘",
              expectedOutcome: "에러 원인을 확인합니다.",
              checklist: ["429 여부 확인"],
              urgencyScore: 90
            }],
            dailyCheckout: {
              status: "attention",
              label: "주의 후 마감",
              score: 72,
              summary: "승인 대기열 확인 필요",
              openRisks: ["승인 대기"],
              tomorrowFocus: ["승인 정리"],
              handoffPrompt: "승인 대기 작업을 정리해줘"
            }
          }),
          completed_at: new Date().toISOString()
        },
        error: null
      },
      data: [],
      count: 0,
      error: null
    });

    const result = await adminAgentTools.inspect_mission_control.run(
      { hours: 24 },
      { supabase: mockSupabaseAdmin, userId: "admin-id" }
    );
    const parsed = JSON.parse(result.result);

    expect(result.status).toBe("success");
    expect(parsed.mission).toEqual(expect.objectContaining({
      status: expect.any(String),
      summary: expect.any(String),
      firstCommand: expect.any(String),
      phases: expect.objectContaining({
        stabilize: expect.any(Number),
        decide: expect.any(Number),
        delegate: expect.any(Number),
        verify: expect.any(Number),
        record: expect.any(Number)
      }),
      items: expect.arrayContaining([
        expect.objectContaining({
          phase: expect.any(String),
          priority: expect.any(String),
          command: expect.any(String),
          guardrail: expect.any(String)
        })
      ])
    }));
    expect(parsed.recommendations.length).toBeGreaterThan(0);
    expect(tables.agent_approvals.insert).not.toHaveBeenCalled();
  });

  it("inspect_owner_inbox 도구는 운영자 직접 확인/승인/위임/관찰 항목을 read-only로 분류한다", async () => {
    tables.agent_approvals = chain({
      data: [{
        id: "approval-1",
        action_type: "flush_match_cache",
        status: "pending",
        payload: {},
        created_at: new Date().toISOString()
      }],
      count: 1,
      error: null
    });
    tables.agent_runs = chain({
      maybeSingle: {
        data: {
          id: "monitor-run",
          summary: JSON.stringify({
            generatedAt: new Date().toISOString(),
            severity: "warn",
            dailyCheckout: {
              status: "attention",
              label: "주의 후 마감",
              score: 72,
              summary: "승인 대기열 확인 필요",
              openRisks: ["승인 대기"],
              tomorrowFocus: ["승인 정리"],
              handoffPrompt: "승인 대기 작업을 정리해줘"
            }
          }),
          completed_at: new Date().toISOString()
        },
        error: null
      },
      data: [],
      count: 0,
      error: null
    });

    const result = await adminAgentTools.inspect_owner_inbox.run(
      { hours: 24 },
      { supabase: mockSupabaseAdmin, userId: "admin-id" }
    );
    const parsed = JSON.parse(result.result);

    expect(result.status).toBe("success");
    expect(parsed.inbox).toEqual(expect.objectContaining({
      status: expect.any(String),
      summary: expect.any(String),
      primaryAction: expect.any(String),
      counts: expect.objectContaining({
        decide: expect.any(Number),
        approve: expect.any(Number),
        delegate: expect.any(Number),
        watch: expect.any(Number)
      }),
      lanes: expect.objectContaining({
        decide: expect.any(Array),
        approve: expect.any(Array),
        delegate: expect.any(Array),
        watch: expect.any(Array)
      })
    }));
    expect(parsed.recommendations.length).toBeGreaterThan(0);
    expect(tables.agent_approvals.insert).not.toHaveBeenCalled();
  });

  it("inspect_outcome_review 도구는 최근 조치 효과와 후속 조치를 read-only로 검토한다", async () => {
    tables.agent_approvals = chain({
      data: [{
        id: "approval-1",
        action_type: "flush_match_cache",
        status: "pending",
        payload: {},
        created_at: new Date().toISOString()
      }],
      count: 1,
      error: null
    });
    tables.agent_runs = chain({
      maybeSingle: {
        data: {
          id: "monitor-run",
          summary: JSON.stringify({
            generatedAt: new Date().toISOString(),
            severity: "warn",
            dailyCheckout: {
              status: "attention",
              label: "주의 후 마감",
              score: 72,
              summary: "승인 대기열 확인 필요",
              openRisks: ["승인 대기"],
              tomorrowFocus: ["승인 정리"],
              handoffPrompt: "승인 대기 작업을 정리해줘"
            }
          }),
          completed_at: new Date().toISOString()
        },
        error: null
      },
      data: [],
      count: 0,
      error: null
    });

    const result = await adminAgentTools.inspect_outcome_review.run(
      { hours: 24 },
      { supabase: mockSupabaseAdmin, userId: "admin-id" }
    );
    const parsed = JSON.parse(result.result);

    expect(result.status).toBe("success");
    expect(parsed.review).toEqual(expect.objectContaining({
      status: expect.any(String),
      score: expect.any(Number),
      summary: expect.any(String),
      primaryPrompt: expect.any(String),
      items: expect.arrayContaining([
        expect.objectContaining({
          status: expect.any(String),
          priority: expect.any(String),
          evidence: expect.any(String),
          nextCheck: expect.any(String),
          prompt: expect.any(String)
        })
      ])
    }));
    expect(parsed.recommendations.length).toBeGreaterThan(0);
    expect(tables.agent_approvals.insert).not.toHaveBeenCalled();
  });

  it("inspect_operator_coach 도구는 지금 물어볼 다음 질문을 read-only로 추천한다", async () => {
    tables.agent_approvals = chain({
      data: [{
        id: "approval-1",
        action_type: "flush_match_cache",
        status: "pending",
        payload: {},
        created_at: new Date().toISOString()
      }],
      count: 1,
      error: null
    });
    tables.agent_runs = chain({
      maybeSingle: {
        data: {
          id: "monitor-run",
          summary: JSON.stringify({
            generatedAt: new Date().toISOString(),
            severity: "warn",
            dailyCheckout: {
              status: "attention",
              label: "주의 후 마감",
              score: 72,
              summary: "승인 대기열 확인 필요",
              openRisks: ["승인 대기"],
              tomorrowFocus: ["승인 정리"],
              handoffPrompt: "승인 대기 작업을 정리해줘"
            }
          }),
          completed_at: new Date().toISOString()
        },
        error: null
      },
      data: [],
      count: 0,
      error: null
    });

    const result = await adminAgentTools.inspect_operator_coach.run(
      { hours: 24 },
      { supabase: mockSupabaseAdmin, userId: "admin-id" }
    );
    const parsed = JSON.parse(result.result);

    expect(result.status).toBe("success");
    expect(parsed.coach).toEqual(expect.objectContaining({
      mode: expect.any(String),
      summary: expect.any(String),
      topPrompt: expect.any(String),
      items: expect.arrayContaining([
        expect.objectContaining({
          priority: expect.any(String),
          title: expect.any(String),
          prompt: expect.any(String),
          expectedValue: expect.any(String)
        })
      ])
    }));
    expect(parsed.recommendations.length).toBeGreaterThan(0);
    expect(tables.agent_approvals.insert).not.toHaveBeenCalled();
  });

  it("inspect_launch_kit 도구는 운영자가 오늘부터 쓰는 루틴과 guardrail을 read-only로 정리한다", async () => {
    tables.agent_approvals = chain({
      data: [{
        id: "approval-1",
        action_type: "create_board_post",
        status: "pending",
        payload: { title: "공지" },
        created_at: new Date().toISOString()
      }],
      count: 1,
      error: null
    });
    tables.agent_runs = chain({
      maybeSingle: {
        data: {
          id: "monitor-run",
          summary: JSON.stringify({
            generatedAt: new Date().toISOString(),
            severity: "warn",
            dailyCheckout: {
              status: "attention",
              label: "주의 후 마감",
              score: 74,
              summary: "승인 영향 범위 확인 필요",
              openRisks: ["승인 대기"],
              tomorrowFocus: ["승인 결과 확인"],
              handoffPrompt: "승인 대기 작업을 정리해줘"
            }
          }),
          completed_at: new Date().toISOString()
        },
        error: null
      },
      data: [],
      count: 0,
      error: null
    });

    const result = await adminAgentTools.inspect_launch_kit.run(
      { hours: 24 },
      { supabase: mockSupabaseAdmin, userId: "admin-id" }
    );
    const parsed = JSON.parse(result.result);

    expect(result.status).toBe("success");
    expect(parsed.launchKit).toEqual(expect.objectContaining({
      status: expect.any(String),
      summary: expect.any(String),
      firstPrompt: expect.any(String),
      routines: expect.arrayContaining([
        expect.objectContaining({
          id: "daily-ops",
          cadence: "daily",
          steps: expect.arrayContaining([
            expect.objectContaining({
              label: expect.any(String),
              location: expect.any(String),
              guardrail: expect.any(String)
            })
          ])
        }),
        expect.objectContaining({ id: "approval-review", cadence: "approval" })
      ]),
      guardrails: expect.arrayContaining([
        expect.stringContaining("승인")
      ]),
      successSignals: expect.any(Array)
    }));
    expect(parsed.recommendations.length).toBeGreaterThan(0);
    expect(tables.agent_approvals.insert).not.toHaveBeenCalled();
  });

  it("inspect_final_readiness 도구는 최종형 에이전트 완성도와 남은 일을 read-only로 점검한다", async () => {
    tables.agent_approvals = chain({
      data: [{
        id: "approval-1",
        action_type: "flush_old_cache",
        status: "pending",
        payload: { cleanupType: "flush_old_cache" },
        created_at: new Date().toISOString()
      }],
      count: 1,
      error: null
    });
    tables.agent_runs = chain({
      maybeSingle: {
        data: {
          id: "monitor-run",
          summary: JSON.stringify({
            generatedAt: new Date().toISOString(),
            severity: "warn",
            dailyCheckout: {
              status: "attention",
              label: "주의 후 마감",
              score: 78,
              summary: "최종 readiness 증거 확인 필요",
              openRisks: ["승인 대기"],
              tomorrowFocus: ["결과 검증"],
              handoffPrompt: "Final Readiness로 남은 일을 점검해줘"
            }
          }),
          completed_at: new Date().toISOString()
        },
        error: null
      },
      data: [],
      count: 0,
      error: null
    });

    const result = await adminAgentTools.inspect_final_readiness.run(
      { hours: 24 },
      { supabase: mockSupabaseAdmin, userId: "admin-id" }
    );
    const parsed = JSON.parse(result.result);

    expect(result.status).toBe("success");
    expect(parsed.finalReadiness).toEqual(expect.objectContaining({
      status: expect.any(String),
      score: expect.any(Number),
      summary: expect.any(String),
      items: expect.arrayContaining([
        expect.objectContaining({
          id: "security",
          title: expect.any(String),
          status: expect.any(String),
          proof: expect.any(Array),
          gap: expect.any(String),
          prompt: expect.any(String)
        }),
        expect.objectContaining({ id: "approval" }),
        expect.objectContaining({ id: "usability" })
      ]),
      remainingWork: expect.any(Array),
      proofPrompts: expect.any(Array)
    }));
    expect(parsed.recommendations.length).toBeGreaterThan(0);
    expect(tables.agent_approvals.insert).not.toHaveBeenCalled();
  });

  it("GET /briefing은 운영 지표와 텍스트 리포트를 반환한다", async () => {
    mockAdminAuth();

    const response = await briefingGET(new Request("http://localhost/api/admin/agent/briefing?hours=24"));
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.briefing.metrics.pendingApprovals).toBe(1);
    expect(body.briefing.metrics.apiErrors).toBe(1);
    expect(body.text).toContain("BGMS 운영 브리핑");
    expect(body.text).toContain("승인 대기");
  });

  it("POST /briefing은 report 저장 승인 요청을 생성한다", async () => {
    mockAdminAuth();

    const response = await briefingPOST(new Request("http://localhost/api/admin/agent/briefing", {
      method: "POST",
      body: JSON.stringify({ title: "테스트 운영 브리핑", reason: "정기 기록" })
    }));
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.approvalId).toBe("approval-1");
    expect(tables.agent_approvals.insert).toHaveBeenCalledWith(expect.objectContaining({
      action_type: "save_agent_report",
      payload: expect.objectContaining({
        title: "테스트 운영 브리핑",
        category: "report"
      })
    }));
  });

  it("POST /briefing은 수동 monitor snapshot을 report 저장 승인 요청으로 변환한다", async () => {
    mockAdminAuth();

    const response = await briefingPOST(new Request("http://localhost/api/admin/agent/briefing", {
      method: "POST",
      body: JSON.stringify({
        title: "수동 점검 리포트",
        snapshot: {
          generatedAt: "2026-06-10T00:00:00.000Z",
          windowHours: 24,
          severity: "warn",
          alerts: [{ type: "pending_approvals", severity: "warn", message: "승인 대기 1건" }],
          recommendations: ["승인 패널에서 확인하세요."],
          approvalGateSummary: { passCount: 0, reviewCount: 1, blockCount: 1 },
          dailyCheckout: {
            status: "blocked",
            label: "마감 차단",
            score: 52,
            summary: "Execution Gate block 때문에 마감 전 조치가 필요합니다."
          },
          nextActions: [{
            id: "review-risky-approvals",
            title: "오래된/위험 승인 먼저 검토",
            priority: "high",
            urgencyScore: 85
          }]
        }
      })
    }));
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.approvalId).toBe("approval-1");
    expect(body.text).toContain("BGMS 수동 운영 점검");
    expect(body.text).toContain("승인 대기 1건");
    expect(body.text).toContain("Execution Gate: pass/review/block 0/1/1");
    expect(body.text).toContain("Daily Checkout: 마감 차단 (52/100)");
    expect(body.text).toContain("Top Action: 오래된/위험 승인 먼저 검토");
    expect(tables.agent_approvals.insert).toHaveBeenCalledWith(expect.objectContaining({
      action_type: "save_agent_report",
      payload: expect.objectContaining({
        title: "수동 점검 리포트",
        metadata: expect.objectContaining({
          source: "manual-monitor-snapshot",
          snapshot: expect.objectContaining({
            severity: "warn",
            approvalGateSummary: expect.objectContaining({ blockCount: 1 }),
            dailyCheckout: expect.objectContaining({ status: "blocked" })
          })
        })
      })
    }));
  });

  it("GET /memories는 active memory만 반환한다", async () => {
    tables.agent_memories = chain({
      data: [
        { id: "active", category: "incident", title: "active", body: "ok", metadata: { active: true }, updated_at: "now" },
        { id: "inactive", category: "incident", title: "inactive", body: "hidden", metadata: { active: false }, updated_at: "now" }
      ],
      error: null
    });
    mockAdminAuth();

    const response = await memoriesGET(new Request("http://localhost/api/admin/agent/memories"));
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.memories).toHaveLength(1);
    expect(body.memories[0].id).toBe("active");
    expect(body.summary).toEqual(expect.objectContaining({
      total: 2,
      active: 1,
      inactive: 1,
      byCategory: { incident: 2 },
      latestUpdatedAt: "now"
    }));
  });

  it("GET /memories는 검색어, 카테고리, inactive 포함 필터를 지원한다", async () => {
    tables.agent_memories = chain({
      data: [
        { id: "pubg", category: "incident", title: "PUBG 429 대응", body: "캐시 우선", metadata: { active: true, tags: ["quota"] }, updated_at: "now" },
        { id: "policy", category: "policy", title: "캐시 정책", body: "오래된 캐시만 삭제", metadata: { active: true }, updated_at: "now" },
        { id: "inactive", category: "incident", title: "비활성 기록", body: "PUBG 예전 정책", metadata: { active: false }, updated_at: "now" }
      ],
      error: null
    });
    mockAdminAuth();

    const response = await memoriesGET(new Request("http://localhost/api/admin/agent/memories?category=incident&q=pubg&includeInactive=true"));
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(tables.agent_memories.eq).toHaveBeenCalledWith("category", "incident");
    expect(body.memories.map((memory: any) => memory.id)).toEqual(["pubg", "inactive"]);
    expect(body.filters).toEqual(expect.objectContaining({
      category: "incident",
      q: "pubg",
      includeInactive: true
    }));
    expect(body.facets.incident).toBe(2);
    expect(body.summary).toEqual(expect.objectContaining({
      total: 3,
      active: 2,
      inactive: 1,
      byCategory: {
        incident: 2,
        policy: 1
      }
    }));
  });

  it("POST /memories는 직접 저장하지 않고 승인 요청을 생성한다", async () => {
    mockAdminAuth();

    const response = await memoriesPOST(new Request("http://localhost/api/admin/agent/memories", {
      method: "POST",
      body: JSON.stringify({
        category: "policy",
        title: "캐시 삭제 정책",
        body: "전체 삭제보다 오래된 캐시만 정리한다.",
        metadata: { tags: ["cache"] }
      })
    }));
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.approvalId).toBe("approval-1");
    expect(tables.agent_approvals.insert).toHaveBeenCalledWith(expect.objectContaining({
      action_type: "save_agent_memory",
      payload: expect.objectContaining({
        category: "policy",
        title: "캐시 삭제 정책"
      })
    }));
  });

  it("POST /memories/:id/deactivate는 memory를 soft deactivate 한다", async () => {
    mockAdminAuth();

    const response = await memoryDeactivatePOST(
      new Request("http://localhost/api/admin/agent/memories/memory-1/deactivate", { method: "POST" }),
      { params: Promise.resolve({ id: "memory-1" }) }
    );
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.success).toBe(true);
    expect(tables.agent_memories.update).toHaveBeenCalledWith(expect.objectContaining({
      metadata: expect.objectContaining({ active: false, deactivatedBy: "admin-id" })
    }));
  });

  it("GET /approvals는 approval queue priority와 age metadata를 포함한다", async () => {
    tables.agent_approvals = chain({
      data: [{
        id: "approval-cache",
        tool_name: "request_cache_cleanup",
        action_type: "flush_old_cache",
        status: "pending",
        payload: { olderThanDays: 14 },
        created_at: new Date(Date.now() - 25 * 60 * 60 * 1000).toISOString()
      }],
      error: null
    });
    mockAdminAuth();

    const response = await approvalsGET();
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.summary).toEqual(expect.objectContaining({
      count: 1,
      highRiskCount: 1,
      staleCount: 1
    }));
    expect(body.approvals[0].queue.priority).toBe("high");
    expect(body.approvals[0].queue.isStale).toBe(true);
    expect(body.approvals[0].impact.risk).toBe("high");
    expect(body.approvals[0].impact.preview).toEqual(expect.objectContaining({
      headline: "오래된 분석 캐시 삭제 미리보기",
      items: expect.arrayContaining([
        expect.objectContaining({ label: "대상", value: "processed_match_telemetry" }),
        expect.objectContaining({ label: "예상 row", value: "0개" })
      ])
    }));
    expect(body.approvals[0].impact.checklist).toEqual(expect.arrayContaining([
      expect.objectContaining({ label: "대상 확인" }),
      expect.objectContaining({ label: "영향 범위" })
    ]));
  });

  it("approval stale 기준은 ADMIN_AGENT_APPROVAL_STALE_HOURS로 조정된다", async () => {
    process.env.ADMIN_AGENT_APPROVAL_STALE_HOURS = "48";
    tables.agent_approvals = chain({
      data: [{
        id: "approval-cache",
        tool_name: "request_cache_cleanup",
        action_type: "flush_old_cache",
        status: "pending",
        payload: { olderThanDays: 14 },
        created_at: new Date(Date.now() - 25 * 60 * 60 * 1000).toISOString()
      }],
      error: null
    });
    mockAdminAuth();

    const response = await approvalsGET();
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.approvals[0].queue.priority).toBe("high");
    expect(body.approvals[0].queue.isStale).toBe(false);
  });

  it("GET /approvals는 게시글 발행 승인에 초안 대비 diff preview를 포함한다", async () => {
    tables.agent_approvals = chain({
      data: [{
        id: "approval-post",
        tool_name: "request_content_post",
        action_type: "create_board_post",
        status: "pending",
        payload: {
          title: "수정된 제목",
          content: "<p>최종 발행 본문입니다. 운영자가 내용을 조금 바꿨습니다.</p>",
          category: "자유",
          draft: {
            title: "원본 제목",
            contentHtml: "<p>원본 초안 본문입니다.</p>",
            seoTitle: "원본 제목 | BGMS.KR"
          }
        },
        created_at: new Date().toISOString()
      }],
      error: null
    });
    mockAdminAuth();

    const response = await approvalsGET();
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.approvals[0].impact.preview.diff).toEqual(expect.objectContaining({
      titleChanged: true,
      contentChanged: true,
      afterTitle: "수정된 제목"
    }));
    expect(body.approvals[0].impact.preview.warnings.join(" ")).toContain("원본 초안");
  });

  it("GET /approvals는 필수 대상이 빠진 위험 작업에 execution gate block을 표시한다", async () => {
    tables.agent_approvals = chain({
      data: [{
        id: "approval-missing-match",
        tool_name: "request_cache_cleanup",
        action_type: "flush_match_cache",
        status: "pending",
        payload: {},
        created_at: new Date().toISOString()
      }],
      error: null
    });
    mockAdminAuth();

    const response = await approvalsGET();
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.approvals[0].impact.executionGate).toEqual(expect.objectContaining({
      status: "block",
      label: "승인 차단",
      reasons: expect.arrayContaining([
        expect.stringContaining("matchId")
      ])
    }));
  });

  it("GET /approvals는 게시글 수정 승인에 수정 전후 diff preview를 포함한다", async () => {
    tables.agent_approvals = chain({
      data: [{
        id: "approval-update-post",
        tool_name: "update_board_post",
        action_type: "update_board_post",
        status: "pending",
        payload: {
          postId: 25,
          title: "수정된 제목",
          content: "<p>수정된 본문입니다.</p>",
          beforeTitle: "기존 제목",
          beforeContent: "<p>기존 본문입니다.</p>"
        },
        created_at: new Date().toISOString()
      }],
      error: null
    });
    mockAdminAuth();

    const response = await approvalsGET();
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.approvals[0].impact.risk).toBe("medium");
    expect(body.approvals[0].impact.preview.headline).toBe("게시글 수정 미리보기");
    expect(body.approvals[0].impact.preview.diff).toEqual(expect.objectContaining({
      titleChanged: true,
      contentChanged: true,
      afterTitle: "수정된 제목"
    }));
    expect(body.approvals[0].impact.executionGate.status).toBe("pass");
  });

  it("GET /approvals는 postId가 빠진 update_board_post에 execution gate block을 표시한다", async () => {
    tables.agent_approvals = chain({
      data: [{
        id: "approval-update-missing-id",
        tool_name: "update_board_post",
        action_type: "update_board_post",
        status: "pending",
        payload: {
          title: "제목",
          content: "<p>본문</p>"
        },
        created_at: new Date().toISOString()
      }],
      error: null
    });
    mockAdminAuth();

    const response = await approvalsGET();
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.approvals[0].impact.executionGate).toEqual(expect.objectContaining({
      status: "block",
      label: "승인 차단",
      reasons: expect.arrayContaining([
        expect.stringContaining("postId")
      ])
    }));
  });

  it("GET /approvals는 수동 monitor snapshot impact에 checkout과 gate 수치를 포함한다", async () => {
    tables.agent_approvals = chain({
      data: [{
        id: "approval-monitor-report",
        tool_name: "request_agent_briefing_report",
        action_type: "save_agent_report",
        status: "pending",
        payload: {
          title: "수동 점검 리포트",
          body: "[BGMS 수동 운영 점검] critical",
          category: "report",
          metadata: {
            source: "manual-monitor-snapshot",
            active: true,
            snapshot: {
              severity: "critical",
              alerts: [{ type: "approval_gate_block", severity: "critical", message: "Execution Gate block 1건" }],
              recommendations: ["Execution Gate block 요청을 승인하지 마세요."],
              approvalGateSummary: { passCount: 1, reviewCount: 0, blockCount: 1 },
              dailyCheckout: { status: "blocked", label: "마감 차단", score: 44 },
              nextActions: [{ id: "review-risky-approvals", title: "오래된/위험 승인 먼저 검토" }]
            }
          }
        },
        created_at: new Date().toISOString()
      }],
      error: null
    });
    mockAdminAuth();

    const response = await approvalsGET();
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.approvals[0].impact.details).toEqual(expect.objectContaining({
      source: "manual-monitor-snapshot",
      severity: "critical"
    }));
    expect(body.approvals[0].impact.preview.items).toEqual(expect.arrayContaining([
      expect.objectContaining({ label: "Alert", value: "1건" }),
      expect.objectContaining({ label: "Gate pass/review/block", value: "1/0/1" }),
      expect.objectContaining({ label: "Daily Checkout", value: "마감 차단 (44/100)" }),
      expect.objectContaining({ label: "Top Action", value: "오래된/위험 승인 먼저 검토" })
    ]));
  });

  it("GET /approvals는 운영 인수인계 리포트 impact에 핵심 수치를 포함한다", async () => {
    tables.agent_approvals = chain({
      data: [{
        id: "approval-handoff",
        tool_name: "request_handoff_report",
        action_type: "save_agent_report",
        status: "pending",
        payload: {
          title: "BGMS 운영 인수인계",
          body: "# BGMS Agent Handoff Packet\n\n- Pending approvals: 3",
          category: "report",
          metadata: {
            source: "handoff-packet",
            active: true,
            handoff: {
              severity: "warn",
              windowHours: 24,
              pendingApprovals: { count: 3, highRiskCount: 1, staleCount: 1 },
              incidentSummary: { totalEvents: 5, criticalEvents: 0, warnEvents: 2 }
            }
          }
        },
        created_at: new Date().toISOString()
      }],
      error: null
    });
    mockAdminAuth();

    const response = await approvalsGET();
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.approvals[0].impact.summary).toContain("운영 인수인계");
    expect(body.approvals[0].impact.details).toEqual(expect.objectContaining({
      source: "handoff-packet",
      sourceLabel: "운영 인수인계 리포트",
      severity: "warn",
      windowHours: 24
    }));
    expect(body.approvals[0].impact.preview.items).toEqual(expect.arrayContaining([
      expect.objectContaining({ label: "종류", value: "운영 인수인계 리포트" }),
      expect.objectContaining({ label: "승인 대기", value: "3건" }),
      expect.objectContaining({ label: "고위험/오래됨", value: "1/1" }),
      expect.objectContaining({ label: "사고 이벤트", value: "5건" })
    ]));
    expect(body.approvals[0].impact.preview.warnings.join(" ")).toContain("운영 인수인계");
  });

  it("GET /approvals는 Daily Ops Digest 리포트 impact에 커맨드센터 수치를 포함한다", async () => {
    tables.agent_approvals = chain({
      data: [{
        id: "approval-digest",
        tool_name: "request_command_center_report",
        action_type: "save_agent_report",
        status: "pending",
        payload: {
          title: "BGMS Daily Ops Digest",
          body: "# BGMS Daily Ops Digest\n\n- Status: warn",
          category: "report",
          metadata: {
            source: "command-center-digest",
            active: true,
            commandCenter: {
              severity: "warn",
              operatingMode: { label: "승인 검토 모드", score: 42 },
              pendingApprovals: { count: 2, highRiskCount: 1, staleCount: 0 },
              approvalGateSummary: { passCount: 1, reviewCount: 1, blockCount: 0 },
              improvementBacklog: { score: 78, label: "stable" },
              dailyCheckout: { status: "attention", label: "주의 후 마감", score: 72 },
              latestMonitorSnapshot: {
                severity: "critical",
                alertCount: 2,
                approvalGateSummary: { passCount: 1, reviewCount: 0, blockCount: 1 }
              }
            }
          }
        },
        created_at: new Date().toISOString()
      }],
      error: null
    });
    mockAdminAuth();

    const response = await approvalsGET();
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.approvals[0].impact.details).toEqual(expect.objectContaining({
      source: "command-center-digest",
      sourceLabel: "일일 운영 Digest 리포트",
      severity: "warn"
    }));
    expect(body.approvals[0].impact.preview.items).toEqual(expect.arrayContaining([
      expect.objectContaining({ label: "운영 모드", value: "승인 검토 모드" }),
      expect.objectContaining({ label: "Attention", value: "42/100" }),
      expect.objectContaining({ label: "Maturity", value: "78/100 (stable)" }),
      expect.objectContaining({ label: "Daily Checkout", value: "주의 후 마감 (72/100)" }),
      expect.objectContaining({ label: "Latest Monitor", value: "critical / alerts 2건 / gate block 1" }),
      expect.objectContaining({ label: "Gate pass/review/block", value: "1/1/0" })
    ]));
  });

  it("GET /approvals는 사고 타임라인 리포트 impact에 이벤트 요약을 포함한다", async () => {
    tables.agent_approvals = chain({
      data: [{
        id: "approval-incident",
        tool_name: "request_incident_timeline_report",
        action_type: "save_agent_report",
        status: "pending",
        payload: {
          title: "BGMS 사고 타임라인",
          body: "# BGMS Incident Timeline\n\n- Events: 7",
          category: "report",
          metadata: {
            source: "incident-timeline",
            active: true,
            timeline: {
              severity: "critical",
              windowHours: 24,
              summary: {
                totalEvents: 7,
                criticalEvents: 2,
                warnEvents: 3,
                failedRuns: 1,
                failedSteps: 2,
                apiErrors: 4,
                approvals: 1
              }
            }
          }
        },
        created_at: new Date().toISOString()
      }],
      error: null
    });
    mockAdminAuth();

    const response = await approvalsGET();
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.approvals[0].impact.details).toEqual(expect.objectContaining({
      source: "incident-timeline",
      sourceLabel: "사고 타임라인 리포트",
      severity: "critical",
      windowHours: 24
    }));
    expect(body.approvals[0].impact.preview.items).toEqual(expect.arrayContaining([
      expect.objectContaining({ label: "이벤트", value: "7건" }),
      expect.objectContaining({ label: "Critical/Warn", value: "2/3" }),
      expect.objectContaining({ label: "실패 run/step", value: "1/2" }),
      expect.objectContaining({ label: "PUBG API 에러", value: "4건" })
    ]));
    expect(body.approvals[0].impact.preview.warnings.join(" ")).toContain("critical 리포트");
    expect(body.approvals[0].impact.checklist).toEqual(expect.arrayContaining([
      expect.objectContaining({ label: "심각도", status: "warning" })
    ]));
  });

  it("inspect_approval_queue 도구는 approval impact를 read-only로 분석한다", async () => {
    tables.agent_approvals = chain({
      data: [{
        id: "approval-cache",
        tool_name: "request_cache_cleanup",
        action_type: "flush_old_cache",
        status: "pending",
        payload: { olderThanDays: 14 },
        created_at: new Date(Date.now() - 25 * 60 * 60 * 1000).toISOString()
      }],
      error: null
    });
    tables.processed_match_telemetry = chain({ count: 12 });

    const result = await adminAgentTools.inspect_approval_queue.run(
      { status: "pending", limit: 5 },
      { supabase: mockSupabaseAdmin, userId: "admin-id" }
    );
    const parsed = JSON.parse(result.result);

    expect(result.status).toBe("success");
    expect(parsed.summary).toEqual(expect.objectContaining({
      count: 1,
      highRiskCount: 1,
      staleCount: 1
    }));
    expect(parsed.approvals[0]).toEqual(expect.objectContaining({
      id: "approval-cache",
      actionType: "flush_old_cache",
      impact: expect.objectContaining({
        risk: "high",
        estimatedRows: 12,
        preview: expect.objectContaining({
          headline: "오래된 분석 캐시 삭제 미리보기",
          items: expect.arrayContaining([
            expect.objectContaining({ label: "예상 row", value: "12개" })
          ])
        }),
        executionGate: expect.objectContaining({ status: "review" })
      })
    }));
    expect(parsed.recommendations.join(" ")).toContain("고위험");
    expect(tables.agent_approvals.update).not.toHaveBeenCalled();
    expect(tables.agent_approvals.insert).not.toHaveBeenCalled();
  });

  it("GET /content-drafts는 운영 데이터 기반 콘텐츠 초안을 반환한다", async () => {
    mockAdminAuth();

    const response = await contentDraftGET(new Request("http://localhost/api/admin/agent/content-drafts?draftType=map_trends"));
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.draft.draftType).toBe("map_trends");
    expect(body.draft.title).toContain("맵 트렌드");
    expect(body.draft.contentHtml).toContain("Erangel");
    expect(body.draft.contentHtml).toContain("콘텐츠 반응");
    expect(body.draft.sourceFacts.contentPerformance.totalPosts).toBeGreaterThan(0);
  });

  it("GET /content-performance는 게시글 성과와 추천을 반환한다", async () => {
    tables.posts = chain({
      data: [
        { id: "post-1", title: "맵 트렌드", category: "자유", views: 200, likes: 20, comments: [{ count: 5 }], created_at: new Date().toISOString() },
        { id: "post-2", title: "운영 공지", category: "공지", views: 100, likes: 3, comments: [{ count: 1 }], created_at: new Date().toISOString() }
      ],
      error: null
    });
    mockAdminAuth();

    const response = await contentPerformanceGET(new Request("http://localhost/api/admin/agent/content-performance?days=30"));
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.report.totalPosts).toBe(2);
    expect(body.report.totalViews).toBe(300);
    expect(body.report.topByViews[0].title).toBe("맵 트렌드");
    expect(body.report.momentum.label).toBeTruthy();
    expect(body.report.lowEffortWins[0]).toContain("맵 트렌드");
    expect(body.report.weeklyPlan).toEqual(expect.arrayContaining([
      expect.objectContaining({ day: "월" })
    ]));
    expect(body.report.recommendations.length).toBeGreaterThan(0);
  });

  it("GET /command-center는 콘텐츠 성과 요약을 포함한다", async () => {
    tables.agent_approvals = chain({
      data: [{
        id: "approval-cache",
        action_type: "flush_match_cache",
        status: "pending",
        payload: {},
        created_at: new Date(Date.now() - 25 * 60 * 60 * 1000).toISOString()
      }],
      error: null
    });
    tables.agent_runs = chain({
      data: [{
        id: "monitor-run",
        status: "completed",
        message: "scheduled operational monitor",
        summary: JSON.stringify({
          generatedAt: new Date().toISOString(),
          severity: "critical",
          alerts: [{ type: "approval_gate_block", severity: "critical", message: "Execution Gate block 1건" }],
          approvalGateSummary: { passCount: 0, reviewCount: 0, blockCount: 1 },
          dailyCheckout: { status: "blocked", label: "마감 차단", score: 48 },
          recommendations: ["Execution Gate block 요청을 확인하세요."]
        }),
        error: null,
        started_at: new Date().toISOString(),
        completed_at: new Date().toISOString()
      }],
      count: 0,
      error: null
    });
    tables.posts = chain({
      data: [
        { id: "post-1", title: "맵 트렌드", category: "자유", views: 200, likes: 20, comments: [{ count: 5 }], created_at: new Date().toISOString() }
      ],
      error: null
    });
    mockAdminAuth();

    const response = await commandCenterGET(new Request("http://localhost/api/admin/agent/command-center"));
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.severity).toBe("critical");
    expect(body.operatingMode).toEqual(expect.objectContaining({
      mode: "incident",
      label: "장애 대응 모드",
      primaryAction: expect.objectContaining({
        prompt: expect.stringContaining("사고 타임라인")
      })
    }));
    expect(body.operatingMode.score).toBeGreaterThan(0);
    expect(body.operatingMode.reasons.join(" ")).toContain("PUBG API");
    expect(body.latestMonitorSnapshot.item).toEqual(expect.objectContaining({
      severity: "critical",
      runId: "monitor-run",
      approvalGateSummary: expect.objectContaining({ blockCount: 1 }),
      dailyCheckout: expect.objectContaining({ label: "마감 차단" })
    }));
    expect(body.dailyCheckout).toEqual(expect.objectContaining({
      status: "blocked",
      label: "마감 차단",
      score: expect.any(Number),
      handoffPrompt: expect.any(String)
    }));
    expect(body.dailyCheckout.openRisks.join(" ")).toContain("Execution Gate");
    expect(body.dailyCheckout.tomorrowFocus.length).toBeGreaterThan(0);
    expect(body.todayActionBoard).toEqual(expect.objectContaining({
      status: "blocked",
      primaryPrompt: expect.any(String),
      lanes: expect.objectContaining({
        doNow: expect.arrayContaining([
          expect.objectContaining({
            id: "resolve-approval-gate-blocks",
            source: "approval_gate",
            priority: "high"
          })
        ]),
        review: expect.any(Array),
        watch: expect.any(Array),
        save: expect.any(Array)
      })
    }));
    expect(body.todayActionBoard.summary).toContain("즉시 처리");
    expect(body.rollout.status).toBeTruthy();
    expect(body.rollout.checks.length).toBeGreaterThan(0);
    expect(body.thresholds.windowHours).toBe(24);
    expect(body.thresholds.approvalStaleHours).toBe(24);
    expect(body.pendingApprovals.highRiskCount).toBe(1);
    expect(body.pendingApprovals.staleCount).toBe(1);
    expect(body.approvalGateSummary).toEqual(expect.objectContaining({
      sampledCount: 1,
      blockCount: 1,
      reviewCount: 0
    }));
    expect(body.approvalGateSummary.items[0].gate.reasons.join(" ")).toContain("matchId");
    expect(body.toolCatalog.counts.dangerous).toBeGreaterThan(0);
    expect(body.contentPerformance.totalPosts).toBe(1);
    expect(body.contentPerformance.topPost.title).toBe("맵 트렌드");
    expect(body.contentPerformance.momentum.label).toBeTruthy();
    expect(body.contentPerformance.weeklyPlan[0].title).toContain("맵 트렌드");
    expect(body.contentPerformance.lowEffortWins.length).toBeGreaterThan(0);
    expect(body.improvementBacklog).toEqual(expect.objectContaining({
      score: expect.any(Number),
      label: expect.any(String),
      items: expect.arrayContaining([
        expect.objectContaining({
          id: "regenerate-blocked-approvals",
          priority: "high"
        })
      ])
    }));
    expect(body.capabilityMatrix).toEqual(expect.objectContaining({
      score: expect.any(Number),
      label: expect.any(String),
      summary: expect.any(String),
      items: expect.arrayContaining([
        expect.objectContaining({ id: "observe", label: "운영 관찰" }),
        expect.objectContaining({ id: "approve", label: "승인 기반 실행" }),
        expect.objectContaining({ id: "monitor", label: "자동 감시" }),
        expect.objectContaining({ id: "security", label: "보안/감사" }),
        expect.objectContaining({ id: "free_plan", label: "무료 플랜 보호" })
      ])
    }));
    expect(body.capabilityMatrix.items.every((item: any) => typeof item.nextStep === "string")).toBe(true);
    expect(body.operatorValue).toEqual(expect.objectContaining({
      score: expect.any(Number),
      label: expect.any(String),
      summary: expect.any(String),
      metrics: expect.arrayContaining([
        expect.objectContaining({ id: "time_saved", label: "운영 시간 절약" }),
        expect.objectContaining({ id: "risk_prevented", label: "위험 차단/검토" }),
        expect.objectContaining({ id: "automation_coverage", label: "자동화 커버리지" }),
        expect.objectContaining({ id: "learning_loop", label: "학습 루프" }),
        expect.objectContaining({ id: "content_leverage", label: "콘텐츠 레버리지" })
      ]),
      wins: expect.any(Array),
      nextLeverage: expect.any(Array)
    }));
    expect(body.growthRoadmap).toEqual(expect.objectContaining({
      status: expect.any(String),
      summary: expect.any(String),
      primaryPrompt: expect.any(String),
      lanes: expect.objectContaining({
        now: expect.any(Array),
        thisWeek: expect.any(Array),
        later: expect.any(Array)
      })
    }));
    expect(body.growthRoadmap.lanes.now).toEqual(expect.arrayContaining([
      expect.objectContaining({
        id: "fix-blocked-approval-gates",
        priority: "high"
      })
    ]));
    expect(body.ownerBrief).toEqual(expect.objectContaining({
      status: "act_now",
      headline: expect.any(String),
      summary: expect.any(String),
      doNow: expect.objectContaining({
        title: expect.any(String),
        prompt: expect.any(String)
      }),
      delegateToAgent: expect.any(Array),
      needsOwnerReview: expect.arrayContaining([
        expect.objectContaining({ title: "Execution Gate block" })
      ]),
      confidence: expect.any(Number)
    }));
    expect(body.monitorTrend).toEqual(expect.objectContaining({
      direction: "insufficient_data",
      label: "추세 데이터 부족",
      sampleSize: 1,
      summary: expect.stringContaining("monitor snapshot"),
      recommendation: expect.any(String)
    }));
    expect(body.automationContracts).toEqual(expect.objectContaining({
      freePlanMode: true,
      summary: expect.stringContaining("자동 실행"),
      counts: expect.objectContaining({
        active: expect.any(Number),
        external: expect.any(Number)
      }),
      guardrails: expect.arrayContaining([
        expect.stringContaining("Vercel cron")
      ]),
      contracts: expect.arrayContaining([
        expect.objectContaining({
          id: "monitor-snapshot",
          risk: "safe",
          whereToCheck: expect.stringContaining("/admin/bot")
        }),
        expect.objectContaining({
          id: "approval-impact",
          risk: "approval_required"
        }),
        expect.objectContaining({
          id: "github-heavy-work",
          status: "external"
        })
      ])
    }));
    expect(body.operatingSop).toEqual(expect.objectContaining({
      status: "blocked",
      title: expect.any(String),
      summary: expect.stringContaining("gate"),
      primaryPrompt: expect.any(String),
      guardrails: expect.arrayContaining([
        expect.stringContaining("승인")
      ]),
      procedures: expect.arrayContaining([
        expect.objectContaining({
          id: "execution-gate-block",
          severity: "critical",
          risk: "approval_required",
          steps: expect.any(Array),
          doneWhen: expect.any(Array),
          nextPrompt: expect.any(String)
        })
      ])
    }));
    expect(body.riskRadar).toEqual(expect.objectContaining({
      status: "act",
      score: expect.any(Number),
      summary: expect.any(String),
      primaryPrompt: expect.any(String),
      items: expect.arrayContaining([
        expect.objectContaining({
          id: "approval-gate-block-risk",
          category: "approval",
          severity: expect.any(String),
          prevention: expect.any(String),
          prompt: expect.stringContaining("승인")
        })
      ])
    }));
    expect(body.decisionTrace).toEqual(expect.objectContaining({
      confidence: expect.any(String),
      summary: expect.any(String),
      observations: expect.arrayContaining([
        expect.objectContaining({ id: "severity" }),
        expect.objectContaining({ id: "gate" }),
        expect.objectContaining({ id: "risk-radar" })
      ]),
      decisions: expect.arrayContaining([
        expect.objectContaining({
          id: "decision-gate-first",
          prompt: expect.stringContaining("승인")
        })
      ]),
      blindSpots: expect.any(Array),
      verifyNext: expect.any(Array)
    }));
    expect(body.safetyAudit).toEqual(expect.objectContaining({
      status: expect.any(String),
      score: expect.any(Number),
      summary: expect.any(String),
      invariants: expect.arrayContaining([
        expect.objectContaining({ id: "dangerous-tools-approval" }),
        expect.objectContaining({ id: "execution-gate" }),
        expect.objectContaining({ id: "free-plan-guardrail" })
      ]),
      requiredFixes: expect.any(Array),
      recommendedChecks: expect.any(Array),
      primaryPrompt: expect.any(String)
    }));
    expect(body.approvalAdvisor).toEqual(expect.objectContaining({
      status: expect.any(String),
      summary: expect.any(String),
      counts: expect.objectContaining({
        approve: expect.any(Number),
        defer: expect.any(Number),
        reject: expect.any(Number)
      }),
      items: expect.arrayContaining([
        expect.objectContaining({
          id: "approval-cache",
          decision: expect.any(String),
          prompt: expect.any(String)
        })
      ]),
      primaryPrompt: expect.any(String)
    }));
    expect(body.missionControl).toEqual(expect.objectContaining({
      status: expect.any(String),
      summary: expect.any(String),
      firstCommand: expect.any(String),
      phases: expect.objectContaining({
        stabilize: expect.any(Number),
        decide: expect.any(Number),
        delegate: expect.any(Number),
        verify: expect.any(Number),
        record: expect.any(Number)
      }),
      items: expect.arrayContaining([
        expect.objectContaining({
          command: expect.any(String),
          guardrail: expect.any(String)
        })
      ])
    }));
    expect(body.ownerInbox).toEqual(expect.objectContaining({
      status: expect.any(String),
      summary: expect.any(String),
      primaryAction: expect.any(String),
      counts: expect.objectContaining({
        decide: expect.any(Number),
        approve: expect.any(Number),
        delegate: expect.any(Number),
        watch: expect.any(Number)
      }),
      lanes: expect.objectContaining({
        decide: expect.any(Array),
        approve: expect.any(Array),
        delegate: expect.any(Array),
        watch: expect.any(Array)
      })
    }));
    expect(body.outcomeReview).toEqual(expect.objectContaining({
      status: expect.any(String),
      score: expect.any(Number),
      summary: expect.any(String),
      primaryPrompt: expect.any(String),
      items: expect.arrayContaining([
        expect.objectContaining({
          title: expect.any(String),
          evidence: expect.any(String),
          prompt: expect.any(String)
        })
      ])
    }));
    expect(body.operatorCoach).toEqual(expect.objectContaining({
      mode: expect.any(String),
      summary: expect.any(String),
      topPrompt: expect.any(String),
      items: expect.arrayContaining([
        expect.objectContaining({
          title: expect.any(String),
          prompt: expect.any(String),
          expectedValue: expect.any(String)
        })
      ])
    }));
    expect(body.launchKit).toEqual(expect.objectContaining({
      status: expect.any(String),
      summary: expect.any(String),
      firstPrompt: expect.any(String),
      routines: expect.arrayContaining([
        expect.objectContaining({
          id: "daily-ops",
          steps: expect.any(Array)
        })
      ]),
      guardrails: expect.any(Array),
      successSignals: expect.any(Array)
    }));
    expect(body.finalReadiness).toEqual(expect.objectContaining({
      status: expect.any(String),
      score: expect.any(Number),
      summary: expect.any(String),
      items: expect.arrayContaining([
        expect.objectContaining({
          id: "security",
          proof: expect.any(Array),
          gap: expect.any(String),
          prompt: expect.any(String)
        })
      ]),
      remainingWork: expect.any(Array),
      proofPrompts: expect.any(Array)
    }));
    expect(body.nextActions).toEqual(expect.arrayContaining([
      expect.objectContaining({
        id: "review-risky-approvals",
        priority: "high",
        category: "approval",
        urgencyScore: expect.any(Number),
        checklist: expect.arrayContaining([
          expect.stringContaining("Execution Gate")
        ]),
        prompt: expect.stringContaining("승인 대기")
      }),
      expect.objectContaining({
        id: "diagnose-pubg-api-errors",
        category: "stability",
        urgencyScore: expect.any(Number),
        prompt: expect.stringContaining("PUBG API")
      }),
      expect.objectContaining({
        id: "inspect-agent-readiness",
        category: "readiness",
        urgencyScore: expect.any(Number),
        prompt: "Admin Agent 준비 상태를 점검해줘"
      })
    ]));
    expect(body.nextActions[0].urgencyScore).toBeGreaterThanOrEqual(body.nextActions[body.nextActions.length - 1].urgencyScore);
    expect(body.relatedMemories.query).toContain("pubg");
    expect(body.relatedMemories.items).toEqual(expect.arrayContaining([
      expect.objectContaining({ title: "PUBG 429 대응" })
    ]));
    expect(body.memorySuggestions).toEqual(expect.arrayContaining([
      expect.objectContaining({
        id: "learn-approval-gate-policy",
        priority: "high",
        prompt: expect.stringContaining("memory 저장 승인 요청")
      })
    ]));
    expect(body.quickPrompts).toContain("Admin Agent 준비 상태를 점검해줘");
    expect(body.quickPrompts).toContain("승인 대기 작업을 impact 기준으로 검토해줘");
    expect(body.quickPrompts).toContain("최근 24시간 사고 타임라인을 요약해줘");
    expect(body.quickPrompts).toContain("운영 인수인계 패킷을 만들어줘");
    expect(body.quickPrompts).toContain("최근 게시글 성과를 분석하고 다음 콘텐츠를 추천해줘");
    expect(body.quickPrompts).toContain("Admin Agent 다음 업그레이드 로드맵을 정리해줘");
    expect(body.quickPrompts).toContain("현재 자동화 계약과 무료 플랜 guardrail을 요약해줘");
    expect(body.quickPrompts).toContain("Admin Agent가 지금 할 수 있는 일과 부족한 능력을 점검해줘");
    expect(body.quickPrompts).toContain("오늘 운영에서 뭐부터 처리해야 하는지 액션 보드로 정리해줘");
    expect(body.quickPrompts).toContain("오늘 운영 마감 가능한지 남은 위험과 내일 포커스를 점검해줘");
    expect(body.quickPrompts).toContain("지금 상황에 맞는 운영 SOP를 단계별로 정리해줘");
    expect(body.quickPrompts).toContain("다음에 터질 수 있는 운영 위험을 Risk Radar로 예측해줘");
    expect(body.quickPrompts).toContain("에이전트가 왜 이렇게 판단했는지 Decision Trace로 근거를 보여줘");
    expect(body.quickPrompts).toContain("Admin Agent 안전 감사 결과와 위험 승인 가능 여부를 점검해줘");
    expect(body.quickPrompts).toContain("승인 대기 요청을 승인/거절/보류 권고로 나눠줘");
    expect(body.quickPrompts).toContain("Mission Control로 지금 실행 순서를 정리해줘");
    expect(body.quickPrompts).toContain("Owner Inbox로 내가 직접 볼 것과 위임할 것을 나눠줘");
    expect(body.quickPrompts).toContain("Outcome Review로 최근 조치가 효과 있었는지 검토해줘");
    expect(body.quickPrompts).toContain("Operator Coach로 지금 가장 좋은 질문 3개를 골라줘");
    expect(body.quickPrompts).toContain("Agent Launch Kit으로 오늘부터 쓰는 법을 정리해줘");
    expect(body.quickPrompts).toContain("Final Readiness로 최종형 에이전트 완성도와 남은 일을 점검해줘");
    expect(body.quickPrompts).toContain("30초 운영자 브리핑으로 지금 할 일만 알려줘");
    expect(body.quickPrompts).toContain("최근 monitor 추세가 좋아지는지 나빠지는지 알려줘");
  });

  it("GET /command-center?format=markdown은 공유용 운영 요약을 반환한다", async () => {
    tables.agent_approvals = chain({
      data: [{
        id: "approval-cache",
        action_type: "flush_old_cache",
        status: "pending",
        payload: { cleanupType: "old-cache" },
        created_at: new Date(Date.now() - 3 * 60 * 60 * 1000).toISOString()
      }],
      error: null
    });
    tables.agent_memories = chain({
      data: [{
        id: "report-1",
        category: "report",
        title: "일일 운영 리포트",
        body: "운영 상태가 안정적이며 승인 대기 작업 1건을 검토해야 합니다.",
        metadata: { active: true, tags: ["daily"] },
        updated_at: new Date().toISOString()
      }],
      maybeSingle: {
        data: {
          id: "report-1",
          title: "일일 운영 리포트",
          body: "운영 상태가 안정적이며 승인 대기 작업 1건을 검토해야 합니다.",
          metadata: { active: true },
          updated_at: new Date().toISOString()
        },
        error: null
      },
      error: null
    });
    mockAdminAuth();

    const response = await commandCenterGET(new Request("http://localhost/api/admin/agent/command-center?format=markdown"));
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.markdown).toContain("BGMS Agent Command Center");
    expect(body.markdown).toContain("Owner Brief");
    expect(body.markdown).toContain("Owner brief:");
    expect(body.markdown).toContain("Operating Mode");
    expect(body.markdown).toContain("Daily Checkout");
    expect(body.markdown).toContain("Today Action Board");
    expect(body.markdown).toContain("Primary prompt");
    expect(body.markdown).toContain("Handoff prompt");
    expect(body.markdown).toContain("Primary action");
    expect(body.markdown).toContain("Approval Queue");
    expect(body.markdown).toContain("flush_old_cache");
    expect(body.markdown).toContain("Approval gates pass/review/block");
    expect(body.markdown).toContain("Thresholds");
    expect(body.markdown).toContain("Approval stale: 24h");
    expect(body.markdown).toContain("Latest Agent Run");
    expect(body.markdown).toContain("Latest Monitor Snapshot");
    expect(body.markdown).toContain("Monitor Trend");
    expect(body.markdown).toContain("Monitor trend:");
    expect(body.markdown).toContain("Current Signals");
    expect(body.markdown).toContain("Next Best Actions");
    expect(body.markdown).toContain("Agent Improvement Backlog");
    expect(body.markdown).toContain("Operator Value Scorecard");
    expect(body.markdown).toContain("Operator value:");
    expect(body.markdown).toContain("Agent Growth Roadmap");
    expect(body.markdown).toContain("Growth roadmap:");
    expect(body.markdown).toContain("Automation Contract");
    expect(body.markdown).toContain("Free plan mode: yes");
    expect(body.markdown).toContain("Vercel cron");
    expect(body.markdown).toContain("Operating SOP");
    expect(body.markdown).toContain("Primary prompt");
    expect(body.markdown).toContain("Risk Radar");
    expect(body.markdown).toContain("Risk radar:");
    expect(body.markdown).toContain("Prevention:");
    expect(body.markdown).toContain("Decision Trace");
    expect(body.markdown).toContain("Decision trace:");
    expect(body.markdown).toContain("Observations:");
    expect(body.markdown).toContain("Safety Audit");
    expect(body.markdown).toContain("Safety audit:");
    expect(body.markdown).toContain("Invariants:");
    expect(body.markdown).toContain("Approval Decision Advisor");
    expect(body.markdown).toContain("Approval advisor:");
    expect(body.markdown).toContain("Advice:");
    expect(body.markdown).toContain("Mission Control");
    expect(body.markdown).toContain("Mission control:");
    expect(body.markdown).toContain("Run order:");
    expect(body.markdown).toContain("Owner Inbox");
    expect(body.markdown).toContain("Owner inbox:");
    expect(body.markdown).toContain("Primary action:");
    expect(body.markdown).toContain("Outcome Review");
    expect(body.markdown).toContain("Outcome review:");
    expect(body.markdown).toContain("Next check:");
    expect(body.markdown).toContain("Operator Coach");
    expect(body.markdown).toContain("Operator coach:");
    expect(body.markdown).toContain("Recommended prompts:");
    expect(body.markdown).toContain("Agent Launch Kit");
    expect(body.markdown).toContain("Launch kit:");
    expect(body.markdown).toContain("Routines:");
    expect(body.markdown).toContain("Guardrails:");
    expect(body.markdown).toContain("Final Readiness");
    expect(body.markdown).toContain("Final readiness:");
    expect(body.markdown).toContain("Remaining work:");
    expect(body.markdown).toContain("Proof prompts:");
    expect(body.markdown).toContain("Capability Matrix");
    expect(body.markdown).toContain("Capability:");
    expect(body.markdown).toContain("Score:");
    expect(body.markdown).toContain("score ");
    expect(body.markdown).toContain("Check:");
    expect(body.markdown).toContain("Prompt:");
    expect(body.markdown).toContain("Latest Report");
    expect(body.markdown).toContain("일일 운영 리포트");
    expect(body.markdown).toContain("Memory Suggestions");
    expect(body.markdown).toContain("Quick Prompts");
    expect(body.markdown).toContain("Readiness");
    expect(body.markdown).toContain("Agent readiness issues");
    expect(body.markdown).toContain("선택 환경변수 미설정");
    expect(body.commandCenter.severity).toBeTruthy();
  });

  it("GET /command-center?format=digest는 짧은 일일 운영 digest를 반환한다", async () => {
    tables.agent_approvals = chain({
      data: [{
        id: "approval-cache",
        action_type: "flush_match_cache",
        status: "pending",
        payload: {},
        created_at: new Date(Date.now() - 3 * 60 * 60 * 1000).toISOString()
      }],
      error: null
    });
    mockAdminAuth();

    const response = await commandCenterGET(new Request("http://localhost/api/admin/agent/command-center?format=digest"));
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.markdown).toContain("BGMS Daily Ops Digest");
    expect(body.markdown).toContain("Snapshot");
    expect(body.markdown).toContain("Checkout:");
    expect(body.markdown).toContain("Action board:");
    expect(body.markdown).toContain("Capability:");
    expect(body.markdown).toContain("Operator value:");
    expect(body.markdown).toContain("Roadmap:");
    expect(body.markdown).toContain("Owner brief:");
    expect(body.markdown).toContain("Automation:");
    expect(body.markdown).toContain("Monitor trend:");
    expect(body.markdown).toContain("Board:");
    expect(body.markdown).toContain("Latest monitor:");
    expect(body.markdown).toContain("Memory suggestion:");
    expect(body.markdown).toContain("Do First");
    expect(body.markdown).toContain("Improve Next");
    expect(body.markdown).toContain("score ");
    expect(body.markdown).toContain("Check:");
    expect(body.markdown).toContain("gate block 1");
    expect(body.commandCenter.approvalGateSummary.blockCount).toBe(1);
  });

  it("GET /command-center?format=final은 최종 readiness 보고서를 반환한다", async () => {
    tables.agent_approvals = chain({
      data: [{
        id: "approval-cache",
        action_type: "flush_match_cache",
        status: "pending",
        payload: {},
        created_at: new Date(Date.now() - 3 * 60 * 60 * 1000).toISOString()
      }],
      error: null
    });
    mockAdminAuth();

    const response = await commandCenterGET(new Request("http://localhost/api/admin/agent/command-center?format=final"));
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.markdown).toContain("BGMS Admin Agent Final Readiness Report");
    expect(body.markdown).toContain("Final Readiness Evidence");
    expect(body.markdown).toContain("Launch Kit");
    expect(body.markdown).toContain("Safety Proof");
    expect(body.markdown).toContain("Approval Proof");
    expect(body.markdown).toContain("Recommended Proof Prompts");
    expect(body.commandCenter.finalReadiness).toEqual(expect.objectContaining({
      status: expect.any(String),
      score: expect.any(Number),
      items: expect.any(Array)
    }));
  });

  it("POST /command-center는 Daily Ops Digest를 report 저장 승인 요청으로 만든다", async () => {
    tables.agent_runs = chain({
      data: [{
        id: "monitor-run",
        status: "completed",
        message: "scheduled operational monitor",
        summary: JSON.stringify({
          generatedAt: "2026-06-10T00:00:00.000Z",
          severity: "critical",
          alerts: [{ type: "approval_gate_block", severity: "critical", message: "Execution Gate block 1건" }],
          approvalGateSummary: { passCount: 0, reviewCount: 0, blockCount: 1 },
          dailyCheckout: { status: "blocked", label: "마감 차단", score: 48 }
        }),
        error: null,
        started_at: new Date().toISOString(),
        completed_at: new Date().toISOString()
      }],
      count: 0,
      error: null
    });
    tables.agent_approvals = chain({
      data: [{
        id: "approval-cache",
        action_type: "flush_match_cache",
        status: "pending",
        payload: {},
        created_at: new Date(Date.now() - 3 * 60 * 60 * 1000).toISOString()
      }],
      insertSingle: { data: { id: "approval-digest" }, error: null },
      error: null
    });
    mockAdminAuth();

    const response = await commandCenterPOST(new Request("http://localhost/api/admin/agent/command-center", {
      method: "POST",
      body: JSON.stringify({ format: "digest", reason: "아침 운영 기록" })
    }));
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.success).toBe(true);
    expect(body.approvalId).toBe("approval-digest");
    expect(body.markdown).toContain("BGMS Daily Ops Digest");
    expect(tables.agent_approvals.insert).toHaveBeenCalledWith(expect.objectContaining({
      action_type: "save_agent_report",
      tool_name: "request_command_center_report",
      payload: expect.objectContaining({
        category: "report",
        body: expect.stringContaining("BGMS Daily Ops Digest"),
        metadata: expect.objectContaining({
          source: "command-center-digest",
          reason: "아침 운영 기록",
          commandCenter: expect.objectContaining({
            severity: expect.any(String),
            approvalGateSummary: expect.objectContaining({ blockCount: 1 }),
            latestMonitorSnapshot: expect.objectContaining({
              runId: "monitor-run",
              severity: "critical",
              alertCount: 1,
              approvalGateSummary: expect.objectContaining({ blockCount: 1 }),
              dailyCheckout: expect.objectContaining({ label: "마감 차단" })
            }),
            dailyCheckout: expect.objectContaining({
              status: "blocked",
              label: "마감 차단",
              score: expect.any(Number),
              openRisks: expect.arrayContaining([
                expect.stringContaining("Execution Gate")
              ])
            }),
            todayActionBoard: expect.objectContaining({
              status: "blocked",
              doNowCount: expect.any(Number),
              topItem: expect.objectContaining({
                title: expect.any(String)
              })
            }),
            capabilityMatrix: expect.objectContaining({
              score: expect.any(Number),
              label: expect.any(String),
              summary: expect.any(String),
              attentionItems: expect.any(Array)
            }),
            operatorValue: expect.objectContaining({
              score: expect.any(Number),
              label: expect.any(String),
              summary: expect.any(String),
              topMetric: expect.any(Object),
              nextLeverage: expect.any(Object)
            }),
            growthRoadmap: expect.objectContaining({
              status: expect.any(String),
              summary: expect.any(String),
              primaryPrompt: expect.any(String),
              nowCount: expect.any(Number),
              topItem: expect.any(Object)
            }),
            ownerBrief: expect.objectContaining({
              status: expect.any(String),
              headline: expect.any(String),
              summary: expect.any(String),
              doNow: expect.any(Object),
              needsOwnerReviewCount: expect.any(Number),
              confidence: expect.any(Number)
            }),
            automationContracts: expect.objectContaining({
              summary: expect.stringContaining("자동 실행"),
              freePlanMode: true,
              counts: expect.objectContaining({
                active: expect.any(Number)
              }),
              active: expect.arrayContaining([
                expect.objectContaining({
                  id: "monitor-snapshot",
                  guardrail: expect.any(String)
                })
              ])
            }),
            monitorTrend: expect.objectContaining({
              direction: expect.any(String),
              label: expect.any(String),
              sampleSize: expect.any(Number),
              recommendation: expect.any(String)
            })
          })
        })
      })
    }));
  });

  it("POST /command-center는 Final Readiness 보고서를 report 저장 승인 요청으로 만든다", async () => {
    tables.agent_approvals = chain({
      data: [{
        id: "approval-cache",
        action_type: "flush_match_cache",
        status: "pending",
        payload: {},
        created_at: new Date(Date.now() - 3 * 60 * 60 * 1000).toISOString()
      }],
      insertSingle: { data: { id: "approval-final" }, error: null },
      error: null
    });
    mockAdminAuth();

    const response = await commandCenterPOST(new Request("http://localhost/api/admin/agent/command-center", {
      method: "POST",
      body: JSON.stringify({ format: "final", reason: "최종 에이전트 증거 보존" })
    }));
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.success).toBe(true);
    expect(body.approvalId).toBe("approval-final");
    expect(body.markdown).toContain("BGMS Admin Agent Final Readiness Report");
    expect(tables.agent_approvals.insert).toHaveBeenCalledWith(expect.objectContaining({
      action_type: "save_agent_report",
      payload: expect.objectContaining({
        category: "report",
        title: expect.stringContaining("Final Readiness"),
        body: expect.stringContaining("Final Readiness Evidence"),
        metadata: expect.objectContaining({
          source: "command-center-final-readiness",
          reason: "최종 에이전트 증거 보존",
          commandCenter: expect.objectContaining({
            finalReadiness: expect.objectContaining({
              status: expect.any(String),
              score: expect.any(Number),
              summary: expect.any(String)
            })
          })
        })
      })
    }));
  });

  it("POST /monitor는 관리자 수동 점검 snapshot을 반환하고 run 로그를 갱신한다", async () => {
    tables.agent_runs = chain({
      insertSingle: { data: { id: "monitor-run" }, error: null },
      updateResult: { data: null, error: null }
    });
    tables.agent_approvals = chain({
      data: [{
        id: "approval-cache",
        action_type: "flush_match_cache",
        status: "pending",
        payload: {},
        created_at: new Date().toISOString()
      }],
      error: null
    });
    tables.pubg_api_status = chain({
      maybeSingle: {
        data: { api_limit: 1000, remaining: 0, reset_at: null, updated_at: new Date().toISOString() },
        error: null
      }
    });
    mockAdminAuth();

    const response = await monitorPOST(new Request("http://localhost/api/admin/agent/monitor", { method: "POST" })) as Response;
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.severity).toBe("critical");
    expect(body.alerts).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: "api_errors" }),
      expect.objectContaining({ type: "pending_approvals" }),
      expect.objectContaining({ type: "approval_gate_block", severity: "critical" }),
      expect.objectContaining({ type: "pubg_quota" })
    ]));
    expect(body.approvalGateSummary.blockCount).toBe(1);
    expect(body.dailyCheckout).toEqual(expect.objectContaining({
      status: "blocked",
      label: "마감 차단",
      handoffPrompt: expect.any(String)
    }));
    expect(body.nextActions[0]).toEqual(expect.objectContaining({
      urgencyScore: expect.any(Number),
      checklist: expect.any(Array)
    }));
    expect(body.ownerBrief).toEqual(expect.objectContaining({
      status: "act_now",
      headline: expect.any(String),
      doNow: expect.objectContaining({
        prompt: expect.any(String)
      })
    }));
    expect(body.operatorValue).toEqual(expect.objectContaining({
      score: expect.any(Number),
      label: expect.any(String),
      nextLeverage: expect.any(Array)
    }));
    expect(body.growthRoadmap).toEqual(expect.objectContaining({
      status: expect.any(String),
      primaryPrompt: expect.any(String)
    }));
    expect(body.playbooks).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: "approval-gate-block" })
    ]));
    expect(body.recommendations.join(" ")).toContain("Execution Gate block");
    expect(body.notification).toEqual(expect.objectContaining({
      provider: "discord",
      configured: false,
      sent: false,
      reason: "webhook_missing"
    }));
    expect(body.recommendations.length).toBeGreaterThan(0);
    expect(tables.agent_runs.insert).toHaveBeenCalledWith(expect.objectContaining({
      message: "manual operational monitor",
      status: "running"
    }));
    expect(tables.agent_runs.update).toHaveBeenCalledWith(expect.objectContaining({
      status: "completed",
      summary: expect.stringContaining("\"notification\"")
    }));
  });

  it("POST /monitor는 최근 동일 Discord 알림이 있으면 cooldown 처리한다", async () => {
    process.env.DISCORD_WEBHOOK_URL = "https://discord.example/webhook";
    const recentSummary = JSON.stringify({
      severity: "critical",
      alerts: [
        { type: "api_errors", severity: "warn" },
        { type: "pending_approvals", severity: "warn" },
        { type: "approval_gate_block", severity: "critical" },
        { type: "pubg_quota", severity: "critical" }
      ],
      notification: { provider: "discord", sent: true }
    });
    tables.agent_runs = chain({
      data: [{ summary: recentSummary, completed_at: new Date().toISOString() }],
      insertSingle: { data: { id: "monitor-run" }, error: null },
      updateResult: { data: null, error: null }
    });
    tables.agent_approvals = chain({
      data: [{
        id: "approval-cache",
        action_type: "flush_match_cache",
        status: "pending",
        payload: {},
        created_at: new Date().toISOString()
      }],
      error: null
    });
    tables.pubg_api_status = chain({
      maybeSingle: {
        data: { api_limit: 1000, remaining: 0, reset_at: null, updated_at: new Date().toISOString() },
        error: null
      }
    });
    vi.stubGlobal("fetch", vi.fn());
    mockAdminAuth();

    const response = await monitorPOST(new Request("http://localhost/api/admin/agent/monitor", { method: "POST" })) as Response;
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.notification).toEqual(expect.objectContaining({
      configured: true,
      sent: false,
      reason: "cooldown",
      cooldownMinutes: 60
    }));
    expect(fetch).not.toHaveBeenCalled();
  });

  it("POST /monitor는 Discord 알림에 checkout과 top action을 포함한다", async () => {
    process.env.DISCORD_WEBHOOK_URL = "https://discord.example/webhook";
    tables.agent_runs = chain({
      data: [],
      insertSingle: { data: { id: "monitor-run" }, error: null },
      updateResult: { data: null, error: null }
    });
    tables.agent_approvals = chain({
      data: [{
        id: "approval-cache",
        action_type: "flush_match_cache",
        status: "pending",
        payload: {},
        created_at: new Date().toISOString()
      }],
      error: null
    });
    tables.pubg_api_status = chain({
      maybeSingle: {
        data: { api_limit: 1000, remaining: 25, reset_at: null, updated_at: new Date().toISOString() },
        error: null
      }
    });
    const fetchMock = vi.fn().mockResolvedValue({ ok: true });
    vi.stubGlobal("fetch", fetchMock);
    mockAdminAuth();

    const response = await monitorPOST(new Request("http://localhost/api/admin/agent/monitor", { method: "POST" })) as Response;
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.notification).toEqual(expect.objectContaining({
      configured: true,
      sent: true,
      reason: "alert_sent"
    }));
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const payload = JSON.parse(fetchMock.mock.calls[0][1].body as string);
    expect(payload.content).toContain("현재 문제");
    expect(payload.content).toContain("**마감 상태**:");
    expect(payload.content).toContain("**운영 요약**:");
    expect(payload.content).toContain("지금 할 일:");
    expect(payload.content).toContain("**승인 차단**: 1건");
    expect(payload.content).toContain("다음 조치");
    expect(payload.content).toContain("확인 위치: `/admin/bot`");
  });

  it("POST /content-drafts는 게시글을 직접 발행하지 않고 create_board_post 승인 요청을 만든다", async () => {
    mockAdminAuth();

    const response = await contentDraftPOST(new Request("http://localhost/api/admin/agent/content-drafts", {
      method: "POST",
      body: JSON.stringify({ draftType: "weekly_ops", reason: "주간 콘텐츠 발행" })
    }));
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.approvalId).toBe("approval-1");
    expect(tables.agent_approvals.insert).toHaveBeenCalledWith(expect.objectContaining({
      action_type: "create_board_post",
      payload: expect.objectContaining({
        draft: expect.objectContaining({ draftType: "weekly_ops" })
      })
    }));
  });

  it("POST /approvals/:id/approve는 콘텐츠 게시글을 승인 후 발행한다", async () => {
    tables.agent_approvals = chain({
      count: 1,
      singleResult: {
        data: {
          id: "approval-content",
          status: "pending",
          action_type: "create_board_post",
          payload: {
            title: "운영 데이터 기반 게시글",
            content: "<p>초안 본문</p>",
            category: "자유",
            draft: { draftType: "weekly_ops", seoTitle: "운영 데이터 기반 게시글 | BGMS.KR" }
          }
        },
        error: null
      },
      updateResult: { data: null, error: null }
    });
    mockAdminAuth();

    const response = await approvalApprovePOST(
      new Request("http://localhost/api/admin/agent/approvals/approval-content/approve", { method: "POST" }),
      { params: Promise.resolve({ id: "approval-content" }) }
    );
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.success).toBe(true);
    expect(body.result.impact.checklist).toEqual(expect.arrayContaining([
      expect.objectContaining({ label: "제목 확인", status: "pass" }),
      expect.objectContaining({ label: "공개 노출", status: "review" })
    ]));
    expect(tables.posts.insert).toHaveBeenCalledWith(expect.objectContaining({
      title: "운영 데이터 기반 게시글",
      content: "<p>초안 본문</p>",
      category: "자유",
      author: "BGMS_AI_BOT",
      user_id: "admin-id"
    }));
    expect(body.result.execution.message).toContain("자유게시판");
    expect(body.result.postExecution).toEqual(expect.objectContaining({
      status: "completed",
      title: "게시글 발행",
      outcome: expect.stringContaining("자유게시판"),
      followUp: expect.arrayContaining([
        expect.stringContaining("게시판")
      ]),
      audit: expect.objectContaining({
        relatedResource: "/board/published-post"
      })
    }));
    expect(body.result.postExecution.metrics).toEqual(expect.arrayContaining([
      expect.objectContaining({ label: "Post ID", value: "published-post" })
    ]));
  });

  it("POST /approvals/:id/approve는 운영 리포트를 agent memory로 저장한다", async () => {
    tables.agent_approvals = chain({
      count: 1,
      singleResult: {
        data: {
          id: "approval-report",
          status: "pending",
          action_type: "save_agent_report",
          payload: {
            category: "report",
            title: "운영 브리핑",
            body: "운영 상태 정상",
            metadata: { active: true, briefing: { severity: "ok", windowHours: 24 } }
          }
        },
        error: null
      },
      updateResult: { data: null, error: null }
    });
    mockAdminAuth();

    const response = await approvalApprovePOST(
      new Request("http://localhost/api/admin/agent/approvals/approval-report/approve", {
        method: "POST",
        body: JSON.stringify({ approvalNote: "정기 운영 리포트 보존" })
      }),
      { params: Promise.resolve({ id: "approval-report" }) }
    );
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.success).toBe(true);
    expect(tables.agent_memories.insert).toHaveBeenCalledWith(expect.objectContaining({
      category: "report",
      title: "운영 브리핑",
      body: "운영 상태 정상",
      metadata: expect.objectContaining({ approvedBy: "admin-id", active: true })
    }));
    expect(body.result.decision).toEqual(expect.objectContaining({
      approvedBy: "admin-id",
      approvalNote: "정기 운영 리포트 보존",
      confirmedImpact: false,
      highRisk: false
    }));
    expect(body.result.execution.message).toContain("운영 리포트");
    expect(body.result.postExecution).toEqual(expect.objectContaining({
      status: "completed",
      title: "운영 리포트 저장",
      followUp: expect.arrayContaining([
        expect.stringContaining("운영 기억")
      ]),
      audit: expect.objectContaining({
        relatedResource: "memory:saved-memory"
      })
    }));
  });

  it("POST /approvals/:id/approve는 고위험 작업에 confirmedImpact를 요구한다", async () => {
    tables.agent_approvals = chain({
      count: 1,
      singleResult: {
        data: {
          id: "approval-danger",
          status: "pending",
          action_type: "flush_old_cache",
          payload: { olderThanDays: 14 }
        },
        error: null
      },
      updateResult: { data: null, error: null }
    });
    mockAdminAuth();

    const response = await approvalApprovePOST(
      new Request("http://localhost/api/admin/agent/approvals/approval-danger/approve", { method: "POST" }),
      { params: Promise.resolve({ id: "approval-danger" }) }
    );
    const body = await response.json();

    expect(response.status).toBe(400);
    expect(body.error).toContain("confirmedImpact");
    expect(body.impact.risk).toBe("high");
    expect(tables.agent_approvals.update).not.toHaveBeenCalled();
  });

  it("POST /approvals/:id/approve는 execution gate block이면 승인 상태로 바꾸지 않는다", async () => {
    tables.agent_approvals = chain({
      count: 1,
      singleResult: {
        data: {
          id: "approval-blocked",
          status: "pending",
          action_type: "flush_match_cache",
          payload: {}
        },
        error: null
      },
      updateResult: { data: null, error: null }
    });
    mockAdminAuth();

    const response = await approvalApprovePOST(
      new Request("http://localhost/api/admin/agent/approvals/approval-blocked/approve", {
        method: "POST",
        body: JSON.stringify({ confirmedImpact: true, approvalNote: "대상 확인" })
      }),
      { params: Promise.resolve({ id: "approval-blocked" }) }
    );
    const body = await response.json();

    expect(response.status).toBe(400);
    expect(body.executionGate).toEqual(expect.objectContaining({ status: "block" }));
    expect(body.executionGate.reasons.join(" ")).toContain("matchId");
    expect(tables.agent_approvals.update).not.toHaveBeenCalled();
  });

  it("POST /approvals/:id/reject는 거절 사유를 approval result에 기록한다", async () => {
    tables.agent_approvals = chain({
      singleResult: {
        data: {
          id: "approval-reject",
          status: "pending"
        },
        error: null
      },
      updateResult: { data: null, error: null }
    });
    mockAdminAuth();

    const response = await approvalRejectPOST(
      new Request("http://localhost/api/admin/agent/approvals/approval-reject/reject", {
        method: "POST",
        body: JSON.stringify({ reason: "중복 요청" })
      }),
      { params: Promise.resolve({ id: "approval-reject" }) }
    );
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.success).toBe(true);
    expect(body.result.reason).toBe("중복 요청");
    expect(tables.agent_approvals.update).toHaveBeenCalledWith(expect.objectContaining({
      status: "rejected",
      approved_by: "admin-id",
      result: expect.stringContaining("중복 요청")
    }));
  });

  function mockAdminAuth() {
    (withAuthGuard as any).mockResolvedValue({
      user: { id: "admin-id" },
      supabaseAdmin: mockSupabaseAdmin
    });
  }
});

function chain(options: {
  data?: any[];
  error?: any;
  count?: number;
  maybeSingle?: { data: any; error: any };
  insertSingle?: { data: any; error: any };
  singleResult?: { data: any; error: any };
  updateResult?: { data: any; error: any };
}) {
  const query: any = {
    select: vi.fn(() => query),
    eq: vi.fn(() => query),
    neq: vi.fn(() => query),
    gte: vi.fn(() => query),
    lt: vi.fn(() => query),
    in: vi.fn(() => query),
    or: vi.fn(() => query),
    order: vi.fn(() => query),
    limit: vi.fn(() => query),
    range: vi.fn(() => query),
    insert: vi.fn(() => query),
    delete: vi.fn(() => query),
    update: vi.fn(() => query),
    single: vi.fn(() => Promise.resolve(options.singleResult || options.insertSingle || { data: options.data?.[0] || null, error: options.error || null })),
    maybeSingle: vi.fn(() => Promise.resolve(options.maybeSingle || { data: options.data?.[0] || null, error: options.error || null }))
  };

  query.then = (resolve: any) => resolve({
    data: options.data || [],
    error: options.error || null,
    count: options.count ?? options.data?.length ?? 0
  });

  query.update.mockImplementation(() => ({
    eq: vi.fn(() => Promise.resolve(options.updateResult || { data: null, error: options.error || null }))
  }));

  return query;
}
