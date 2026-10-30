export type AgentRiskRadarSeverity = "low" | "medium" | "high" | "critical";
export type AgentRiskRadarCategory = "approval" | "stability" | "cost" | "deploy" | "readiness" | "content" | "memory";

export interface AgentRiskRadarItem {
  id: string;
  category: AgentRiskRadarCategory;
  severity: AgentRiskRadarSeverity;
  likelihood: number;
  impact: number;
  score: number;
  horizon: "now" | "today" | "this_week";
  title: string;
  why: string;
  evidence: string[];
  prevention: string;
  prompt: string;
}

export interface AgentRiskRadar {
  generatedAt: string;
  status: "clear" | "watch" | "act";
  score: number;
  summary: string;
  primaryPrompt: string;
  items: AgentRiskRadarItem[];
}

export function buildAgentRiskRadar(input: {
  severity: "ok" | "warn" | "critical";
  pendingApprovals?: { count?: number; highRiskCount?: number; staleCount?: number; oldestAgeHours?: number };
  approvalGateSummary?: { blockCount?: number; reviewCount?: number };
  failedRuns?: { count?: number };
  apiErrors?: { total?: number };
  aiUsage?: { totalRequests?: number; totalCostUsd?: number };
  deploymentHealth?: { severity?: "ok" | "warn" | "critical"; message?: string };
  readiness?: { status?: "ok" | "warn" | "critical" };
  rollout?: { status?: "pass" | "warn" | "fail" };
  monitorTrend?: { direction?: "improving" | "stable" | "worsening" | "insufficient_data"; label?: string; recommendation?: string };
  dailyCheckout?: { status?: "clear" | "attention" | "blocked"; score?: number; openRisks?: string[] };
  contentPerformance?: { totalPosts?: number; totalViews?: number; momentum?: { label?: string }; recommendations?: string[] };
  memorySuggestions?: any[];
}): AgentRiskRadar {
  const items = dedupeItems([
    ...approvalRisks(input),
    ...stabilityRisks(input),
    ...costRisks(input),
    ...deployRisks(input),
    ...readinessRisks(input),
    ...contentRisks(input),
    ...memoryRisks(input),
    ...trendRisks(input)
  ]).sort((a, b) => b.score - a.score).slice(0, 7);
  const score = Math.max(0, Math.min(100, items[0]?.score || (input.severity === "ok" ? 12 : 40)));
  const status = score >= 75 ? "act" : score >= 35 ? "watch" : "clear";
  const primaryPrompt = items[0]?.prompt
    || (input.dailyCheckout?.status === "clear" ? "오늘 운영 브리핑을 리포트로 저장 요청해줘" : "오늘 운영 브리핑 해줘");

  return {
    generatedAt: new Date().toISOString(),
    status,
    score,
    summary: buildSummary(status, items, input),
    primaryPrompt,
    items
  };
}

function approvalRisks(input: Parameters<typeof buildAgentRiskRadar>[0]): AgentRiskRadarItem[] {
  const count = Number(input.pendingApprovals?.count || 0);
  const stale = Number(input.pendingApprovals?.staleCount || 0);
  const high = Number(input.pendingApprovals?.highRiskCount || 0);
  const block = Number(input.approvalGateSummary?.blockCount || 0);
  const items: AgentRiskRadarItem[] = [];
  if (block > 0) {
    items.push(item({
      id: "approval-gate-block-risk",
      category: "approval",
      likelihood: 95,
      impact: 92,
      horizon: "now",
      title: "차단된 승인 요청이 운영 판단을 막을 수 있음",
      why: "Execution Gate block 요청은 승인해도 실행 대상이 불명확해 실패하거나 위험하게 오해될 수 있습니다.",
      evidence: [`gate block ${block}건`, `pending ${count}건`],
      prevention: "block 요청을 승인하지 말고 payload와 필수 대상값을 확인해 거절 또는 재요청합니다.",
      prompt: "승인 대기 작업을 impact 기준으로 검토해줘"
    }));
  }
  if (stale > 0 || high > 0) {
    items.push(item({
      id: "approval-aging-risk",
      category: "approval",
      likelihood: Math.min(90, 50 + stale * 12 + high * 10),
      impact: high > 0 ? 85 : 66,
      horizon: "today",
      title: "오래된/고위험 승인 요청이 누적될 수 있음",
      why: "승인 큐가 쌓이면 identity 정리, 게시글 초안, 리포트 저장 같은 작업의 맥락이 흐려져 잘못 승인할 가능성이 커집니다.",
      evidence: [`stale ${stale}건`, `high risk ${high}건`, `oldest ${Number(input.pendingApprovals?.oldestAgeHours || 0)}h`],
      prevention: "고위험과 오래된 요청부터 impact, preview, checklist를 보고 승인 또는 거절합니다.",
      prompt: "승인 대기 작업을 impact 기준으로 검토해줘"
    }));
  }
  return items;
}

function stabilityRisks(input: Parameters<typeof buildAgentRiskRadar>[0]): AgentRiskRadarItem[] {
  const apiErrors = Number(input.apiErrors?.total || 0);
  const failedRuns = Number(input.failedRuns?.count || 0);
  const items: AgentRiskRadarItem[] = [];
  if (apiErrors > 0) {
    items.push(item({
      id: "pubg-api-instability-risk",
      category: "stability",
      likelihood: Math.min(95, 45 + apiErrors * 10),
      impact: 82,
      horizon: "now",
      title: "PUBG API 에러가 분석 품질을 흔들 수 있음",
      why: "API 에러가 늘면 매치 분석, 텔레메트리 처리, 캐시 재사용 판단이 함께 불안정해질 수 있습니다.",
      evidence: [`API errors ${apiErrors}건`],
      prevention: "route/status/message별 원인을 먼저 분리하고 429면 강제 재분석을 보류합니다.",
      prompt: "최근 PUBG API 에러 원인을 분석해줘"
    }));
  }
  if (failedRuns > 0) {
    items.push(item({
      id: "agent-run-failure-risk",
      category: "stability",
      likelihood: Math.min(90, 50 + failedRuns * 12),
      impact: 74,
      horizon: "today",
      title: "Agent 실행 실패가 감시 공백을 만들 수 있음",
      why: "최근 실패 run이 있으면 monitor snapshot, approval result, 리포트 저장 흐름 중 일부가 누락될 수 있습니다.",
      evidence: [`failed runs ${failedRuns}건`],
      prevention: "최근 run timeline과 실패 step을 보고 table/env/tool 오류를 분리합니다.",
      prompt: "최근 24시간 사고 타임라인을 요약해줘"
    }));
  }
  return items;
}

function costRisks(input: Parameters<typeof buildAgentRiskRadar>[0]): AgentRiskRadarItem[] {
  const cost = Number(input.aiUsage?.totalCostUsd || 0);
  const requests = Number(input.aiUsage?.totalRequests || 0);
  if (cost <= 0 && requests <= 0) return [];
  const likelihood = Math.min(85, Math.round(35 + cost * 800 + requests * 1.5));
  if (likelihood < 40) return [];
  return [item({
    id: "ai-cost-drift-risk",
    category: "cost",
    likelihood,
    impact: cost > 0.05 ? 82 : 58,
    horizon: "today",
    title: "AI 비용 또는 반복 분석이 누적될 수 있음",
    why: "AI 요청이 늘면 무료/저비용 운영에서 캐시 재사용 정책과 모델별 비용 확인이 중요해집니다.",
    evidence: [`AI requests ${requests}건`, `AI cost $${cost.toFixed(6)}`],
    prevention: "model_name과 analysis_type별 비용을 보고 중복 분석이나 고비용 분석을 줄입니다.",
    prompt: "최근 AI 비용과 사용량을 분석해줘"
  })];
}

function deployRisks(input: Parameters<typeof buildAgentRiskRadar>[0]): AgentRiskRadarItem[] {
  if (!input.deploymentHealth?.severity || input.deploymentHealth.severity === "ok") return [];
  return [item({
    id: "deployment-risk",
    category: "deploy",
    likelihood: input.deploymentHealth.severity === "critical" ? 88 : 62,
    impact: input.deploymentHealth.severity === "critical" ? 86 : 66,
    horizon: "now",
    title: "배포 불안정이 운영 기능 확인을 지연시킬 수 있음",
    why: "배포 실패 또는 상태 조회 불안정 중에는 새 agent UI/API 변경이 운영 화면에 반영되지 않을 수 있습니다.",
    evidence: [input.deploymentHealth.message || `deployment ${input.deploymentHealth.severity}`],
    prevention: "Vercel 실패 로그와 GitHub Actions 실행 시간을 비교하고 위험 승인을 잠시 보류합니다.",
    prompt: "최근 Vercel 배포 실패 원인을 분석해줘"
  })];
}

function readinessRisks(input: Parameters<typeof buildAgentRiskRadar>[0]): AgentRiskRadarItem[] {
  const readinessBad = input.readiness?.status && input.readiness.status !== "ok";
  const rolloutBad = input.rollout?.status && input.rollout.status !== "pass";
  if (!readinessBad && !rolloutBad) return [];
  return [item({
    id: "agent-readiness-risk",
    category: "readiness",
    likelihood: input.readiness?.status === "critical" || input.rollout?.status === "fail" ? 90 : 65,
    impact: 84,
    horizon: "now",
    title: "Agent 준비 상태가 판단 신뢰도를 낮출 수 있음",
    why: "필수 테이블, env, 도구 catalog, approval loop 중 하나가 흔들리면 에이전트 답변보다 self-test가 먼저입니다.",
    evidence: [`readiness ${input.readiness?.status || "unknown"}`, `rollout ${input.rollout?.status || "unknown"}`],
    prevention: "Agent Readiness와 Rollout Readiness를 먼저 확인하고 critical 항목을 수정합니다.",
    prompt: "Admin Agent 준비 상태를 점검해줘"
  })];
}

function contentRisks(input: Parameters<typeof buildAgentRiskRadar>[0]): AgentRiskRadarItem[] {
  const totalPosts = Number(input.contentPerformance?.totalPosts || 0);
  const momentum = input.contentPerformance?.momentum?.label;
  if (totalPosts > 0 && momentum !== "quiet" && momentum !== "no_data") return [];
  return [item({
    id: "content-momentum-risk",
    category: "content",
    likelihood: momentum === "quiet" ? 58 : 45,
    impact: 48,
    horizon: "this_week",
    title: "콘텐츠 운영 모멘텀이 약해질 수 있음",
    why: "운영이 안정권일 때 콘텐츠 초안과 성과 분석을 이어가지 않으면 사이트 성장 루프가 끊깁니다.",
    evidence: [`posts ${totalPosts}건`, `momentum ${momentum || "unknown"}`],
    prevention: "최근 성과와 low-effort win을 보고 이번 주 게시글 초안을 만듭니다.",
    prompt: "최근 게시글 성과를 분석하고 다음 콘텐츠를 추천해줘"
  })];
}

function memoryRisks(input: Parameters<typeof buildAgentRiskRadar>[0]): AgentRiskRadarItem[] {
  const suggestions = input.memorySuggestions || [];
  if (!suggestions.length) return [];
  return [item({
    id: "memory-loss-risk",
    category: "memory",
    likelihood: Math.min(75, 45 + suggestions.length * 8),
    impact: 54,
    horizon: "this_week",
    title: "반복 이슈 대응 지식이 기록되지 않을 수 있음",
    why: "해결책을 memory로 남기지 않으면 다음 유사 장애에서 다시 처음부터 분석하게 됩니다.",
    evidence: [`memory suggestions ${suggestions.length}건`, suggestions[0]?.title || "memory 후보 있음"],
    prevention: "반복될 정책/장애 대응만 골라 memory 저장 승인 요청으로 남깁니다.",
    prompt: "이번 대응 내용을 memory로 저장해줘"
  })];
}

function trendRisks(input: Parameters<typeof buildAgentRiskRadar>[0]): AgentRiskRadarItem[] {
  if (input.monitorTrend?.direction !== "worsening") return [];
  return [item({
    id: "monitor-worsening-risk",
    category: "stability",
    likelihood: 78,
    impact: 72,
    horizon: "today",
    title: "운영 지표가 악화 방향으로 움직일 수 있음",
    why: input.monitorTrend.recommendation || "최근 monitor snapshot의 alert/gate/checkout 추세가 나빠지고 있습니다.",
    evidence: [`trend ${input.monitorTrend.label || "worsening"}`],
    prevention: "Owner Brief와 사고 타임라인을 먼저 보고 가장 점수가 높은 위험을 낮춥니다.",
    prompt: "최근 monitor 추세가 좋아지는지 나빠지는지 알려줘"
  })];
}

function item(input: Omit<AgentRiskRadarItem, "severity" | "score">): AgentRiskRadarItem {
  const score = Math.round(input.likelihood * 0.55 + input.impact * 0.45);
  return {
    ...input,
    score,
    severity: score >= 85 ? "critical" : score >= 70 ? "high" : score >= 45 ? "medium" : "low"
  };
}

function dedupeItems(items: AgentRiskRadarItem[]) {
  const seen = new Set<string>();
  return items.filter((risk) => {
    if (seen.has(risk.id)) return false;
    seen.add(risk.id);
    return true;
  });
}

function buildSummary(status: AgentRiskRadar["status"], items: AgentRiskRadarItem[], input: Parameters<typeof buildAgentRiskRadar>[0]) {
  if (!items.length) return "선제 대응이 필요한 뚜렷한 위험 신호가 없습니다. Daily Checkout과 리포트 저장 루프를 유지하면 됩니다.";
  const top = items[0];
  const checkout = input.dailyCheckout?.status ? ` Daily Checkout은 ${input.dailyCheckout.status} 상태입니다.` : "";
  if (status === "act") return `${top.title} 위험이 가장 큽니다. ${top.prevention}${checkout}`;
  if (status === "watch") return `${top.title} 가능성을 관찰해야 합니다. ${top.prompt}부터 확인하세요.${checkout}`;
  return `낮은 위험 ${items.length}건이 있습니다. ${top.prompt}로 예방 점검을 이어가면 됩니다.${checkout}`;
}
