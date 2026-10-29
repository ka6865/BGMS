import { NextResponse } from "next/server";
import { emptyApprovalGateSummary, emptyApprovalQueueSummary, fetchApprovalGateSummary, fetchApprovalQueueSummary } from "@/lib/admin-agent/approvals";
import { buildTodayActionBoard } from "@/lib/admin-agent/action-board";
import { buildAgentApprovalAdvisor } from "@/lib/admin-agent/approval-advisor";
import { buildAgentAutomationContracts } from "@/lib/admin-agent/automation-contracts";
import { buildAgentCapabilityMatrix } from "@/lib/admin-agent/capability-matrix";
import { buildCommandCenterMarkdown, buildDailyDigestMarkdown, buildFinalReadinessMarkdown } from "@/lib/admin-agent/command-center-export";
import { buildContentPerformanceReport } from "@/lib/admin-agent/content-performance";
import { buildAgentDailyCheckout } from "@/lib/admin-agent/daily-checkout";
import { buildAgentDecisionTrace } from "@/lib/admin-agent/decision-trace";
import { fetchVercelDeploymentHealth, unavailableDeploymentHealth } from "@/lib/admin-agent/deployments";
import { buildAgentFinalReadiness } from "@/lib/admin-agent/final-readiness";
import { buildAgentGrowthRoadmap } from "@/lib/admin-agent/growth-roadmap";
import { buildAgentImprovementBacklog } from "@/lib/admin-agent/improvement-backlog";
import { buildAgentLaunchKit } from "@/lib/admin-agent/launch-kit";
import { buildMemorySuggestions } from "@/lib/admin-agent/memory-suggestions";
import { buildAgentMissionControl } from "@/lib/admin-agent/mission-control";
import { buildAgentMonitorTrend } from "@/lib/admin-agent/monitor-trend";
import { approvalCreationFailedResponse, createApprovalRequest, verifyAdminRole } from "@/lib/admin-agent/logging";
import { buildNextBestActions } from "@/lib/admin-agent/next-actions";
import { buildAgentOperatingMode } from "@/lib/admin-agent/operating-mode";
import { buildAgentOperatingSop } from "@/lib/admin-agent/operating-sop";
import { buildAgentOwnerInbox } from "@/lib/admin-agent/owner-inbox";
import { buildAgentOperatorCoach } from "@/lib/admin-agent/operator-coach";
import { buildOperatorValueScorecard } from "@/lib/admin-agent/operator-value";
import { buildAgentOutcomeReview } from "@/lib/admin-agent/outcome-review";
import { buildAgentOwnerBrief } from "@/lib/admin-agent/owner-brief";
import { defaultPlaybooks, matchPlaybooks } from "@/lib/admin-agent/playbooks";
import { buildAgentRiskRadar } from "@/lib/admin-agent/risk-radar";
import { buildAgentSafetyAudit } from "@/lib/admin-agent/safety-audit";
import { runAgentSelfTest } from "@/lib/admin-agent/self-test";
import { buildAgentRolloutReadiness } from "@/lib/admin-agent/rollout";
import { getAgentThresholds } from "@/lib/admin-agent/thresholds";
import { buildAgentToolCatalog } from "@/lib/admin-agent/tool-catalog";
import { buildTrafficSummary, buildUnavailableTrafficSummary } from "@/lib/admin-agent/traffic-summary";
import { AGENT_SOURCE_FAILURE_MESSAGE, createSourceSettler, type AgentSourceFailure } from "@/lib/admin-agent/settle";
import type { AgentRolloutReadiness } from "@/lib/admin-agent/rollout";
import type { AgentSelfTest } from "@/lib/admin-agent/self-test";
import { withAuthGuard } from "@/utils/supabase/guard";

const COMMAND_CENTER_ERROR_MESSAGE = "운영 커맨드센터 데이터를 불러오지 못했습니다. 잠시 후 다시 시도해 주세요.";

export async function GET(request: Request) {
  try {
    return await handleGet(request);
  } catch (error: any) {
    console.error("[COMMAND-CENTER] GET failed:", error?.message || error);
    return NextResponse.json({ error: COMMAND_CENTER_ERROR_MESSAGE }, { status: 500 });
  }
}

export async function POST(request: Request) {
  try {
    return await handlePost(request);
  } catch (error: any) {
    console.error("[COMMAND-CENTER] POST failed:", error?.message || error);
    return NextResponse.json({ error: COMMAND_CENTER_ERROR_MESSAGE }, { status: 500 });
  }
}

async function handleGet(request: Request) {
  const auth = await withAuthGuard();
  if (auth.error) return auth.error;
  const { supabaseAdmin: supabase, user } = auth;

  const adminError = await verifyAdminRole(supabase, user.id);
  if (adminError) return adminError;
  const payload = await buildCommandCenterPayload(supabase);

  const format = new URL(request.url).searchParams.get("format");
  if (format === "markdown") {
    return NextResponse.json({
      markdown: buildCommandCenterMarkdown(payload),
      commandCenter: payload
    });
  }

  if (format === "digest") {
    return NextResponse.json({
      markdown: buildDailyDigestMarkdown(payload),
      commandCenter: payload
    });
  }

  if (format === "final") {
    return NextResponse.json({
      markdown: buildFinalReadinessMarkdown(payload),
      commandCenter: payload
    });
  }

  return NextResponse.json(payload);
}

async function handlePost(request: Request) {
  const auth = await withAuthGuard();
  if (auth.error) return auth.error;
  const { supabaseAdmin: supabase, user } = auth;

  const adminError = await verifyAdminRole(supabase, user.id);
  if (adminError) return adminError;

  const body = await request.json().catch(() => ({}));
  const payload = await buildCommandCenterPayload(supabase);
  const format = body.format === "markdown" || body.format === "final" ? body.format : "digest";
  const markdown = format === "markdown"
    ? buildCommandCenterMarkdown(payload)
    : format === "final"
      ? buildFinalReadinessMarkdown(payload)
      : buildDailyDigestMarkdown(payload);
  const title = body.title || (format === "markdown"
    ? `BGMS 운영 커맨드센터 ${new Date().toLocaleDateString("ko-KR")}`
    : format === "final"
      ? `BGMS Admin Agent Final Readiness ${new Date().toLocaleDateString("ko-KR")}`
      : `BGMS Daily Ops Digest ${new Date().toLocaleDateString("ko-KR")}`);

  const approvalId = await createApprovalRequest(supabase, {
    requestedBy: user.id,
    toolName: "request_command_center_report",
    actionType: "save_agent_report",
    payload: {
      category: "report",
      title,
      body: markdown,
      metadata: {
        source: format === "markdown" ? "command-center-summary" : format === "final" ? "command-center-final-readiness" : "command-center-digest",
        active: true,
        reason: body.reason || "운영 커맨드센터 기록 보존",
        commandCenter: {
          generatedAt: payload.generatedAt,
          severity: payload.severity,
          operatingMode: payload.operatingMode,
          pendingApprovals: {
            count: payload.pendingApprovals.count,
            highRiskCount: payload.pendingApprovals.highRiskCount,
            staleCount: payload.pendingApprovals.staleCount
          },
          approvalGateSummary: {
            sampledCount: payload.approvalGateSummary.sampledCount,
            passCount: payload.approvalGateSummary.passCount,
            reviewCount: payload.approvalGateSummary.reviewCount,
            blockCount: payload.approvalGateSummary.blockCount
          },
          improvementBacklog: {
            score: payload.improvementBacklog.score,
            label: payload.improvementBacklog.label,
            topItem: payload.improvementBacklog.items[0] || null
          },
          dailyCheckout: {
            status: payload.dailyCheckout.status,
            label: payload.dailyCheckout.label,
            score: payload.dailyCheckout.score,
            summary: payload.dailyCheckout.summary,
            openRisks: payload.dailyCheckout.openRisks.slice(0, 5),
            tomorrowFocus: payload.dailyCheckout.tomorrowFocus.slice(0, 3),
            handoffPrompt: payload.dailyCheckout.handoffPrompt
          },
          todayActionBoard: {
            status: payload.todayActionBoard.status,
            summary: payload.todayActionBoard.summary,
            primaryPrompt: payload.todayActionBoard.primaryPrompt,
            doNowCount: payload.todayActionBoard.lanes.doNow.length,
            reviewCount: payload.todayActionBoard.lanes.review.length,
            watchCount: payload.todayActionBoard.lanes.watch.length,
            saveCount: payload.todayActionBoard.lanes.save.length,
            topItem: payload.todayActionBoard.lanes.doNow[0]
              || payload.todayActionBoard.lanes.review[0]
              || payload.todayActionBoard.lanes.watch[0]
              || payload.todayActionBoard.lanes.save[0]
              || null
          },
          capabilityMatrix: {
            score: payload.capabilityMatrix.score,
            label: payload.capabilityMatrix.label,
            summary: payload.capabilityMatrix.summary,
            attentionItems: payload.capabilityMatrix.items
              .filter((item: any) => item.status !== "ready")
              .slice(0, 4)
              .map((item: any) => ({
                id: item.id,
                label: item.label,
                status: item.status,
                score: item.score,
                nextStep: item.nextStep
              }))
          },
          operatorValue: {
            score: payload.operatorValue.score,
            label: payload.operatorValue.label,
            summary: payload.operatorValue.summary,
            topMetric: payload.operatorValue.metrics[0] || null,
            nextLeverage: payload.operatorValue.nextLeverage[0] || null
          },
          growthRoadmap: {
            status: payload.growthRoadmap.status,
            summary: payload.growthRoadmap.summary,
            primaryPrompt: payload.growthRoadmap.primaryPrompt,
            nowCount: payload.growthRoadmap.lanes.now.length,
            thisWeekCount: payload.growthRoadmap.lanes.thisWeek.length,
            laterCount: payload.growthRoadmap.lanes.later.length,
            topItem: payload.growthRoadmap.lanes.now[0]
              || payload.growthRoadmap.lanes.thisWeek[0]
              || payload.growthRoadmap.lanes.later[0]
              || null
          },
          ownerBrief: {
            status: payload.ownerBrief.status,
            headline: payload.ownerBrief.headline,
            summary: payload.ownerBrief.summary,
            doNow: payload.ownerBrief.doNow,
            needsOwnerReviewCount: payload.ownerBrief.needsOwnerReview.length,
            confidence: payload.ownerBrief.confidence
          },
          automationContracts: {
            summary: payload.automationContracts.summary,
            freePlanMode: payload.automationContracts.freePlanMode,
            counts: payload.automationContracts.counts,
            active: payload.automationContracts.contracts
              .filter((contract: any) => contract.status === "active")
              .map((contract: any) => ({
                id: contract.id,
                title: contract.title,
                cadence: contract.cadence,
                guardrail: contract.guardrail
              }))
          },
          operatingSop: {
            status: payload.operatingSop.status,
            title: payload.operatingSop.title,
            summary: payload.operatingSop.summary,
            primaryPrompt: payload.operatingSop.primaryPrompt,
            procedureCount: payload.operatingSop.procedures.length,
            topProcedure: payload.operatingSop.procedures[0]
              ? {
                id: payload.operatingSop.procedures[0].id,
                title: payload.operatingSop.procedures[0].title,
                severity: payload.operatingSop.procedures[0].severity,
                risk: payload.operatingSop.procedures[0].risk,
                nextPrompt: payload.operatingSop.procedures[0].nextPrompt
              }
              : null
          },
          riskRadar: {
            status: payload.riskRadar.status,
            score: payload.riskRadar.score,
            summary: payload.riskRadar.summary,
            primaryPrompt: payload.riskRadar.primaryPrompt,
            topRisks: payload.riskRadar.items.slice(0, 3).map((risk: any) => ({
              id: risk.id,
              category: risk.category,
              severity: risk.severity,
              score: risk.score,
              title: risk.title,
              prompt: risk.prompt
            }))
          },
          decisionTrace: {
            confidence: payload.decisionTrace.confidence,
            summary: payload.decisionTrace.summary,
            observationCount: payload.decisionTrace.observations.length,
            decisionCount: payload.decisionTrace.decisions.length,
            blindSpotCount: payload.decisionTrace.blindSpots.filter((item: string) => !item.includes("큰 blind spot")).length,
            topDecision: payload.decisionTrace.decisions[0]
              ? {
                id: payload.decisionTrace.decisions[0].id,
                title: payload.decisionTrace.decisions[0].title,
                confidence: payload.decisionTrace.decisions[0].confidence,
                prompt: payload.decisionTrace.decisions[0].prompt
              }
              : null
          },
          safetyAudit: {
            status: payload.safetyAudit.status,
            score: payload.safetyAudit.score,
            summary: payload.safetyAudit.summary,
            requiredFixCount: payload.safetyAudit.requiredFixes.length,
            topInvariant: payload.safetyAudit.invariants.find((item: any) => item.status !== "ok")
              || payload.safetyAudit.invariants[0]
              || null
          },
          approvalAdvisor: {
            status: payload.approvalAdvisor.status,
            summary: payload.approvalAdvisor.summary,
            counts: payload.approvalAdvisor.counts,
            topAdvice: payload.approvalAdvisor.items[0] || null
          },
          missionControl: {
            status: payload.missionControl.status,
            summary: payload.missionControl.summary,
            firstCommand: payload.missionControl.firstCommand,
            phases: payload.missionControl.phases,
            topItems: payload.missionControl.items.slice(0, 3)
          },
          ownerInbox: {
            status: payload.ownerInbox.status,
            summary: payload.ownerInbox.summary,
            primaryAction: payload.ownerInbox.primaryAction,
            counts: payload.ownerInbox.counts
          },
          outcomeReview: {
            status: payload.outcomeReview.status,
            score: payload.outcomeReview.score,
            summary: payload.outcomeReview.summary,
            primaryPrompt: payload.outcomeReview.primaryPrompt,
            topItems: payload.outcomeReview.items.slice(0, 3)
          },
          operatorCoach: {
            mode: payload.operatorCoach.mode,
            summary: payload.operatorCoach.summary,
            topPrompt: payload.operatorCoach.topPrompt,
            topItems: payload.operatorCoach.items.slice(0, 3)
          },
          launchKit: {
            status: payload.launchKit.status,
            summary: payload.launchKit.summary,
            firstPrompt: payload.launchKit.firstPrompt,
            routines: payload.launchKit.routines.map((routine: any) => ({
              id: routine.id,
              cadence: routine.cadence,
              owner: routine.owner,
              title: routine.title
            }))
          },
          finalReadiness: {
            status: payload.finalReadiness.status,
            score: payload.finalReadiness.score,
            summary: payload.finalReadiness.summary,
            remainingWork: payload.finalReadiness.remainingWork.slice(0, 5),
            topItems: payload.finalReadiness.items.slice(0, 4)
          },
          monitorTrend: {
            direction: payload.monitorTrend.direction,
            label: payload.monitorTrend.label,
            sampleSize: payload.monitorTrend.sampleSize,
            summary: payload.monitorTrend.summary,
            recommendation: payload.monitorTrend.recommendation,
            deltas: payload.monitorTrend.deltas
          },
          trafficSummary: payload.trafficSummary ? {
            status: payload.trafficSummary.status,
            windowHours: payload.trafficSummary.windowHours,
            sessions: payload.trafficSummary.current.uniqueSessions,
            pageViews: payload.trafficSummary.current.pageViews,
            statsSearches: payload.trafficSummary.current.statsSearches,
            aiFeatureUses: payload.trafficSummary.current.aiFeatureUses,
            topPages: payload.trafficSummary.current.topPages.slice(0, 3),
            topFeatures: payload.trafficSummary.current.topFeatures.slice(0, 3),
            topUsers: payload.trafficSummary.current.topUsers.slice(0, 3),
            highlights: payload.trafficSummary.highlights
          } : null,
          trafficSummary7d: payload.trafficSummary7d ? {
            status: payload.trafficSummary7d.status,
            windowHours: payload.trafficSummary7d.windowHours,
            sessions: payload.trafficSummary7d.current.uniqueSessions,
            pageViews: payload.trafficSummary7d.current.pageViews,
            statsSearches: payload.trafficSummary7d.current.statsSearches,
            aiFeatureUses: payload.trafficSummary7d.current.aiFeatureUses,
            topPages: payload.trafficSummary7d.current.topPages.slice(0, 3),
            topFeatures: payload.trafficSummary7d.current.topFeatures.slice(0, 3),
            topUsers: payload.trafficSummary7d.current.topUsers.slice(0, 3),
            highlights: payload.trafficSummary7d.highlights
          } : null,
          latestMonitorSnapshot: payload.latestMonitorSnapshot?.item ? {
            runId: payload.latestMonitorSnapshot.item.runId,
            generatedAt: payload.latestMonitorSnapshot.item.generatedAt,
            runCompletedAt: payload.latestMonitorSnapshot.item.runCompletedAt,
            severity: payload.latestMonitorSnapshot.item.severity,
            alertCount: Array.isArray(payload.latestMonitorSnapshot.item.alerts) ? payload.latestMonitorSnapshot.item.alerts.length : 0,
            approvalGateSummary: payload.latestMonitorSnapshot.item.approvalGateSummary || null,
            dailyCheckout: payload.latestMonitorSnapshot.item.dailyCheckout || null,
            topAlert: payload.latestMonitorSnapshot.item.alerts?.[0] || null
          } : null
        }
      }
    }
  });

  if (!approvalId) {
    return approvalCreationFailedResponse("운영 커맨드센터 리포트 저장", { format, markdown, commandCenter: payload });
  }

  return NextResponse.json({
    success: true,
    approvalId,
    format,
    markdown,
    commandCenter: payload
  });
}

function fallbackSelfTest(message: string): AgentSelfTest {
  return {
    generatedAt: new Date().toISOString(),
    status: "warn",
    checks: [{ id: "selftest:unavailable", label: "Agent self-test", status: "warn", message }],
    toolCount: 0
  };
}

function fallbackRollout(message: string): AgentRolloutReadiness {
  return {
    generatedAt: new Date().toISOString(),
    status: "warn",
    checks: [{
      id: "rollout:unavailable",
      label: "배포 전 점검",
      status: "warn",
      message,
      action: "잠시 후 커맨드센터를 다시 불러오고, 계속 실패하면 서버 로그를 확인하세요."
    }],
    selfTest: fallbackSelfTest(message)
  };
}

async function buildCommandCenterPayload(supabase: any) {
  const thresholds = getAgentThresholds();
  // 병렬 조회 하나가 실패해도 나머지로 커맨드센터를 그린다. 실패한 소스는 degradedSources 에 남긴다.
  const degradedSources: AgentSourceFailure[] = [];
  const settle = createSourceSettler(degradedSources, "[COMMAND-CENTER]");
  const [latestRun, latestMonitorSnapshot, monitorTrend, pendingApprovals, approvalGateSummary, failedRuns, latestErrors, aiUsage, memories, latestReport, readiness, deploymentHealth, contentPerformance, rollout, recentAgentActivity, approvalOutcomes, trafficSummary, trafficSummary7d] = await Promise.all([
    settle<any>("latestRun", () => fetchLatestRun(supabase), (message) => ({ error: message })),
    settle<Awaited<ReturnType<typeof fetchLatestMonitorSnapshot>>>("latestMonitorSnapshot", () => fetchLatestMonitorSnapshot(supabase), (message) => ({ item: null, error: message })),
    settle<Awaited<ReturnType<typeof fetchMonitorTrend>>>("monitorTrend", () => fetchMonitorTrend(supabase), (message) => ({ ...buildAgentMonitorTrend([]), error: message })),
    settle("pendingApprovals", () => fetchApprovalQueueSummary(supabase), emptyApprovalQueueSummary),
    settle("approvalGateSummary", () => fetchApprovalGateSummary(supabase), emptyApprovalGateSummary),
    settle<{ count: number; error?: string }>("failedRuns", () => countRecentFailedRuns(supabase, thresholds.windowHours), (message) => ({ count: 0, error: message })),
    settle<{ total: number; latest: any[]; error?: string }>("apiErrors", () => fetchRecentApiErrors(supabase, thresholds.windowHours), (message) => ({ total: 0, latest: [], error: message })),
    settle<{ totalRequests: number; totalCostUsd: number; error?: string }>("aiUsage", () => fetchRecentAiUsage(supabase, thresholds.windowHours), (message) => ({ totalRequests: 0, totalCostUsd: 0, error: message })),
    settle<{ items: any[]; error?: string }>("memories", () => fetchRecentMemories(supabase), (message) => ({ items: [], error: message })),
    settle<{ item: any; error?: string }>("latestReport", () => fetchLatestReport(supabase), (message) => ({ item: null, error: message })),
    settle("readiness", () => runAgentSelfTest(supabase), fallbackSelfTest),
    settle("deploymentHealth", () => fetchVercelDeploymentHealth(), unavailableDeploymentHealth),
    settle<Awaited<ReturnType<typeof fetchContentPerformance>>>("contentPerformance", () => fetchContentPerformance(supabase), (message) => ({
      totalPosts: 0,
      totalViews: 0,
      averageEngagementRate: 0,
      momentum: { score: 0, label: "no_data", reason: "콘텐츠 성과 조회 실패" },
      topPost: null,
      topCategory: null,
      lowEffortWins: [],
      weeklyPlan: [],
      recommendations: [],
      error: message
    } as any)),
    settle("rollout", () => buildAgentRolloutReadiness(supabase), fallbackRollout),
    settle<Awaited<ReturnType<typeof fetchRecentAgentActivity>>>("recentAgentActivity", () => fetchRecentAgentActivity(supabase, thresholds.windowHours), (message) => ({ totalRuns: 0, completedRuns: 0, failedRuns: 0, monitorRuns: 0, error: message })),
    settle<Awaited<ReturnType<typeof fetchRecentApprovalOutcomes>>>("approvalOutcomes", () => fetchRecentApprovalOutcomes(supabase, thresholds.windowHours), (message) => ({ executed: 0, rejected: 0, failed: 0, error: message })),
    settle("trafficSummary", () => buildTrafficSummary(supabase, thresholds.windowHours), (message) => buildUnavailableTrafficSummary(thresholds.windowHours, message)),
    settle("trafficSummary7d", () => buildTrafficSummary(supabase, 168), (message) => buildUnavailableTrafficSummary(168, message))
  ]);

  // 예외 없이 { error } 를 돌려준 핵심 집계도 실패한 소스로 본다. 이 값들의 0은 "정상"이 아니라 "모름"이다.
  const coreSources: Array<[string, any]> = [
    ["pendingApprovals", pendingApprovals],
    ["approvalGateSummary", approvalGateSummary],
    ["failedRuns", failedRuns],
    ["apiErrors", latestErrors],
    ["aiUsage", aiUsage],
    ["trafficSummary", trafficSummary]
  ];
  for (const [source, value] of coreSources) {
    if (value?.error && !degradedSources.some((item) => item.source === source)) {
      degradedSources.push({ source, message: AGENT_SOURCE_FAILURE_MESSAGE });
    }
  }

  const baseSeverity = getSeverity({
    pendingApprovals: pendingApprovals.count,
    staleApprovals: pendingApprovals.staleCount,
    highRiskApprovals: pendingApprovals.highRiskCount,
    failedRuns: failedRuns.count,
    apiErrors: latestErrors.total,
    aiCost: aiUsage.totalCostUsd,
    deploymentSeverity: deploymentHealth.severity,
    thresholds
  });
  // 일부 집계를 읽지 못했으면 정상으로 단정하지 않고 최소 주의로 올린다.
  const severity: typeof baseSeverity = baseSeverity === "ok" && degradedSources.length > 0 ? "warn" : baseSeverity;
  const nextActions = buildNextBestActions({
    pendingApprovals: pendingApprovals.count,
    staleApprovals: pendingApprovals.staleCount,
    highRiskApprovals: pendingApprovals.highRiskCount,
    failedRuns: failedRuns.count,
    apiErrors: latestErrors.total,
    aiCost: aiUsage.totalCostUsd,
    readinessStatus: readiness.status,
    rolloutStatus: rollout.status,
    deploymentHealth,
    contentRecommendations: contentPerformance.recommendations,
    thresholds
  });
  const operatingMode = buildAgentOperatingMode({
    severity,
    pendingApprovals: {
      count: pendingApprovals.count,
      highRiskCount: pendingApprovals.highRiskCount,
      staleCount: pendingApprovals.staleCount
    },
    failedRuns,
    apiErrors: latestErrors,
    aiUsage,
    readinessStatus: readiness.status,
    rolloutStatus: rollout.status,
    deploymentSeverity: deploymentHealth.severity,
    thresholds
  });
  const relatedMemories = buildRelatedMemoryHints({
    memories: memories.items || [],
    apiErrors: latestErrors,
    aiUsage,
    pendingApprovals,
    deploymentHealth
  });
  const memorySuggestions = buildMemorySuggestions({
    apiErrors: latestErrors,
    aiUsage,
    pendingApprovals,
    approvalGateSummary,
    failedRuns,
    deploymentHealth,
    memories
  });
  const improvementBacklog = buildAgentImprovementBacklog({
    readiness,
    rollout,
    pendingApprovals,
    approvalGateSummary,
    failedRuns,
    apiErrors: latestErrors,
    aiUsage,
    deploymentHealth,
    memories,
    latestReport,
    contentPerformance,
    thresholds
  });
  const dailyCheckout = buildAgentDailyCheckout({
    severity,
    pendingApprovals,
    approvalGateSummary,
    failedRuns,
    apiErrors: latestErrors,
    aiUsage,
    readinessStatus: readiness.status,
    rolloutStatus: rollout.status,
    deploymentSeverity: deploymentHealth.severity,
    nextActions,
    latestReport
  });
  const todayActionBoard = buildTodayActionBoard({
    dailyCheckout,
    nextActions,
    approvalGateSummary,
    pendingApprovals,
    latestReport
  });
  const toolCatalog = buildAgentToolCatalog();
  const capabilityMatrix = buildAgentCapabilityMatrix({
    readiness,
    rollout,
    toolCatalog,
    pendingApprovals,
    approvalGateSummary,
    latestMonitorSnapshot,
    dailyCheckout,
    todayActionBoard,
    memorySuggestions,
    contentPerformance,
    deploymentHealth,
    improvementBacklog
  });
  const operatorValue = buildOperatorValueScorecard({
    recentAgentActivity,
    approvalOutcomes,
    pendingApprovals,
    approvalGateSummary,
    failedRuns,
    apiErrors: latestErrors,
    aiUsage,
    latestMonitorSnapshot,
    todayActionBoard,
    memorySuggestions,
    relatedMemories,
    contentPerformance,
    capabilityMatrix
  });
  const growthRoadmap = buildAgentGrowthRoadmap({
    severity,
    operatingMode,
    dailyCheckout,
    todayActionBoard,
    nextActions,
    improvementBacklog,
    capabilityMatrix,
    operatorValue,
    approvalGateSummary,
    pendingApprovals,
    memorySuggestions
  });
  const ownerBrief = buildAgentOwnerBrief({
    severity,
    operatingMode,
    dailyCheckout,
    todayActionBoard,
    growthRoadmap,
    operatorValue,
    capabilityMatrix,
    pendingApprovals,
    approvalGateSummary,
    latestMonitorSnapshot,
    contentPerformance
  });
  const automationContracts = buildAgentAutomationContracts({
    pendingApprovals,
    monitorSeverity: latestMonitorSnapshot?.item?.severity || severity,
    deploymentConfigured: deploymentHealth.configured,
    discordConfigured: Boolean(process.env.DISCORD_WEBHOOK_URL)
  });
  const operatingSop = buildAgentOperatingSop({
    severity,
    operatingMode,
    dailyCheckout,
    nextActions,
    playbooks: buildCommandCenterPlaybooks({
      pendingApprovals: pendingApprovals.count,
      staleApprovals: pendingApprovals.staleCount,
      highRiskApprovals: pendingApprovals.highRiskCount,
      failedRuns: failedRuns.count,
      apiErrors: latestErrors.total,
      aiCost: aiUsage.totalCostUsd,
      deploymentSeverity: deploymentHealth.severity,
      thresholds
    }),
    pendingApprovals,
    approvalGateSummary,
    failedRuns,
    apiErrors: latestErrors,
    aiUsage,
    deploymentHealth,
    readiness,
    rollout,
    monitorTrend,
    contentPerformance
  });
  const riskRadar = buildAgentRiskRadar({
    severity,
    pendingApprovals,
    approvalGateSummary,
    failedRuns,
    apiErrors: latestErrors,
    aiUsage,
    deploymentHealth,
    readiness,
    rollout,
    monitorTrend,
    dailyCheckout,
    contentPerformance,
    memorySuggestions
  });
  const decisionTrace = buildAgentDecisionTrace({
    severity,
    operatingMode,
    ownerBrief,
    dailyCheckout,
    todayActionBoard,
    riskRadar,
    operatingSop,
    pendingApprovals,
    approvalGateSummary,
    failedRuns,
    apiErrors: latestErrors,
    aiUsage,
    latestMonitorSnapshot,
    monitorTrend,
    readiness,
    rollout,
    deploymentHealth,
    contentPerformance,
    memories,
    latestReport
  });
  const safetyAudit = buildAgentSafetyAudit({
    readiness,
    toolCatalog,
    approvalGateSummary,
    automationContracts,
    riskRadar,
    decisionTrace,
    pendingApprovals,
    latestMonitorSnapshot,
    deploymentHealth
  });
  const approvalAdvisor = buildAgentApprovalAdvisor({
    pendingApprovals,
    approvalGateSummary,
    safetyAudit,
    riskRadar
  });
  const missionControl = buildAgentMissionControl({
    severity,
    ownerBrief,
    todayActionBoard,
    approvalAdvisor,
    operatingSop,
    riskRadar,
    safetyAudit,
    dailyCheckout,
    nextActions,
    latestReport
  });
  const ownerInbox = buildAgentOwnerInbox({
    ownerBrief,
    missionControl,
    approvalAdvisor,
    safetyAudit,
    riskRadar,
    operatingSop,
    growthRoadmap,
    operatorValue,
    pendingApprovals
  });
  const outcomeReview = buildAgentOutcomeReview({
    recentAgentActivity,
    approvalOutcomes,
    pendingApprovals,
    approvalGateSummary,
    failedRuns,
    apiErrors: latestErrors,
    aiUsage,
    latestMonitorSnapshot,
    monitorTrend,
    dailyCheckout,
    missionControl,
    ownerInbox
  });
  const operatorCoach = buildAgentOperatorCoach({
    severity,
    outcomeReview,
    ownerInbox,
    missionControl,
    dailyCheckout,
    growthRoadmap,
    operatorValue,
    capabilityMatrix,
    contentPerformance
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
    missionControl,
    approvalAdvisor,
    monitorTrend,
    contentPerformance
  });
  const finalReadiness = buildAgentFinalReadiness({
    readiness,
    rollout,
    capabilityMatrix,
    automationContracts,
    safetyAudit,
    approvalAdvisor,
    missionControl,
    ownerInbox,
    outcomeReview,
    operatorCoach,
    launchKit,
    monitorTrend,
    contentPerformance,
    pendingApprovals,
    approvalGateSummary,
    toolCatalog
  });

  return {
    generatedAt: new Date().toISOString(),
    severity,
    // 병렬 조회 중 실패해 기본값으로 대체된 항목 목록(정상이면 빈 배열)
    degradedSources,
    operatingMode,
    dailyCheckout,
    todayActionBoard,
    latestRun,
    latestMonitorSnapshot,
    monitorTrend,
    pendingApprovals,
    approvalGateSummary,
    failedRuns,
    apiErrors: latestErrors,
    aiUsage,
    memories,
    latestReport,
    readiness,
    rollout: {
      status: rollout.status,
      checks: rollout.checks
    },
    deploymentHealth,
    contentPerformance,
    trafficSummary,
    trafficSummary7d,
    thresholds,
    toolCatalog,
    capabilityMatrix,
    operatorValue,
    growthRoadmap,
    ownerBrief,
    automationContracts,
    operatingSop,
    riskRadar,
    decisionTrace,
    safetyAudit,
    approvalAdvisor,
    missionControl,
    ownerInbox,
    outcomeReview,
    operatorCoach,
    launchKit,
    finalReadiness,
    playbooks: buildCommandCenterPlaybooks({
      pendingApprovals: pendingApprovals.count,
      staleApprovals: pendingApprovals.staleCount,
      highRiskApprovals: pendingApprovals.highRiskCount,
      failedRuns: failedRuns.count,
      apiErrors: latestErrors.total,
      aiCost: aiUsage.totalCostUsd,
      deploymentSeverity: deploymentHealth.severity,
      thresholds
    }),
    nextActions,
    relatedMemories,
    memorySuggestions,
    improvementBacklog,
    quickPrompts: [
      "오늘 운영 브리핑 해줘",
      "Admin Agent 준비 상태를 점검해줘",
      "승인 대기 작업을 impact 기준으로 검토해줘",
      "최근 24시간 사고 타임라인을 요약해줘",
      "운영 인수인계 패킷을 만들어줘",
      "최근 PUBG API 에러 원인을 분석해줘",
      "최근 AI 비용과 사용량을 분석해줘",
      "지난번 비슷한 장애 기억이 있는지 찾아줘",
      "Admin Agent가 최근 나에게 얼마나 도움이 됐는지 요약해줘",
      "Admin Agent 다음 업그레이드 로드맵을 정리해줘",
      "현재 자동화 계약과 무료 플랜 guardrail을 요약해줘",
      "Admin Agent가 지금 할 수 있는 일과 부족한 능력을 점검해줘",
      "오늘 운영에서 뭐부터 처리해야 하는지 액션 보드로 정리해줘",
      "오늘 운영 마감 가능한지 남은 위험과 내일 포커스를 점검해줘",
      "지금 상황에 맞는 운영 SOP를 단계별로 정리해줘",
      "다음에 터질 수 있는 운영 위험을 Risk Radar로 예측해줘",
      "에이전트가 왜 이렇게 판단했는지 Decision Trace로 근거를 보여줘",
      "Admin Agent 안전 감사 결과와 위험 승인 가능 여부를 점검해줘",
      "승인 대기 요청을 승인/거절/보류 권고로 나눠줘",
      "Mission Control로 지금 실행 순서를 정리해줘",
      "Owner Inbox로 내가 직접 볼 것과 위임할 것을 나눠줘",
      "Outcome Review로 최근 조치가 효과 있었는지 검토해줘",
      "Operator Coach로 지금 가장 좋은 질문 3개를 골라줘",
      "Agent Launch Kit으로 오늘부터 쓰는 법을 정리해줘",
      "Final Readiness로 최종형 에이전트 완성도와 남은 일을 점검해줘",
      "30초 운영자 브리핑으로 지금 할 일만 알려줘",
      "최근 monitor 추세가 좋아지는지 나빠지는지 알려줘",
      "최근 24시간 유저 활동을 요약해줘",
      "오늘 운영 브리핑을 리포트로 저장 요청해줘",
      "이번 주 운영 데이터 기반 게시글 초안을 만들어줘",
      "최근 게시글 성과를 분석하고 다음 콘텐츠를 추천해줘",
      "최근 Vercel 배포 실패 원인을 분석해줘"
    ]
  };
}

function buildRelatedMemoryHints(input: {
  memories: any[];
  apiErrors: { total: number; latest?: any[] };
  aiUsage: { totalCostUsd: number };
  pendingApprovals: { count: number; highRiskCount: number; staleCount: number };
  deploymentHealth: { severity: "ok" | "warn" | "critical" };
}) {
  const signals = [
    ...(input.apiErrors.total > 0 ? ["pubg", "api", "429", "quota", "error"] : []),
    ...(input.aiUsage.totalCostUsd > 0 ? ["ai", "cost", "token", "cache"] : []),
    ...(input.pendingApprovals.count > 0 ? ["approval", "cache", "publish", "report"] : []),
    ...(input.deploymentHealth.severity !== "ok" ? ["vercel", "deploy", "build"] : [])
  ];
  const uniqueSignals = Array.from(new Set(signals));
  const scored = input.memories
    .map((memory) => {
      const tags = Array.isArray(memory.metadata?.tags) ? memory.metadata.tags.join(" ") : "";
      const haystack = `${memory.title || ""} ${memory.body || ""} ${memory.category || ""} ${tags}`.toLowerCase();
      const score = uniqueSignals.reduce((sum, signal) => sum + (haystack.includes(signal) ? 1 : 0), 0);
      return { memory, score };
    })
    .filter((item) => item.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, 3)
    .map((item) => item.memory);

  return {
    query: uniqueSignals.slice(0, 4).join(" "),
    reason: scored.length
      ? "현재 운영 신호와 연결된 과거 memory입니다."
      : "현재 신호와 직접 매칭되는 memory가 없어 최근 memory를 참고 후보로 표시합니다.",
    items: scored.length ? scored : input.memories.slice(0, 2)
  };
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

async function fetchLatestMonitorSnapshot(supabase: any) {
  const { data, error } = await supabase
    .from("agent_runs")
    .select("id, status, message, summary, error, started_at, completed_at")
    .eq("system_prompt", "admin-agent-monitor")
    .eq("status", "completed")
    .order("completed_at", { ascending: false })
    .limit(1)
    .maybeSingle();

  if (error) return { item: null, error: error.message };
  if (!data) return { item: null };

  const snapshot = parseJson(data.summary);
  if (!snapshot) {
    return {
      item: null,
      error: "latest monitor summary is not valid JSON",
      run: data
    };
  }

  return {
    item: {
      ...snapshot,
      runId: data.id,
      runMessage: data.message,
      runStartedAt: data.started_at,
      runCompletedAt: data.completed_at
    }
  };
}

async function fetchMonitorTrend(supabase: any) {
  const { data, error } = await supabase
    .from("agent_runs")
    .select("summary, completed_at")
    .eq("system_prompt", "admin-agent-monitor")
    .eq("status", "completed")
    .order("completed_at", { ascending: false })
    .limit(7);

  if (error) {
    return {
      ...buildAgentMonitorTrend([]),
      error: error.message
    };
  }

  return buildAgentMonitorTrend(data || []);
}

async function countRecentFailedRuns(supabase: any, windowHours: number) {
  const since = new Date(Date.now() - windowHours * 60 * 60 * 1000).toISOString();
  return countRows(supabase, "agent_runs", "status", "failed", since);
}

async function fetchRecentApiErrors(supabase: any, windowHours: number) {
  const since = new Date(Date.now() - windowHours * 60 * 60 * 1000).toISOString();
  const { data, error } = await supabase
    .from("pubg_api_errors")
    .select("route, status, message, created_at")
    .gte("created_at", since)
    .order("created_at", { ascending: false })
    .limit(20);

  if (error) return { total: 0, error: error.message, latest: [] };
  return { total: data?.length || 0, latest: data || [] };
}

async function fetchRecentAiUsage(supabase: any, windowHours: number) {
  const since = new Date(Date.now() - windowHours * 60 * 60 * 1000).toISOString();
  const { data, error } = await supabase
    .from("ai_usage_logs")
    .select("cost_usd, model_name, analysis_type")
    .gte("created_at", since)
    .limit(500);

  if (error) return { totalRequests: 0, totalCostUsd: 0, error: error.message };
  const totalCostUsd = (data || []).reduce((sum: number, row: any) => sum + Number(row.cost_usd || 0), 0);
  return { totalRequests: data?.length || 0, totalCostUsd: Number(totalCostUsd.toFixed(6)) };
}

async function fetchRecentMemories(supabase: any) {
  const { data, error } = await supabase
    .from("agent_memories")
    .select("id, category, title, body, metadata, updated_at")
    .order("updated_at", { ascending: false })
    .limit(5);

  if (error) return { items: [], error: error.message };
  return { items: (data || []).filter((memory: any) => memory.metadata?.active !== false) };
}

async function fetchLatestReport(supabase: any) {
  const { data, error } = await supabase
    .from("agent_memories")
    .select("id, title, body, metadata, updated_at")
    .eq("category", "report")
    .order("updated_at", { ascending: false })
    .limit(1)
    .maybeSingle();

  if (error) return { item: null, error: error.message };
  if (data?.metadata?.active === false) return { item: null };
  return { item: data || null };
}

async function fetchContentPerformance(supabase: any) {
  try {
    const report = await buildContentPerformanceReport(supabase, { days: 30, limit: 30 });
    return {
      totalPosts: report.totalPosts,
      totalViews: report.totalViews,
      averageEngagementRate: report.averageEngagementRate,
      momentum: report.momentum,
      topPost: report.topByViews[0] || null,
      topCategory: report.categories[0] || null,
      lowEffortWins: report.lowEffortWins.slice(0, 3),
      weeklyPlan: report.weeklyPlan,
      recommendations: report.recommendations.slice(0, 3)
    };
  } catch (error: any) {
    return {
      totalPosts: 0,
      totalViews: 0,
      averageEngagementRate: 0,
      momentum: { score: 0, label: "no_data", reason: "콘텐츠 성과 조회 실패" },
      topPost: null,
      topCategory: null,
      lowEffortWins: [],
      weeklyPlan: [],
      recommendations: [],
      error: error.message || String(error)
    };
  }
}

async function fetchRecentAgentActivity(supabase: any, windowHours: number) {
  const since = new Date(Date.now() - windowHours * 60 * 60 * 1000).toISOString();
  const { data, error } = await supabase
    .from("agent_runs")
    .select("id, status, system_prompt, message, started_at, completed_at")
    .gte("started_at", since)
    .order("started_at", { ascending: false })
    .limit(200);

  if (error) {
    return {
      totalRuns: 0,
      completedRuns: 0,
      failedRuns: 0,
      monitorRuns: 0,
      error: error.message
    };
  }

  const rows = data || [];
  return {
    totalRuns: rows.length,
    completedRuns: rows.filter((run: any) => run.status === "completed").length,
    failedRuns: rows.filter((run: any) => run.status === "failed").length,
    monitorRuns: rows.filter((run: any) => run.system_prompt === "admin-agent-monitor" || String(run.message || "").includes("monitor")).length
  };
}

async function fetchRecentApprovalOutcomes(supabase: any, windowHours: number) {
  const since = new Date(Date.now() - windowHours * 60 * 60 * 1000).toISOString();
  const { data, error } = await supabase
    .from("agent_approvals")
    .select("id, status, action_type, decided_at, executed_at")
    .or(`decided_at.gte.${since},executed_at.gte.${since}`)
    .limit(200);

  if (error) {
    return {
      executed: 0,
      rejected: 0,
      failed: 0,
      error: error.message
    };
  }

  const rows = data || [];
  return {
    executed: rows.filter((approval: any) => approval.status === "executed").length,
    rejected: rows.filter((approval: any) => approval.status === "rejected").length,
    failed: rows.filter((approval: any) => approval.status === "failed").length
  };
}

async function countRows(supabase: any, table: string, column?: string, value?: string, since?: string) {
  let query = supabase.from(table).select("*", { count: "exact", head: true });
  if (column && value !== undefined) query = query.eq(column, value);
  if (since) query = query.gte("started_at", since);

  const { count, error } = await query;
  if (error) return { count: 0, error: error.message };
  return { count: count || 0 };
}

function getSeverity(input: { pendingApprovals: number; staleApprovals: number; highRiskApprovals: number; failedRuns: number; apiErrors: number; aiCost: number; deploymentSeverity: "ok" | "warn" | "critical"; thresholds: ReturnType<typeof getAgentThresholds> }) {
  if (input.failedRuns > 0 || input.apiErrors >= input.thresholds.apiErrorsCritical || input.aiCost > input.thresholds.aiCostCriticalUsd || input.deploymentSeverity === "critical" || input.staleApprovals > 0) return "critical";
  if (input.pendingApprovals > 0 || input.highRiskApprovals > 0 || input.apiErrors > 0 || input.aiCost > input.thresholds.aiCostWarnUsd || input.deploymentSeverity === "warn") return "warn";
  return "ok";
}

function buildCommandCenterPlaybooks(input: { pendingApprovals: number; staleApprovals: number; highRiskApprovals: number; failedRuns: number; apiErrors: number; aiCost: number; deploymentSeverity: "ok" | "warn" | "critical"; thresholds: ReturnType<typeof getAgentThresholds> }) {
  const alerts = [];
  if (input.failedRuns > 0) alerts.push({ type: "monitor_failed", severity: "critical" as const });
  if (input.apiErrors > 0) alerts.push({ type: "api_errors", severity: input.apiErrors >= input.thresholds.apiErrorsCritical ? "critical" as const : "warn" as const });
  if (input.aiCost > input.thresholds.aiCostWarnUsd) alerts.push({ type: "ai_cost", severity: input.aiCost > input.thresholds.aiCostCriticalUsd ? "critical" as const : "warn" as const });
  if (input.pendingApprovals > 0) alerts.push({ type: "pending_approvals", severity: input.staleApprovals > 0 ? "critical" as const : "warn" as const });
  if (input.deploymentSeverity !== "ok") alerts.push({ type: "deployment_failure", severity: input.deploymentSeverity });
  const matched = matchPlaybooks(alerts);
  return matched.length ? matched.slice(0, 3) : defaultPlaybooks().slice(0, 3);
}

function parseJson(value?: string | null) {
  if (!value) return null;
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}
