import { SchemaType, type FunctionDeclaration } from "@google/generative-ai";
import puppeteer from "puppeteer";
import { buildAgentBriefing, renderBriefingText } from "@/lib/admin-agent/briefing";
import { buildContentDraft } from "@/lib/admin-agent/content";
import { buildContentPerformanceReport } from "@/lib/admin-agent/content-performance";
import { buildAgentDailyCheckout } from "@/lib/admin-agent/daily-checkout";
import { auditProcessedTelemetryIdentity, buildProcessedTelemetryIdentityRepairPayload } from "@/lib/admin-agent/data-quality";
import { buildAgentDecisionTrace } from "@/lib/admin-agent/decision-trace";
import { buildAgentFinalReadiness } from "@/lib/admin-agent/final-readiness";
import { buildAgentHandoffPacket } from "@/lib/admin-agent/handoff";
import { buildIncidentTimeline } from "@/lib/admin-agent/incident-timeline";
import { fetchApprovalGateSummary, fetchApprovalQueueSummary, normalizeApproval, summarizeApprovalQueue } from "@/lib/admin-agent/approvals";
import { buildTodayActionBoard } from "@/lib/admin-agent/action-board";
import { buildAgentApprovalAdvisor } from "@/lib/admin-agent/approval-advisor";
import { buildAgentAutomationContracts } from "@/lib/admin-agent/automation-contracts";
import { buildAgentCapabilityMatrix } from "@/lib/admin-agent/capability-matrix";
import { buildApprovalExecutionGate, calculateApprovalImpact } from "@/lib/admin-agent/impact";
import { buildAgentGrowthRoadmap } from "@/lib/admin-agent/growth-roadmap";
import { buildAgentImprovementBacklog } from "@/lib/admin-agent/improvement-backlog";
import { buildAgentLaunchKit } from "@/lib/admin-agent/launch-kit";
import { buildAgentMissionControl } from "@/lib/admin-agent/mission-control";
import { buildAgentMonitorTrend } from "@/lib/admin-agent/monitor-trend";
import { buildAgentOperatingSop } from "@/lib/admin-agent/operating-sop";
import { buildAgentOwnerInbox } from "@/lib/admin-agent/owner-inbox";
import { buildAgentOperatorCoach } from "@/lib/admin-agent/operator-coach";
import { buildOperatorValueScorecard } from "@/lib/admin-agent/operator-value";
import { buildAgentOutcomeReview } from "@/lib/admin-agent/outcome-review";
import { buildAgentOwnerBrief } from "@/lib/admin-agent/owner-brief";
import { defaultPlaybooks, matchPlaybooks } from "@/lib/admin-agent/playbooks";
import { buildAgentRiskRadar } from "@/lib/admin-agent/risk-radar";
import { buildAgentSafetyAudit } from "@/lib/admin-agent/safety-audit";
import { buildAgentRolloutReadiness } from "@/lib/admin-agent/rollout";
import { runAgentSelfTest } from "@/lib/admin-agent/self-test";
import { buildAgentToolCatalog } from "@/lib/admin-agent/tool-catalog";
import { buildTrafficSummary, renderTrafficSummaryText } from "@/lib/admin-agent/traffic-summary";
import { getAgentThresholds } from "@/lib/admin-agent/thresholds";
import { buildUserMetricsSummary, renderUserMetricsSummaryText } from "@/lib/admin-agent/user-metrics";
import { buildStorageHealth } from "@/lib/admin-agent/storage-health";
import { createApprovalRequest } from "./logging";
import type { AdminAgentContext, AdminAgentTool, AgentToolResult } from "./types";

const getDbStatisticsDecl: FunctionDeclaration = {
  name: "get_db_statistics",
  description: "DB에서 PUBG 매치 기반 플레이어 성과, 맵 선호도, API 에러 통계, 코칭 스타일 선호도 정보를 집계합니다. 가입자/회원 수는 inspect_user_metrics를 사용합니다.",
  parameters: {
    type: SchemaType.OBJECT,
    properties: {
      statType: {
        type: SchemaType.STRING,
        description: "조회할 통계 유형: 'map_preference', 'top_players', 'api_errors', 'coaching_preference', 'general_stats'. 회원/방문자 수에는 사용하지 않습니다."
      }
    },
    required: ["statType"]
  }
};

const inspectOperationsDecl: FunctionDeclaration = {
  name: "inspect_operations",
  description: "운영 상태를 진단합니다. PUBG API 에러, AI 비용, R2/텔레메트리 캐시, pending marker 현황을 묶어 문제 원인과 조치안을 만들 때 사용합니다.",
  parameters: {
    type: SchemaType.OBJECT,
    properties: {
      focus: {
        type: SchemaType.STRING,
        description: "진단 초점: 'api_errors', 'ai_cost', 'cache_health', 'pending_markers', 'overview'"
      },
      hours: {
        type: SchemaType.NUMBER,
        description: "최근 몇 시간 범위를 볼지 지정합니다. 기본 24."
      }
    },
    required: ["focus"]
  }
};

const inspectAgentReadinessDecl: FunctionDeclaration = {
  name: "inspect_agent_readiness",
  description: "Admin Agent 자체 준비 상태를 조회합니다. 필수 테이블 접근성, env 구성 여부, tool registry, 승인 대기 수를 점검하는 read-only 진단입니다.",
  parameters: {
    type: SchemaType.OBJECT,
    properties: {
      includeOptional: {
        type: SchemaType.BOOLEAN,
        description: "선택 env와 관측 테이블까지 함께 볼지 여부. 기본 true."
      }
    }
  }
};

const inspectApprovalQueueDecl: FunctionDeclaration = {
  name: "inspect_approval_queue",
  description: "승인 대기열을 impact와 queue priority 기준으로 조회합니다. 승인/거절/실행은 하지 않는 read-only 분석 도구입니다.",
  parameters: {
    type: SchemaType.OBJECT,
    properties: {
      status: {
        type: SchemaType.STRING,
        description: "조회할 approval 상태. 기본 'pending'. 예: pending, approved, rejected, executed, failed, all"
      },
      limit: {
        type: SchemaType.NUMBER,
        description: "가져올 approval 개수. 기본 10, 최대 30."
      }
    }
  }
};

const inspectIncidentTimelineDecl: FunctionDeclaration = {
  name: "inspect_incident_timeline",
  description: "최근 운영 사고 흐름을 시간순으로 조회합니다. agent run, failed step, approval, PUBG API error를 묶어 원인 추적과 공유용 요약을 만드는 read-only 도구입니다.",
  parameters: {
    type: SchemaType.OBJECT,
    properties: {
      hours: {
        type: SchemaType.NUMBER,
        description: "최근 몇 시간 범위를 볼지 지정합니다. 기본 24, 최대 168."
      },
      limit: {
        type: SchemaType.NUMBER,
        description: "가져올 이벤트 개수. 기본 80, 최대 200."
      },
      includeMarkdown: {
        type: SchemaType.BOOLEAN,
        description: "공유용 Markdown 본문을 포함할지 여부. 기본 false."
      }
    }
  }
};

const inspectHandoffPacketDecl: FunctionDeclaration = {
  name: "inspect_handoff_packet",
  description: "운영 교대/인수인계를 위한 handoff packet을 생성합니다. 승인 큐, readiness, 최신 리포트, 최신 run, 사고 타임라인, 후속 조치를 묶는 read-only 도구입니다. 저장은 하지 않습니다.",
  parameters: {
    type: SchemaType.OBJECT,
    properties: {
      hours: {
        type: SchemaType.NUMBER,
        description: "최근 몇 시간 범위를 볼지 지정합니다. 기본 24, 최대 168."
      },
      includeMarkdown: {
        type: SchemaType.BOOLEAN,
        description: "공유용 Markdown 본문을 포함할지 여부. 기본 false."
      }
    }
  }
};

const inspectOperatorValueDecl: FunctionDeclaration = {
  name: "inspect_operator_value",
  description: "Admin Agent가 최근 운영자에게 제공한 실질 가치를 조회합니다. 시간 절약, 위험 차단/검토, 자동화 커버리지, 학습 루프, 콘텐츠 레버리지를 계산하는 read-only 도구입니다.",
  parameters: {
    type: SchemaType.OBJECT,
    properties: {
      hours: {
        type: SchemaType.NUMBER,
        description: "최근 몇 시간 범위를 볼지 지정합니다. 기본 24, 최대 168."
      },
      includeContent: {
        type: SchemaType.BOOLEAN,
        description: "콘텐츠 성과 분석까지 포함할지 여부. 기본 true."
      }
    }
  }
};

const inspectOwnerBriefDecl: FunctionDeclaration = {
  name: "inspect_owner_brief",
  description: "운영자를 위한 30초 브리핑을 생성합니다. Owner Brief, 지금 할 일, 에이전트에게 맡길 일, 직접 확인할 일을 반환하는 read-only 도구입니다.",
  parameters: {
    type: SchemaType.OBJECT,
    properties: {
      hours: {
        type: SchemaType.NUMBER,
        description: "최근 몇 시간 범위를 볼지 지정합니다. 기본 24, 최대 168."
      }
    }
  }
};

const inspectMonitorTrendDecl: FunctionDeclaration = {
  name: "inspect_monitor_trend",
  description: "최근 Admin Agent monitor snapshot 추세를 조회합니다. 개선 중/안정/악화 조짐/데이터 부족을 계산하는 read-only 도구입니다.",
  parameters: {
    type: SchemaType.OBJECT,
    properties: {
      limit: {
        type: SchemaType.NUMBER,
        description: "비교할 monitor snapshot 개수. 기본 7, 최대 14."
      }
    }
  }
};

const inspectAutomationContractDecl: FunctionDeclaration = {
  name: "inspect_automation_contract",
  description: "Admin Agent 자동화 계약을 조회합니다. 무엇이 자동 실행되고, 무엇이 승인 필요하며, 무엇이 GitHub Actions에 위임되는지 설명하는 read-only 도구입니다.",
  parameters: {
    type: SchemaType.OBJECT,
    properties: {
      includeContracts: {
        type: SchemaType.BOOLEAN,
        description: "개별 자동화 계약 목록까지 포함할지 여부. 기본 true."
      }
    }
  }
};

const summarizeUserActivityDecl: FunctionDeclaration = {
  name: "summarize_user_activity",
  description: "최근 방문 세션, 페이지뷰, 전적 검색, AI 기능, 게시판 활동, 상자/리플레이 사용량을 Supabase analytics_events에서 집계합니다. read-only 운영 분석 도구입니다.",
  parameters: {
    type: SchemaType.OBJECT,
    properties: {
      hours: {
        type: SchemaType.NUMBER,
        description: "최근 몇 시간 범위를 볼지 지정합니다. 기본 24, 최대 168."
      }
    }
  }
};

const inspectUserMetricsDecl: FunctionDeclaration = {
  name: "inspect_user_metrics",
  description: "Supabase Auth와 profiles를 service role 권한으로 조회해 가입자 수, 관리자 제외 회원 수, 최근 로그인/활동 유저 수, profiles 누락 여부를 집계합니다. read-only 관리자 유저 지표 도구입니다.",
  parameters: {
    type: SchemaType.OBJECT,
    properties: {
      hours: {
        type: SchemaType.NUMBER,
        description: "최근 몇 시간 범위를 볼지 지정합니다. 기본 24, 최대 168."
      }
    }
  }
};

const inspectCapabilityMatrixDecl: FunctionDeclaration = {
  name: "inspect_capability_matrix",
  description: "Admin Agent가 현재 실제로 무엇을 할 수 있고 어떤 능력이 부족한지 capability matrix로 조회합니다. read-only 자기 점검 도구입니다.",
  parameters: {
    type: SchemaType.OBJECT,
    properties: {
      includeDetails: {
        type: SchemaType.BOOLEAN,
        description: "각 capability의 evidence와 nextStep까지 포함할지 여부. 기본 true."
      }
    }
  }
};

const inspectGrowthRoadmapDecl: FunctionDeclaration = {
  name: "inspect_growth_roadmap",
  description: "Admin Agent의 다음 업그레이드 로드맵을 조회합니다. Now/This Week/Later 개선 액션과 첫 실행 프롬프트를 계산하는 read-only 도구입니다.",
  parameters: {
    type: SchemaType.OBJECT,
    properties: {
      hours: {
        type: SchemaType.NUMBER,
        description: "최근 몇 시간 범위를 볼지 지정합니다. 기본 24, 최대 168."
      }
    }
  }
};

const inspectTodayActionBoardDecl: FunctionDeclaration = {
  name: "inspect_today_action_board",
  description: "오늘 처리할 운영 액션 보드를 조회합니다. Do Now/Review/Watch/Save lane과 첫 실행 프롬프트를 계산하는 read-only 도구입니다.",
  parameters: {
    type: SchemaType.OBJECT,
    properties: {
      includeChecklist: {
        type: SchemaType.BOOLEAN,
        description: "각 액션의 checklist를 포함할지 여부. 기본 true."
      }
    }
  }
};

const inspectDailyCheckoutDecl: FunctionDeclaration = {
  name: "inspect_daily_checkout",
  description: "오늘 운영 마감 가능 여부를 조회합니다. 마감 점수, 완료 신호, 남은 위험, 내일 포커스, 인수인계 프롬프트를 계산하는 read-only 도구입니다.",
  parameters: {
    type: SchemaType.OBJECT,
    properties: {
      hours: {
        type: SchemaType.NUMBER,
        description: "최근 몇 시간 범위를 볼지 지정합니다. 기본 24, 최대 168."
      }
    }
  }
};

const inspectOperatingSopDecl: FunctionDeclaration = {
  name: "inspect_operating_sop",
  description: "현재 운영 상태에 맞는 단계별 운영 SOP를 조회합니다. 승인/삭제/발행은 하지 않고, 확인 위치와 절차, 완료 기준, 다음 프롬프트를 계산하는 read-only 도구입니다.",
  parameters: {
    type: SchemaType.OBJECT,
    properties: {
      hours: {
        type: SchemaType.NUMBER,
        description: "최근 몇 시간 범위를 볼지 지정합니다. 기본 24, 최대 168."
      },
      includeSteps: {
        type: SchemaType.BOOLEAN,
        description: "각 SOP 절차의 단계와 완료 기준을 포함할지 여부. 기본 true."
      }
    }
  }
};

const inspectRiskRadarDecl: FunctionDeclaration = {
  name: "inspect_risk_radar",
  description: "다음에 터질 수 있는 운영 위험을 예측합니다. 승인 누적, API/API 비용, 배포, readiness, 콘텐츠 정체를 묶어 예방 액션을 제안하는 read-only 도구입니다.",
  parameters: {
    type: SchemaType.OBJECT,
    properties: {
      hours: {
        type: SchemaType.NUMBER,
        description: "최근 몇 시간 범위를 볼지 지정합니다. 기본 24, 최대 168."
      }
    }
  }
};

const inspectDecisionTraceDecl: FunctionDeclaration = {
  name: "inspect_decision_trace",
  description: "Admin Agent가 왜 특정 운영 판단을 했는지 근거를 추적합니다. observation, decision, blind spot, verify prompt를 반환하는 read-only 도구입니다.",
  parameters: {
    type: SchemaType.OBJECT,
    properties: {
      hours: {
        type: SchemaType.NUMBER,
        description: "최근 몇 시간 범위를 볼지 지정합니다. 기본 24, 최대 168."
      }
    }
  }
};

const inspectSafetyAuditDecl: FunctionDeclaration = {
  name: "inspect_safety_audit",
  description: "Admin Agent의 안전 경계를 점검합니다. admin/API guard, 위험 도구 승인 강제, execution gate, log redaction, 무료 플랜 guardrail을 검토하는 read-only 도구입니다.",
  parameters: {
    type: SchemaType.OBJECT,
    properties: {
      hours: {
        type: SchemaType.NUMBER,
        description: "최근 몇 시간 범위를 볼지 지정합니다. 기본 24, 최대 168."
      }
    }
  }
};

const inspectApprovalAdvisorDecl: FunctionDeclaration = {
  name: "inspect_approval_advisor",
  description: "승인 대기 요청을 승인/거절/보류 권고로 분류합니다. impact 실행은 하지 않고 approval queue, execution gate, safety audit, risk radar를 묶어 read-only로 판단합니다.",
  parameters: {
    type: SchemaType.OBJECT,
    properties: {
      hours: {
        type: SchemaType.NUMBER,
        description: "최근 몇 시간 범위를 볼지 지정합니다. 기본 24, 최대 168."
      }
    }
  }
};

const inspectMissionControlDecl: FunctionDeclaration = {
  name: "inspect_mission_control",
  description: "현재 운영 신호를 하나의 실행 순서로 정리합니다. Owner Brief, Action Board, Approval Advisor, SOP, Risk Radar를 묶는 read-only 운영 지휘 도구입니다.",
  parameters: {
    type: SchemaType.OBJECT,
    properties: {
      hours: {
        type: SchemaType.NUMBER,
        description: "최근 몇 시간 범위를 볼지 지정합니다. 기본 24, 최대 168."
      }
    }
  }
};

const inspectOwnerInboxDecl: FunctionDeclaration = {
  name: "inspect_owner_inbox",
  description: "운영자가 직접 결정할 것, 승인 패널에서 볼 것, 에이전트에게 위임할 것, 나중에 관찰할 것을 분류하는 read-only inbox 도구입니다.",
  parameters: {
    type: SchemaType.OBJECT,
    properties: {
      hours: {
        type: SchemaType.NUMBER,
        description: "최근 몇 시간 범위를 볼지 지정합니다. 기본 24, 최대 168."
      }
    }
  }
};

const inspectOutcomeReviewDecl: FunctionDeclaration = {
  name: "inspect_outcome_review",
  description: "최근 운영 조치가 효과 있었는지, 아직 후속 조치가 남았는지 검토합니다. agent run, approval outcome, monitor, incident 신호를 묶는 read-only 결과 검증 도구입니다.",
  parameters: {
    type: SchemaType.OBJECT,
    properties: {
      hours: {
        type: SchemaType.NUMBER,
        description: "최근 몇 시간 범위를 볼지 지정합니다. 기본 24, 최대 168."
      }
    }
  }
};

const inspectOperatorCoachDecl: FunctionDeclaration = {
  name: "inspect_operator_coach",
  description: "현재 상황에서 운영자가 물어볼 가장 좋은 다음 질문/프롬프트를 추천합니다. outcome, inbox, mission, roadmap, value 신호를 묶는 read-only 코칭 도구입니다.",
  parameters: {
    type: SchemaType.OBJECT,
    properties: {
      hours: {
        type: SchemaType.NUMBER,
        description: "최근 몇 시간 범위를 볼지 지정합니다. 기본 24, 최대 168."
      }
    }
  }
};

const inspectLaunchKitDecl: FunctionDeclaration = {
  name: "inspect_launch_kit",
  description: "현재 Admin Agent를 어떻게 쓰면 되는지 daily/incident/approval/growth routine과 guardrail을 정리하는 read-only 런치 키트 도구입니다.",
  parameters: {
    type: SchemaType.OBJECT,
    properties: {
      hours: {
        type: SchemaType.NUMBER,
        description: "최근 몇 시간 범위를 볼지 지정합니다. 기본 24, 최대 168."
      }
    }
  }
};

const inspectFinalReadinessDecl: FunctionDeclaration = {
  name: "inspect_final_readiness",
  description: "BGMS Admin Agent가 최종형 운영 에이전트로 충분한지 보안, 승인, 진단, 자동화, 사용성, 학습, 콘텐츠, 검증 증거와 남은 일을 계산하는 read-only 도구입니다.",
  parameters: {
    type: SchemaType.OBJECT,
    properties: {
      hours: {
        type: SchemaType.NUMBER,
        description: "최근 몇 시간 범위를 볼지 지정합니다. 기본 24, 최대 168."
      }
    }
  }
};

const createBoardPostDecl: FunctionDeclaration = {
  name: "create_board_post",
  description: "커뮤니티 자유게시판에 HTML 본문을 포함한 분석 리포트 글을 발행합니다. 위험 작업이므로 승인 대기 요청만 생성합니다.",
  parameters: {
    type: SchemaType.OBJECT,
    properties: {
      title: { type: SchemaType.STRING, description: "게시글 제목" },
      content: { type: SchemaType.STRING, description: "HTML 형식의 게시글 본문" }
    },
    required: ["title", "content"]
  }
};

const updateBoardPostDecl: FunctionDeclaration = {
  name: "update_board_post",
  description: "이미 등록된 게시글의 제목과 본문을 수정합니다. 위험 작업이므로 승인 대기 요청만 생성합니다. [주의] 기존 본문에 있던 이미지 태그(<img>)를 누락하고 content를 작성하면 승인 시 스토리지에서 실제 이미지 파일이 자동 삭제되므로, 이미지를 명시적으로 삭제하려는 목적이 아니라면 원본 본문의 <img> 태그들을 반드시 누락 없이 복사하여 새 content에 유지시켜야 합니다.",
  parameters: {
    type: SchemaType.OBJECT,
    properties: {
      postId: { type: SchemaType.NUMBER, description: "수정할 게시글의 고유 ID" },
      title: { type: SchemaType.STRING, description: "수정할 제목" },
      content: { type: SchemaType.STRING, description: "HTML 형식의 수정할 본문" }
    },
    required: ["postId", "title", "content"]
  }
};

const requestCacheCleanupDecl: FunctionDeclaration = {
  name: "request_cache_cleanup",
  description: "캐시 삭제 작업을 승인 대기 요청으로 등록합니다. 실제 삭제는 관리자 승인 후 별도 실행됩니다. 단순 R2 파일 수/용량만 보고 flush_old_cache를 제안하지 말고, 명확한 장애 원인이나 사용자의 직접 요청이 있을 때만 사용합니다.",
  parameters: {
    type: SchemaType.OBJECT,
    properties: {
      cleanupType: {
        type: SchemaType.STRING,
        description: "삭제 유형: 'flush_old_cache', 'flush_player_cache', 'flush_match_cache', 'reset_benchmarks'"
      },
      nickname: { type: SchemaType.STRING, description: "플레이어 캐시 삭제 대상 닉네임" },
      matchId: { type: SchemaType.STRING, description: "매치 캐시 삭제 대상 matchId" },
      olderThanDays: { type: SchemaType.NUMBER, description: "flush_old_cache 대상 기준 일수. 기본 14일." },
      reason: { type: SchemaType.STRING, description: "관리자가 승인할 수 있도록 남기는 삭제 사유" }
    },
    required: ["cleanupType", "reason"]
  }
};

const inspectDataQualityDecl: FunctionDeclaration = {
  name: "inspect_data_quality",
  description: "전적 분석 캐시의 데이터 품질을 점검합니다. processed_match_telemetry identity mismatch를 dry-run으로 검사하며 삭제하지 않습니다.",
  parameters: {
    type: SchemaType.OBJECT,
    properties: {
      recentDays: { type: SchemaType.NUMBER, description: "최근 며칠 범위를 검사할지 지정합니다. 기본 2일." },
      maxRows: { type: SchemaType.NUMBER, description: "최대 검사 row 수입니다. 기본 1000." }
    }
  }
};

const requestDataQualityRepairDecl: FunctionDeclaration = {
  name: "request_data_quality_repair",
  description: "전적 분석 identity mismatch 정리를 승인 대기 요청으로 등록합니다. 실제 삭제는 관리자 승인 후 targets 재검증을 거쳐 실행됩니다.",
  parameters: {
    type: SchemaType.OBJECT,
    properties: {
      recentDays: { type: SchemaType.NUMBER, description: "최근 며칠 범위를 검사할지 지정합니다. 기본 2일." },
      maxRows: { type: SchemaType.NUMBER, description: "최대 검사 row 수입니다. 기본 1000." },
      targetLimit: { type: SchemaType.NUMBER, description: "승인 요청에 포함할 최대 삭제 후보 수입니다. 기본 50." },
      reason: { type: SchemaType.STRING, description: "관리자가 승인할 수 있도록 남기는 정리 사유" }
    }
  }
};

const takeMapScreenshotDecl: FunctionDeclaration = {
  name: "take_map_screenshot",
  description: "특정 지도 화면을 가상 브라우저로 캡처하고 Storage 업로드 후 이미지 URL을 반환합니다.",
  parameters: {
    type: SchemaType.OBJECT,
    properties: {
      mapName: { type: SchemaType.STRING, description: "캡처할 맵 명칭. 예: miramar, erangel, taego" },
      layer: { type: SchemaType.STRING, description: "활성화할 레이어. 예: secret_room, vehicle" }
    },
    required: ["mapName", "layer"]
  }
};

const tavilySearchDecl: FunctionDeclaration = {
  name: "tavily_search",
  description: "최신 PUBG 패치 노트, 공략 트렌드, 커뮤니티 반응 등 실시간 인터넷 정보를 검색합니다.",
  parameters: {
    type: SchemaType.OBJECT,
    properties: {
      query: { type: SchemaType.STRING, description: "검색할 쿼리" }
    },
    required: ["query"]
  }
};

const getVercelDeploymentsDecl: FunctionDeclaration = {
  name: "get_vercel_deployments",
  description: "Vercel 최근 배포 리스트와 상태를 조회합니다.",
  parameters: {
    type: SchemaType.OBJECT,
    properties: {
      limit: { type: SchemaType.NUMBER, description: "가져올 배포 개수. 기본 5." }
    }
  }
};

const getVercelBuildLogsDecl: FunctionDeclaration = {
  name: "get_vercel_build_logs",
  description: "Vercel 특정 배포 ID의 빌드 로그를 가져와 실패 원인을 파악합니다.",
  parameters: {
    type: SchemaType.OBJECT,
    properties: {
      deploymentId: { type: SchemaType.STRING, description: "조회할 Vercel 배포 ID" }
    },
    required: ["deploymentId"]
  }
};

const searchAgentMemoriesDecl: FunctionDeclaration = {
  name: "search_agent_memories",
  description: "이전 장애, 운영 정책, 해결책 등 agent_memories에 저장된 운영 기억을 검색합니다.",
  parameters: {
    type: SchemaType.OBJECT,
    properties: {
      category: { type: SchemaType.STRING, description: "검색할 memory category. 예: incident, policy, content, operations" },
      query: { type: SchemaType.STRING, description: "제목/본문에서 찾을 키워드" },
      limit: { type: SchemaType.NUMBER, description: "가져올 개수. 기본 5." }
    }
  }
};

const requestAgentMemoryDecl: FunctionDeclaration = {
  name: "request_agent_memory",
  description: "새 운영 기억 저장을 승인 대기 요청으로 등록합니다. 실제 저장은 관리자 승인 후 실행됩니다.",
  parameters: {
    type: SchemaType.OBJECT,
    properties: {
      category: { type: SchemaType.STRING, description: "memory category. 예: incident, policy, content, operations" },
      title: { type: SchemaType.STRING, description: "짧고 검색 가능한 제목" },
      body: { type: SchemaType.STRING, description: "반복 참고할 운영 지식, 원인, 해결책, 정책" },
      tags: { type: SchemaType.ARRAY, items: { type: SchemaType.STRING }, description: "검색용 태그" },
      reason: { type: SchemaType.STRING, description: "이 기억을 저장해야 하는 이유" }
    },
    required: ["category", "title", "body", "reason"]
  }
};

const generateOperationsBriefingDecl: FunctionDeclaration = {
  name: "generate_operations_briefing",
  description: "최근 운영 상태, alerts, playbooks, memories를 묶어 운영 브리핑을 생성합니다. 조회성 작업이라 바로 실행됩니다.",
  parameters: {
    type: SchemaType.OBJECT,
    properties: {
      hours: { type: SchemaType.NUMBER, description: "최근 몇 시간 범위를 볼지 지정합니다. 기본 24." }
    }
  }
};

const requestOperationsReportDecl: FunctionDeclaration = {
  name: "request_operations_report",
  description: "운영 브리핑을 agent memory의 report로 저장하는 승인 대기 요청을 생성합니다.",
  parameters: {
    type: SchemaType.OBJECT,
    properties: {
      hours: { type: SchemaType.NUMBER, description: "최근 몇 시간 범위를 볼지 지정합니다. 기본 24." },
      title: { type: SchemaType.STRING, description: "저장할 리포트 제목" },
      reason: { type: SchemaType.STRING, description: "리포트를 저장해야 하는 이유" }
    },
    required: ["reason"]
  }
};

const generateContentDraftDecl: FunctionDeclaration = {
  name: "generate_content_draft",
  description: "운영 데이터와 사이트 통계를 바탕으로 게시글 초안을 생성합니다. 발행하지 않는 조회성 작업입니다.",
  parameters: {
    type: SchemaType.OBJECT,
    properties: {
      draftType: {
        type: SchemaType.STRING,
        description: "초안 유형: 'weekly_ops', 'patch_digest', 'map_trends', 'community_notice'"
      },
      hours: { type: SchemaType.NUMBER, description: "최근 몇 시간 범위의 데이터를 볼지 지정합니다. 기본 168." },
      tone: { type: SchemaType.STRING, description: "문체 지시. 예: 친근한 운영 공지, 분석가 톤" }
    }
  }
};

const analyzeContentPerformanceDecl: FunctionDeclaration = {
  name: "analyze_content_performance",
  description: "최근 게시글의 조회수, 좋아요, 댓글, 카테고리별 성과를 분석하고 다음 콘텐츠 추천을 생성합니다. 조회성 작업입니다.",
  parameters: {
    type: SchemaType.OBJECT,
    properties: {
      days: { type: SchemaType.NUMBER, description: "최근 며칠 범위를 분석할지 지정합니다. 기본 30." },
      limit: { type: SchemaType.NUMBER, description: "분석할 게시글 수. 기본 50." }
    }
  }
};

const requestContentPostDecl: FunctionDeclaration = {
  name: "request_content_post",
  description: "운영 데이터 기반 게시글 초안을 만들고 자유게시판 발행 승인 요청을 생성합니다. 실제 발행은 관리자 승인 후에만 됩니다.",
  parameters: {
    type: SchemaType.OBJECT,
    properties: {
      draftType: {
        type: SchemaType.STRING,
        description: "초안 유형: 'weekly_ops', 'patch_digest', 'map_trends', 'community_notice'"
      },
      hours: { type: SchemaType.NUMBER, description: "최근 몇 시간 범위의 데이터를 볼지 지정합니다. 기본 168." },
      title: { type: SchemaType.STRING, description: "기본 제목을 덮어쓸 제목" },
      reason: { type: SchemaType.STRING, description: "발행 승인이 필요한 이유" }
    },
    required: ["draftType", "reason"]
  }
};

function ok(result: unknown): AgentToolResult {
  return {
    status: "success",
    result: typeof result === "string" ? result : JSON.stringify(result)
  };
}

function failed(error: unknown): AgentToolResult {
  const message = error instanceof Error ? error.message : String(error);
  return { status: "failed", result: `Error: ${message}` };
}

export async function runDbStatQuery(statType: string, supabase: any): Promise<string> {
  if (statType === "map_preference") {
    const { data, error } = await supabase
      .from("match_stats_raw")
      .select("map_name")
      .eq("is_analysis_sample", true)
      .order("created_at", { ascending: false })
      .limit(2000);

    if (error) throw error;
    const counts: Record<string, number> = {};
    data?.forEach((r: any) => {
      counts[r.map_name] = (counts[r.map_name] || 0) + 1;
    });
    return JSON.stringify({
      description: "최근 2000건의 매치 데이터를 기반으로 집계한 인기 맵 선호도 순위입니다.",
      data: counts
    });
  }

  if (statType === "top_players") {
    const { data, error } = await supabase
      .from("match_stats_raw")
      .select("player_id, damage, kills, map_name")
      .eq("win_place", 1)
      .order("damage", { ascending: false })
      .limit(5);

    if (error) throw error;
    return JSON.stringify({
      description: "최근 1등 매치 중 최다 딜량을 기록한 랭커 탑 5입니다.",
      data
    });
  }

  if (statType === "api_errors") {
    const { data, error } = await supabase
      .from("pubg_api_errors")
      .select("message, status")
      .order("created_at", { ascending: false })
      .limit(100);

    if (error) throw error;
    const counts: Record<string, number> = {};
    data?.forEach((r: any) => {
      const key = `${r.status} - ${r.message}`;
      counts[key] = (counts[key] || 0) + 1;
    });
    return JSON.stringify({
      description: "최근 PUBG API 연동 에러 100건의 빈도별 집계입니다.",
      data: counts
    });
  }

  if (statType === "coaching_preference") {
    const { data, error } = await supabase
      .from("match_ai_coaching_cache")
      .select("coaching_style");

    if (error) throw error;
    const counts: Record<string, number> = {};
    data?.forEach((r: any) => {
      counts[r.coaching_style] = (counts[r.coaching_style] || 0) + 1;
    });
    return JSON.stringify({
      description: "유저들이 요청한 AI 코칭 스타일 선호 비중입니다.",
      data: counts
    });
  }

  if (statType === "general_stats") {
    const { data, error } = await supabase
      .from("match_stats_raw")
      .select("kills, damage")
      .eq("is_analysis_sample", true)
      .order("created_at", { ascending: false })
      .limit(2000);

    if (error) throw error;
    if (!data || data.length === 0) return "No data found";
    const totals = data.reduce(
      (acc: { kills: number; damage: number }, row: any) => ({
        kills: acc.kills + Number(row.kills || 0),
        damage: acc.damage + Number(row.damage || 0)
      }),
      { kills: 0, damage: 0 }
    );
    return JSON.stringify({
      description: "최근 2000건의 매치 기준 일반 유저 평균 통계입니다.",
      averageKills: (totals.kills / data.length).toFixed(2),
      averageDamage: (totals.damage / data.length).toFixed(1)
    });
  }

  return "알 수 없는 통계 유형입니다.";
}

async function inspectOperations(args: any, supabase: any): Promise<string> {
  const focus = args.focus || "overview";
  const hours = Number(args.hours || 24);
  const since = new Date(Date.now() - hours * 60 * 60 * 1000).toISOString();
  const result: Record<string, unknown> = {
    description: `최근 ${hours}시간 기준 운영 진단 데이터입니다.`,
    focus
  };

  if (focus === "api_errors" || focus === "overview") {
    const { data, error } = await supabase
      .from("pubg_api_errors")
      .select("route, status, message, detail, created_at")
      .gte("created_at", since)
      .order("created_at", { ascending: false })
      .limit(100);
    result.apiErrors = error ? { error: error.message } : summarizeApiErrors(data || []);
  }

  if (focus === "ai_cost" || focus === "overview") {
    const { data, error } = await supabase
      .from("ai_usage_logs")
      .select("model_name, analysis_type, prompt_tokens, completion_tokens, cost_usd, created_at")
      .gte("created_at", since)
      .order("created_at", { ascending: false })
      .limit(500);
    result.aiUsage = error ? { error: error.message } : summarizeAiUsage(data || []);
  }

  if (focus === "cache_health" || focus === "overview") {
    const telemetryCount = await countRows(supabase, "processed_match_telemetry");
    const storageHealth = await buildStorageHealth(supabase);
    result.cacheHealth = {
      processedTelemetryRows: telemetryCount,
      r2: storageHealth.r2,
      database: storageHealth.database,
      tables: storageHealth.tables,
      recommendations: storageHealth.recommendations
    };
  }

  if (focus === "pending_markers" || focus === "overview") {
    const pendingCount = await countRows(supabase, "pending_markers");
    const { data, error } = await supabase
      .from("pending_markers")
      .select("*")
      .order("created_at", { ascending: false })
      .limit(20);
    result.pendingMarkers = error ? { count: pendingCount, error: error.message } : { count: pendingCount, latest: data || [] };
  }

  return JSON.stringify(result);
}

async function inspectAgentReadiness(args: any, supabase: any): Promise<string> {
  const includeOptional = args.includeOptional !== false;
  const requiredTables = ["agent_runs", "agent_steps", "agent_approvals", "agent_memories"];
  const optionalTables = includeOptional ? ["pubg_api_errors", "ai_usage_logs", "processed_match_telemetry", "analytics_events", "profiles"] : [];
  const tableChecks = await Promise.all(
    [...requiredTables, ...optionalTables].map(async (table) => {
      const { count, error } = await supabase
        .from(table)
        .select("*", { count: "exact", head: true });
      return {
        table,
        required: requiredTables.includes(table),
        status: error ? requiredTables.includes(table) ? "critical" : "warn" : "ok",
        message: error?.message || "reachable",
        count: count || 0
      };
    })
  );

  const pendingApprovals = await countPendingApprovals(supabase);
  const env = [
    envStatus("NEXT_PUBLIC_SUPABASE_URL", true),
    envStatus("SUPABASE_SERVICE_ROLE_KEY", true),
    envStatus("GOOGLE_GEMINI_API_KEY", true),
    {
      name: "ADMIN_AGENT_CRON_SECRET or CRON_SECRET",
      required: true,
      status: process.env.ADMIN_AGENT_CRON_SECRET || process.env.CRON_SECRET ? "ok" : "critical",
      statusText: process.env.ADMIN_AGENT_CRON_SECRET || process.env.CRON_SECRET ? "정상" : "위험",
      message: process.env.ADMIN_AGENT_CRON_SECRET || process.env.CRON_SECRET ? "설정됨" : "필수 환경변수 누락"
    },
    ...(includeOptional
      ? [
        envStatus("DISCORD_WEBHOOK_URL", false),
        envStatus("TAVILY_API_KEY", false),
        {
          name: "VERCEL_TOKEN + VERCEL_PROJECT_ID",
          required: false,
          status: process.env.VERCEL_TOKEN && process.env.VERCEL_PROJECT_ID ? "ok" : "warn",
          statusText: process.env.VERCEL_TOKEN && process.env.VERCEL_PROJECT_ID ? "정상" : "주의",
          message: process.env.VERCEL_TOKEN && process.env.VERCEL_PROJECT_ID ? "설정됨" : "선택 환경변수 미설정"
        }
      ]
      : [])
  ];

  const criticalCount = tableChecks.filter((check) => check.status === "critical").length + env.filter((check) => check.status === "critical").length;
  const warnCount = tableChecks.filter((check) => check.status === "warn").length + env.filter((check) => check.status === "warn").length;
  const status = criticalCount > 0 ? "critical" : warnCount > 0 ? "warn" : "ok";

  return JSON.stringify({
    description: "Admin Agent readiness read-only 진단입니다. secret 값은 노출하지 않습니다.",
    status,
    statusText: statusLabel(status),
    summary: {
      criticalCount,
      warnCount,
      toolCount: Object.keys(adminAgentTools).length,
      pendingApprovals
    },
    tables: tableChecks,
    env,
    recommendations: buildReadinessRecommendations(status, tableChecks, env, pendingApprovals)
  });
}

async function countPendingApprovals(supabase: any) {
  const { count, error } = await supabase
    .from("agent_approvals")
    .select("*", { count: "exact", head: true })
    .eq("status", "pending");
  if (error) return { count: 0, error: error.message };
  return { count: count || 0 };
}

function envStatus(name: string, required: boolean) {
  const configured = Boolean(process.env[name]);
  const status = configured ? "ok" : required ? "critical" : "warn";
  return {
    name,
    required,
    status,
    statusText: statusLabel(status),
    message: configured ? "설정됨" : required ? "필수 환경변수 누락" : "선택 환경변수 미설정"
  };
}

function buildReadinessRecommendations(status: string, tableChecks: any[], env: any[], pendingApprovals: any) {
  const recommendations = [];
  const missingTables = tableChecks.filter((check) => check.status === "critical").map((check) => check.table);
  const missingEnv = env.filter((check) => check.status === "critical").map((check) => check.name);
  if (missingTables.length) recommendations.push(`필수 테이블 확인 필요: ${missingTables.join(", ")}`);
  if (missingEnv.length) recommendations.push(`필수 환경변수 확인 필요: ${missingEnv.join(", ")}`);
  if (pendingApprovals.count > 0) recommendations.push(`승인 대기 ${pendingApprovals.count}건을 /admin/bot 승인 패널에서 검토하세요.`);
  if (status === "ok") recommendations.push("관리자 AI 준비 상태는 정상 범위입니다. 운영보드와 최근 점검 기록을 이어서 확인하세요.");
  return recommendations;
}

function statusLabel(status: string) {
  const map: Record<string, string> = {
    ok: "정상",
    warn: "주의",
    critical: "위험",
    pass: "통과",
    fail: "실패",
    pending: "대기",
    blocked: "차단"
  };
  return map[status] || status;
}

async function inspectApprovalQueue(args: any, supabase: any): Promise<string> {
  const status = String(args.status || "pending").trim();
  const limit = Math.min(Math.max(Number(args.limit || 10), 1), 30);
  let query = supabase
    .from("agent_approvals")
    .select("*")
    .order("created_at", { ascending: true })
    .limit(limit);

  if (status && status !== "all") query = query.eq("status", status);

  const { data, error } = await query;
  if (error) throw error;

  const approvals = await Promise.all((data || []).map(async (approval: any) => {
    const queue = normalizeApproval(approval);
    const impact = await calculateApprovalImpact(supabase, approval.action_type, approval.payload || {});
    const executionGate = buildApprovalExecutionGate(approval.action_type, approval.payload || {}, impact);
    return {
      id: approval.id,
      actionType: approval.action_type,
      status: approval.status,
      toolName: approval.tool_name,
      title: approval.payload?.title || approval.payload?.cleanupType || approval.action_type,
      createdAt: approval.created_at,
      queue: {
        priority: queue.priority,
        ageHours: queue.ageHours,
        isStale: queue.isStale
      },
      impact: {
        risk: impact.risk,
        summary: impact.summary,
        estimatedRows: impact.estimatedRows,
        preview: impact.preview,
        checklist: impact.checklist,
        executionGate
      }
    };
  }));
  const summary = summarizeApprovalQueue(approvals.map((approval: any) => ({
    id: approval.id,
    action_type: approval.actionType,
    status: approval.status,
    created_at: approval.createdAt,
    payload: {},
    priority: approval.queue.priority,
    ageHours: approval.queue.ageHours,
    isStale: approval.queue.isStale
  })));

  return JSON.stringify({
    description: "승인 대기열 read-only impact 분석입니다. 실행/승인/거절은 하지 않았습니다.",
    filters: { status, limit },
    summary: {
      count: summary.count,
      highRiskCount: summary.highRiskCount,
      staleCount: summary.staleCount,
      oldestAgeHours: summary.oldestAgeHours
    },
    approvals,
    recommendations: buildApprovalQueueRecommendations(summary, approvals)
  });
}

function buildApprovalQueueRecommendations(summary: any, approvals: any[]) {
  const recommendations = [];
  if (summary.highRiskCount > 0) recommendations.push("고위험 승인 요청은 impact checklist와 payload를 확인한 뒤 승인 메모를 남기세요.");
  if (summary.staleCount > 0) recommendations.push("오래된 승인 요청은 실제 필요 여부를 재검토하고 중복이면 거절하세요.");
  const top = approvals[0];
  if (top) recommendations.push(`우선 검토 후보: ${top.title} (${top.queue.priority}, ${top.queue.ageHours}h old)`);
  if (!recommendations.length) recommendations.push("현재 조회 조건의 승인 대기열은 정상 범위입니다.");
  return recommendations;
}

async function inspectIncidentTimeline(args: any, supabase: any): Promise<string> {
  const timeline = await buildIncidentTimeline(supabase, {
    hours: Number(args.hours || 24),
    limit: Number(args.limit || 80)
  });
  const includeMarkdown = args.includeMarkdown === true;

  return JSON.stringify({
    description: "최근 운영 사고 타임라인 read-only 분석입니다. 실행/승인/수정은 하지 않았습니다.",
    generatedAt: timeline.generatedAt,
    windowHours: timeline.windowHours,
    severity: timeline.severity,
    summary: timeline.summary,
    events: timeline.events.slice(0, 20),
    recommendations: timeline.recommendations,
    ...(includeMarkdown ? { markdown: timeline.markdown } : {})
  });
}

async function inspectHandoffPacket(args: any, supabase: any): Promise<string> {
  const packet = await buildAgentHandoffPacket(supabase, {
    hours: Number(args.hours || 24)
  });
  const includeMarkdown = args.includeMarkdown === true;

  return JSON.stringify({
    description: "운영 인수인계 handoff packet read-only 분석입니다. 저장/승인 요청은 하지 않았습니다.",
    generatedAt: packet.generatedAt,
    windowHours: packet.windowHours,
    severity: packet.severity,
    summary: {
      pendingApprovals: packet.pendingApprovals.count,
      highRiskApprovals: packet.pendingApprovals.highRiskCount,
      staleApprovals: packet.pendingApprovals.staleCount,
      incidentEvents: packet.incidentTimeline.summary.totalEvents,
      criticalIncidentEvents: packet.incidentTimeline.summary.criticalEvents,
      readiness: packet.readiness.status,
      rollout: packet.rollout.status
    },
    latestRun: packet.latestRun,
    latestReport: packet.latestReport,
    followUp: extractHandoffFollowUp(packet.markdown),
    ...(includeMarkdown ? { markdown: packet.markdown } : {})
  });
}

async function inspectOperatorValue(args: any, supabase: any): Promise<string> {
  const hours = Math.min(Math.max(Number(args.hours || 24), 1), 168);
  const since = new Date(Date.now() - hours * 60 * 60 * 1000).toISOString();
  const includeContent = args.includeContent !== false;

  const [
    activity,
    approvalOutcomes,
    pendingApprovals,
    approvalGateSummary,
    latestMonitorSnapshot,
    memories,
    contentPerformance
  ] = await Promise.all([
    fetchToolRecentAgentActivity(supabase, since),
    fetchToolRecentApprovalOutcomes(supabase, since),
    fetchApprovalQueueSummary(supabase),
    fetchApprovalGateSummary(supabase),
    fetchToolLatestMonitorSnapshot(supabase),
    fetchToolRecentMemories(supabase),
    includeContent ? fetchToolContentPerformance(supabase) : Promise.resolve(null)
  ]);

  const scorecard = buildOperatorValueScorecard({
    recentAgentActivity: activity,
    approvalOutcomes,
    pendingApprovals,
    approvalGateSummary,
    latestMonitorSnapshot,
    todayActionBoard: latestMonitorSnapshot.item?.todayActionBoard || null,
    memorySuggestions: [],
    relatedMemories: { items: memories },
    contentPerformance: contentPerformance || undefined
  });

  return JSON.stringify({
    description: `최근 ${hours}시간 기준 Admin Agent 운영 가치 scorecard입니다. 조회성 계산이며 실행/승인/수정은 하지 않았습니다.`,
    windowHours: hours,
    scorecard,
    recommendations: scorecard.nextLeverage.map((item) => item.prompt)
  });
}

async function inspectOwnerBrief(args: any, supabase: any): Promise<string> {
  const hours = Math.min(Math.max(Number(args.hours || 24), 1), 168);
  const since = new Date(Date.now() - hours * 60 * 60 * 1000).toISOString();
  const [
    activity,
    approvalOutcomes,
    pendingApprovals,
    approvalGateSummary,
    latestMonitorSnapshot,
    memories
  ] = await Promise.all([
    fetchToolRecentAgentActivity(supabase, since),
    fetchToolRecentApprovalOutcomes(supabase, since),
    fetchApprovalQueueSummary(supabase),
    fetchApprovalGateSummary(supabase),
    fetchToolLatestMonitorSnapshot(supabase),
    fetchToolRecentMemories(supabase)
  ]);
  const monitor = latestMonitorSnapshot.item || {};
  const severity = monitor.severity || (pendingApprovals.count > 0 ? "warn" : "ok");
  const actionBoard = monitor.dailyCheckout
    ? buildTodayActionBoard({
      dailyCheckout: monitor.dailyCheckout,
      nextActions: monitor.nextActions || [],
      approvalGateSummary: monitor.approvalGateSummary || approvalGateSummary,
      pendingApprovals
    })
    : null;
  const scorecard = buildOperatorValueScorecard({
    recentAgentActivity: activity,
    approvalOutcomes,
    pendingApprovals,
    approvalGateSummary,
    latestMonitorSnapshot,
    todayActionBoard: actionBoard,
    memorySuggestions: [],
    relatedMemories: { items: memories }
  });
  const roadmap = buildAgentGrowthRoadmap({
    severity,
    dailyCheckout: monitor.dailyCheckout,
    todayActionBoard: actionBoard,
    nextActions: monitor.nextActions || [],
    operatorValue: scorecard,
    approvalGateSummary,
    pendingApprovals,
    memorySuggestions: []
  });
  const ownerBrief = buildAgentOwnerBrief({
    severity,
    dailyCheckout: monitor.dailyCheckout,
    todayActionBoard: actionBoard,
    growthRoadmap: roadmap,
    operatorValue: scorecard,
    pendingApprovals,
    approvalGateSummary,
    latestMonitorSnapshot
  });

  return JSON.stringify({
    description: `최근 ${hours}시간 기준 30초 운영자 브리핑입니다. 조회성 계산이며 실행/승인/수정은 하지 않았습니다.`,
    windowHours: hours,
    ownerBrief,
    operatorValue: {
      score: scorecard.score,
      label: scorecard.label,
      summary: scorecard.summary,
      nextLeverage: scorecard.nextLeverage
    },
    growthRoadmap: {
      status: roadmap.status,
      summary: roadmap.summary,
      primaryPrompt: roadmap.primaryPrompt,
      now: roadmap.lanes.now.slice(0, 3),
      thisWeek: roadmap.lanes.thisWeek.slice(0, 3)
    },
    recommendations: [
      ownerBrief.doNow.prompt,
      ...ownerBrief.delegateToAgent.map((item) => item.prompt)
    ].filter(Boolean).slice(0, 4)
  });
}

async function inspectMonitorTrend(args: any, supabase: any): Promise<string> {
  const limit = Math.min(Math.max(Number(args.limit || 7), 2), 14);
  const { data, error } = await supabase
    .from("agent_runs")
    .select("summary, completed_at")
    .eq("system_prompt", "admin-agent-monitor")
    .eq("status", "completed")
    .order("completed_at", { ascending: false })
    .limit(limit);

  if (error) throw error;
  const trend = buildAgentMonitorTrend(data || []);

  return JSON.stringify({
    description: `최근 monitor snapshot 최대 ${limit}개 기준 운영 추세입니다. 조회성 계산이며 실행/승인/수정은 하지 않았습니다.`,
    limit,
    trend,
    recommendations: [
      trend.recommendation,
      trend.direction === "worsening" ? "최근 24시간 사고 타임라인을 요약해줘" : null,
      trend.direction === "improving" ? "개선 원인을 memory 저장 승인 요청으로 남겨줘" : null
    ].filter(Boolean)
  });
}

async function inspectAutomationContract(args: any, supabase: any): Promise<string> {
  const includeContracts = args.includeContracts !== false;
  const [pendingApprovals, latestMonitorSnapshot] = await Promise.all([
    fetchApprovalQueueSummary(supabase),
    fetchToolLatestMonitorSnapshot(supabase)
  ]);
  const contracts = buildAgentAutomationContracts({
    pendingApprovals,
    monitorSeverity: latestMonitorSnapshot.item?.severity || (pendingApprovals.count > 0 ? "warn" : "ok"),
    discordConfigured: Boolean(process.env.DISCORD_WEBHOOK_URL)
  });

  return JSON.stringify({
    description: "현재 Admin Agent 자동화 계약입니다. 조회성 계산이며 실행/승인/수정은 하지 않았습니다.",
    freePlanMode: contracts.freePlanMode,
    summary: contracts.summary,
    counts: contracts.counts,
    guardrails: contracts.guardrails,
    contracts: includeContracts ? contracts.contracts : contracts.contracts.map((contract) => ({
      id: contract.id,
      title: contract.title,
      status: contract.status,
      risk: contract.risk,
      whereToCheck: contract.whereToCheck
    })),
    recommendations: [
      "자동 실행은 monitor snapshot과 read-only 브리핑 중심으로 유지하세요.",
      pendingApprovals.count > 0 ? "승인 대기 작업을 impact 기준으로 검토해줘" : null,
      "긴 작업은 GitHub Actions 자동화와 Agent 역할 분담을 요약해줘"
    ].filter(Boolean)
  });
}

async function summarizeUserActivity(args: any, supabase: any): Promise<string> {
  const hours = Math.min(Math.max(Number(args.hours || 24), 1), 168);
  const [summary, userMetrics] = await Promise.all([
    buildTrafficSummary(supabase, hours),
    buildUserMetricsSummary(supabase, hours)
  ]);
  return JSON.stringify({
    description: `최근 ${hours}시간 기준 유저 활동 집계입니다. 가입자 수는 Supabase Auth/profiles 기준, 방문 행동은 analytics_events 기준입니다.`,
    summary,
    userMetrics,
    readable: renderTrafficSummaryText(summary),
    accountReadable: renderUserMetricsSummaryText(userMetrics),
    recommendations: buildTrafficRecommendations(summary)
  });
}

async function inspectUserMetrics(args: any, supabase: any): Promise<string> {
  const hours = Math.min(Math.max(Number(args.hours || 24), 1), 168);
  const summary = await buildUserMetricsSummary(supabase, hours);
  return JSON.stringify({
    description: `최근 ${hours}시간 기준 가입자/회원/활동 유저 집계입니다. 관리자 활동은 활동 지표에서 제외합니다.`,
    summary,
    readable: renderUserMetricsSummaryText(summary),
    recommendations: buildUserMetricRecommendations(summary)
  });
}

function buildTrafficRecommendations(summary: Awaited<ReturnType<typeof buildTrafficSummary>>) {
  if (summary.status === "unavailable") return ["analytics_events 마이그레이션 적용과 서버 환경변수를 확인하세요."];
  if (summary.status === "empty") return ["배포 후 실제 페이지 이동과 기능 사용 이벤트가 쌓이는지 /admin/bot 운영판에서 다시 확인하세요."];
  const recommendations = [];
  if (summary.current.statsSearches > 0) recommendations.push("전적 검색 유입이 있으니 PUBG API quota와 검색 캐시 상태를 같이 확인하세요.");
  if (summary.current.aiFeatureUses > 0) recommendations.push("AI 기능 사용이 있으니 ai_usage_logs 비용 집계와 함께 보면 좋습니다.");
  if (summary.current.topPages[0]) recommendations.push(`인기 페이지 ${summary.current.topPages[0].label} 기준으로 콘텐츠/공지 위치를 조정할 수 있습니다.`);
  if (!recommendations.length) recommendations.push("현재 활동량은 낮습니다. 인기 페이지와 기능 데이터가 더 쌓인 뒤 콘텐츠 추천에 연결하세요.");
  return recommendations;
}

function buildUserMetricRecommendations(summary: Awaited<ReturnType<typeof buildUserMetricsSummary>>) {
  if (summary.status === "unavailable") return ["SUPABASE_SERVICE_ROLE_KEY와 auth.admin.listUsers 권한을 확인하세요."];
  const recommendations = [];
  if (summary.accounts.missingProfiles > 0) recommendations.push("누락된 profiles가 있으니 /admin 데이터 관리에서 유저 동기화를 실행하세요.");
  if (summary.accounts.orphanProfiles > 0) recommendations.push("Auth에 없는 profiles가 있어 과거/테스트 데이터인지 확인하세요.");
  if (summary.activity.analyticsEvents > 0 && summary.activity.analyticsLoggedInUsers === 0) {
    recommendations.push("analytics_events에는 로그인 user_id가 없으므로 로컬/비로그인 유입 여부를 확인하고, 새 배포 후 로그인 사용자 이벤트에 user_id가 붙는지 재검증하세요.");
  }
  if (summary.topSearchedTargets[0]) {
    recommendations.push(`전적 검색 대상 ${summary.topSearchedTargets[0].nickname}은 조회 대상 닉네임이며 해당 회원의 로그인 활동으로 단정하지 마세요.`);
  }
  if (!recommendations.length) recommendations.push("가입자/활동 유저 집계 권한은 정상입니다.");
  return recommendations;
}

async function inspectCapabilityMatrix(args: any, supabase: any): Promise<string> {
  const includeDetails = args.includeDetails !== false;
  const [readiness, rollout, pendingApprovals, approvalGateSummary, latestMonitorSnapshot] = await Promise.all([
    runAgentSelfTest(supabase),
    buildAgentRolloutReadiness(supabase),
    fetchApprovalQueueSummary(supabase),
    fetchApprovalGateSummary(supabase),
    fetchToolLatestMonitorSnapshot(supabase)
  ]);
  const monitor = latestMonitorSnapshot.item || {};
  const dailyCheckout = monitor.dailyCheckout || null;
  const todayActionBoard = dailyCheckout
    ? buildTodayActionBoard({
      dailyCheckout,
      nextActions: monitor.nextActions || [],
      approvalGateSummary: monitor.approvalGateSummary || approvalGateSummary,
      pendingApprovals
    })
    : null;
  const contentPerformance = await fetchToolContentPerformance(supabase).catch(() => null);
  const matrix = buildAgentCapabilityMatrix({
    readiness,
    rollout,
    toolCatalog: buildAgentToolCatalog(),
    pendingApprovals,
    approvalGateSummary,
    latestMonitorSnapshot,
    dailyCheckout,
    todayActionBoard,
    memorySuggestions: [],
    contentPerformance,
    deploymentHealth: { severity: "ok" },
    improvementBacklog: null
  });
  const attentionItems = matrix.items.filter((item) => item.status !== "ready");

  return JSON.stringify({
    description: "현재 Admin Agent capability matrix입니다. 조회성 계산이며 실행/승인/수정은 하지 않았습니다.",
    score: matrix.score,
    label: matrix.label,
    summary: matrix.summary,
    items: includeDetails
      ? matrix.items
      : matrix.items.map((item) => ({
        id: item.id,
        label: item.label,
        status: item.status,
        score: item.score,
        nextStep: item.nextStep
      })),
    recommendations: attentionItems.length
      ? attentionItems.slice(0, 3).map((item) => item.nextStep)
      : ["현재 capability matrix는 안정권입니다. monitor trend와 approval gate를 계속 관찰하세요."]
  });
}

async function inspectGrowthRoadmap(args: any, supabase: any): Promise<string> {
  const hours = Math.min(Math.max(Number(args.hours || 24), 1), 168);
  const since = new Date(Date.now() - hours * 60 * 60 * 1000).toISOString();
  const thresholds = getAgentThresholds();
  const [
    readiness,
    rollout,
    pendingApprovals,
    approvalGateSummary,
    latestMonitorSnapshot,
    activity,
    approvalOutcomes,
    memories,
    contentPerformance,
    apiErrors,
    aiUsage,
    failedRuns
  ] = await Promise.all([
    runAgentSelfTest(supabase),
    buildAgentRolloutReadiness(supabase),
    fetchApprovalQueueSummary(supabase),
    fetchApprovalGateSummary(supabase),
    fetchToolLatestMonitorSnapshot(supabase),
    fetchToolRecentAgentActivity(supabase, since),
    fetchToolRecentApprovalOutcomes(supabase, since),
    fetchToolRecentMemories(supabase),
    fetchToolContentPerformance(supabase).catch(() => null),
    fetchToolRecentApiErrors(supabase, since),
    fetchToolRecentAiUsage(supabase, since),
    fetchToolRecentFailedRuns(supabase, since)
  ]);
  const monitor = latestMonitorSnapshot.item || {};
  const severity = monitor.severity || (pendingApprovals.count > 0 ? "warn" : "ok");
  const dailyCheckout = monitor.dailyCheckout || null;
  const todayActionBoard = dailyCheckout
    ? buildTodayActionBoard({
      dailyCheckout,
      nextActions: monitor.nextActions || [],
      approvalGateSummary: monitor.approvalGateSummary || approvalGateSummary,
      pendingApprovals
    })
    : null;
  const capabilityMatrix = buildAgentCapabilityMatrix({
    readiness,
    rollout,
    toolCatalog: buildAgentToolCatalog(),
    pendingApprovals,
    approvalGateSummary,
    latestMonitorSnapshot,
    dailyCheckout,
    todayActionBoard,
    memorySuggestions: [],
    contentPerformance,
    deploymentHealth: { severity: "ok" },
    improvementBacklog: null
  });
  const operatorValue = buildOperatorValueScorecard({
    recentAgentActivity: activity,
    approvalOutcomes,
    pendingApprovals,
    approvalGateSummary,
    latestMonitorSnapshot,
    todayActionBoard,
    memorySuggestions: [],
    relatedMemories: { items: memories },
    contentPerformance: contentPerformance || undefined
  });
  const improvementBacklog = buildAgentImprovementBacklog({
    readiness,
    rollout,
    pendingApprovals,
    approvalGateSummary,
    failedRuns,
    apiErrors,
    aiUsage,
    deploymentHealth: { configured: false, severity: "ok" },
    memories: { items: memories },
    latestReport: { item: null },
    contentPerformance: contentPerformance || undefined,
    thresholds
  });
  const roadmap = buildAgentGrowthRoadmap({
    severity,
    dailyCheckout,
    todayActionBoard,
    nextActions: monitor.nextActions || [],
    improvementBacklog,
    capabilityMatrix,
    operatorValue,
    approvalGateSummary,
    pendingApprovals,
    memorySuggestions: []
  });

  return JSON.stringify({
    description: `최근 ${hours}시간 기준 Admin Agent 성장 로드맵입니다. 조회성 계산이며 실행/승인/수정은 하지 않았습니다.`,
    windowHours: hours,
    roadmap,
    capability: {
      score: capabilityMatrix.score,
      label: capabilityMatrix.label,
      weakItems: capabilityMatrix.items.filter((item) => item.status !== "ready").slice(0, 3)
    },
    operatorValue: {
      score: operatorValue.score,
      label: operatorValue.label,
      nextLeverage: operatorValue.nextLeverage.slice(0, 3)
    },
    improvementBacklog: {
      score: improvementBacklog.score,
      label: improvementBacklog.label,
      topItems: improvementBacklog.items.slice(0, 3)
    },
    recommendations: [
      roadmap.primaryPrompt,
      ...roadmap.lanes.now.map((item) => item.prompt),
      ...roadmap.lanes.thisWeek.slice(0, 2).map((item) => item.prompt)
    ].filter(Boolean).slice(0, 5)
  });
}

async function inspectTodayActionBoard(args: any, supabase: any): Promise<string> {
  const includeChecklist = args.includeChecklist !== false;
  const [pendingApprovals, approvalGateSummary, latestMonitorSnapshot] = await Promise.all([
    fetchApprovalQueueSummary(supabase),
    fetchApprovalGateSummary(supabase),
    fetchToolLatestMonitorSnapshot(supabase)
  ]);
  const monitor = latestMonitorSnapshot.item || {};
  const board = buildTodayActionBoard({
    dailyCheckout: monitor.dailyCheckout,
    nextActions: monitor.nextActions || [],
    approvalGateSummary: monitor.approvalGateSummary || approvalGateSummary,
    pendingApprovals
  });

  const mapItem = (item: any) => includeChecklist ? item : {
    id: item.id,
    lane: item.lane,
    priority: item.priority,
    title: item.title,
    reason: item.reason,
    prompt: item.prompt,
    expectedOutcome: item.expectedOutcome,
    score: item.score,
    source: item.source
  };

  return JSON.stringify({
    description: "오늘 운영 액션 보드입니다. 조회성 계산이며 실행/승인/수정은 하지 않았습니다.",
    board: {
      generatedAt: board.generatedAt,
      status: board.status,
      summary: board.summary,
      primaryPrompt: board.primaryPrompt,
      lanes: {
        doNow: board.lanes.doNow.map(mapItem),
        review: board.lanes.review.map(mapItem),
        watch: board.lanes.watch.map(mapItem),
        save: board.lanes.save.map(mapItem)
      }
    },
    counts: {
      doNow: board.lanes.doNow.length,
      review: board.lanes.review.length,
      watch: board.lanes.watch.length,
      save: board.lanes.save.length
    },
    recommendations: [
      board.primaryPrompt,
      ...board.lanes.doNow.map((item) => item.prompt),
      ...board.lanes.review.slice(0, 2).map((item) => item.prompt)
    ].filter(Boolean).slice(0, 5)
  });
}

async function inspectDailyCheckout(args: any, supabase: any): Promise<string> {
  const hours = Math.min(Math.max(Number(args.hours || 24), 1), 168);
  const since = new Date(Date.now() - hours * 60 * 60 * 1000).toISOString();
  const thresholds = getAgentThresholds();
  const [
    pendingApprovals,
    approvalGateSummary,
    latestMonitorSnapshot,
    failedRuns,
    apiErrors,
    aiUsage,
    readiness,
    rollout
  ] = await Promise.all([
    fetchApprovalQueueSummary(supabase),
    fetchApprovalGateSummary(supabase),
    fetchToolLatestMonitorSnapshot(supabase),
    fetchToolRecentFailedRuns(supabase, since),
    fetchToolRecentApiErrors(supabase, since),
    fetchToolRecentAiUsage(supabase, since),
    runAgentSelfTest(supabase),
    buildAgentRolloutReadiness(supabase)
  ]);
  const monitor = latestMonitorSnapshot.item || {};
  const severity = monitor.severity || (
    failedRuns.count > 0
      || apiErrors.total >= thresholds.apiErrorsCritical
      || aiUsage.totalCostUsd > thresholds.aiCostCriticalUsd
      || pendingApprovals.staleCount > 0
      ? "critical"
      : pendingApprovals.count > 0 || apiErrors.total > 0 || aiUsage.totalCostUsd > thresholds.aiCostWarnUsd
        ? "warn"
        : "ok"
  );
  const checkout = monitor.dailyCheckout || buildAgentDailyCheckout({
    severity,
    pendingApprovals,
    approvalGateSummary,
    failedRuns,
    apiErrors,
    aiUsage,
    readinessStatus: readiness.status,
    rolloutStatus: rollout.status,
    deploymentSeverity: "ok",
    nextActions: monitor.nextActions || [],
    latestReport: { item: null }
  });

  return JSON.stringify({
    description: `최근 ${hours}시간 기준 Daily Checkout입니다. 조회성 계산이며 실행/승인/수정은 하지 않았습니다.`,
    windowHours: hours,
    source: monitor.dailyCheckout ? "latest-monitor-snapshot" : "fresh-read-only-calculation",
    checkout,
    signals: {
      severity,
      pendingApprovals: pendingApprovals.count,
      highRiskApprovals: pendingApprovals.highRiskCount,
      staleApprovals: pendingApprovals.staleCount,
      gateBlockCount: approvalGateSummary.blockCount || 0,
      failedRuns: failedRuns.count,
      apiErrors: apiErrors.total,
      aiCostUsd: aiUsage.totalCostUsd,
      readiness: readiness.status,
      rollout: rollout.status
    },
    recommendations: [
      checkout.handoffPrompt,
      checkout.status === "clear" ? "오늘 운영 브리핑을 리포트로 저장 요청해줘" : null,
      checkout.status !== "clear" ? "오늘 운영에서 뭐부터 처리해야 하는지 액션 보드로 정리해줘" : null
    ].filter(Boolean)
  });
}

async function inspectOperatingSop(args: any, supabase: any): Promise<string> {
  const hours = Math.min(Math.max(Number(args.hours || 24), 1), 168);
  const includeSteps = args.includeSteps !== false;
  const since = new Date(Date.now() - hours * 60 * 60 * 1000).toISOString();
  const thresholds = getAgentThresholds();
  const [
    pendingApprovals,
    approvalGateSummary,
    latestMonitorSnapshot,
    failedRuns,
    apiErrors,
    aiUsage,
    readiness,
    rollout,
    contentPerformance
  ] = await Promise.all([
    fetchApprovalQueueSummary(supabase),
    fetchApprovalGateSummary(supabase),
    fetchToolLatestMonitorSnapshot(supabase),
    fetchToolRecentFailedRuns(supabase, since),
    fetchToolRecentApiErrors(supabase, since),
    fetchToolRecentAiUsage(supabase, since),
    runAgentSelfTest(supabase),
    buildAgentRolloutReadiness(supabase),
    fetchToolContentPerformance(supabase).catch(() => null)
  ]);
  const monitor = latestMonitorSnapshot.item || {};
  const severity = monitor.severity || (
    failedRuns.count > 0
      || apiErrors.total >= thresholds.apiErrorsCritical
      || aiUsage.totalCostUsd > thresholds.aiCostCriticalUsd
      || pendingApprovals.staleCount > 0
      ? "critical"
      : pendingApprovals.count > 0 || apiErrors.total > 0 || aiUsage.totalCostUsd > thresholds.aiCostWarnUsd
        ? "warn"
        : "ok"
  );
  const playbooks = buildToolPlaybooks({
    pendingApprovals: pendingApprovals.count,
    staleApprovals: pendingApprovals.staleCount,
    highRiskApprovals: pendingApprovals.highRiskCount,
    failedRuns: failedRuns.count,
    apiErrors: apiErrors.total,
    aiCost: aiUsage.totalCostUsd,
    deploymentSeverity: "ok",
    thresholds
  });
  const dailyCheckout = monitor.dailyCheckout || buildAgentDailyCheckout({
    severity,
    pendingApprovals,
    approvalGateSummary,
    failedRuns,
    apiErrors,
    aiUsage,
    readinessStatus: readiness.status,
    rolloutStatus: rollout.status,
    deploymentSeverity: "ok",
    nextActions: monitor.nextActions || [],
    latestReport: { item: null }
  });
  const sop = buildAgentOperatingSop({
    severity,
    dailyCheckout,
    nextActions: monitor.nextActions || [],
    playbooks,
    pendingApprovals,
    approvalGateSummary,
    failedRuns,
    apiErrors,
    aiUsage,
    readiness,
    rollout,
    contentPerformance: contentPerformance || undefined
  });
  const mapProcedure = (procedure: any) => includeSteps ? procedure : {
    id: procedure.id,
    title: procedure.title,
    severity: procedure.severity,
    risk: procedure.risk,
    trigger: procedure.trigger,
    why: procedure.why,
    nextPrompt: procedure.nextPrompt
  };

  return JSON.stringify({
    description: `최근 ${hours}시간 기준 운영 SOP입니다. 조회성 계산이며 실행/승인/수정은 하지 않았습니다.`,
    windowHours: hours,
    sop: {
      ...sop,
      procedures: sop.procedures.map(mapProcedure)
    },
    signals: {
      severity,
      pendingApprovals: pendingApprovals.count,
      highRiskApprovals: pendingApprovals.highRiskCount,
      staleApprovals: pendingApprovals.staleCount,
      gateBlockCount: approvalGateSummary.blockCount || 0,
      failedRuns: failedRuns.count,
      apiErrors: apiErrors.total,
      aiCostUsd: aiUsage.totalCostUsd,
      readiness: readiness.status,
      rollout: rollout.status
    },
    recommendations: [
      sop.primaryPrompt,
      ...sop.procedures.slice(0, 3).map((procedure) => procedure.nextPrompt)
    ].filter(Boolean).slice(0, 5)
  });
}

async function inspectRiskRadar(args: any, supabase: any): Promise<string> {
  const hours = Math.min(Math.max(Number(args.hours || 24), 1), 168);
  const since = new Date(Date.now() - hours * 60 * 60 * 1000).toISOString();
  const thresholds = getAgentThresholds();
  const [
    pendingApprovals,
    approvalGateSummary,
    latestMonitorSnapshot,
    failedRuns,
    apiErrors,
    aiUsage,
    readiness,
    rollout,
    contentPerformance
  ] = await Promise.all([
    fetchApprovalQueueSummary(supabase),
    fetchApprovalGateSummary(supabase),
    fetchToolLatestMonitorSnapshot(supabase),
    fetchToolRecentFailedRuns(supabase, since),
    fetchToolRecentApiErrors(supabase, since),
    fetchToolRecentAiUsage(supabase, since),
    runAgentSelfTest(supabase),
    buildAgentRolloutReadiness(supabase),
    fetchToolContentPerformance(supabase).catch(() => null)
  ]);
  const monitor = latestMonitorSnapshot.item || {};
  const severity = monitor.severity || (
    failedRuns.count > 0
      || apiErrors.total >= thresholds.apiErrorsCritical
      || aiUsage.totalCostUsd > thresholds.aiCostCriticalUsd
      || pendingApprovals.staleCount > 0
      ? "critical"
      : pendingApprovals.count > 0 || apiErrors.total > 0 || aiUsage.totalCostUsd > thresholds.aiCostWarnUsd
        ? "warn"
        : "ok"
  );
  const dailyCheckout = monitor.dailyCheckout || buildAgentDailyCheckout({
    severity,
    pendingApprovals,
    approvalGateSummary,
    failedRuns,
    apiErrors,
    aiUsage,
    readinessStatus: readiness.status,
    rolloutStatus: rollout.status,
    deploymentSeverity: "ok",
    nextActions: monitor.nextActions || [],
    latestReport: { item: null }
  });
  const radar = buildAgentRiskRadar({
    severity,
    pendingApprovals,
    approvalGateSummary,
    failedRuns,
    apiErrors,
    aiUsage,
    readiness,
    rollout,
    dailyCheckout,
    contentPerformance: contentPerformance || undefined
  });

  return JSON.stringify({
    description: `최근 ${hours}시간 기준 Risk Radar입니다. 조회성 계산이며 실행/승인/수정은 하지 않았습니다.`,
    windowHours: hours,
    radar,
    signals: {
      severity,
      pendingApprovals: pendingApprovals.count,
      highRiskApprovals: pendingApprovals.highRiskCount,
      staleApprovals: pendingApprovals.staleCount,
      gateBlockCount: approvalGateSummary.blockCount || 0,
      failedRuns: failedRuns.count,
      apiErrors: apiErrors.total,
      aiCostUsd: aiUsage.totalCostUsd,
      readiness: readiness.status,
      rollout: rollout.status
    },
    recommendations: [
      radar.primaryPrompt,
      ...radar.items.slice(0, 4).map((risk) => risk.prompt)
    ].filter(Boolean).slice(0, 5)
  });
}

async function inspectDecisionTrace(args: any, supabase: any): Promise<string> {
  const hours = Math.min(Math.max(Number(args.hours || 24), 1), 168);
  const since = new Date(Date.now() - hours * 60 * 60 * 1000).toISOString();
  const thresholds = getAgentThresholds();
  const [
    pendingApprovals,
    approvalGateSummary,
    latestMonitorSnapshot,
    failedRuns,
    apiErrors,
    aiUsage,
    readiness,
    rollout,
    contentPerformance
  ] = await Promise.all([
    fetchApprovalQueueSummary(supabase),
    fetchApprovalGateSummary(supabase),
    fetchToolLatestMonitorSnapshot(supabase),
    fetchToolRecentFailedRuns(supabase, since),
    fetchToolRecentApiErrors(supabase, since),
    fetchToolRecentAiUsage(supabase, since),
    runAgentSelfTest(supabase),
    buildAgentRolloutReadiness(supabase),
    fetchToolContentPerformance(supabase).catch(() => null)
  ]);
  const monitor = latestMonitorSnapshot.item || {};
  const severity = monitor.severity || (
    failedRuns.count > 0
      || apiErrors.total >= thresholds.apiErrorsCritical
      || aiUsage.totalCostUsd > thresholds.aiCostCriticalUsd
      || pendingApprovals.staleCount > 0
      ? "critical"
      : pendingApprovals.count > 0 || apiErrors.total > 0 || aiUsage.totalCostUsd > thresholds.aiCostWarnUsd
        ? "warn"
        : "ok"
  );
  const dailyCheckout = monitor.dailyCheckout || buildAgentDailyCheckout({
    severity,
    pendingApprovals,
    approvalGateSummary,
    failedRuns,
    apiErrors,
    aiUsage,
    readinessStatus: readiness.status,
    rolloutStatus: rollout.status,
    deploymentSeverity: "ok",
    nextActions: monitor.nextActions || [],
    latestReport: { item: null }
  });
  const riskRadar = buildAgentRiskRadar({
    severity,
    pendingApprovals,
    approvalGateSummary,
    failedRuns,
    apiErrors,
    aiUsage,
    readiness,
    rollout,
    dailyCheckout,
    contentPerformance: contentPerformance || undefined
  });
  const operatingSop = buildAgentOperatingSop({
    severity,
    dailyCheckout,
    nextActions: monitor.nextActions || [],
    playbooks: buildToolPlaybooks({
      pendingApprovals: pendingApprovals.count,
      staleApprovals: pendingApprovals.staleCount,
      highRiskApprovals: pendingApprovals.highRiskCount,
      failedRuns: failedRuns.count,
      apiErrors: apiErrors.total,
      aiCost: aiUsage.totalCostUsd,
      deploymentSeverity: "ok",
      thresholds
    }),
    pendingApprovals,
    approvalGateSummary,
    failedRuns,
    apiErrors,
    aiUsage,
    readiness,
    rollout,
    contentPerformance: contentPerformance || undefined
  });
  const trace = buildAgentDecisionTrace({
    severity,
    dailyCheckout,
    riskRadar,
    operatingSop,
    pendingApprovals,
    approvalGateSummary,
    failedRuns,
    apiErrors,
    aiUsage,
    latestMonitorSnapshot,
    readiness,
    rollout,
    contentPerformance: contentPerformance || undefined
  });

  return JSON.stringify({
    description: `최근 ${hours}시간 기준 Decision Trace입니다. 조회성 계산이며 실행/승인/수정은 하지 않았습니다.`,
    windowHours: hours,
    trace,
    recommendations: trace.verifyNext
  });
}

async function inspectSafetyAudit(args: any, supabase: any): Promise<string> {
  const hours = Math.min(Math.max(Number(args.hours || 24), 1), 168);
  const since = new Date(Date.now() - hours * 60 * 60 * 1000).toISOString();
  const thresholds = getAgentThresholds();
  const [
    pendingApprovals,
    approvalGateSummary,
    latestMonitorSnapshot,
    failedRuns,
    apiErrors,
    aiUsage,
    readiness,
    rollout,
    contentPerformance
  ] = await Promise.all([
    fetchApprovalQueueSummary(supabase),
    fetchApprovalGateSummary(supabase),
    fetchToolLatestMonitorSnapshot(supabase),
    fetchToolRecentFailedRuns(supabase, since),
    fetchToolRecentApiErrors(supabase, since),
    fetchToolRecentAiUsage(supabase, since),
    runAgentSelfTest(supabase),
    buildAgentRolloutReadiness(supabase),
    fetchToolContentPerformance(supabase).catch(() => null)
  ]);
  const monitor = latestMonitorSnapshot.item || {};
  const severity = monitor.severity || (
    failedRuns.count > 0
      || apiErrors.total >= thresholds.apiErrorsCritical
      || aiUsage.totalCostUsd > thresholds.aiCostCriticalUsd
      || pendingApprovals.staleCount > 0
      ? "critical"
      : pendingApprovals.count > 0 || apiErrors.total > 0 || aiUsage.totalCostUsd > thresholds.aiCostWarnUsd
        ? "warn"
        : "ok"
  );
  const dailyCheckout = monitor.dailyCheckout || buildAgentDailyCheckout({
    severity,
    pendingApprovals,
    approvalGateSummary,
    failedRuns,
    apiErrors,
    aiUsage,
    readinessStatus: readiness.status,
    rolloutStatus: rollout.status,
    deploymentSeverity: "ok",
    nextActions: monitor.nextActions || [],
    latestReport: { item: null }
  });
  const riskRadar = buildAgentRiskRadar({
    severity,
    pendingApprovals,
    approvalGateSummary,
    failedRuns,
    apiErrors,
    aiUsage,
    readiness,
    rollout,
    dailyCheckout,
    contentPerformance: contentPerformance || undefined
  });
  const operatingSop = buildAgentOperatingSop({
    severity,
    dailyCheckout,
    nextActions: monitor.nextActions || [],
    playbooks: buildToolPlaybooks({
      pendingApprovals: pendingApprovals.count,
      staleApprovals: pendingApprovals.staleCount,
      highRiskApprovals: pendingApprovals.highRiskCount,
      failedRuns: failedRuns.count,
      apiErrors: apiErrors.total,
      aiCost: aiUsage.totalCostUsd,
      deploymentSeverity: "ok",
      thresholds
    }),
    pendingApprovals,
    approvalGateSummary,
    failedRuns,
    apiErrors,
    aiUsage,
    readiness,
    rollout,
    contentPerformance: contentPerformance || undefined
  });
  const decisionTrace = buildAgentDecisionTrace({
    severity,
    dailyCheckout,
    riskRadar,
    operatingSop,
    pendingApprovals,
    approvalGateSummary,
    failedRuns,
    apiErrors,
    aiUsage,
    latestMonitorSnapshot,
    readiness,
    rollout,
    contentPerformance: contentPerformance || undefined
  });
  const audit = buildAgentSafetyAudit({
    readiness,
    toolCatalog: buildAgentToolCatalog(),
    approvalGateSummary,
    automationContracts: buildAgentAutomationContracts({
      pendingApprovals,
      monitorSeverity: severity,
      discordConfigured: Boolean(process.env.DISCORD_WEBHOOK_URL)
    }),
    riskRadar,
    decisionTrace,
    pendingApprovals,
    latestMonitorSnapshot,
    deploymentHealth: { configured: false, severity: "ok" }
  });

  return JSON.stringify({
    description: `최근 ${hours}시간 기준 Agent Safety Audit입니다. 조회성 계산이며 실행/승인/수정은 하지 않았습니다.`,
    windowHours: hours,
    audit,
    recommendations: [
      audit.primaryPrompt,
      ...audit.requiredFixes,
      ...audit.recommendedChecks
    ].filter(Boolean).slice(0, 6)
  });
}

async function inspectApprovalAdvisor(args: any, supabase: any): Promise<string> {
  const hours = Math.min(Math.max(Number(args.hours || 24), 1), 168);
  const since = new Date(Date.now() - hours * 60 * 60 * 1000).toISOString();
  const thresholds = getAgentThresholds();
  const [
    pendingApprovals,
    approvalGateSummary,
    latestMonitorSnapshot,
    failedRuns,
    apiErrors,
    aiUsage,
    readiness,
    rollout,
    contentPerformance
  ] = await Promise.all([
    fetchApprovalQueueSummary(supabase),
    fetchApprovalGateSummary(supabase),
    fetchToolLatestMonitorSnapshot(supabase),
    fetchToolRecentFailedRuns(supabase, since),
    fetchToolRecentApiErrors(supabase, since),
    fetchToolRecentAiUsage(supabase, since),
    runAgentSelfTest(supabase),
    buildAgentRolloutReadiness(supabase),
    fetchToolContentPerformance(supabase).catch(() => null)
  ]);
  const monitor = latestMonitorSnapshot.item || {};
  const severity = monitor.severity || (
    failedRuns.count > 0
      || apiErrors.total >= thresholds.apiErrorsCritical
      || aiUsage.totalCostUsd > thresholds.aiCostCriticalUsd
      || pendingApprovals.staleCount > 0
      ? "critical"
      : pendingApprovals.count > 0 || apiErrors.total > 0 || aiUsage.totalCostUsd > thresholds.aiCostWarnUsd
        ? "warn"
        : "ok"
  );
  const dailyCheckout = monitor.dailyCheckout || buildAgentDailyCheckout({
    severity,
    pendingApprovals,
    approvalGateSummary,
    failedRuns,
    apiErrors,
    aiUsage,
    readinessStatus: readiness.status,
    rolloutStatus: rollout.status,
    deploymentSeverity: "ok",
    nextActions: monitor.nextActions || [],
    latestReport: { item: null }
  });
  const riskRadar = buildAgentRiskRadar({
    severity,
    pendingApprovals,
    approvalGateSummary,
    failedRuns,
    apiErrors,
    aiUsage,
    readiness,
    rollout,
    dailyCheckout,
    contentPerformance: contentPerformance || undefined
  });
  const operatingSop = buildAgentOperatingSop({
    severity,
    dailyCheckout,
    nextActions: monitor.nextActions || [],
    playbooks: buildToolPlaybooks({
      pendingApprovals: pendingApprovals.count,
      staleApprovals: pendingApprovals.staleCount,
      highRiskApprovals: pendingApprovals.highRiskCount,
      failedRuns: failedRuns.count,
      apiErrors: apiErrors.total,
      aiCost: aiUsage.totalCostUsd,
      deploymentSeverity: "ok",
      thresholds
    }),
    pendingApprovals,
    approvalGateSummary,
    failedRuns,
    apiErrors,
    aiUsage,
    readiness,
    rollout,
    contentPerformance: contentPerformance || undefined
  });
  const decisionTrace = buildAgentDecisionTrace({
    severity,
    dailyCheckout,
    riskRadar,
    operatingSop,
    pendingApprovals,
    approvalGateSummary,
    failedRuns,
    apiErrors,
    aiUsage,
    latestMonitorSnapshot,
    readiness,
    rollout,
    contentPerformance: contentPerformance || undefined
  });
  const automationContracts = buildAgentAutomationContracts({
    pendingApprovals,
    monitorSeverity: severity,
    discordConfigured: Boolean(process.env.DISCORD_WEBHOOK_URL)
  });
  const safetyAudit = buildAgentSafetyAudit({
    readiness,
    toolCatalog: buildAgentToolCatalog(),
    approvalGateSummary,
    automationContracts,
    riskRadar,
    decisionTrace,
    pendingApprovals,
    latestMonitorSnapshot,
    deploymentHealth: { configured: false, severity: "ok" }
  });
  const advisor = buildAgentApprovalAdvisor({
    pendingApprovals,
    approvalGateSummary,
    safetyAudit,
    riskRadar
  });

  return JSON.stringify({
    description: `최근 ${hours}시간 기준 Approval Decision Advisor입니다. 조회성 계산이며 실행/승인/수정은 하지 않았습니다.`,
    windowHours: hours,
    advisor,
    signals: {
      severity,
      pendingApprovals: pendingApprovals.count,
      highRiskApprovals: pendingApprovals.highRiskCount,
      staleApprovals: pendingApprovals.staleCount,
      gateBlockCount: approvalGateSummary.blockCount || 0,
      gateReviewCount: approvalGateSummary.reviewCount || 0,
      safetyStatus: safetyAudit.status,
      riskStatus: riskRadar.status,
      failedRuns: failedRuns.count,
      apiErrors: apiErrors.total,
      aiCostUsd: aiUsage.totalCostUsd,
      readiness: readiness.status,
      rollout: rollout.status
    },
    recommendations: [
      advisor.primaryPrompt,
      ...advisor.items.slice(0, 5).map((item) => item.prompt)
    ].filter(Boolean).slice(0, 6)
  });
}

async function inspectMissionControl(args: any, supabase: any): Promise<string> {
  const hours = Math.min(Math.max(Number(args.hours || 24), 1), 168);
  const since = new Date(Date.now() - hours * 60 * 60 * 1000).toISOString();
  const thresholds = getAgentThresholds();
  const [
    pendingApprovals,
    approvalGateSummary,
    latestMonitorSnapshot,
    failedRuns,
    apiErrors,
    aiUsage,
    readiness,
    rollout,
    contentPerformance,
    activity,
    approvalOutcomes,
    memories
  ] = await Promise.all([
    fetchApprovalQueueSummary(supabase),
    fetchApprovalGateSummary(supabase),
    fetchToolLatestMonitorSnapshot(supabase),
    fetchToolRecentFailedRuns(supabase, since),
    fetchToolRecentApiErrors(supabase, since),
    fetchToolRecentAiUsage(supabase, since),
    runAgentSelfTest(supabase),
    buildAgentRolloutReadiness(supabase),
    fetchToolContentPerformance(supabase).catch(() => null),
    fetchToolRecentAgentActivity(supabase, since),
    fetchToolRecentApprovalOutcomes(supabase, since),
    fetchToolRecentMemories(supabase)
  ]);
  const monitor = latestMonitorSnapshot.item || {};
  const severity = monitor.severity || (
    failedRuns.count > 0
      || apiErrors.total >= thresholds.apiErrorsCritical
      || aiUsage.totalCostUsd > thresholds.aiCostCriticalUsd
      || pendingApprovals.staleCount > 0
      ? "critical"
      : pendingApprovals.count > 0 || apiErrors.total > 0 || aiUsage.totalCostUsd > thresholds.aiCostWarnUsd
        ? "warn"
        : "ok"
  );
  const dailyCheckout = monitor.dailyCheckout || buildAgentDailyCheckout({
    severity,
    pendingApprovals,
    approvalGateSummary,
    failedRuns,
    apiErrors,
    aiUsage,
    readinessStatus: readiness.status,
    rolloutStatus: rollout.status,
    deploymentSeverity: "ok",
    nextActions: monitor.nextActions || [],
    latestReport: { item: null }
  });
  const todayActionBoard = buildTodayActionBoard({
    dailyCheckout,
    nextActions: monitor.nextActions || [],
    approvalGateSummary,
    pendingApprovals
  });
  const riskRadar = buildAgentRiskRadar({
    severity,
    pendingApprovals,
    approvalGateSummary,
    failedRuns,
    apiErrors,
    aiUsage,
    readiness,
    rollout,
    dailyCheckout,
    contentPerformance: contentPerformance || undefined
  });
  const operatingSop = buildAgentOperatingSop({
    severity,
    dailyCheckout,
    nextActions: monitor.nextActions || [],
    playbooks: buildToolPlaybooks({
      pendingApprovals: pendingApprovals.count,
      staleApprovals: pendingApprovals.staleCount,
      highRiskApprovals: pendingApprovals.highRiskCount,
      failedRuns: failedRuns.count,
      apiErrors: apiErrors.total,
      aiCost: aiUsage.totalCostUsd,
      deploymentSeverity: "ok",
      thresholds
    }),
    pendingApprovals,
    approvalGateSummary,
    failedRuns,
    apiErrors,
    aiUsage,
    readiness,
    rollout,
    contentPerformance: contentPerformance || undefined
  });
  const decisionTrace = buildAgentDecisionTrace({
    severity,
    dailyCheckout,
    riskRadar,
    operatingSop,
    pendingApprovals,
    approvalGateSummary,
    failedRuns,
    apiErrors,
    aiUsage,
    latestMonitorSnapshot,
    readiness,
    rollout,
    contentPerformance: contentPerformance || undefined
  });
  const automationContracts = buildAgentAutomationContracts({
    pendingApprovals,
    monitorSeverity: severity,
    discordConfigured: Boolean(process.env.DISCORD_WEBHOOK_URL)
  });
  const capabilityMatrix = buildAgentCapabilityMatrix({
    readiness,
    rollout,
    toolCatalog: buildAgentToolCatalog(),
    pendingApprovals,
    approvalGateSummary,
    latestMonitorSnapshot,
    dailyCheckout,
    todayActionBoard,
    memorySuggestions: [],
    contentPerformance: contentPerformance || undefined,
    deploymentHealth: { configured: false, severity: "ok" },
    improvementBacklog: null
  });
  const safetyAudit = buildAgentSafetyAudit({
    readiness,
    toolCatalog: buildAgentToolCatalog(),
    approvalGateSummary,
    automationContracts,
    riskRadar,
    decisionTrace,
    pendingApprovals,
    latestMonitorSnapshot,
    deploymentHealth: { configured: false, severity: "ok" }
  });
  const approvalAdvisor = buildAgentApprovalAdvisor({
    pendingApprovals,
    approvalGateSummary,
    safetyAudit,
    riskRadar
  });
  const operatorValue = buildOperatorValueScorecard({
    recentAgentActivity: activity,
    approvalOutcomes,
    pendingApprovals,
    approvalGateSummary,
    latestMonitorSnapshot,
    todayActionBoard,
    memorySuggestions: [],
    relatedMemories: { items: memories },
    contentPerformance: contentPerformance || undefined
  });
  const roadmap = buildAgentGrowthRoadmap({
    severity,
    dailyCheckout,
    todayActionBoard,
    nextActions: monitor.nextActions || [],
    operatorValue,
    approvalGateSummary,
    pendingApprovals,
    memorySuggestions: []
  });
  const ownerBrief = buildAgentOwnerBrief({
    severity,
    dailyCheckout,
    todayActionBoard,
    growthRoadmap: roadmap,
    operatorValue,
    pendingApprovals,
    approvalGateSummary,
    latestMonitorSnapshot,
    contentPerformance: contentPerformance || undefined
  });
  const mission = buildAgentMissionControl({
    severity,
    ownerBrief,
    todayActionBoard,
    approvalAdvisor,
    operatingSop,
    riskRadar,
    safetyAudit,
    dailyCheckout,
    nextActions: monitor.nextActions || [],
    latestReport: { item: null }
  });
  const ownerInbox = buildAgentOwnerInbox({
    ownerBrief,
    missionControl: mission,
    approvalAdvisor,
    safetyAudit,
    riskRadar,
    operatingSop,
    growthRoadmap: roadmap,
    operatorValue,
    pendingApprovals
  });
  const outcomeReview = buildAgentOutcomeReview({
    recentAgentActivity: activity,
    approvalOutcomes,
    pendingApprovals,
    approvalGateSummary,
    failedRuns,
    apiErrors,
    aiUsage,
    latestMonitorSnapshot,
    dailyCheckout,
    missionControl: mission,
    ownerInbox
  });
  const operatorCoach = buildAgentOperatorCoach({
    severity,
    outcomeReview,
    ownerInbox,
    missionControl: mission,
    dailyCheckout,
    growthRoadmap: roadmap,
    operatorValue,
    contentPerformance: contentPerformance || undefined
  });
  const launchKit = buildAgentLaunchKit({
    readiness,
    rollout,
    capabilityMatrix,
    automationContracts,
    safetyAudit,
    operatorCoach,
    outcomeReview,
    ownerInbox,
    missionControl: mission,
    approvalAdvisor,
    monitorTrend: latestMonitorSnapshot.item?.monitorTrend,
    contentPerformance: contentPerformance || undefined
  });
  const finalReadiness = buildAgentFinalReadiness({
    readiness,
    rollout,
    capabilityMatrix,
    automationContracts,
    safetyAudit,
    approvalAdvisor,
    missionControl: mission,
    ownerInbox,
    outcomeReview,
    operatorCoach,
    launchKit,
    monitorTrend: latestMonitorSnapshot.item?.monitorTrend,
    contentPerformance: contentPerformance || undefined,
    pendingApprovals,
    approvalGateSummary,
    toolCatalog: buildAgentToolCatalog()
  });

  return JSON.stringify({
    description: `최근 ${hours}시간 기준 Mission Control입니다. 조회성 계산이며 실행/승인/수정은 하지 않았습니다.`,
    windowHours: hours,
    mission,
    ownerInbox,
    outcomeReview,
    operatorCoach,
    launchKit,
    finalReadiness,
    signals: {
      severity,
      pendingApprovals: pendingApprovals.count,
      gateBlockCount: approvalGateSummary.blockCount || 0,
      safetyStatus: safetyAudit.status,
      approvalAdvisorStatus: approvalAdvisor.status,
      riskStatus: riskRadar.status,
      dailyCheckout: dailyCheckout.status,
      failedRuns: failedRuns.count,
      apiErrors: apiErrors.total,
      aiCostUsd: aiUsage.totalCostUsd
    },
    recommendations: [
      mission.firstCommand,
      ...mission.items.slice(0, 5).map((item) => item.command)
    ].filter(Boolean).slice(0, 6)
  });
}

async function inspectOwnerInbox(args: any, supabase: any): Promise<string> {
  const parsed = JSON.parse(await inspectMissionControl(args, supabase));
  return JSON.stringify({
    description: `최근 ${parsed.windowHours}시간 기준 Owner Inbox입니다. 조회성 계산이며 실행/승인/수정은 하지 않았습니다.`,
    windowHours: parsed.windowHours,
    inbox: parsed.ownerInbox,
    missionStatus: parsed.mission?.status,
    signals: parsed.signals,
    recommendations: [
      parsed.ownerInbox?.primaryAction,
      ...(["decide", "approve", "delegate", "watch"] as const).flatMap((lane) =>
        (parsed.ownerInbox?.lanes?.[lane] || []).slice(0, 2).map((item: any) => item.action)
      )
    ].filter(Boolean).slice(0, 6)
  });
}

async function inspectOutcomeReview(args: any, supabase: any): Promise<string> {
  const parsed = JSON.parse(await inspectMissionControl(args, supabase));
  return JSON.stringify({
    description: `최근 ${parsed.windowHours}시간 기준 Outcome Review입니다. 조회성 계산이며 실행/승인/수정은 하지 않았습니다.`,
    windowHours: parsed.windowHours,
    review: parsed.outcomeReview,
    missionStatus: parsed.mission?.status,
    ownerInboxStatus: parsed.ownerInbox?.status,
    signals: parsed.signals,
    recommendations: [
      parsed.outcomeReview?.primaryPrompt,
      ...(parsed.outcomeReview?.items || []).slice(0, 5).map((item: any) => item.prompt)
    ].filter(Boolean).slice(0, 6)
  });
}

async function inspectOperatorCoach(args: any, supabase: any): Promise<string> {
  const parsed = JSON.parse(await inspectMissionControl(args, supabase));
  return JSON.stringify({
    description: `최근 ${parsed.windowHours}시간 기준 Operator Coach입니다. 조회성 계산이며 실행/승인/수정은 하지 않았습니다.`,
    windowHours: parsed.windowHours,
    coach: parsed.operatorCoach,
    outcomeStatus: parsed.outcomeReview?.status,
    ownerInboxStatus: parsed.ownerInbox?.status,
    missionStatus: parsed.mission?.status,
    recommendations: [
      parsed.operatorCoach?.topPrompt,
      ...(parsed.operatorCoach?.items || []).slice(0, 5).map((item: any) => item.prompt)
    ].filter(Boolean).slice(0, 6)
  });
}

async function inspectLaunchKit(args: any, supabase: any): Promise<string> {
  const parsed = JSON.parse(await inspectMissionControl(args, supabase));
  return JSON.stringify({
    description: `최근 ${parsed.windowHours}시간 기준 Agent Launch Kit입니다. 조회성 계산이며 실행/승인/수정은 하지 않았습니다.`,
    windowHours: parsed.windowHours,
    launchKit: parsed.launchKit,
    missionStatus: parsed.mission?.status,
    outcomeStatus: parsed.outcomeReview?.status,
    ownerInboxStatus: parsed.ownerInbox?.status,
    signals: parsed.signals,
    recommendations: [
      parsed.launchKit?.firstPrompt,
      ...(parsed.launchKit?.routines || []).flatMap((routine: any) =>
        (routine.steps || []).slice(0, 2).map((step: any) => step.prompt)
      )
    ].filter(Boolean).slice(0, 8)
  });
}

async function inspectFinalReadiness(args: any, supabase: any): Promise<string> {
  const parsed = JSON.parse(await inspectMissionControl(args, supabase));
  return JSON.stringify({
    description: `최근 ${parsed.windowHours}시간 기준 Final Readiness입니다. 조회성 계산이며 실행/승인/수정은 하지 않았습니다.`,
    windowHours: parsed.windowHours,
    finalReadiness: parsed.finalReadiness,
    launchStatus: parsed.launchKit?.status,
    missionStatus: parsed.mission?.status,
    outcomeStatus: parsed.outcomeReview?.status,
    signals: parsed.signals,
    recommendations: [
      ...(parsed.finalReadiness?.proofPrompts || []),
      ...(parsed.finalReadiness?.items || []).filter((item: any) => item.status !== "pass").map((item: any) => item.prompt)
    ].filter(Boolean).slice(0, 8)
  });
}

function buildToolPlaybooks(input: { pendingApprovals: number; staleApprovals: number; highRiskApprovals: number; failedRuns: number; apiErrors: number; aiCost: number; deploymentSeverity: "ok" | "warn" | "critical"; thresholds: ReturnType<typeof getAgentThresholds> }) {
  const alerts = [
    input.apiErrors > 0 ? { type: "api_errors", severity: input.apiErrors >= input.thresholds.apiErrorsCritical ? "critical" as const : "warn" as const } : null,
    input.aiCost >= input.thresholds.aiCostWarnUsd ? { type: "ai_cost", severity: input.aiCost >= input.thresholds.aiCostCriticalUsd ? "critical" as const : "warn" as const } : null,
    input.pendingApprovals > 0 ? { type: "pending_approvals", severity: input.staleApprovals > 0 || input.highRiskApprovals > 0 ? "warn" as const : "ok" as const } : null,
    input.failedRuns > 0 ? { type: "monitor_failed", severity: "warn" as const } : null,
    input.deploymentSeverity !== "ok" ? { type: "deployment_failure", severity: input.deploymentSeverity } : null
  ].filter(Boolean) as any[];
  const matched = matchPlaybooks(alerts);
  return matched.length ? matched.slice(0, 3) : defaultPlaybooks().slice(0, 3);
}

async function fetchToolRecentAgentActivity(supabase: any, since: string) {
  const { data, error } = await supabase
    .from("agent_runs")
    .select("id, status, system_prompt, message, started_at, completed_at")
    .gte("started_at", since)
    .order("started_at", { ascending: false })
    .limit(200);
  if (error) throw error;
  const rows = data || [];
  return {
    totalRuns: rows.length,
    completedRuns: rows.filter((run: any) => run.status === "completed").length,
    failedRuns: rows.filter((run: any) => run.status === "failed").length,
    monitorRuns: rows.filter((run: any) => run.system_prompt === "admin-agent-monitor" || String(run.message || "").includes("monitor")).length
  };
}

async function fetchToolRecentApprovalOutcomes(supabase: any, since: string) {
  const { data, error } = await supabase
    .from("agent_approvals")
    .select("id, status, action_type, decided_at, executed_at")
    .or(`decided_at.gte.${since},executed_at.gte.${since}`)
    .limit(200);
  if (error) throw error;
  const rows = data || [];
  return {
    executed: rows.filter((approval: any) => approval.status === "executed").length,
    rejected: rows.filter((approval: any) => approval.status === "rejected").length,
    failed: rows.filter((approval: any) => approval.status === "failed").length
  };
}

async function fetchToolRecentApiErrors(supabase: any, since: string) {
  const { data, error } = await supabase
    .from("pubg_api_errors")
    .select("route, status, message, created_at")
    .gte("created_at", since)
    .order("created_at", { ascending: false })
    .limit(20);
  if (error) return { total: 0, latest: [], error: error.message };
  return { total: data?.length || 0, latest: data || [] };
}

async function fetchToolRecentAiUsage(supabase: any, since: string) {
  const { data, error } = await supabase
    .from("ai_usage_logs")
    .select("cost_usd, model_name, analysis_type")
    .gte("created_at", since)
    .limit(500);
  if (error) return { totalRequests: 0, totalCostUsd: 0, error: error.message };
  const totalCostUsd = (data || []).reduce((sum: number, row: any) => sum + Number(row.cost_usd || 0), 0);
  return { totalRequests: data?.length || 0, totalCostUsd: Number(totalCostUsd.toFixed(6)) };
}

async function fetchToolRecentFailedRuns(supabase: any, since: string) {
  const { count, error } = await supabase
    .from("agent_runs")
    .select("*", { count: "exact", head: true })
    .eq("status", "failed")
    .gte("started_at", since);
  if (error) return { count: 0, error: error.message };
  return { count: count || 0 };
}

async function fetchToolLatestMonitorSnapshot(supabase: any) {
  const { data, error } = await supabase
    .from("agent_runs")
    .select("id, summary, completed_at")
    .eq("status", "completed")
    .eq("system_prompt", "admin-agent-monitor")
    .order("completed_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (error) throw error;
  const parsed = parseJson(data?.summary);
  return { item: parsed ? { ...parsed, runId: data?.id, runCompletedAt: data?.completed_at } : null };
}

async function fetchToolRecentMemories(supabase: any) {
  const { data, error } = await supabase
    .from("agent_memories")
    .select("id, category, title, body, metadata, updated_at")
    .order("updated_at", { ascending: false })
    .limit(5);
  if (error) throw error;
  return (data || []).filter((memory: any) => memory.metadata?.active !== false);
}

async function fetchToolContentPerformance(supabase: any) {
  const report = await buildContentPerformanceReport(supabase, { days: 30, limit: 30 });
  return {
    totalPosts: report.totalPosts,
    totalViews: report.totalViews,
    recommendations: report.recommendations.slice(0, 3),
    weeklyPlan: report.weeklyPlan
  };
}

function extractHandoffFollowUp(markdown: string) {
  const section = markdown.split("## Recommended Follow-up")[1]?.split("\n\n")[0] || "";
  return section
    .split("\n")
    .map((line) => line.replace(/^- /, "").trim())
    .filter(Boolean)
    .slice(0, 6);
}

function parseJson(value?: string | null) {
  if (!value) return null;
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

function summarizeApiErrors(rows: any[]) {
  const byStatus: Record<string, number> = {};
  const byMessage: Record<string, number> = {};
  rows.forEach((row) => {
    byStatus[row.status || "unknown"] = (byStatus[row.status || "unknown"] || 0) + 1;
    const key = `${row.route || "unknown"} | ${row.status || "unknown"} | ${row.message || "unknown"}`;
    byMessage[key] = (byMessage[key] || 0) + 1;
  });
  return { total: rows.length, byStatus, topMessages: Object.entries(byMessage).sort((a, b) => b[1] - a[1]).slice(0, 10) };
}

function summarizeAiUsage(rows: any[]) {
  const byModel: Record<string, { count: number; cost: number; promptTokens: number; completionTokens: number }> = {};
  rows.forEach((row) => {
    const key = row.model_name || "unknown";
    byModel[key] ||= { count: 0, cost: 0, promptTokens: 0, completionTokens: 0 };
    byModel[key].count += 1;
    byModel[key].cost += Number(row.cost_usd || 0);
    byModel[key].promptTokens += Number(row.prompt_tokens || 0);
    byModel[key].completionTokens += Number(row.completion_tokens || 0);
  });
  const totalCost = Object.values(byModel).reduce((sum, item) => sum + item.cost, 0);
  return { totalRequests: rows.length, totalCost: Number(totalCost.toFixed(6)), byModel };
}

async function countRows(supabase: any, table: string) {
  try {
    const { count, error } = await supabase
      .from(table)
      .select("*", { count: "exact", head: true });
    if (error) throw error;
    return count || 0;
  } catch (error: any) {
    return { error: error.message || String(error) };
  }
}

export async function executeBoardPost(payload: any, supabase: any, userId: string): Promise<string> {
  let imageUrl = null;
  const imgRegex = /<img[^>]+src\s*=\s*["']?([^"'\s>]+)["']?/i;
  const match = String(payload.content || "").match(imgRegex);
  if (match?.[1]) imageUrl = match[1];

  const { data, error } = await supabase
    .from("posts")
    .insert({
      title: payload.title,
      content: payload.content,
      user_id: userId,
      author: "BGMS_AI_BOT",
      category: payload.category || "자유",
      image_url: imageUrl,
      status: "draft"
    })
    .select("id")
    .single();

  if (error) throw error;
  return JSON.stringify({ 
    success: true, 
    message: "자유게시판의 '어드민 검증' 탭에 초안 글이 임시 등록되었습니다. 게시판 내 '어드민 검증' 탭에서 확인해 주십시오.", 
    postId: data?.id 
  });
}

async function requestBoardPostApproval(args: any, context: AdminAgentContext): Promise<AgentToolResult> {
  const approvalId = await createApprovalRequest(context.supabase, {
    runId: context.runId,
    stepId: context.stepId,
    requestedBy: context.userId,
    toolName: "create_board_post",
    actionType: "create_board_post",
    payload: { title: args.title, content: args.content }
  });
  return {
    status: "approval_required",
    approvalId: approvalId || undefined,
    result: JSON.stringify({
      approvalRequired: true,
      approvalId,
      message: "게시글 발행은 승인 대기열에 등록되었습니다. 관리자 승인 후 실제 발행됩니다.",
      preview: { title: args.title, content: args.content }
    })
  };
}

async function requestUpdateBoardPostApproval(args: any, context: AdminAgentContext): Promise<AgentToolResult> {
  // 기존 게시글 원본을 조회하여 비교용 데이터를 payload에 포함
  let beforeTitle: string | null = null;
  let beforeContent: string | null = null;
  const { data: existingPost } = await context.supabase
    .from("posts")
    .select("title, content")
    .eq("id", args.postId)
    .single();
  if (existingPost) {
    beforeTitle = existingPost.title || null;
    beforeContent = existingPost.content || null;
  }

  const approvalId = await createApprovalRequest(context.supabase, {
    runId: context.runId,
    stepId: context.stepId,
    requestedBy: context.userId,
    toolName: "update_board_post",
    actionType: "update_board_post",
    payload: {
      postId: args.postId,
      title: args.title,
      content: args.content,
      beforeTitle,
      beforeContent
    }
  });
  return {
    status: "approval_required",
    approvalId: approvalId || undefined,
    result: JSON.stringify({
      approvalRequired: true,
      approvalId,
      message: "게시글 수정 승인 대기 요청을 성공적으로 올렸습니다.",
      preview: {
        postId: args.postId,
        title: args.title,
        beforeTitle
      }
    })
  };
}

export async function executeBoardPostUpdate(payload: any, supabase: any): Promise<string> {
  const postId = payload.postId;
  if (!postId) throw new Error("수정 대상 postId가 필요합니다.");

  // 기존 게시글 원본 조회
  const { data: existingPost, error: fetchError } = await supabase
    .from("posts")
    .select("content, user_id, author, category, is_notice, parent_id")
    .eq("id", postId)
    .single();
  if (fetchError) throw new Error(`게시글 조회 실패: ${fetchError.message}`);

  // 1. 최상위 원본 게시글(status = 'published'이거나 parent_id가 없는 최종 원본)의 이미지 URL 목록만 수집
  const imgRegex = /<img[^>]+src\s*=\s*["']?([^"'\s>]+)["']?/gi;
  const originalImages: string[] = [];

  let currentParentId = existingPost.parent_id || postId;
  let rootPost = null;

  while (currentParentId) {
    const { data: parentPost } = await supabase
      .from("posts")
      .select("id, content, parent_id, status")
      .eq("id", currentParentId)
      .single();
    if (!parentPost) break;
    
    rootPost = parentPost;
    // status가 published이거나 parent_id가 없다면 최종 원본이므로 루프를 중단합니다.
    if (parentPost.status === "published" || !parentPost.parent_id) {
      break;
    }
    currentParentId = parentPost.parent_id;
  }

  // 최상위 원본 글의 본문에서 이미지를 안전하게 추출합니다.
  if (rootPost && rootPost.content) {
    const matches = [...rootPost.content.matchAll(imgRegex)];
    matches.forEach(m => { if (m[1]) originalImages.push(m[1]); });
  }

  // 2. 수정 후 본문의 이미지 유실 방지 Fail-Safe 처리 (지능형 이미지 주소 대치 및 복원)
  let newContent = String(payload.content || "");
  const uniqueOriginalImages = [...new Set(originalImages)];

  if (uniqueOriginalImages.length > 0) {
    const hasImgTags = /<img[^>]+src\s*=\s*["']?([^"'\s>]+)["']?/i.test(newContent);

    if (hasImgTags) {
      // 본문 중간에 <img> 태그가 이미 존재한다면, AI가 가상으로 지조해 낸 엑박 이미지 주소들을 진짜 원본 스토리지 주소로 자동 대치(Swap)합니다.
      let imgIndex = 0;
      newContent = newContent.replace(/<img([^>]+)src\s*=\s*(["']?)([^"'\s>]+)(["']?)([^>]*)\/?>/gi, (match, p1, quote1, src, quote2, p2) => {
        // 이미 유효한 원본 이미지 주소라면 대치 없이 인덱스만 소비합니다.
        if (uniqueOriginalImages.includes(src)) {
          imgIndex++;
          return match;
        }
        // 가짜 주소(예: bgms.kr/assets/... 또는 example.com 등)인 경우 진짜 원본 주소로 대치합니다.
        if (imgIndex < uniqueOriginalImages.length) {
          const originalSrc = uniqueOriginalImages[imgIndex++];
          console.log(`🔄 [Fail-Safe Image Swap]: Replacing fake src '${src}' with original '${originalSrc}'`);
          return `<img${p1}src=${quote1}${originalSrc}${quote2}${p2}/>`;
        }
        return match;
      });
    } else {
      // 본문에 <img> 태그가 완전히 누락된 경우에만 본문 맨 위에 원래 이미지를 강제로 복원해 줍니다.
      console.log("🛠️ [Fail-Safe Image Restoration]: No images found. Restoring to top:", uniqueOriginalImages);
      const restoredImgTags = uniqueOriginalImages
        .map(src => `<img src='${src}' alt='자동 복원된 이미지' style='max-width:100%; border-radius: 8px; margin: 15px auto; display: block;'/>`)
        .join("\n");
      newContent = restoredImgTags + "\n" + newContent;
    }
  }

  // 수정 후 본문에서 대표 이미지 URL 추출
  let imageUrl = null;
  const singleImgRegex = /<img[^>]+src\s*=\s*["']?([^"'\s>]+)["']?/i;
  const imgMatch = newContent.match(singleImgRegex);
  if (imgMatch?.[1]) imageUrl = imgMatch[1];

  // 진짜 최상위 원본 ID 추적 (existingPost가 이미 draft일 수 있으므로 최상위 published 글의 ID를 parent_id로 지정)
  let rootPostId = Number(postId);
  let rootParentId = existingPost.parent_id;
  while (rootParentId) {
    const { data: parentPost } = await supabase
      .from("posts")
      .select("id, parent_id, status")
      .eq("id", rootParentId)
      .single();
    if (!parentPost) break;
    rootPostId = parentPost.id;
    if (parentPost.status === "published" || !parentPost.parent_id) {
      break;
    }
    rootParentId = parentPost.parent_id;
  }

  // 수정 초안(Shadow Draft) 생성 (1차 승인 시에는 원본을 덮어쓰지 않고 카테고리를 '어드민 검증' 탭 등에서 확인할 수 있도록 status=draft로 삽입)
  const { data: draftPost, error: insertError } = await supabase
    .from("posts")
    .insert({
      title: payload.title,
      content: newContent,
      image_url: imageUrl,
      user_id: existingPost.user_id,
      author: existingPost.author,
      category: existingPost.category,
      is_notice: existingPost.is_notice,
      status: "draft",
      parent_id: rootPostId
    })
    .select("id")
    .single();
  if (insertError) throw new Error(`수정 초안 생성 실패: ${insertError.message}`);

  return JSON.stringify({
    success: true,
    message: `수정 초안(#${draftPost?.id})이 성공적으로 생성되어 '어드민 검증' 탭에 등록되었습니다.`,
    postId: draftPost?.id,
    removedImages: 0
  });
}

async function requestCacheCleanup(args: any, context: AdminAgentContext): Promise<AgentToolResult> {
  const approvalId = await createApprovalRequest(context.supabase, {
    runId: context.runId,
    stepId: context.stepId,
    requestedBy: context.userId,
    toolName: "request_cache_cleanup",
    actionType: args.cleanupType,
    payload: {
      cleanupType: args.cleanupType,
      nickname: args.nickname || null,
      matchId: args.matchId || null,
      olderThanDays: Number(args.olderThanDays || 14),
      reason: args.reason
    }
  });
  return {
    status: "approval_required",
    approvalId: approvalId || undefined,
    result: JSON.stringify({
      approvalRequired: true,
      approvalId,
      message: "캐시 삭제 작업은 승인 대기열에 등록되었습니다.",
      cleanupType: args.cleanupType,
      reason: args.reason
    })
  };
}

async function inspectDataQuality(args: any, supabase: any): Promise<string> {
  const audit = await auditProcessedTelemetryIdentity(supabase, {
    recentDays: Number(args.recentDays || 2),
    maxRows: Number(args.maxRows || 1000),
    sampleLimit: 10,
    targetLimit: Number(args.targetLimit || 50)
  });

  return JSON.stringify({
    summary: {
      scannedRows: audit.scannedRows,
      mismatchCount: audit.mismatchCount,
      deletionCandidateCount: audit.deletionCandidateCount,
      missingPlatformColumnRows: audit.missingPlatformColumnRows,
      truncated: audit.truncated,
      generatedAt: audit.generatedAt
    },
    samples: audit.samples,
    recommendation: audit.mismatchCount > 0
      ? "identity mismatch row는 읽기 차단 대상입니다. request_data_quality_repair로 승인 요청을 만들고, 승인 전 impact를 확인하세요."
      : "identity mismatch가 감지되지 않았습니다."
  });
}

async function requestDataQualityRepair(args: any, context: AdminAgentContext): Promise<AgentToolResult> {
  const audit = await auditProcessedTelemetryIdentity(context.supabase, {
    recentDays: Number(args.recentDays || 2),
    maxRows: Number(args.maxRows || 1000),
    sampleLimit: 10,
    targetLimit: Number(args.targetLimit || 50)
  });

  if (audit.mismatchCount === 0 || audit.deletionTargets.length === 0) {
    return ok(JSON.stringify({
      approvalRequired: false,
      message: audit.mismatchCount === 0
        ? "identity mismatch가 감지되지 않아 승인 요청을 만들지 않았습니다."
        : "mismatch는 있으나 platform/match/player 기준으로 안전하게 삭제할 targets가 없어 승인 요청을 만들지 않았습니다.",
      audit
    }));
  }

  const payload = buildProcessedTelemetryIdentityRepairPayload(audit, Number(args.targetLimit || 50));
  const approvalId = await createApprovalRequest(context.supabase, {
    runId: context.runId,
    stepId: context.stepId,
    requestedBy: context.userId,
    toolName: "request_data_quality_repair",
    actionType: "repair_processed_telemetry_identity",
    payload: {
      ...payload,
      reason: args.reason || payload.reason,
      source: "admin-bot"
    }
  });

  return {
    status: "approval_required",
    approvalId: approvalId || undefined,
    result: JSON.stringify({
      approvalRequired: true,
      approvalId,
      message: "전적 분석 identity mismatch 정리 작업이 승인 대기열에 등록되었습니다.",
      audit: {
        scannedRows: audit.scannedRows,
        mismatchCount: audit.mismatchCount,
        targetCount: payload.targetCount
      }
    })
  };
}

async function takeMapScreenshot(mapName: string, layer: string, supabase: any): Promise<string> {
  let browser = null;
  try {
    try {
      const { data: buckets } = await supabase.storage.listBuckets();
      if (!buckets?.some((bucket: any) => bucket.name === "map-captures")) {
        await supabase.storage.createBucket("map-captures", {
          public: true,
          fileSizeLimit: 5242880
        });
      }
    } catch (bucketErr) {
      console.warn("[SCREENSHOT] Bucket lookup/create failed:", bucketErr);
    }

    browser = await puppeteer.launch({
      headless: true,
      args: ["--no-sandbox", "--disable-setuid-sandbox"]
    });

    const page = await browser.newPage();
    await page.setViewport({ width: 1200, height: 800 });

    const baseUrl = process.env.NEXT_PUBLIC_APP_URL || "http://localhost:3000";
    const mapUrl = `${baseUrl}/maps/${mapName.toLowerCase()}?layer=${layer}&sidebar=false&notice=false`;

    await page.goto(mapUrl, { waitUntil: "networkidle2" });
    await new Promise((resolve) => setTimeout(resolve, 2500));

    const screenshotBuffer = await page.screenshot({ type: "png" });
    const filename = `${mapName.toLowerCase()}_${layer}_${Date.now()}.png`;
    const { error: uploadError } = await supabase.storage
      .from("map-captures")
      .upload(filename, screenshotBuffer, {
        contentType: "image/png",
        upsert: true
      });

    if (uploadError) throw uploadError;

    const { data: urlData } = supabase.storage
      .from("map-captures")
      .getPublicUrl(filename);

    return JSON.stringify({
      success: true,
      message: `${mapName} 지도의 ${layer} 레이어 화면을 캡처했습니다.`,
      imageUrl: urlData?.publicUrl || ""
    });
  } finally {
    if (browser) await browser.close();
  }
}

async function runTavilySearch(query: string): Promise<string> {
  const apiKey = process.env.TAVILY_API_KEY;
  if (!apiKey) return "Tavily API 키가 설정되지 않았습니다.";

  const res = await fetch("https://api.tavily.com/search", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      api_key: apiKey,
      query,
      max_results: 5,
      include_answer: true
    })
  });
  if (!res.ok) throw new Error(`Tavily API 에러: ${await res.text()}`);
  const data = await res.json();
  return JSON.stringify({
    answer: data.answer || "직접적인 답변 요약이 없습니다.",
    results: data.results?.map((item: any) => ({
      title: item.title,
      url: item.url,
      content: item.content
    })) || []
  });
}

async function runGetVercelDeployments(limit = 5): Promise<string> {
  const token = process.env.VERCEL_TOKEN;
  const projectId = process.env.VERCEL_PROJECT_ID;
  if (!token || !projectId) {
    return "Vercel API 연동에 필요한 VERCEL_TOKEN 또는 VERCEL_PROJECT_ID 환경변수가 설정되지 않았습니다.";
  }

  const res = await fetch(`https://api.vercel.com/v6/deployments?projectId=${projectId}&limit=${limit}`, {
    headers: { Authorization: `Bearer ${token}` }
  });
  if (!res.ok) throw new Error(`Vercel API 오류: ${await res.text()}`);
  const data = await res.json();
  return JSON.stringify({
    description: "최근 Vercel 배포 목록입니다.",
    deployments: data.deployments?.map((deployment: any) => ({
      uid: deployment.uid,
      name: deployment.name,
      url: deployment.url,
      state: deployment.state,
      creator: deployment.creator?.username,
      created: new Date(deployment.created).toLocaleString("ko-KR")
    })) || []
  });
}

async function runGetVercelBuildLogs(deploymentId: string): Promise<string> {
  const token = process.env.VERCEL_TOKEN;
  if (!token) return "Vercel API 연동에 필요한 VERCEL_TOKEN 환경변수가 설정되지 않았습니다.";

  const res = await fetch(`https://api.vercel.com/v2/deployments/${deploymentId}/events?direction=backward&limit=100`, {
    headers: { Authorization: `Bearer ${token}` }
  });
  if (!res.ok) throw new Error(`Vercel API 오류: ${await res.text()}`);
  const events = await res.json();
  const errorLogs = events
    .filter((event: any) => event.type === "stderr" || event.payload?.text?.toLowerCase().includes("error") || event.payload?.text?.toLowerCase().includes("failed"))
    .map((event: any) => event.payload?.text || "")
    .join("\n");

  return JSON.stringify({
    description: `${deploymentId} 배포의 빌드 에러 로그입니다.`,
    logs: errorLogs || "에러 로그를 찾지 못했습니다."
  });
}

async function searchAgentMemories(args: any, supabase: any): Promise<string> {
  const limit = Math.min(Number(args.limit || 5), 10);
  let query = supabase
    .from("agent_memories")
    .select("id, category, title, body, metadata, updated_at")
    .order("updated_at", { ascending: false })
    .limit(limit);

  if (args.category) query = query.eq("category", String(args.category));
  if (args.query) {
    const keyword = String(args.query).replace(/[%_]/g, "").trim();
    if (keyword) query = query.or(`title.ilike.%${keyword}%,body.ilike.%${keyword}%`);
  }

  const { data, error } = await query;
  if (error) throw error;
  return JSON.stringify({
    description: "저장된 운영 기억 검색 결과입니다.",
    memories: (data || []).filter((memory: any) => memory.metadata?.active !== false)
  });
}

async function requestAgentMemory(args: any, context: AdminAgentContext): Promise<AgentToolResult> {
  const approvalId = await createApprovalRequest(context.supabase, {
    runId: context.runId,
    stepId: context.stepId,
    requestedBy: context.userId,
    toolName: "request_agent_memory",
    actionType: "save_agent_memory",
    payload: {
      category: args.category,
      title: args.title,
      body: args.body,
      metadata: {
        tags: args.tags || [],
        reason: args.reason,
        source: "agent-request",
        active: true
      }
    }
  });
  return {
    status: "approval_required",
    approvalId: approvalId || undefined,
    result: JSON.stringify({
      approvalRequired: true,
      approvalId,
      message: "운영 기억 저장은 승인 대기열에 등록되었습니다.",
      title: args.title,
      reason: args.reason
    })
  };
}

async function generateOperationsBriefing(args: any, supabase: any): Promise<string> {
  const briefing = await buildAgentBriefing(supabase, Number(args.hours || 24));
  return JSON.stringify({
    briefing,
    text: renderBriefingText(briefing)
  });
}

async function requestOperationsReport(args: any, context: AdminAgentContext): Promise<AgentToolResult> {
  const briefing = await buildAgentBriefing(context.supabase, Number(args.hours || 24));
  const body = renderBriefingText(briefing);
  const title = args.title || `BGMS 운영 브리핑 ${new Date().toLocaleDateString("ko-KR")}`;
  const approvalId = await createApprovalRequest(context.supabase, {
    runId: context.runId,
    stepId: context.stepId,
    requestedBy: context.userId,
    toolName: "request_operations_report",
    actionType: "save_agent_report",
    payload: {
      category: "report",
      title,
      body,
      metadata: {
        source: "agent-request",
        active: true,
        reason: args.reason,
        briefing
      }
    }
  });

  return {
    status: "approval_required",
    approvalId: approvalId || undefined,
    result: JSON.stringify({
      approvalRequired: true,
      approvalId,
      message: "운영 리포트 저장은 승인 대기열에 등록되었습니다.",
      title,
      severity: briefing.severity
    })
  };
}

async function generateContentDraft(args: any, supabase: any): Promise<string> {
  const draft = await buildContentDraft(supabase, {
    draftType: args.draftType,
    hours: Number(args.hours || 168),
    tone: args.tone
  });
  return JSON.stringify({ draft });
}

async function analyzeContentPerformance(args: any, supabase: any): Promise<string> {
  const report = await buildContentPerformanceReport(supabase, {
    days: Number(args.days || 30),
    limit: Number(args.limit || 50)
  });
  return JSON.stringify({ report });
}

async function requestContentPost(args: any, context: AdminAgentContext): Promise<AgentToolResult> {
  const draft = await buildContentDraft(context.supabase, {
    draftType: args.draftType,
    hours: Number(args.hours || 168),
    tone: args.tone
  });

  const approvalId = await createApprovalRequest(context.supabase, {
    runId: context.runId,
    stepId: context.stepId,
    requestedBy: context.userId,
    toolName: "request_content_post",
    actionType: "create_board_post",
    payload: {
      title: args.title || draft.title,
      content: draft.contentHtml,
      category: draft.category,
      reason: args.reason,
      draft
    }
  });

  return {
    status: "approval_required",
    approvalId: approvalId || undefined,
    result: JSON.stringify({
      approvalRequired: true,
      approvalId,
      message: "콘텐츠 게시글 발행은 승인 대기열에 등록되었습니다.",
      title: args.title || draft.title,
      draftType: draft.draftType
    })
  };
}

export const adminAgentTools: Record<string, AdminAgentTool> = {
  get_db_statistics: {
    declaration: getDbStatisticsDecl,
    safetyLevel: "read",
    run: async (args, context) => {
      try {
        return ok(await runDbStatQuery(args.statType, context.supabase));
      } catch (error) {
        return failed(error);
      }
    }
  },
  inspect_operations: {
    declaration: inspectOperationsDecl,
    safetyLevel: "read",
    run: async (args, context) => {
      try {
        return ok(await inspectOperations(args, context.supabase));
      } catch (error) {
        return failed(error);
      }
    }
  },
  inspect_agent_readiness: {
    declaration: inspectAgentReadinessDecl,
    safetyLevel: "read",
    run: async (args, context) => {
      try {
        return ok(await inspectAgentReadiness(args, context.supabase));
      } catch (error) {
        return failed(error);
      }
    }
  },
  inspect_approval_queue: {
    declaration: inspectApprovalQueueDecl,
    safetyLevel: "read",
    run: async (args, context) => {
      try {
        return ok(await inspectApprovalQueue(args, context.supabase));
      } catch (error) {
        return failed(error);
      }
    }
  },
  inspect_data_quality: {
    declaration: inspectDataQualityDecl,
    safetyLevel: "read",
    run: async (args, context) => {
      try {
        return ok(await inspectDataQuality(args, context.supabase));
      } catch (error) {
        return failed(error);
      }
    }
  },
  inspect_incident_timeline: {
    declaration: inspectIncidentTimelineDecl,
    safetyLevel: "read",
    run: async (args, context) => {
      try {
        return ok(await inspectIncidentTimeline(args, context.supabase));
      } catch (error) {
        return failed(error);
      }
    }
  },
  inspect_handoff_packet: {
    declaration: inspectHandoffPacketDecl,
    safetyLevel: "read",
    run: async (args, context) => {
      try {
        return ok(await inspectHandoffPacket(args, context.supabase));
      } catch (error) {
        return failed(error);
      }
    }
  },
  inspect_operator_value: {
    declaration: inspectOperatorValueDecl,
    safetyLevel: "read",
    run: async (args, context) => {
      try {
        return ok(await inspectOperatorValue(args, context.supabase));
      } catch (error) {
        return failed(error);
      }
    }
  },
  inspect_owner_brief: {
    declaration: inspectOwnerBriefDecl,
    safetyLevel: "read",
    run: async (args, context) => {
      try {
        return ok(await inspectOwnerBrief(args, context.supabase));
      } catch (error) {
        return failed(error);
      }
    }
  },
  inspect_monitor_trend: {
    declaration: inspectMonitorTrendDecl,
    safetyLevel: "read",
    run: async (args, context) => {
      try {
        return ok(await inspectMonitorTrend(args, context.supabase));
      } catch (error) {
        return failed(error);
      }
    }
  },
  inspect_automation_contract: {
    declaration: inspectAutomationContractDecl,
    safetyLevel: "read",
    run: async (args, context) => {
      try {
        return ok(await inspectAutomationContract(args, context.supabase));
      } catch (error) {
        return failed(error);
      }
    }
  },
  summarize_user_activity: {
    declaration: summarizeUserActivityDecl,
    safetyLevel: "read",
    run: async (args, context) => {
      try {
        return ok(await summarizeUserActivity(args, context.supabase));
      } catch (error) {
        return failed(error);
      }
    }
  },
  inspect_user_metrics: {
    declaration: inspectUserMetricsDecl,
    safetyLevel: "read",
    run: async (args, context) => {
      try {
        return ok(await inspectUserMetrics(args, context.supabase));
      } catch (error) {
        return failed(error);
      }
    }
  },
  inspect_capability_matrix: {
    declaration: inspectCapabilityMatrixDecl,
    safetyLevel: "read",
    run: async (args, context) => {
      try {
        return ok(await inspectCapabilityMatrix(args, context.supabase));
      } catch (error) {
        return failed(error);
      }
    }
  },
  inspect_growth_roadmap: {
    declaration: inspectGrowthRoadmapDecl,
    safetyLevel: "read",
    run: async (args, context) => {
      try {
        return ok(await inspectGrowthRoadmap(args, context.supabase));
      } catch (error) {
        return failed(error);
      }
    }
  },
  inspect_today_action_board: {
    declaration: inspectTodayActionBoardDecl,
    safetyLevel: "read",
    run: async (args, context) => {
      try {
        return ok(await inspectTodayActionBoard(args, context.supabase));
      } catch (error) {
        return failed(error);
      }
    }
  },
  inspect_daily_checkout: {
    declaration: inspectDailyCheckoutDecl,
    safetyLevel: "read",
    run: async (args, context) => {
      try {
        return ok(await inspectDailyCheckout(args, context.supabase));
      } catch (error) {
        return failed(error);
      }
    }
  },
  inspect_operating_sop: {
    declaration: inspectOperatingSopDecl,
    safetyLevel: "read",
    run: async (args, context) => {
      try {
        return ok(await inspectOperatingSop(args, context.supabase));
      } catch (error) {
        return failed(error);
      }
    }
  },
  inspect_risk_radar: {
    declaration: inspectRiskRadarDecl,
    safetyLevel: "read",
    run: async (args, context) => {
      try {
        return ok(await inspectRiskRadar(args, context.supabase));
      } catch (error) {
        return failed(error);
      }
    }
  },
  inspect_decision_trace: {
    declaration: inspectDecisionTraceDecl,
    safetyLevel: "read",
    run: async (args, context) => {
      try {
        return ok(await inspectDecisionTrace(args, context.supabase));
      } catch (error) {
        return failed(error);
      }
    }
  },
  inspect_safety_audit: {
    declaration: inspectSafetyAuditDecl,
    safetyLevel: "read",
    run: async (args, context) => {
      try {
        return ok(await inspectSafetyAudit(args, context.supabase));
      } catch (error) {
        return failed(error);
      }
    }
  },
  inspect_approval_advisor: {
    declaration: inspectApprovalAdvisorDecl,
    safetyLevel: "read",
    run: async (args, context) => {
      try {
        return ok(await inspectApprovalAdvisor(args, context.supabase));
      } catch (error) {
        return failed(error);
      }
    }
  },
  inspect_mission_control: {
    declaration: inspectMissionControlDecl,
    safetyLevel: "read",
    run: async (args, context) => {
      try {
        return ok(await inspectMissionControl(args, context.supabase));
      } catch (error) {
        return failed(error);
      }
    }
  },
  inspect_owner_inbox: {
    declaration: inspectOwnerInboxDecl,
    safetyLevel: "read",
    run: async (args, context) => {
      try {
        return ok(await inspectOwnerInbox(args, context.supabase));
      } catch (error) {
        return failed(error);
      }
    }
  },
  inspect_outcome_review: {
    declaration: inspectOutcomeReviewDecl,
    safetyLevel: "read",
    run: async (args, context) => {
      try {
        return ok(await inspectOutcomeReview(args, context.supabase));
      } catch (error) {
        return failed(error);
      }
    }
  },
  inspect_operator_coach: {
    declaration: inspectOperatorCoachDecl,
    safetyLevel: "read",
    run: async (args, context) => {
      try {
        return ok(await inspectOperatorCoach(args, context.supabase));
      } catch (error) {
        return failed(error);
      }
    }
  },
  inspect_launch_kit: {
    declaration: inspectLaunchKitDecl,
    safetyLevel: "read",
    run: async (args, context) => {
      try {
        return ok(await inspectLaunchKit(args, context.supabase));
      } catch (error) {
        return failed(error);
      }
    }
  },
  inspect_final_readiness: {
    declaration: inspectFinalReadinessDecl,
    safetyLevel: "read",
    run: async (args, context) => {
      try {
        return ok(await inspectFinalReadiness(args, context.supabase));
      } catch (error) {
        return failed(error);
      }
    }
  },
  create_board_post: {
    declaration: createBoardPostDecl,
    safetyLevel: "dangerous",
    run: requestBoardPostApproval
  },
  update_board_post: {
    declaration: updateBoardPostDecl,
    safetyLevel: "dangerous",
    run: requestUpdateBoardPostApproval
  },
  request_cache_cleanup: {
    declaration: requestCacheCleanupDecl,
    safetyLevel: "dangerous",
    run: requestCacheCleanup
  },
  request_data_quality_repair: {
    declaration: requestDataQualityRepairDecl,
    safetyLevel: "dangerous",
    run: requestDataQualityRepair
  },
  take_map_screenshot: {
    declaration: takeMapScreenshotDecl,
    safetyLevel: "write",
    run: async (args, context) => {
      try {
        return ok(await takeMapScreenshot(args.mapName, args.layer, context.supabase));
      } catch (error) {
        return failed(error);
      }
    }
  },
  tavily_search: {
    declaration: tavilySearchDecl,
    safetyLevel: "read",
    run: async (args) => {
      try {
        return ok(await runTavilySearch(args.query));
      } catch (error) {
        return failed(error);
      }
    }
  },
  get_vercel_deployments: {
    declaration: getVercelDeploymentsDecl,
    safetyLevel: "read",
    run: async (args) => {
      try {
        return ok(await runGetVercelDeployments(args.limit));
      } catch (error) {
        return failed(error);
      }
    }
  },
  get_vercel_build_logs: {
    declaration: getVercelBuildLogsDecl,
    safetyLevel: "read",
    run: async (args) => {
      try {
        return ok(await runGetVercelBuildLogs(args.deploymentId));
      } catch (error) {
        return failed(error);
      }
    }
  },
  search_agent_memories: {
    declaration: searchAgentMemoriesDecl,
    safetyLevel: "read",
    run: async (args, context) => {
      try {
        return ok(await searchAgentMemories(args, context.supabase));
      } catch (error) {
        return failed(error);
      }
    }
  },
  request_agent_memory: {
    declaration: requestAgentMemoryDecl,
    safetyLevel: "dangerous",
    run: requestAgentMemory
  },
  generate_operations_briefing: {
    declaration: generateOperationsBriefingDecl,
    safetyLevel: "read",
    run: async (args, context) => {
      try {
        return ok(await generateOperationsBriefing(args, context.supabase));
      } catch (error) {
        return failed(error);
      }
    }
  },
  request_operations_report: {
    declaration: requestOperationsReportDecl,
    safetyLevel: "dangerous",
    run: requestOperationsReport
  },
  generate_content_draft: {
    declaration: generateContentDraftDecl,
    safetyLevel: "read",
    run: async (args, context) => {
      try {
        return ok(await generateContentDraft(args, context.supabase));
      } catch (error) {
        return failed(error);
      }
    }
  },
  analyze_content_performance: {
    declaration: analyzeContentPerformanceDecl,
    safetyLevel: "read",
    run: async (args, context) => {
      try {
        return ok(await analyzeContentPerformance(args, context.supabase));
      } catch (error) {
        return failed(error);
      }
    }
  },
  request_content_post: {
    declaration: requestContentPostDecl,
    safetyLevel: "dangerous",
    run: requestContentPost
  }
};

export const adminAgentFunctionDeclarations = Object.values(adminAgentTools).map((tool) => tool.declaration);
