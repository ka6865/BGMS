type RunLike = {
  id: string;
  status: string;
  message: string;
  summary?: string | null;
  error?: string | null;
  started_at?: string | null;
  completed_at?: string | null;
};

type StepLike = {
  tool_name: string;
  safety_level: string;
  status: string;
  params?: Record<string, any> | null;
  result?: string | null;
  error?: string | null;
  started_at?: string | null;
  completed_at?: string | null;
};

type ApprovalLike = {
  id: string;
  action_type: string;
  status: string;
  payload?: Record<string, any> | null;
  result?: string | null;
  error?: string | null;
  created_at?: string | null;
  decided_at?: string | null;
  executed_at?: string | null;
};

export function buildAgentRunTimeline(input: {
  run: RunLike;
  steps: StepLike[];
  approvals: ApprovalLike[];
}) {
  const { run, steps, approvals } = input;
  const lines = [
    `# BGMS Agent Run Timeline`,
    "",
    `- Run ID: ${run.id}`,
    `- Status: ${run.status}`,
    `- Message: ${run.message}`,
    `- Started: ${formatDate(run.started_at)}`,
    `- Completed: ${formatDate(run.completed_at)}`,
    ...(run.summary ? [`- Summary: ${trimText(run.summary, 500)}`] : []),
    ...(run.error ? [`- Error: ${trimText(run.error, 500)}`] : []),
    "",
    "## Steps",
    ...(steps.length
      ? steps.flatMap((step, index) => renderStep(step, index + 1))
      : ["- No recorded tool steps."]),
    "",
    "## Approvals",
    ...(approvals.length
      ? approvals.flatMap((approval, index) => renderApproval(approval, index + 1))
      : ["- No approval requests linked to this run."]),
    "",
    "## Operator Notes",
    "- 확인 위치: `/admin/dashboard?section=approvals` 승인 대기 및 최근 실행 기록",
    "- 위험 작업은 승인 이력과 impact/result를 함께 확인하세요."
  ];

  return lines.join("\n");
}

function renderStep(step: StepLike, index: number) {
  return [
    `### ${index}. ${step.tool_name}`,
    `- Safety: ${step.safety_level}`,
    `- Status: ${step.status}`,
    `- Started: ${formatDate(step.started_at)}`,
    `- Completed: ${formatDate(step.completed_at)}`,
    `- Params: ${safeJson(step.params || {})}`,
    ...(step.result ? [`- Result: ${trimText(step.result, 800)}`] : []),
    ...(step.error ? [`- Error: ${trimText(step.error, 800)}`] : []),
    ""
  ];
}

function renderApproval(approval: ApprovalLike, index: number) {
  const parsedResult = parseJson(approval.result);
  const decision = parsedResult && typeof parsedResult === "object" ? (parsedResult as any).decision : null;
  const postExecution = parsedResult && typeof parsedResult === "object" ? (parsedResult as any).postExecution : null;
  return [
    `### ${index}. ${approval.action_type}`,
    `- Approval ID: ${approval.id}`,
    `- Status: ${approval.status}`,
    `- Created: ${formatDate(approval.created_at)}`,
    `- Decided: ${formatDate(approval.decided_at)}`,
    `- Executed: ${formatDate(approval.executed_at)}`,
    ...(decision ? [
      `- Approved By: ${decision.approvedBy || "-"}`,
      `- Approval Note: ${decision.approvalNote || "-"}`,
      `- High Risk: ${decision.highRisk ? "yes" : "no"}`,
      `- Impact Confirmed: ${decision.confirmedImpact ? "yes" : "no"}`
    ] : []),
    ...(postExecution ? [
      `- Outcome: ${postExecution.outcome || "-"}`,
      `- Follow-up: ${Array.isArray(postExecution.followUp) ? postExecution.followUp.join(" / ") : "-"}`,
      `- Related Resource: ${postExecution.audit?.relatedResource || "-"}`
    ] : []),
    `- Payload: ${safeJson(approval.payload || {})}`,
    ...(approval.result ? [`- Result: ${trimText(approval.result, 800)}`] : []),
    ...(approval.error ? [`- Error: ${trimText(approval.error, 800)}`] : []),
    ""
  ];
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

function safeJson(value: unknown) {
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

function trimText(value: string, limit: number) {
  const text = String(value).replace(/\s+/g, " ").trim();
  return text.length > limit ? `${text.slice(0, limit)}...` : text;
}
