export type AgentOperatingModeName = "normal" | "watch" | "incident" | "approval_review" | "deploy_guard";

export type AgentOperatingMode = {
  mode: AgentOperatingModeName;
  label: string;
  score: number;
  summary: string;
  reasons: string[];
  primaryAction: {
    label: string;
    prompt: string;
  };
  guardrails: string[];
};

type OperatingModeInput = {
  severity: "ok" | "warn" | "critical";
  pendingApprovals: {
    count: number;
    highRiskCount?: number;
    staleCount?: number;
  };
  failedRuns: { count: number };
  apiErrors: { total: number };
  aiUsage: { totalCostUsd: number };
  readinessStatus?: "ok" | "warn" | "critical";
  rolloutStatus?: "pass" | "warn" | "fail" | "block";
  deploymentSeverity?: "ok" | "warn" | "critical";
  thresholds: {
    aiCostWarnUsd: number;
    aiCostCriticalUsd: number;
  };
};

export function buildAgentOperatingMode(input: OperatingModeInput): AgentOperatingMode {
  const reasons = buildReasons(input);
  const score = calculateAttentionScore(input);
  const mode = chooseMode(input);

  return {
    mode,
    label: getModeLabel(mode),
    score,
    summary: buildModeSummary(mode, score, reasons),
    reasons,
    primaryAction: getPrimaryAction(mode),
    guardrails: buildGuardrails(input, mode)
  };
}

function chooseMode(input: OperatingModeInput): AgentOperatingModeName {
  if (input.deploymentSeverity === "critical" || input.rolloutStatus === "fail" || input.rolloutStatus === "block") return "deploy_guard";
  if (input.severity === "critical" || input.apiErrors.total > 0 || input.failedRuns.count > 0) return "incident";
  if ((input.pendingApprovals.highRiskCount || 0) > 0 || (input.pendingApprovals.staleCount || 0) > 0) return "approval_review";
  if (
    input.severity === "warn"
    || input.deploymentSeverity === "warn"
    || input.readinessStatus === "warn"
    || input.rolloutStatus === "warn"
    || input.aiUsage.totalCostUsd >= input.thresholds.aiCostWarnUsd
    || input.pendingApprovals.count > 0
  ) {
    return "watch";
  }
  return "normal";
}

function calculateAttentionScore(input: OperatingModeInput) {
  const score =
    (input.severity === "critical" ? 35 : input.severity === "warn" ? 15 : 0)
    + Math.min(input.apiErrors.total * 8, 24)
    + Math.min(input.failedRuns.count * 10, 20)
    + Math.min(input.pendingApprovals.count * 4, 16)
    + Math.min((input.pendingApprovals.highRiskCount || 0) * 12, 24)
    + Math.min((input.pendingApprovals.staleCount || 0) * 8, 16)
    + (input.deploymentSeverity === "critical" ? 30 : input.deploymentSeverity === "warn" ? 12 : 0)
    + (input.rolloutStatus === "fail" || input.rolloutStatus === "block" ? 20 : input.rolloutStatus === "warn" ? 8 : 0)
    + (input.readinessStatus === "critical" ? 18 : input.readinessStatus === "warn" ? 8 : 0)
    + (input.aiUsage.totalCostUsd >= input.thresholds.aiCostCriticalUsd ? 18 : input.aiUsage.totalCostUsd >= input.thresholds.aiCostWarnUsd ? 8 : 0);

  return Math.min(Math.max(score, 0), 100);
}

function buildReasons(input: OperatingModeInput) {
  const reasons = [
    ...(input.apiErrors.total > 0 ? [`PUBG API 에러 ${input.apiErrors.total.toLocaleString("ko-KR")}건`] : []),
    ...(input.failedRuns.count > 0 ? [`실패한 agent run ${input.failedRuns.count.toLocaleString("ko-KR")}건`] : []),
    ...((input.pendingApprovals.highRiskCount || 0) > 0 ? [`고위험 승인 ${input.pendingApprovals.highRiskCount}건`] : []),
    ...((input.pendingApprovals.staleCount || 0) > 0 ? [`오래된 승인 ${input.pendingApprovals.staleCount}건`] : []),
    ...(input.pendingApprovals.count > 0 && !(input.pendingApprovals.highRiskCount || input.pendingApprovals.staleCount) ? [`승인 대기 ${input.pendingApprovals.count}건`] : []),
    ...(input.deploymentSeverity && input.deploymentSeverity !== "ok" ? [`배포 상태 ${input.deploymentSeverity}`] : []),
    ...(input.readinessStatus && input.readinessStatus !== "ok" ? [`Agent readiness ${input.readinessStatus}`] : []),
    ...(input.rolloutStatus && input.rolloutStatus !== "pass" ? [`Rollout ${input.rolloutStatus}`] : []),
    ...(input.aiUsage.totalCostUsd >= input.thresholds.aiCostWarnUsd ? [`AI 비용 $${input.aiUsage.totalCostUsd.toFixed(4)}`] : [])
  ];

  return reasons.length ? reasons : ["위험 신호 없음"];
}

function getModeLabel(mode: AgentOperatingModeName) {
  if (mode === "incident") return "장애 대응 모드";
  if (mode === "approval_review") return "승인 검토 모드";
  if (mode === "deploy_guard") return "배포 보호 모드";
  if (mode === "watch") return "관찰 강화 모드";
  return "정상 운영 모드";
}

function buildModeSummary(mode: AgentOperatingModeName, score: number, reasons: string[]) {
  if (mode === "normal") return `Attention ${score}/100. 정상 운영 범위입니다.`;
  return `Attention ${score}/100. ${reasons.slice(0, 3).join(", ")} 우선 확인이 필요합니다.`;
}

function getPrimaryAction(mode: AgentOperatingModeName) {
  if (mode === "incident") {
    return { label: "사고 원인 분석", prompt: "최근 24시간 사고 타임라인을 요약하고 원인 후보와 조치 우선순위를 정리해줘" };
  }
  if (mode === "approval_review") {
    return { label: "승인 대기 검토", prompt: "승인 대기 작업을 impact 기준으로 검토해줘" };
  }
  if (mode === "deploy_guard") {
    return { label: "배포 보호 점검", prompt: "최근 Vercel 배포 실패 원인을 분석하고 rollout readiness를 점검해줘" };
  }
  if (mode === "watch") {
    return { label: "운영 브리핑", prompt: "오늘 운영 브리핑 해줘" };
  }
  return { label: "정기 브리핑", prompt: "오늘 운영 브리핑을 리포트로 저장 요청해줘" };
}

function buildGuardrails(input: OperatingModeInput, mode: AgentOperatingModeName) {
  const guardrails = [
    "삭제/발행/초기화는 승인 대기열을 거친다.",
    "정상 상태에서는 Discord 알림을 보내지 않는다."
  ];

  if (mode === "incident") guardrails.push("장애 대응 중에는 데이터 정리 승인보다 원인 로그와 quota 확인을 먼저 한다.");
  if (mode === "approval_review") guardrails.push("고위험 승인은 impact 재계산과 승인 메모를 남긴 뒤 실행한다.");
  if (mode === "deploy_guard") guardrails.push("배포 보호 모드에서는 rollout block 항목 해소 전 위험 작업을 미룬다.");
  if (input.aiUsage.totalCostUsd >= input.thresholds.aiCostWarnUsd) guardrails.push("AI 비용 상승 시 긴 분석/콘텐츠 생성 요청은 수동 확인 후 진행한다.");

  return guardrails;
}
