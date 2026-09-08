export type AgentAutomationContractStatus = "active" | "ready" | "manual" | "external";
export type AgentAutomationContractRisk = "safe" | "approval_required" | "manual_only";

export interface AgentAutomationContract {
  id: string;
  title: string;
  status: AgentAutomationContractStatus;
  cadence: string;
  owner: "agent" | "admin" | "github_actions" | "vercel";
  risk: AgentAutomationContractRisk;
  whatRuns: string;
  guardrail: string;
  whereToCheck: string;
  prompt?: string;
}

export interface AgentAutomationContractSummary {
  generatedAt: string;
  freePlanMode: boolean;
  summary: string;
  counts: Record<AgentAutomationContractStatus, number>;
  guardrails: string[];
  contracts: AgentAutomationContract[];
}

export function buildAgentAutomationContracts(input?: {
  pendingApprovals?: { count?: number; highRiskCount?: number; staleCount?: number };
  monitorSeverity?: "ok" | "warn" | "critical";
  deploymentConfigured?: boolean;
  discordConfigured?: boolean;
  communityAgent?: { enabled: boolean; publishingEnabled: boolean };
}): AgentAutomationContractSummary {
  const contracts: AgentAutomationContract[] = [
    {
      id: "monitor-snapshot",
      title: "운영 감시 스냅샷",
      status: "active",
      cadence: "GitHub Actions daily-tasks 마지막 step 또는 관리자 수동 실행",
      owner: "github_actions",
      risk: "safe",
      whatRuns: "PUBG API 에러, AI 비용, 승인 대기열, 배포 상태, daily checkout을 읽고 agent_runs에 기록합니다.",
      guardrail: "정상 상태는 Discord로 보내지 않고 로그만 남깁니다.",
      whereToCheck: "/admin/bot · Monitor Snapshot",
      prompt: "오늘 운영 브리핑 해줘"
    },
    {
      id: "discord-alerts",
      title: "위험 조건 Discord 알림",
      status: input?.discordConfigured ? "active" : "ready",
      cadence: "monitor snapshot 중 warn/critical 조건 발생 시",
      owner: "agent",
      risk: "safe",
      whatRuns: "문제 유형, 현재 수치, 확인 위치를 짧게 알립니다.",
      guardrail: "DISCORD_WEBHOOK_URL이 없으면 실패로 보지 않고 조용히 건너뜁니다.",
      whereToCheck: "Discord 채널 또는 /admin/bot · Latest Monitor",
      prompt: "최근 monitor 알림이 왜 발생했는지 요약해줘"
    },
    {
      id: "approval-impact",
      title: "승인 영향도 미리보기",
      status: "active",
      cadence: "승인 목록 조회 및 승인 직전",
      owner: "agent",
      risk: "approval_required",
      whatRuns: "게시글 발행, 캐시 삭제, benchmark reset의 예상 영향 범위를 계산합니다.",
      guardrail: "위험 작업은 승인 전 impact를 다시 계산하고 confirmedImpact가 없으면 실행하지 않습니다.",
      whereToCheck: "/admin/bot · Approval Panel",
      prompt: "승인 대기 작업을 impact 기준으로 검토해줘"
    },
    {
      id: "owner-brief",
      title: "30초 운영자 브리핑",
      status: "active",
      cadence: "관리자 질문 또는 command center 조회 시",
      owner: "agent",
      risk: "safe",
      whatRuns: "지금 할 일, 에이전트에게 맡길 일, 직접 봐야 할 일을 분리합니다.",
      guardrail: "읽기 전용으로만 계산하며 위험 작업을 자동 실행하지 않습니다.",
      whereToCheck: "/admin/bot · Owner Brief",
      prompt: "30초 운영자 브리핑으로 지금 할 일만 알려줘"
    },
    {
      id: "github-heavy-work",
      title: "긴 작업은 GitHub Actions 유지",
      status: "external",
      cadence: "기존 workflow 스케줄",
      owner: "github_actions",
      risk: "manual_only",
      whatRuns: "hotdrop/패치노트처럼 오래 걸리거나 무료 Vercel runtime에 부담이 되는 작업은 기존 workflow에 둡니다.",
      guardrail: "Vercel cron을 추가하지 않고 Agent는 관찰, 기록, 승인 보조에 집중합니다.",
      whereToCheck: "GitHub Actions · daily-tasks",
      prompt: "GitHub Actions 자동화와 Agent 역할 분담을 요약해줘"
    },
    {
      id: "community-agent-publishing",
      title: "커뮤니티 정책 범위 자동 발행",
      status: input?.communityAgent?.enabled && input.communityAgent.publishingEnabled
        ? "active"
        : input?.communityAgent?.enabled
          ? "ready"
          : "manual",
      cadence: "하루 최대 1건, 수집과 검증 조건을 충족할 때",
      owner: "agent",
      risk: "approval_required",
      whatRuns: "커뮤니티 AI 비서가 확인 가능한 자료를 수집하고 초안을 검증합니다. 자동 게시가 켜진 경우에만 정책 범위 안에서 게시합니다.",
      guardrail: "수집 중지, 하루 한도, 허용 카테고리, 출처 설정, 자료 부족 보류를 모두 지킵니다. 댓글과 답글은 이 자동화에 포함하지 않습니다.",
      whereToCheck: "/admin/bot · 커뮤니티 운영",
      prompt: "커뮤니티 운영 상태와 보류 사유를 요약해줘"
    }
  ];

  const counts = contracts.reduce<Record<AgentAutomationContractStatus, number>>((acc, contract) => {
    acc[contract.status] += 1;
    return acc;
  }, { active: 0, ready: 0, manual: 0, external: 0 });

  const pending = input?.pendingApprovals?.count || 0;
  const severity = input?.monitorSeverity || "ok";
  const summary = [
    `자동 실행 ${counts.active}개`,
    `준비됨 ${counts.ready}개`,
    `외부 위임 ${counts.external}개`,
    pending ? `승인 대기 ${pending}건` : "승인 대기 없음",
    severity !== "ok" ? `monitor ${severity}` : "monitor ok"
  ].join(" · ");

  return {
    generatedAt: new Date().toISOString(),
    freePlanMode: true,
    summary,
    counts,
    guardrails: [
      "Vercel cron은 추가하지 않습니다.",
      "일반 관리자 도구의 삭제, 발행, 권한 변경, 대량 수정은 승인 없이는 실행하지 않습니다. 커뮤니티 정책 범위 자동 발행은 별도 계약을 따릅니다.",
      "서비스 role 권한은 서버 route와 admin-agent lib 안에서만 사용합니다.",
      "긴 작업은 기존 GitHub Actions에 남기고 Agent는 snapshot과 영향 분석을 맡습니다."
    ],
    contracts
  };
}
