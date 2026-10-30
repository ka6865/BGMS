import { adminAgentTools } from "./tools";
import { buildTodayActionBoard } from "./action-board";
import { buildAgentDailyCheckout } from "./daily-checkout";
import { buildMemorySuggestions } from "./memory-suggestions";
import { redactForAgentLog } from "./redaction";
import { buildNextBestActions } from "./next-actions";
import { getAgentThresholds } from "./thresholds";
import { buildAgentToolCatalog } from "./tool-catalog";

export type AgentSelfTestStatus = "ok" | "warn" | "critical";

export type AgentSelfTest = {
  generatedAt: string;
  status: AgentSelfTestStatus;
  checks: Array<{
    id: string;
    label: string;
    status: AgentSelfTestStatus;
    message: string;
    count?: number;
  }>;
  toolCount: number;
};

const REQUIRED_TABLES = [
  "agent_runs",
  "agent_steps",
  "agent_approvals",
  "agent_memories"
];

const OBSERVABILITY_TABLES = [
  "pubg_api_errors",
  "ai_usage_logs",
  "processed_match_telemetry",
  "analytics_events",
  "profiles"
];

export async function runAgentSelfTest(supabase: any): Promise<AgentSelfTest> {
  const checks = [];

  for (const table of REQUIRED_TABLES) {
    checks.push(await checkTable(supabase, table, true));
  }

  for (const table of OBSERVABILITY_TABLES) {
    checks.push(await checkTable(supabase, table, false));
  }

  checks.push(...checkEnv());
  checks.push(checkThresholds());
  checks.push(checkLogRedaction());
  checks.push(checkTools());
  checks.push(checkToolSafetyClassification());
  checks.push(checkApprovalLoop());
  checks.push(checkReportApprovalWorkflow());
  checks.push(checkDecisionSupportWorkflow());
  checks.push(checkActionBoardWorkflow());
  checks.push(checkMemoryLearningWorkflow());
  checks.push(checkAgentApiSurface());

  const status = getOverallStatus(checks);

  return {
    generatedAt: new Date().toISOString(),
    status,
    checks,
    toolCount: Object.keys(adminAgentTools).length
  };
}

async function checkTable(supabase: any, table: string, required: boolean) {
  const { count, error } = await supabase
    .from(table)
    .select("*", { count: "exact", head: true });

  if (error) {
    return {
      id: `table:${table}`,
      label: table,
      status: required ? "critical" as const : "warn" as const,
      message: error.message || "table check failed"
    };
  }

  return {
    id: `table:${table}`,
    label: table,
    status: "ok" as const,
    message: "reachable",
    count: count || 0
  };
}

function checkEnv() {
  return [
    envCheck("NEXT_PUBLIC_SUPABASE_URL", true),
    envCheck("SUPABASE_SERVICE_ROLE_KEY", true),
    envCheck("GOOGLE_GEMINI_API_KEY", true),
    envCheck("ADMIN_AGENT_CRON_SECRET or CRON_SECRET", true, Boolean(process.env.ADMIN_AGENT_CRON_SECRET || process.env.CRON_SECRET)),
    envCheck("DISCORD_WEBHOOK_URL", false),
    envCheck("TAVILY_API_KEY", false),
    envCheck("VERCEL_TOKEN + VERCEL_PROJECT_ID", false, Boolean(process.env.VERCEL_TOKEN && process.env.VERCEL_PROJECT_ID))
  ];
}

function checkThresholds() {
  const thresholds = getAgentThresholds();
  return {
    id: "config:thresholds",
    label: "에이전트 기준값",
    status: "ok" as const,
    message: `점검 범위 ${thresholds.windowHours}시간, AI 비용 기준 $${thresholds.aiCostWarnUsd}/$${thresholds.aiCostCriticalUsd}, API 위험 기준 ${thresholds.apiErrorsCritical}건, PUBG 남은 호출 기준 ${thresholds.pubgQuotaWarnRemaining}/${thresholds.pubgQuotaCriticalRemaining}, 오래된 승인 기준 ${thresholds.approvalStaleHours}시간`
  };
}

function envCheck(name: string, required: boolean, configured?: boolean) {
  const isConfigured = configured ?? Boolean(process.env[name]);
  return {
    id: `env:${name}`,
    label: name,
    status: isConfigured ? "ok" as const : required ? "critical" as const : "warn" as const,
    message: isConfigured ? "설정됨" : required ? "필수 환경변수 누락" : "선택 환경변수 미설정"
  };
}

function checkLogRedaction() {
  const sample = {
    apiKey: "secret-value-123",
    nested: {
      authorization: "Bearer abcdefghijklmnopqrstuvwxyz",
      url: "postgresql://postgres:plain-password@example.supabase.co:5432/postgres"
    },
    text: "token=abcdef1234567890 and password=hunter2"
  };
  const redacted = redactForAgentLog(sample) as any;
  const serialized = JSON.stringify(redacted);
  const leaked = [
    "secret-value-123",
    "abcdefghijklmnopqrstuvwxyz",
    "plain-password",
    "abcdef1234567890",
    "hunter2"
  ].filter((needle) => serialized.includes(needle));

  return {
    id: "security:log-redaction",
    label: "Agent log redaction",
    status: leaked.length ? "critical" as const : "ok" as const,
    message: leaked.length
      ? `sensitive values leaked in redaction sample: ${leaked.join(", ")}`
      : "agent run, step, approval logs redact common secret/token/password patterns"
  };
}

function checkTools() {
  const catalog = buildAgentToolCatalog();
  const requiredTools = [
    "get_db_statistics",
    "inspect_operations",
    "inspect_agent_readiness",
    "inspect_approval_queue",
    "inspect_incident_timeline",
    "inspect_handoff_packet",
    "inspect_operator_value",
    "inspect_owner_brief",
    "inspect_monitor_trend",
    "inspect_automation_contract",
    "summarize_user_activity",
    "inspect_user_metrics",
    "inspect_capability_matrix",
    "inspect_growth_roadmap",
    "inspect_today_action_board",
    "inspect_daily_checkout",
    "inspect_operating_sop",
    "inspect_risk_radar",
    "inspect_decision_trace",
    "inspect_safety_audit",
    "inspect_approval_advisor",
    "inspect_mission_control",
    "inspect_owner_inbox",
    "inspect_outcome_review",
    "inspect_operator_coach",
    "inspect_launch_kit",
    "inspect_final_readiness",
    "search_agent_memories",
    "generate_operations_briefing",
    "generate_content_draft",
    "analyze_content_performance",
    "request_content_post",
    "request_agent_memory",
    "create_board_post"
  ];
  const missing = requiredTools.filter((toolName) => !adminAgentTools[toolName]);

  return {
    id: "tools:registry",
    label: "Admin Agent tools",
    status: missing.length ? "critical" as const : "ok" as const,
    message: missing.length
      ? `missing tools: ${missing.join(", ")}`
      : `${catalog.total} tools registered: read ${catalog.counts.read}, write ${catalog.counts.write}, dangerous ${catalog.counts.dangerous}`
  };
}

function checkToolSafetyClassification() {
  const catalog = buildAgentToolCatalog();
  const expected: Record<string, "read" | "write" | "dangerous"> = {
    get_db_statistics: "read",
    inspect_operations: "read",
    inspect_agent_readiness: "read",
    inspect_approval_queue: "read",
    inspect_incident_timeline: "read",
    inspect_handoff_packet: "read",
    inspect_operator_value: "read",
    inspect_owner_brief: "read",
    inspect_monitor_trend: "read",
    inspect_automation_contract: "read",
    summarize_user_activity: "read",
    inspect_user_metrics: "read",
    inspect_capability_matrix: "read",
    inspect_growth_roadmap: "read",
    inspect_today_action_board: "read",
    inspect_daily_checkout: "read",
    inspect_operating_sop: "read",
    inspect_risk_radar: "read",
    inspect_decision_trace: "read",
    inspect_safety_audit: "read",
    inspect_approval_advisor: "read",
    inspect_mission_control: "read",
    inspect_owner_inbox: "read",
    inspect_outcome_review: "read",
    inspect_operator_coach: "read",
    inspect_launch_kit: "read",
    inspect_final_readiness: "read",
    search_agent_memories: "read",
    generate_operations_briefing: "read",
    generate_content_draft: "read",
    analyze_content_performance: "read",
    take_map_screenshot: "write",
    request_agent_memory: "dangerous",
    request_operations_report: "dangerous",
    request_content_post: "dangerous",
    create_board_post: "dangerous"
  };
  const mismatches = Object.entries(expected).flatMap(([name, safetyLevel]) => {
    const tool = catalog.tools.find((item) => item.name === name);
    if (!tool) return [`${name}: missing`];
    if (tool.safetyLevel !== safetyLevel) return [`${name}: expected ${safetyLevel}, got ${tool.safetyLevel}`];
    return [];
  });

  return {
    id: "tools:safety-classification",
    label: "Tool safety classification",
    status: mismatches.length ? "critical" as const : "ok" as const,
    message: mismatches.length
      ? `tool safety mismatch: ${mismatches.join(", ")}`
      : "read/write/dangerous tool classifications match the approval policy"
  };
}

function checkApprovalLoop() {
  const catalog = buildAgentToolCatalog();
  const approvalTools = [
    "request_agent_memory",
    "request_operations_report",
    "request_content_post",
    "create_board_post"
  ];
  const missing = approvalTools.filter((toolName) => !adminAgentTools[toolName]);
  const unsafe = catalog.tools.filter((tool) =>
    approvalTools.includes(tool.name) && tool.safetyLevel !== "dangerous"
  );

  return {
    id: "workflow:approval-loop",
    label: "Approval execution loop",
    status: missing.length || unsafe.length ? "critical" as const : "ok" as const,
    message: missing.length
      ? `missing approval tools: ${missing.join(", ")}`
      : unsafe.length
        ? `approval tools not marked dangerous: ${unsafe.map((tool) => tool.name).join(", ")}`
        : "dangerous write/delete/publish/report actions are routed through approval tools"
  };
}

function checkReportApprovalWorkflow() {
  const catalog = buildAgentToolCatalog();
  const reportTool = catalog.tools.find((tool) => tool.name === "request_operations_report");
  const reportActionCovered = reportTool?.safetyLevel === "dangerous" && reportTool.approvalRequired;
  const memoryTool = catalog.tools.find((tool) => tool.name === "request_agent_memory");
  const memoryActionCovered = memoryTool?.safetyLevel === "dangerous" && memoryTool.approvalRequired;
  const missing = [
    !reportActionCovered ? "request_operations_report" : null,
    !memoryActionCovered ? "request_agent_memory" : null
  ].filter(Boolean);

  return {
    id: "workflow:report-approval",
    label: "Report and memory approval workflow",
    status: missing.length ? "critical" as const : "ok" as const,
    message: missing.length
      ? `report/memory approval workflow missing dangerous gate: ${missing.join(", ")}`
      : "operations reports, command-center digests, and memories are preserved through approval-backed save actions"
  };
}

function checkDecisionSupportWorkflow() {
  const thresholds = getAgentThresholds();
  const actions = buildNextBestActions({
    pendingApprovals: 2,
    staleApprovals: 1,
    highRiskApprovals: 1,
    failedRuns: 0,
    apiErrors: thresholds.apiErrorsCritical,
    aiCost: 0,
    readinessStatus: "ok",
    rolloutStatus: "pass",
    deploymentHealth: {
      provider: "vercel",
      configured: false,
      severity: "ok",
      latest: null,
      recentFailures: [],
      message: "not configured"
    },
    contentRecommendations: [],
    thresholds
  });
  const checkout = buildAgentDailyCheckout({
    severity: "critical",
    pendingApprovals: { count: 2, highRiskCount: 1, staleCount: 1 },
    approvalGateSummary: { blockCount: 1, reviewCount: 0 },
    failedRuns: { count: 0 },
    apiErrors: { total: thresholds.apiErrorsCritical },
    aiUsage: { totalRequests: 0, totalCostUsd: 0 },
    readinessStatus: "ok",
    rolloutStatus: "pass",
    deploymentSeverity: "ok",
    nextActions: actions,
    latestReport: { item: { title: "self-test sample" } }
  });
  const topAction = actions[0];
  const issues = [
    !topAction ? "missing next action" : null,
    topAction && topAction.urgencyScore < 1 ? "next action urgency score missing" : null,
    topAction && !topAction.checklist.length ? "next action checklist missing" : null,
    checkout.status !== "blocked" ? `checkout expected blocked, got ${checkout.status}` : null,
    !checkout.openRisks.some((risk) => risk.includes("Execution Gate")) ? "checkout missing Execution Gate risk" : null,
    !checkout.handoffPrompt ? "checkout handoff prompt missing" : null
  ].filter(Boolean);

  return {
    id: "workflow:decision-support",
    label: "Decision support workflow",
    status: issues.length ? "critical" as const : "ok" as const,
    message: issues.length
      ? `decision support invariant failed: ${issues.join(", ")}`
      : "next best actions and daily checkout produce scored, checklist-backed operator guidance"
  };
}

function checkActionBoardWorkflow() {
  const thresholds = getAgentThresholds();
  const actions = buildNextBestActions({
    pendingApprovals: 3,
    staleApprovals: 1,
    highRiskApprovals: 1,
    failedRuns: 0,
    apiErrors: thresholds.apiErrorsCritical,
    aiCost: 0,
    readinessStatus: "ok",
    rolloutStatus: "pass",
    deploymentHealth: {
      provider: "vercel",
      configured: false,
      severity: "ok",
      latest: null,
      recentFailures: [],
      message: "not configured"
    },
    contentRecommendations: [],
    thresholds
  });
  const checkout = buildAgentDailyCheckout({
    severity: "critical",
    pendingApprovals: { count: 3, highRiskCount: 1, staleCount: 1 },
    approvalGateSummary: { blockCount: 1, reviewCount: 0 },
    failedRuns: { count: 0 },
    apiErrors: { total: thresholds.apiErrorsCritical },
    aiUsage: { totalRequests: 0, totalCostUsd: 0 },
    readinessStatus: "ok",
    rolloutStatus: "pass",
    deploymentSeverity: "ok",
    nextActions: actions,
    latestReport: { item: { title: "self-test sample" } }
  });
  const board = buildTodayActionBoard({
    dailyCheckout: checkout,
    nextActions: actions,
    approvalGateSummary: { blockCount: 1, reviewCount: 0 },
    pendingApprovals: { count: 3, highRiskCount: 1, staleCount: 1 },
    latestReport: { item: { title: "self-test sample" } }
  });
  const issues = [
    board.status !== "blocked" ? `action board expected blocked, got ${board.status}` : null,
    !board.primaryPrompt ? "primary prompt missing" : null,
    !board.lanes.doNow.some((item) => item.id === "resolve-approval-gate-blocks") ? "do now lane missing approval gate block item" : null,
    !board.lanes.review.length ? "review lane missing" : null,
    board.lanes.doNow.some((item) => item.score < 1) ? "do now item score missing" : null
  ].filter(Boolean);

  return {
    id: "workflow:today-action-board",
    label: "Today Action Board workflow",
    status: issues.length ? "critical" as const : "ok" as const,
    message: issues.length
      ? `today action board invariant failed: ${issues.join(", ")}`
      : "today action board produces do-now/review/watch/save lanes with a primary prompt"
  };
}

function checkMemoryLearningWorkflow() {
  const suggestions = buildMemorySuggestions({
    apiErrors: { total: 3, latest: [{ route: "/api/pubg/player", status: 429 }] },
    aiUsage: { totalCostUsd: 0.25 },
    pendingApprovals: { count: 2, highRiskCount: 1, staleCount: 1 },
    approvalGateSummary: {
      blockCount: 1,
      items: [{
        title: "identity mismatch 정리",
        actionType: "repair_processed_telemetry_identity",
        gate: { reasons: ["identity mismatch 삭제 대상 targets가 없습니다."] }
      }]
    },
    failedRuns: { count: 1 },
    deploymentHealth: { severity: "critical", message: "recent deployment failed" },
    memories: { items: [] }
  });
  const issues = [
    !suggestions.length ? "missing memory suggestions" : null,
    !suggestions.some((item) => item.id === "learn-approval-gate-policy") ? "missing approval gate learning suggestion" : null,
    !suggestions.some((item) => item.prompt.includes("memory 저장 승인 요청")) ? "suggestion prompt does not route through approval" : null,
    suggestions.some((item) => !item.tags.length) ? "suggestion tags missing" : null,
    suggestions.some((item) => !item.evidence.length) ? "suggestion evidence missing" : null
  ].filter(Boolean);

  return {
    id: "workflow:memory-learning",
    label: "Memory learning workflow",
    status: issues.length ? "critical" as const : "ok" as const,
    message: issues.length
      ? `memory learning invariant failed: ${issues.join(", ")}`
      : "learning suggestions propose approval-backed memories with tags and evidence"
  };
}

function checkAgentApiSurface() {
  const expectedRoutes = [
    "/api/admin/agent/command-center",
    "POST /api/admin/agent/command-center",
    "/api/admin/agent/monitor",
    "/api/admin/agent/approvals",
    "/api/admin/agent/briefing",
    "/api/admin/agent/handoff",
    "/api/admin/agent/incidents",
    "/api/admin/agent/memories",
    "/api/admin/agent/rollout",
    "/api/admin/agent/tools"
  ];

  return {
    id: "workflow:api-surface",
    label: "Agent API surface",
    status: "ok" as const,
    message: `${expectedRoutes.length} admin agent routes expected: ${expectedRoutes.join(", ")}`
  };
}

function getOverallStatus(checks: AgentSelfTest["checks"]): AgentSelfTestStatus {
  if (checks.some((check) => check.status === "critical")) return "critical";
  if (checks.some((check) => check.status === "warn")) return "warn";
  return "ok";
}
