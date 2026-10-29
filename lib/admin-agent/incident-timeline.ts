export type IncidentTimelineEvent = {
  id: string;
  at: string;
  source: "agent_run" | "agent_step" | "approval" | "pubg_api_error";
  severity: "ok" | "warn" | "critical";
  title: string;
  detail: string;
  link?: string;
};

export type IncidentTimeline = {
  generatedAt: string;
  windowHours: number;
  severity: "ok" | "warn" | "critical";
  summary: {
    totalEvents: number;
    criticalEvents: number;
    warnEvents: number;
    failedRuns: number;
    failedSteps: number;
    apiErrors: number;
    approvals: number;
  };
  events: IncidentTimelineEvent[];
  recommendations: string[];
  markdown: string;
};

export async function buildIncidentTimeline(
  supabase: any,
  input: { hours?: number; limit?: number } = {}
): Promise<IncidentTimeline> {
  const windowHours = Math.min(Math.max(Number(input.hours || 24), 1), 168);
  const limit = Math.min(Math.max(Number(input.limit || 80), 10), 200);
  const since = new Date(Date.now() - windowHours * 60 * 60 * 1000).toISOString();

  const [runsResult, stepsResult, approvalsResult, apiErrorsResult] = await Promise.all([
    supabase
      .from("agent_runs")
      .select("id, status, message, summary, error, started_at, completed_at")
      .gte("started_at", since)
      .order("started_at", { ascending: false })
      .limit(limit),
    supabase
      .from("agent_steps")
      .select("id, run_id, tool_name, safety_level, status, error, started_at, completed_at")
      .gte("started_at", since)
      .order("started_at", { ascending: false })
      .limit(limit),
    supabase
      .from("agent_approvals")
      .select("id, run_id, action_type, status, payload, result, error, created_at, decided_at, executed_at")
      .gte("created_at", since)
      .order("created_at", { ascending: false })
      .limit(limit),
    supabase
      .from("pubg_api_errors")
      .select("route, status, message, created_at")
      .gte("created_at", since)
      .order("created_at", { ascending: false })
      .limit(limit)
  ]);

  const events = [
    ...eventsFromRuns(runsResult.data || [], runsResult.error),
    ...eventsFromSteps(stepsResult.data || [], stepsResult.error),
    ...eventsFromApprovals(approvalsResult.data || [], approvalsResult.error),
    ...eventsFromApiErrors(apiErrorsResult.data || [], apiErrorsResult.error)
  ]
    .filter((event) => event.at)
    .sort((a, b) => new Date(b.at).getTime() - new Date(a.at).getTime())
    .slice(0, limit);

  const summary = {
    totalEvents: events.length,
    criticalEvents: events.filter((event) => event.severity === "critical").length,
    warnEvents: events.filter((event) => event.severity === "warn").length,
    failedRuns: (runsResult.data || []).filter((run: any) => run.status === "failed").length,
    failedSteps: (stepsResult.data || []).filter((step: any) => step.status === "failed").length,
    apiErrors: (apiErrorsResult.data || []).length,
    approvals: (approvalsResult.data || []).length
  };
  const severity: IncidentTimeline["severity"] = summary.criticalEvents > 0 ? "critical" : summary.warnEvents > 0 ? "warn" : "ok";
  const timeline: IncidentTimeline = {
    generatedAt: new Date().toISOString(),
    windowHours,
    severity,
    summary,
    events,
    recommendations: buildRecommendations(summary),
    markdown: ""
  };

  timeline.markdown = buildIncidentTimelineMarkdown(timeline);
  return timeline;
}

export function buildIncidentTimelineMarkdown(timeline: Omit<IncidentTimeline, "markdown">) {
  const lines = [
    "# BGMS Incident Timeline",
    "",
    `- Generated: ${formatDate(timeline.generatedAt)}`,
    `- Window: ${timeline.windowHours}h`,
    `- Severity: ${timeline.severity}`,
    `- Events: ${timeline.summary.totalEvents}`,
    `- Critical/Warn: ${timeline.summary.criticalEvents}/${timeline.summary.warnEvents}`,
    `- Failed runs/steps: ${timeline.summary.failedRuns}/${timeline.summary.failedSteps}`,
    `- PUBG API errors: ${timeline.summary.apiErrors}`,
    `- Approvals touched: ${timeline.summary.approvals}`,
    "",
    "## Timeline",
    ...(timeline.events.length
      ? timeline.events.map((event) => `- ${formatDate(event.at)} [${event.severity}] ${event.source}: ${event.title} - ${event.detail}${event.link ? ` (${event.link})` : ""}`)
      : ["- No incident events in this window."]),
    "",
    "## Recommended Follow-up",
    ...(timeline.recommendations.length ? timeline.recommendations.map((item) => `- ${item}`) : ["- No follow-up required."]),
    "",
    "확인 위치: `/admin/dashboard` 운영 상태, 승인 대기, 최근 실행 기록"
  ];

  return lines.join("\n");
}

function eventsFromRuns(rows: any[], error?: any): IncidentTimelineEvent[] {
  if (error) return [errorEvent("agent-runs-query", "agent_run", "Agent run 조회 실패", error.message || String(error))];
  return rows.map((run) => ({
    id: `run:${run.id}`,
    at: run.started_at || run.completed_at,
    source: "agent_run" as const,
    severity: run.status === "failed" ? "critical" as const : run.status === "running" ? "warn" as const : "ok" as const,
    title: trimText(run.message || run.id, 120),
    detail: trimText(run.error || run.summary || run.status || "-", 180),
    link: run.id ? `/admin/bot?run=${run.id}` : undefined
  }));
}

function eventsFromSteps(rows: any[], error?: any): IncidentTimelineEvent[] {
  if (error) return [errorEvent("agent-steps-query", "agent_step", "Agent step 조회 실패", error.message || String(error))];
  return rows
    .filter((step) => step.status === "failed" || step.safety_level === "dangerous")
    .map((step) => ({
      id: `step:${step.id}`,
      at: step.started_at || step.completed_at,
      source: "agent_step" as const,
      severity: step.status === "failed" ? "critical" as const : "warn" as const,
      title: step.tool_name || "unknown tool",
      detail: trimText(step.error || `${step.safety_level} tool ${step.status}`, 180),
      link: step.run_id ? `/admin/bot?run=${step.run_id}` : undefined
    }));
}

function eventsFromApprovals(rows: any[], error?: any): IncidentTimelineEvent[] {
  if (error) return [errorEvent("agent-approvals-query", "approval", "Approval 조회 실패", error.message || String(error))];
  return rows.map((approval) => {
    const parsedResult = parseJson(approval.result);
    const outcome = parsedResult && typeof parsedResult === "object"
      ? (parsedResult as any).postExecution?.outcome || (parsedResult as any).execution?.message
      : null;
    return {
      id: `approval:${approval.id}`,
      at: approval.executed_at || approval.decided_at || approval.created_at,
      source: "approval" as const,
      severity: approval.status === "failed" ? "critical" as const : approval.status === "pending" ? "warn" as const : "ok" as const,
      title: approval.action_type || "approval",
      detail: trimText(approval.error || outcome || approval.payload?.reason || approval.status || "-", 180),
      link: approval.id ? `/admin/bot?approval=${approval.id}` : undefined
    };
  });
}

function eventsFromApiErrors(rows: any[], error?: any): IncidentTimelineEvent[] {
  if (error) return [errorEvent("pubg-api-errors-query", "pubg_api_error", "PUBG API error 조회 실패", error.message || String(error))];
  return rows.map((row, index) => ({
    id: `pubg-api-error:${row.created_at || index}`,
    at: row.created_at,
    source: "pubg_api_error" as const,
    severity: "critical" as const,
    title: `${row.route || "unknown route"} ${row.status || ""}`.trim(),
    detail: trimText(row.message || "PUBG API error", 180)
  }));
}

function errorEvent(
  id: string,
  source: IncidentTimelineEvent["source"],
  title: string,
  detail: string
): IncidentTimelineEvent {
  return {
    id,
    at: new Date().toISOString(),
    source,
    severity: "warn",
    title,
    detail
  };
}

function buildRecommendations(summary: IncidentTimeline["summary"]) {
  const recommendations = [];
  if (summary.apiErrors > 0) recommendations.push("PUBG API error route/status별 원인을 먼저 확인하고 quota 상태를 점검하세요.");
  if (summary.failedRuns > 0 || summary.failedSteps > 0) recommendations.push("실패한 agent run의 Timeline Export를 열어 tool params/result를 확인하세요.");
  if (summary.approvals > 0) recommendations.push("사고 시간대 승인/거절/실행된 approval의 impact와 result를 함께 대조하세요.");
  if (!recommendations.length) recommendations.push("최근 창에서 사고성 이벤트가 없습니다. 정상 운영 리포트로 저장할 수 있습니다.");
  return recommendations;
}

function parseJson(value?: string | null) {
  if (!value) return null;
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

function formatDate(value?: string | null) {
  if (!value) return "-";
  return new Date(value).toLocaleString("ko-KR", {
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit"
  });
}

function trimText(value: string, limit: number) {
  const text = String(value || "").replace(/\s+/g, " ").trim();
  return text.length > limit ? `${text.slice(0, limit - 1)}...` : text;
}
