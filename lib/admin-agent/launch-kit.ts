export type AgentLaunchKitRoutine = {
  id: string;
  title: string;
  cadence: "daily" | "incident" | "approval" | "growth";
  owner: "admin" | "agent" | "github_actions";
  why: string;
  steps: Array<{
    label: string;
    prompt?: string;
    location: string;
    guardrail: string;
  }>;
};

export type AgentLaunchKit = {
  generatedAt: string;
  status: "ready" | "watch" | "blocked";
  summary: string;
  firstPrompt: string;
  routines: AgentLaunchKitRoutine[];
  guardrails: string[];
  successSignals: string[];
};

export function buildAgentLaunchKit(input: {
  readiness?: any;
  rollout?: any;
  capabilityMatrix?: any;
  automationContracts?: any;
  safetyAudit?: any;
  operatorCoach?: any;
  outcomeReview?: any;
  ownerInbox?: any;
  missionControl?: any;
  approvalAdvisor?: any;
  monitorTrend?: any;
  contentPerformance?: any;
}): AgentLaunchKit {
  const status = resolveLaunchStatus(input);
  const firstPrompt = pickFirstPrompt(input);
  const routines = buildRoutines(input);
  const guardrails = uniqueCompact([
    ...(input.automationContracts?.guardrails || []),
    ...(input.safetyAudit?.requiredFixes || []),
    ...(input.safetyAudit?.recommendedChecks || []),
    "조회/진단/브리핑은 즉시 실행하되 삭제, 발행, 권한 변경, 대량 수정은 승인 패널을 거친다.",
    "SUPABASE_SERVICE_ROLE_KEY와 서비스 role 권한은 서버 API 안에서만 사용한다.",
    "무료 플랜 보호를 위해 긴 작업은 GitHub Actions에 남기고 Agent는 관찰, 기록, 알림, 승인 영향 분석에 집중한다."
  ]).slice(0, 8);
  const successSignals = uniqueCompact([
    input.outcomeReview ? `Outcome Review ${input.outcomeReview.status}: ${input.outcomeReview.score ?? 0}/100` : null,
    input.safetyAudit ? `Safety Audit ${input.safetyAudit.status}: ${input.safetyAudit.score ?? 0}/100` : null,
    input.approvalAdvisor ? `Approval Advisor ${input.approvalAdvisor.status}: approve ${input.approvalAdvisor.counts?.approve ?? 0}, defer ${input.approvalAdvisor.counts?.defer ?? 0}, reject ${input.approvalAdvisor.counts?.reject ?? 0}` : null,
    input.monitorTrend ? `Monitor Trend ${input.monitorTrend.label}: ${input.monitorTrend.summary}` : null,
    input.capabilityMatrix ? `Capability ${input.capabilityMatrix.label}: ${input.capabilityMatrix.score ?? 0}/100` : null,
    input.contentPerformance ? `Content ${input.contentPerformance.totalPosts ?? 0} posts / ${input.contentPerformance.totalViews ?? 0} views` : null
  ]).slice(0, 6);

  return {
    generatedAt: new Date().toISOString(),
    status,
    summary: buildSummary(status, input),
    firstPrompt,
    routines,
    guardrails,
    successSignals
  };
}

function resolveLaunchStatus(input: {
  readiness?: any;
  rollout?: any;
  capabilityMatrix?: any;
  safetyAudit?: any;
  outcomeReview?: any;
  ownerInbox?: any;
  approvalAdvisor?: any;
}) {
  if (
    input.safetyAudit?.status === "block"
    || input.rollout?.status === "fail"
    || input.capabilityMatrix?.label === "at_risk"
    || input.readiness?.status === "critical"
    || input.approvalAdvisor?.status === "blocked"
  ) {
    return "blocked" as const;
  }

  if (
    input.safetyAudit?.status === "watch"
    || input.rollout?.status === "partial"
    || input.capabilityMatrix?.label === "needs_attention"
    || input.outcomeReview?.status === "follow_up"
    || input.ownerInbox?.status === "attention"
    || input.approvalAdvisor?.status === "review"
  ) {
    return "watch" as const;
  }

  return "ready" as const;
}

function pickFirstPrompt(input: {
  operatorCoach?: any;
  missionControl?: any;
  ownerInbox?: any;
  outcomeReview?: any;
}) {
  return input.operatorCoach?.topPrompt
    || input.missionControl?.firstCommand
    || input.ownerInbox?.primaryAction
    || input.outcomeReview?.primaryPrompt
    || "30초 운영자 브리핑으로 지금 할 일만 알려줘";
}

function buildSummary(status: AgentLaunchKit["status"], input: {
  operatorCoach?: any;
  missionControl?: any;
  safetyAudit?: any;
  ownerInbox?: any;
}) {
  if (status === "blocked") {
    return `안전/준비 상태에 차단 신호가 있어 먼저 ${input.safetyAudit?.primaryPrompt || "Admin Agent 안전 감사 결과와 위험 승인 가능 여부를 점검해줘"}를 실행해야 합니다.`;
  }

  if (status === "watch") {
    return `운영 사용은 가능하지만 ${input.ownerInbox?.summary || input.safetyAudit?.summary || "검토할 신호"}를 먼저 확인하고 승인 작업은 보수적으로 처리하세요.`;
  }

  return `오늘부터 ${input.operatorCoach?.topPrompt || input.missionControl?.firstCommand || "30초 운영자 브리핑"}로 시작하면 됩니다. 조회는 Agent에게 맡기고 위험 실행은 승인 패널에서만 진행합니다.`;
}

function buildRoutines(input: {
  operatorCoach?: any;
  outcomeReview?: any;
  ownerInbox?: any;
  missionControl?: any;
  approvalAdvisor?: any;
  monitorTrend?: any;
  contentPerformance?: any;
}): AgentLaunchKitRoutine[] {
  return [
    {
      id: "daily-ops",
      title: "매일 운영 시작",
      cadence: "daily",
      owner: "agent",
      why: "운영자가 긴 로그를 보지 않고도 현재 안정성, 승인, 비용, 콘텐츠 신호를 한 번에 파악합니다.",
      steps: [
        {
          label: "30초 브리핑으로 현재 상태 확인",
          prompt: "30초 운영자 브리핑으로 지금 할 일만 알려줘",
          location: "/admin/bot",
          guardrail: "조회성 브리핑만 실행합니다."
        },
        {
          label: "Mission Control로 실행 순서 정리",
          prompt: input.missionControl?.firstCommand || "Mission Control로 지금 실행 순서를 정리해줘",
          location: "/admin/bot",
          guardrail: "삭제/발행은 여기서 직접 실행하지 않습니다."
        },
        {
          label: "Outcome Review로 전날 조치 확인",
          prompt: input.outcomeReview?.primaryPrompt || "Outcome Review로 최근 조치가 효과 있었는지 검토해줘",
          location: "/admin/bot",
          guardrail: "효과 확인 후 필요한 경우에만 새 승인 요청을 만듭니다."
        }
      ]
    },
    {
      id: "incident-response",
      title: "장애 조짐 대응",
      cadence: "incident",
      owner: "agent",
      why: "PUBG API, 비용, 배포, 승인 누적 신호가 나쁠 때 원인과 대응 순서를 빠르게 좁힙니다.",
      steps: [
        {
          label: "Risk Radar로 다음 위험 확인",
          prompt: "다음에 터질 수 있는 운영 위험을 Risk Radar로 예측해줘",
          location: "/admin/bot",
          guardrail: "예측과 진단만 수행합니다."
        },
        {
          label: "운영 SOP로 조치 절차 확인",
          prompt: "지금 상황에 맞는 운영 SOP를 단계별로 정리해줘",
          location: "/admin/bot",
          guardrail: "위험 조치는 승인 요청으로 분리합니다."
        },
        {
          label: "Owner Inbox로 직접 볼 일만 추림",
          prompt: input.ownerInbox?.primaryAction || "Owner Inbox로 내가 직접 볼 것과 위임할 것을 나눠줘",
          location: "/admin/bot",
          guardrail: "관리자가 결정할 항목과 Agent에게 맡길 항목을 분리합니다."
        }
      ]
    },
    {
      id: "approval-review",
      title: "승인 대기 검토",
      cadence: "approval",
      owner: "admin",
      why: "게시글 초안 저장, identity 정리, memory 저장 같은 위험 작업의 영향 범위를 승인 전에 확인합니다.",
      steps: [
        {
          label: "Approval Advisor로 권고 확인",
          prompt: input.approvalAdvisor?.primaryPrompt || "승인 대기 요청을 승인/거절/보류 권고로 나눠줘",
          location: "/admin/bot 승인 패널",
          guardrail: "impact와 execution gate를 확인하기 전에는 승인하지 않습니다."
        },
        {
          label: "Safety Audit로 차단 조건 확인",
          prompt: "Admin Agent 안전 감사 결과와 위험 승인 가능 여부를 점검해줘",
          location: "/admin/bot",
          guardrail: "block 상태의 approval은 재생성하거나 보류합니다."
        },
        {
          label: "실행 후 Outcome Review 확인",
          prompt: "Outcome Review로 최근 조치가 효과 있었는지 검토해줘",
          location: "/admin/bot",
          guardrail: "실행 결과와 error를 로그에 남긴 뒤 재확인합니다."
        }
      ]
    },
    {
      id: "growth-loop",
      title: "성장/콘텐츠 루프",
      cadence: "growth",
      owner: "agent",
      why: "운영 데이터가 쌓인 뒤 콘텐츠 성과, 다음 업그레이드, 기억 저장 후보로 연결합니다.",
      steps: [
        {
          label: "Operator Coach로 다음 질문 선택",
          prompt: input.operatorCoach?.topPrompt || "Operator Coach로 지금 가장 좋은 질문 3개를 골라줘",
          location: "/admin/bot",
          guardrail: "질문 추천은 조회성입니다."
        },
        {
          label: "콘텐츠 성과와 다음 초안 확인",
          prompt: "최근 게시글 성과를 분석하고 다음 콘텐츠를 추천해줘",
          location: "/admin/bot",
          guardrail: "게시글 발행은 승인 요청까지만 생성합니다."
        },
        {
          label: "업그레이드 로드맵 갱신",
          prompt: "Admin Agent 다음 업그레이드 로드맵을 정리해줘",
          location: "/admin/bot",
          guardrail: "무료 플랜 보호와 GitHub Actions 위임 원칙을 유지합니다."
        }
      ]
    }
  ];
}

function uniqueCompact(items: Array<string | null | undefined>) {
  return [...new Set(items.map((item) => String(item || "").trim()).filter(Boolean))];
}
