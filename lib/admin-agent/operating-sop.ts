import type { AgentPlaybook } from "./playbooks";

export type AgentOperatingSopStatus = "normal" | "watch" | "incident" | "blocked";
export type AgentOperatingSopRisk = "read" | "approval_required" | "manual_check";
export type AgentOperatingSopOwner = "agent" | "admin" | "github_actions" | "manual";

export interface AgentOperatingSopStep {
  id: string;
  label: string;
  owner: AgentOperatingSopOwner;
  risk: AgentOperatingSopRisk;
  action: string;
  prompt?: string;
}

export interface AgentOperatingSopProcedure {
  id: string;
  title: string;
  severity: "ok" | "warn" | "critical";
  risk: AgentOperatingSopRisk;
  trigger: string;
  why: string;
  steps: AgentOperatingSopStep[];
  doneWhen: string[];
  nextPrompt: string;
}

export interface AgentOperatingSop {
  generatedAt: string;
  status: AgentOperatingSopStatus;
  title: string;
  summary: string;
  primaryPrompt: string;
  checkLocation: string;
  guardrails: string[];
  procedures: AgentOperatingSopProcedure[];
}

export function buildAgentOperatingSop(input: {
  severity: "ok" | "warn" | "critical";
  operatingMode?: any;
  dailyCheckout?: any;
  todayActionBoard?: any;
  nextActions?: any[];
  playbooks?: AgentPlaybook[];
  pendingApprovals?: { count?: number; highRiskCount?: number; staleCount?: number };
  approvalGateSummary?: { blockCount?: number; reviewCount?: number; items?: any[] };
  failedRuns?: { count?: number };
  apiErrors?: { total?: number };
  aiUsage?: { totalCostUsd?: number };
  deploymentHealth?: { severity?: "ok" | "warn" | "critical"; message?: string };
  readiness?: { status?: "ok" | "warn" | "critical" };
  rollout?: { status?: "pass" | "warn" | "fail" };
  monitorTrend?: { direction?: string; label?: string; recommendation?: string };
  contentPerformance?: { recommendations?: string[]; weeklyPlan?: any[] };
}): AgentOperatingSop {
  const procedures = dedupeProcedures([
    ...proceduresFromGate(input),
    ...proceduresFromApprovals(input),
    ...proceduresFromIncidents(input),
    ...proceduresFromReadiness(input),
    ...proceduresFromContent(input),
    ...proceduresFromDailyClose(input)
  ]).slice(0, 6);
  const status = getSopStatus(input, procedures);
  const top = procedures[0];
  const primaryPrompt = top?.nextPrompt
    || input.dailyCheckout?.handoffPrompt
    || input.operatingMode?.primaryAction?.prompt
    || "오늘 운영 브리핑 해줘";

  return {
    generatedAt: new Date().toISOString(),
    status,
    title: getTitle(status),
    summary: buildSummary(status, procedures, input),
    primaryPrompt,
    checkLocation: "/admin/bot",
    guardrails: [
      "삭제, 게시글 발행, memory/report 저장은 승인 없이 실행하지 않습니다.",
      "Execution Gate가 block이면 승인하지 말고 필수 대상값을 채운 새 요청을 만듭니다.",
      "긴 작업과 정기 수집은 Vercel Cron으로 옮기지 않고 기존 GitHub Actions에 둡니다."
    ],
    procedures
  };
}

function proceduresFromGate(input: Parameters<typeof buildAgentOperatingSop>[0]): AgentOperatingSopProcedure[] {
  const blocked = Number(input.approvalGateSummary?.blockCount || 0);
  if (!blocked) return [];
  const item = input.approvalGateSummary?.items?.find((candidate: any) => candidate.gate?.status === "block");
  return [{
    id: "execution-gate-block",
    title: "Execution Gate 차단 승인 정리",
    severity: "critical",
    risk: "approval_required",
    trigger: `차단된 승인 요청 ${blocked}건`,
    why: "필수 대상값이 없는 위험 작업은 승인해도 안전하게 실행할 수 없습니다.",
    steps: [
      step("open-approval", "승인 상세 열기", "admin", "manual_check", "승인 패널에서 block 요청의 gate 사유와 payload를 확인합니다."),
      step("reject-or-recreate", "거절 또는 재요청", "admin", "approval_required", "필수 대상값이 없으면 승인하지 말고 사유를 남겨 거절하거나, 대상값을 채운 새 요청을 만듭니다.", "승인 대기 작업을 impact 기준으로 검토해줘"),
      step("timeline", "기록 확인", "agent", "read", "관련 run timeline을 확인해 왜 요청이 만들어졌는지 확인합니다.", "최근 24시간 사고 타임라인을 요약해줘")
    ],
    doneWhen: [
      "block gate 수가 0이 됩니다.",
      "거절 사유 또는 새 승인 요청의 대상값이 로그에 남습니다."
    ],
    nextPrompt: item
      ? `승인 요청 ${item.id}의 Execution Gate 차단 사유와 재요청 방법을 정리해줘`
      : "승인 대기 작업을 impact 기준으로 검토해줘"
  }];
}

function proceduresFromApprovals(input: Parameters<typeof buildAgentOperatingSop>[0]): AgentOperatingSopProcedure[] {
  const count = Number(input.pendingApprovals?.count || 0);
  if (!count) return [];
  const stale = Number(input.pendingApprovals?.staleCount || 0);
  const high = Number(input.pendingApprovals?.highRiskCount || 0);
  return [{
    id: "approval-queue-triage",
    title: "승인 대기열 우선순위 검토",
    severity: stale || high ? "warn" : "ok",
    risk: "approval_required",
    trigger: `승인 대기 ${count}건, 고위험 ${high}건, 오래됨 ${stale}건`,
    why: "승인 큐는 에이전트가 자동 실행하지 않는 안전장치이므로 운영자가 impact를 보고 결정해야 합니다.",
    steps: [
      step("sort", "필터 정렬", "admin", "manual_check", "고위험, 오래됨, block 요청 순서로 승인 패널을 봅니다."),
      step("impact", "Impact 확인", "admin", "manual_check", "예상 row 수, 게시글 preview, checklist, execution gate를 확인합니다."),
      step("decide", "승인 또는 거절", "admin", "approval_required", "필요한 작업만 승인하고, 애매한 요청은 사유를 남겨 거절합니다.", "승인 대기 작업을 impact 기준으로 검토해줘")
    ],
    doneWhen: [
      "고위험/오래된 승인 요청이 0건입니다.",
      "실행 결과 또는 거절 사유가 approval result에 남습니다."
    ],
    nextPrompt: "승인 대기 작업을 impact 기준으로 검토해줘"
  }];
}

function proceduresFromIncidents(input: Parameters<typeof buildAgentOperatingSop>[0]): AgentOperatingSopProcedure[] {
  const procedures: AgentOperatingSopProcedure[] = [];
  if (Number(input.apiErrors?.total || 0) > 0) {
    procedures.push({
      id: "pubg-api-incident",
      title: "PUBG API 에러 진단",
      severity: input.severity === "critical" ? "critical" : "warn",
      risk: "read",
      trigger: `최근 API 에러 ${input.apiErrors?.total || 0}건`,
      why: "API 에러는 수집/분석/캐시 품질에 영향을 주므로 route/status/message별 원인 분리가 먼저입니다.",
      steps: [
        step("inspect", "에러 패턴 조회", "agent", "read", "route/status/message별 빈도와 최신 에러를 확인합니다.", "최근 PUBG API 에러 원인을 분석해줘"),
        step("protect-quota", "재시도 억제", "manual", "manual_check", "429 또는 quota 위험이면 강제 재분석과 긴 수집 작업을 보류합니다."),
        step("save", "대응 기록 후보", "agent", "approval_required", "반복될 만한 원인/조치라면 memory 저장 승인 요청을 만듭니다.", "이번 대응 내용을 memory로 저장해줘")
      ],
      doneWhen: [
        "원인이 API quota, 외부 5xx, 내부 요청량 중 하나로 분리됩니다.",
        "재처리/캐시 삭제 같은 위험 작업은 승인 요청으로만 남습니다."
      ],
      nextPrompt: "최근 PUBG API 에러 원인을 분석해줘"
    });
  }
  if (Number(input.aiUsage?.totalCostUsd || 0) > 0 && input.severity !== "ok") {
    procedures.push({
      id: "ai-cost-watch",
      title: "AI 비용/토큰 사용량 점검",
      severity: input.severity === "critical" ? "critical" : "warn",
      risk: "read",
      trigger: `최근 AI 비용 $${Number(input.aiUsage?.totalCostUsd || 0).toFixed(6)}`,
      why: "비용 급등은 모델/분석 타입/반복 요청 중 어디에서 발생했는지 먼저 분리해야 합니다.",
      steps: [
        step("inspect-ai", "비용 분석", "agent", "read", "model_name과 analysis_type별 비용을 확인합니다.", "최근 AI 비용과 사용량을 분석해줘"),
        step("cache-policy", "캐시 정책 확인", "manual", "manual_check", "중복 분석이 많으면 캐시 재사용 정책을 우선 확인합니다."),
        step("report", "운영 리포트 저장", "agent", "approval_required", "임계치 초과 대응은 report 저장 승인 요청으로 보존합니다.", "오늘 운영 브리핑을 리포트로 저장 요청해줘")
      ],
      doneWhen: [
        "비용을 만든 분석 타입과 모델이 확인됩니다.",
        "재발 방지 정책 또는 캐시 확인 항목이 기록됩니다."
      ],
      nextPrompt: "최근 AI 비용과 사용량을 분석해줘"
    });
  }
  if (input.deploymentHealth?.severity && input.deploymentHealth.severity !== "ok") {
    procedures.push({
      id: "deployment-guard",
      title: "Vercel 배포 실패/불안정 점검",
      severity: input.deploymentHealth.severity,
      risk: "read",
      trigger: input.deploymentHealth.message || "배포 상태가 안정권이 아닙니다.",
      why: "무료 플랜에서는 긴 작업을 함수로 밀어 넣기보다 실패 로그와 GitHub Actions 상태를 분리해서 봐야 합니다.",
      steps: [
        step("inspect-deploy", "배포 로그 요약", "agent", "read", "최근 실패 배포와 빌드 로그 원인을 요약합니다.", "최근 Vercel 배포 실패 원인을 분석해줘"),
        step("compare-actions", "Actions 비교", "github_actions", "manual_check", "daily-tasks 마지막 monitor snapshot과 배포 시간을 비교합니다."),
        step("hold-risk", "위험 작업 보류", "admin", "manual_check", "배포 불안정 중에는 캐시 삭제/대량 작업 승인을 보류합니다.")
      ],
      doneWhen: [
        "실패 배포 ID 또는 runtime 원인이 확인됩니다.",
        "다음 배포 전 실행할 검증 명령이 정리됩니다."
      ],
      nextPrompt: "최근 Vercel 배포 실패 원인을 분석해줘"
    });
  }
  return procedures;
}

function proceduresFromReadiness(input: Parameters<typeof buildAgentOperatingSop>[0]): AgentOperatingSopProcedure[] {
  const readinessBad = input.readiness?.status && input.readiness.status !== "ok";
  const rolloutBad = input.rollout?.status && input.rollout.status !== "pass";
  if (!readinessBad && !rolloutBad) return [];
  return [{
    id: "agent-readiness-repair",
    title: "Admin Agent 준비 상태 복구",
    severity: readinessBad && input.readiness?.status === "critical" || input.rollout?.status === "fail" ? "critical" : "warn",
    risk: "read",
    trigger: `readiness ${input.readiness?.status || "unknown"}, rollout ${input.rollout?.status || "unknown"}`,
    why: "준비 상태가 흔들리면 에이전트 판단보다 table/env/tool registry 확인이 먼저입니다.",
    steps: [
      step("self-test", "Self-test 확인", "agent", "read", "필수 테이블, env, 도구 등록, 승인 루프를 확인합니다.", "Admin Agent 준비 상태를 점검해줘"),
      step("rollout", "Rollout gate 확인", "agent", "read", "배포 전 readiness gate와 실패 항목을 확인합니다.", "Admin Agent 다음 업그레이드 로드맵을 정리해줘"),
      step("fix", "환경/코드 수정", "manual", "manual_check", "필수 env 또는 테이블 접근 문제가 있으면 배포 전 먼저 수정합니다.")
    ],
    doneWhen: [
      "Agent Readiness가 ok입니다.",
      "Rollout Readiness가 pass입니다."
    ],
    nextPrompt: "Admin Agent 준비 상태를 점검해줘"
  }];
}

function proceduresFromContent(input: Parameters<typeof buildAgentOperatingSop>[0]): AgentOperatingSopProcedure[] {
  if (!input.contentPerformance?.recommendations?.length && !input.contentPerformance?.weeklyPlan?.length) return [];
  return [{
    id: "content-ops-loop",
    title: "콘텐츠 운영 루프",
    severity: "ok",
    risk: "approval_required",
    trigger: "콘텐츠 성과 추천 또는 주간 발행 계획 존재",
    why: "운영 데이터가 안정권일 때는 콘텐츠 초안과 성과 분석으로 사이트 성장에 연결합니다.",
    steps: [
      step("performance", "성과 분석", "agent", "read", "최근 게시글 성과와 low-effort win을 확인합니다.", "최근 게시글 성과를 분석하고 다음 콘텐츠를 추천해줘"),
      step("draft", "초안 생성", "agent", "read", "운영 데이터 기반 게시글 초안을 만듭니다.", "이번 주 운영 데이터 기반 게시글 초안을 만들어줘"),
      step("publish-approval", "초안 저장 승인", "admin", "approval_required", "승인 패널에서 preview와 HTML 본문을 검토한 뒤 승인하면 비공개 초안이 저장됩니다. 어드민 검증 탭에서 초안을 확인하고 공개 발행은 별도로 진행합니다.", "이 게시글을 비공개 초안 저장 승인 요청으로 올려줘")
    ],
    doneWhen: [
      "게시글 초안이 생성되었거나 초안 저장 승인 요청이 만들어집니다.",
      "승인 결과에는 비공개 초안 저장이 기록되고, 공개 발행 여부는 게시판에서 별도로 확인합니다."
    ],
    nextPrompt: "최근 게시글 성과를 분석하고 다음 콘텐츠를 추천해줘"
  }];
}

function proceduresFromDailyClose(input: Parameters<typeof buildAgentOperatingSop>[0]): AgentOperatingSopProcedure[] {
  const checkout = input.dailyCheckout;
  if (checkout?.status === "blocked") return [];
  return [{
    id: "daily-closeout",
    title: checkout?.status === "clear" ? "일일 운영 마감" : "주의 후 운영 마감",
    severity: checkout?.status === "attention" ? "warn" : "ok",
    risk: "read",
    trigger: checkout?.summary || "운영 상태를 마감 전 점검합니다.",
    why: "하루 운영을 닫기 전에 남은 위험과 내일 첫 포커스를 기록해 다음 점검 품질을 높입니다.",
    steps: [
      step("checkout", "마감 점검", "agent", "read", "Daily Checkout으로 open risk와 tomorrow focus를 확인합니다.", "오늘 운영 마감 가능한지 남은 위험과 내일 포커스를 점검해줘"),
      step("digest", "Digest 저장 요청", "agent", "approval_required", "보존할 가치가 있으면 Daily Ops Digest 저장 승인 요청을 만듭니다.", "오늘 운영 브리핑을 리포트로 저장 요청해줘"),
      step("handoff", "인수인계", "agent", "read", "내일 이어볼 항목이 있으면 handoff packet을 생성합니다.", "운영 인수인계 패킷을 만들어줘")
    ],
    doneWhen: [
      "Daily Checkout open risk가 확인됩니다.",
      "필요한 리포트/인수인계가 승인 대기 또는 Markdown으로 남습니다."
    ],
    nextPrompt: checkout?.handoffPrompt || "오늘 운영 마감 가능한지 남은 위험과 내일 포커스를 점검해줘"
  }];
}

function step(
  id: string,
  label: string,
  owner: AgentOperatingSopOwner,
  risk: AgentOperatingSopRisk,
  action: string,
  prompt?: string
): AgentOperatingSopStep {
  return { id, label, owner, risk, action, prompt };
}

function getSopStatus(input: Parameters<typeof buildAgentOperatingSop>[0], procedures: AgentOperatingSopProcedure[]): AgentOperatingSopStatus {
  if (Number(input.approvalGateSummary?.blockCount || 0) > 0 || input.dailyCheckout?.status === "blocked") return "blocked";
  if (input.severity === "critical" || procedures.some((item) => item.severity === "critical")) return "incident";
  if (input.severity === "warn" || procedures.some((item) => item.severity === "warn")) return "watch";
  return "normal";
}

function getTitle(status: AgentOperatingSopStatus) {
  if (status === "blocked") return "먼저 멈추고 승인 gate를 정리하세요";
  if (status === "incident") return "장애 대응 SOP를 우선 실행하세요";
  if (status === "watch") return "주의 신호를 절차대로 점검하세요";
  return "운영 마감과 성장 루프를 진행하세요";
}

function buildSummary(status: AgentOperatingSopStatus, procedures: AgentOperatingSopProcedure[], input: Parameters<typeof buildAgentOperatingSop>[0]) {
  const top = procedures[0]?.title || "일일 운영 마감";
  const trend = input.monitorTrend?.label ? ` Monitor trend는 ${input.monitorTrend.label}입니다.` : "";
  if (status === "blocked") return `${top}가 최우선입니다. 위험 작업은 승인하지 말고 gate 사유를 먼저 해소하세요.${trend}`;
  if (status === "incident") return `${top}부터 실행해 원인과 조치 경계를 분리하세요.${trend}`;
  if (status === "watch") return `${top}를 먼저 보고, 승인/비용/API 신호를 낮춘 뒤 마감하세요.${trend}`;
  return `${top}를 기준으로 리포트 저장, 인수인계, 콘텐츠 운영까지 이어갈 수 있습니다.${trend}`;
}

function dedupeProcedures(procedures: AgentOperatingSopProcedure[]) {
  const seen = new Set<string>();
  return procedures.filter((procedure) => {
    if (seen.has(procedure.id)) return false;
    seen.add(procedure.id);
    return true;
  }).sort((a, b) => severityWeight(b.severity) - severityWeight(a.severity));
}

function severityWeight(severity: "ok" | "warn" | "critical") {
  if (severity === "critical") return 3;
  if (severity === "warn") return 2;
  return 1;
}
