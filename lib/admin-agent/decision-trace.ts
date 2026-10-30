export type AgentDecisionTraceConfidence = "high" | "medium" | "low";

export interface AgentDecisionTraceObservation {
  id: string;
  label: string;
  value: string;
  source: string;
  weight: "high" | "medium" | "low";
}

export interface AgentDecisionTraceDecision {
  id: string;
  title: string;
  conclusion: string;
  basedOn: string[];
  confidence: AgentDecisionTraceConfidence;
  nextCheck: string;
  prompt: string;
}

export interface AgentDecisionTrace {
  generatedAt: string;
  confidence: AgentDecisionTraceConfidence;
  summary: string;
  observations: AgentDecisionTraceObservation[];
  decisions: AgentDecisionTraceDecision[];
  blindSpots: string[];
  verifyNext: string[];
}

export function buildAgentDecisionTrace(input: {
  severity: "ok" | "warn" | "critical";
  operatingMode?: any;
  ownerBrief?: any;
  dailyCheckout?: any;
  todayActionBoard?: any;
  riskRadar?: any;
  operatingSop?: any;
  pendingApprovals?: { count?: number; highRiskCount?: number; staleCount?: number };
  approvalGateSummary?: { blockCount?: number; reviewCount?: number; passCount?: number };
  failedRuns?: { count?: number; error?: string };
  apiErrors?: { total?: number; error?: string };
  aiUsage?: { totalRequests?: number; totalCostUsd?: number; error?: string };
  latestMonitorSnapshot?: { item?: any; error?: string };
  monitorTrend?: { direction?: string; label?: string; sampleSize?: number; error?: string };
  readiness?: { status?: string };
  rollout?: { status?: string };
  deploymentHealth?: { configured?: boolean; severity?: string; message?: string };
  contentPerformance?: { totalPosts?: number; topPost?: any; error?: string };
  memories?: { items?: any[]; error?: string };
  latestReport?: { item?: any; error?: string };
}): AgentDecisionTrace {
  const observations = buildObservations(input);
  const decisions = buildDecisions(input, observations);
  const blindSpots = buildBlindSpots(input);
  const confidence = getConfidence(input, observations, blindSpots);

  return {
    generatedAt: new Date().toISOString(),
    confidence,
    summary: buildSummary(confidence, decisions, blindSpots),
    observations,
    decisions,
    blindSpots,
    verifyNext: buildVerifyNext(input, decisions, blindSpots)
  };
}

function buildObservations(input: Parameters<typeof buildAgentDecisionTrace>[0]): AgentDecisionTraceObservation[] {
  const observations: AgentDecisionTraceObservation[] = [
    observation("severity", "Severity", input.severity, "command-center severity", "high"),
    observation(
      "approvals",
      "Approval Queue",
      `${Number(input.pendingApprovals?.count || 0)} pending, high ${Number(input.pendingApprovals?.highRiskCount || 0)}, stale ${Number(input.pendingApprovals?.staleCount || 0)}`,
      "agent_approvals summary",
      Number(input.pendingApprovals?.count || 0) > 0 ? "high" : "medium"
    ),
    observation(
      "gate",
      "Execution Gate",
      `pass ${Number(input.approvalGateSummary?.passCount || 0)}, review ${Number(input.approvalGateSummary?.reviewCount || 0)}, block ${Number(input.approvalGateSummary?.blockCount || 0)}`,
      "approval impact/gate calculation",
      Number(input.approvalGateSummary?.blockCount || 0) > 0 ? "high" : "medium"
    ),
    observation(
      "checkout",
      "Daily Checkout",
      `${input.dailyCheckout?.label || input.dailyCheckout?.status || "unknown"} (${Number(input.dailyCheckout?.score || 0)}/100)`,
      "daily checkout calculation",
      input.dailyCheckout?.status === "blocked" ? "high" : "medium"
    ),
    observation(
      "risk-radar",
      "Risk Radar",
      `${input.riskRadar?.status || "unknown"} (${Number(input.riskRadar?.score || 0)}/100)`,
      "risk radar calculation",
      input.riskRadar?.status === "act" ? "high" : "medium"
    ),
    observation(
      "monitor-trend",
      "Monitor Trend",
      `${input.monitorTrend?.label || input.monitorTrend?.direction || "unknown"} (${Number(input.monitorTrend?.sampleSize || 0)} samples)`,
      "recent agent monitor snapshots",
      Number(input.monitorTrend?.sampleSize || 0) >= 2 ? "medium" : "low"
    ),
    observation(
      "readiness",
      "Readiness",
      `agent ${input.readiness?.status || "unknown"}, rollout ${input.rollout?.status || "unknown"}`,
      "self-test and rollout readiness",
      input.readiness?.status !== "ok" || input.rollout?.status !== "pass" ? "high" : "medium"
    ),
    observation(
      "signals",
      "Incident Signals",
      `API errors ${Number(input.apiErrors?.total || 0)}, failed runs ${Number(input.failedRuns?.count || 0)}, AI $${Number(input.aiUsage?.totalCostUsd || 0).toFixed(6)}`,
      "observability tables and agent_runs",
      Number(input.apiErrors?.total || 0) || Number(input.failedRuns?.count || 0) ? "high" : "medium"
    )
  ];

  if (input.deploymentHealth) {
    observations.push(observation(
      "deployment",
      "Deployment",
      input.deploymentHealth.message || input.deploymentHealth.severity || "unknown",
      "Vercel deployment health",
      input.deploymentHealth.severity && input.deploymentHealth.severity !== "ok" ? "high" : "low"
    ));
  }

  if (input.contentPerformance) {
    observations.push(observation(
      "content",
      "Content",
      `${Number(input.contentPerformance.totalPosts || 0)} posts, top ${input.contentPerformance.topPost?.title || "none"}`,
      "posts/content performance",
      "low"
    ));
  }

  return observations;
}

function buildDecisions(input: Parameters<typeof buildAgentDecisionTrace>[0], observations: AgentDecisionTraceObservation[]): AgentDecisionTraceDecision[] {
  const decisions: AgentDecisionTraceDecision[] = [];
  const blockCount = Number(input.approvalGateSummary?.blockCount || 0);
  const topRisk = input.riskRadar?.items?.[0];
  const topSop = input.operatingSop?.procedures?.[0];
  const ownerPrompt = input.ownerBrief?.doNow?.prompt;

  if (blockCount > 0 || input.dailyCheckout?.status === "blocked") {
    decisions.push(decision({
      id: "decision-gate-first",
      title: "승인 gate를 먼저 정리",
      conclusion: "위험 작업 실행보다 Execution Gate block과 승인 대기열 정리가 우선입니다.",
      basedOn: ["gate", "checkout", "approvals"],
      confidence: blockCount > 0 ? "high" : "medium",
      nextCheck: "/admin/dashboard?section=approvals · 승인 대기",
      prompt: "승인 대기 작업을 impact 기준으로 검토해줘"
    }));
  }

  if (topRisk) {
    decisions.push(decision({
      id: "decision-prevent-risk",
      title: "가장 큰 선제 위험 낮추기",
      conclusion: `${topRisk.title} 항목이 다음 예방 우선순위입니다.`,
      basedOn: ["risk-radar", "signals", "monitor-trend"],
      confidence: topRisk.score >= 70 ? "high" : "medium",
      nextCheck: "/admin/bot · AI 비서에게 선제 위험 점검 요청",
      prompt: topRisk.prompt
    }));
  }

  if (topSop) {
    decisions.push(decision({
      id: "decision-follow-sop",
      title: "SOP 절차대로 실행",
      conclusion: `${topSop.title} 절차를 따르면 지금 상태의 조치 경계를 유지할 수 있습니다.`,
      basedOn: ["severity", "checkout", "risk-radar"],
      confidence: input.operatingSop?.status === "blocked" ? "high" : "medium",
      nextCheck: "/admin/bot · AI 비서에게 운영 절차 안내 요청",
      prompt: topSop.nextPrompt
    }));
  }

  if (ownerPrompt && decisions.length < 4) {
    decisions.push(decision({
      id: "decision-owner-brief",
      title: "운영자 30초 브리핑 우선",
      conclusion: input.ownerBrief?.headline || "Owner Brief의 지금 할 일을 우선 처리합니다.",
      basedOn: ["severity", "checkout", "risk-radar"],
      confidence: input.ownerBrief?.confidence >= 70 ? "high" : "medium",
      nextCheck: "/admin/dashboard?section=today · 오늘 할 일",
      prompt: ownerPrompt
    }));
  }

  if (!decisions.length) {
    decisions.push(decision({
      id: "decision-normal-close",
      title: "정상 운영 루프 유지",
      conclusion: "뚜렷한 차단 위험이 없으므로 Daily Checkout, 리포트 저장, 콘텐츠 운영 루프를 유지합니다.",
      basedOn: observations.slice(0, 4).map((item) => item.id),
      confidence: "medium",
      nextCheck: "/admin/dashboard?section=today · 마감 전에 확인할 것",
      prompt: "오늘 운영 마감 가능한지 남은 위험과 내일 포커스를 점검해줘"
    }));
  }

  return decisions.slice(0, 4);
}

function buildBlindSpots(input: Parameters<typeof buildAgentDecisionTrace>[0]) {
  const blindSpots = [
    input.latestMonitorSnapshot?.error ? `Latest monitor snapshot parse/query issue: ${input.latestMonitorSnapshot.error}` : null,
    Number(input.monitorTrend?.sampleSize || 0) < 2 ? "monitor trend sample이 부족해 악화/개선 방향 판단 신뢰도가 낮습니다." : null,
    input.deploymentHealth && !input.deploymentHealth.configured ? "Vercel deployment token/project 설정이 없어 배포 상태는 제한적으로만 판단합니다." : null,
    input.memories?.error ? `memory query issue: ${input.memories.error}` : null,
    input.latestReport?.error ? `latest report query issue: ${input.latestReport.error}` : null,
    input.contentPerformance?.error ? `content performance issue: ${input.contentPerformance.error}` : null
  ].filter(Boolean) as string[];

  return blindSpots.length ? blindSpots : ["현재 command-center 입력 기준으로 큰 blind spot은 감지되지 않았습니다."];
}

function buildVerifyNext(input: Parameters<typeof buildAgentDecisionTrace>[0], decisions: AgentDecisionTraceDecision[], blindSpots: string[]) {
  const checks = [
    decisions[0]?.prompt,
    Number(input.approvalGateSummary?.blockCount || 0) > 0 ? "승인 대기 작업을 impact 기준으로 검토해줘" : null,
    input.riskRadar?.primaryPrompt,
    blindSpots.some((item) => item.includes("monitor trend")) ? "최근 monitor 추세가 좋아지는지 나빠지는지 알려줘" : null,
    "오늘 운영 브리핑 해줘"
  ].filter(Boolean) as string[];

  return Array.from(new Set(checks)).slice(0, 5);
}

function getConfidence(input: Parameters<typeof buildAgentDecisionTrace>[0], observations: AgentDecisionTraceObservation[], blindSpots: string[]): AgentDecisionTraceConfidence {
  const highWeight = observations.filter((item) => item.weight === "high").length;
  const unknownPenalty = observations.filter((item) => item.value.includes("unknown")).length;
  const realBlindSpots = blindSpots.filter((item) => !item.includes("큰 blind spot")).length;
  if (realBlindSpots >= 2 || unknownPenalty >= 3) return "low";
  if (input.severity === "critical" || highWeight >= 2) return "high";
  if (realBlindSpots === 1 || unknownPenalty > 0) return "medium";
  return "high";
}

function buildSummary(confidence: AgentDecisionTraceConfidence, decisions: AgentDecisionTraceDecision[], blindSpots: string[]) {
  const top = decisions[0]?.title || "정상 운영 루프";
  const blindSpotCount = blindSpots.filter((item) => !item.includes("큰 blind spot")).length;
  return `${top} 판단 근거를 ${decisions.length}개 decision과 ${blindSpotCount}개 blind spot으로 추적했습니다. 신뢰도는 ${confidence}입니다.`;
}

function observation(
  id: string,
  label: string,
  value: string,
  source: string,
  weight: AgentDecisionTraceObservation["weight"]
): AgentDecisionTraceObservation {
  return { id, label, value, source, weight };
}

function decision(input: AgentDecisionTraceDecision): AgentDecisionTraceDecision {
  return input;
}
