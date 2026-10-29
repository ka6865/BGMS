import { fetchApprovalQueueSummary } from "@/lib/admin-agent/approvals";
import { buildIncidentTimeline } from "@/lib/admin-agent/incident-timeline";
import { buildAgentRolloutReadiness } from "@/lib/admin-agent/rollout";
import { runAgentSelfTest } from "@/lib/admin-agent/self-test";
import { getAgentThresholds } from "@/lib/admin-agent/thresholds";

export type AgentHandoffPacket = {
  generatedAt: string;
  windowHours: number;
  severity: "ok" | "warn" | "critical";
  latestRun: any;
  latestReport: any;
  pendingApprovals: Awaited<ReturnType<typeof fetchApprovalQueueSummary>>;
  readiness: Awaited<ReturnType<typeof runAgentSelfTest>>;
  rollout: Awaited<ReturnType<typeof buildAgentRolloutReadiness>>;
  incidentTimeline: Awaited<ReturnType<typeof buildIncidentTimeline>>;
  markdown: string;
};

export async function buildAgentHandoffPacket(
  supabase: any,
  input: { hours?: number } = {}
): Promise<AgentHandoffPacket> {
  const thresholds = getAgentThresholds();
  const windowHours = Math.min(Math.max(Number(input.hours || thresholds.windowHours || 24), 1), 168);
  const [latestRun, latestReport, pendingApprovals, readiness, rollout, incidentTimeline] = await Promise.all([
    fetchLatestRun(supabase),
    fetchLatestReport(supabase),
    fetchApprovalQueueSummary(supabase),
    runAgentSelfTest(supabase),
    buildAgentRolloutReadiness(supabase),
    buildIncidentTimeline(supabase, { hours: windowHours, limit: 80 })
  ]);

  const severity = getHandoffSeverity({
    pendingApprovals,
    readiness,
    rollout,
    incidentTimeline
  });
  const packet: AgentHandoffPacket = {
    generatedAt: new Date().toISOString(),
    windowHours,
    severity,
    latestRun,
    latestReport,
    pendingApprovals,
    readiness,
    rollout,
    incidentTimeline,
    markdown: ""
  };

  packet.markdown = buildHandoffMarkdown(packet);
  return packet;
}

export function buildHandoffMarkdown(packet: Omit<AgentHandoffPacket, "markdown">) {
  return [
    "# BGMS Agent Handoff Packet",
    "",
    `- Generated: ${formatDate(packet.generatedAt)}`,
    `- Window: ${packet.windowHours}h`,
    `- Severity: ${packet.severity}`,
    `- Pending approvals: ${packet.pendingApprovals.count} (high ${packet.pendingApprovals.highRiskCount}, stale ${packet.pendingApprovals.staleCount})`,
    `- Incident events: ${packet.incidentTimeline.summary.totalEvents} (critical ${packet.incidentTimeline.summary.criticalEvents}, warn ${packet.incidentTimeline.summary.warnEvents})`,
    `- Readiness/Rollout: ${packet.readiness.status} / ${packet.rollout.status}`,
    "",
    "## Latest Agent Run",
    ...formatLatestRun(packet.latestRun),
    "",
    "## Approval Queue",
    ...(packet.pendingApprovals.items.length
      ? packet.pendingApprovals.items.slice(0, 8).map((approval) => {
        const label = approval.payload?.title || approval.payload?.cleanupType || approval.action_type;
        return `- [${approval.priority}${approval.isStale ? ", stale" : ""}] ${approval.action_type}: ${label} (${approval.ageHours}h) /admin/bot?approval=${approval.id}`;
      })
      : ["- No pending approvals."]),
    "",
    "## Latest Saved Report",
    ...(packet.latestReport
      ? [
        `- ${packet.latestReport.title || "Untitled report"}`,
        `- Updated: ${formatDate(packet.latestReport.updated_at)}`,
        `- Preview: ${trimText(packet.latestReport.body, 260)}`
      ]
      : ["- No saved report."]),
    "",
    "## Readiness Issues",
    ...formatReadinessIssues(packet.readiness, packet.rollout),
    "",
    "## Incident Timeline",
    ...(packet.incidentTimeline.events.length
      ? packet.incidentTimeline.events.slice(0, 12).map((event) => `- ${formatDate(event.at)} [${event.severity}] ${event.source}: ${event.title} - ${event.detail}${event.link ? ` (${event.link})` : ""}`)
      : ["- No incident events in this window."]),
    "",
    "## Recommended Follow-up",
    ...buildFollowUp(packet),
    "",
    "확인 위치: `/admin/dashboard`"
  ].join("\n");
}

async function fetchLatestRun(supabase: any) {
  const { data, error } = await supabase
    .from("agent_runs")
    .select("id, status, message, summary, error, started_at, completed_at")
    .order("started_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (error) return { error: error.message };
  return data || null;
}

async function fetchLatestReport(supabase: any) {
  const { data, error } = await supabase
    .from("agent_memories")
    .select("id, title, body, metadata, updated_at")
    .eq("category", "report")
    .order("updated_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (error || data?.metadata?.active === false) return null;
  return data || null;
}

function getHandoffSeverity(input: {
  pendingApprovals: AgentHandoffPacket["pendingApprovals"];
  readiness: AgentHandoffPacket["readiness"];
  rollout: AgentHandoffPacket["rollout"];
  incidentTimeline: AgentHandoffPacket["incidentTimeline"];
}): AgentHandoffPacket["severity"] {
  if (
    input.incidentTimeline.severity === "critical" ||
    input.readiness.status === "critical" ||
    input.rollout.status === "fail" ||
    input.pendingApprovals.staleCount > 0
  ) return "critical";
  if (
    input.incidentTimeline.severity === "warn" ||
    input.readiness.status === "warn" ||
    input.rollout.status === "warn" ||
    input.pendingApprovals.count > 0
  ) return "warn";
  return "ok";
}

function formatLatestRun(run: any) {
  if (!run) return ["- No recent agent run."];
  if (run.error && !run.id) return [`- Error: ${run.error}`];
  return [
    `- Status: ${run.status || "unknown"}`,
    `- Message: ${trimText(run.message, 220)}`,
    `- Started: ${formatDate(run.started_at)}`,
    `- Summary: ${trimText(run.summary || run.error, 260)}`,
    ...(run.id ? [`- Detail: /admin/bot?run=${run.id}`] : [])
  ];
}

function formatReadinessIssues(readiness: any, rollout: any) {
  const readinessIssues = (readiness?.checks || [])
    .filter((check: any) => check.status && check.status !== "ok")
    .slice(0, 5)
    .map((check: any) => `- Agent [${check.status}] ${check.label}: ${check.message}`);
  const rolloutIssues = (rollout?.checks || [])
    .filter((check: any) => check.status && check.status !== "pass")
    .slice(0, 5)
    .map((check: any) => `- Rollout [${check.status}] ${check.label}: ${check.message}`);
  if (!readinessIssues.length && !rolloutIssues.length) return ["- No readiness issues."];
  return [...readinessIssues, ...rolloutIssues];
}

function buildFollowUp(packet: Omit<AgentHandoffPacket, "markdown">) {
  const followUp = [];
  if (packet.incidentTimeline.summary.criticalEvents > 0) followUp.push("사고 타임라인의 critical event부터 원인과 조치 여부를 확인하세요.");
  if (packet.pendingApprovals.highRiskCount > 0) followUp.push("고위험 approval은 impact/preview를 확인하고 승인 메모를 남기세요.");
  if (packet.pendingApprovals.staleCount > 0) followUp.push("오래된 approval은 필요 여부를 재검토하고 중복이면 거절하세요.");
  if (packet.readiness.status !== "ok" || packet.rollout.status !== "pass") followUp.push("readiness/rollout issue를 먼저 해소한 뒤 배포나 위험 작업을 진행하세요.");
  if (!followUp.length) followUp.push("현재 handoff 기준 큰 위험 신호가 없습니다. 정상 운영 리포트 저장을 검토하세요.");
  return followUp.map((item) => `- ${item}`);
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

function trimText(value?: string | null, maxLength = 160) {
  const normalized = String(value || "").replace(/\s+/g, " ").trim();
  if (!normalized) return "-";
  return normalized.length > maxLength ? `${normalized.slice(0, maxLength - 1)}...` : normalized;
}
