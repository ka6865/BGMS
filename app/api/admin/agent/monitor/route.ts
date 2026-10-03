import { NextResponse } from "next/server";
import { createClient as createSupabaseAdminClient } from "@supabase/supabase-js";
import { fetchApprovalGateSummary, fetchApprovalQueueSummary } from "@/lib/admin-agent/approvals";
import { buildAgentDailyCheckout } from "@/lib/admin-agent/daily-checkout";
import {
  auditProcessedTelemetryIdentity,
  buildProcessedTelemetryIdentityRepairPayload,
  type ProcessedTelemetryIdentityAudit
} from "@/lib/admin-agent/data-quality";
import { fetchVercelDeploymentHealth } from "@/lib/admin-agent/deployments";
import { buildAgentGrowthRoadmap } from "@/lib/admin-agent/growth-roadmap";
import { completeAgentRun, createAgentRun, createApprovalRequest, verifyAdminRole } from "@/lib/admin-agent/logging";
import { buildNextBestActions } from "@/lib/admin-agent/next-actions";
import { buildOperatorValueScorecard } from "@/lib/admin-agent/operator-value";
import { buildAgentOwnerBrief } from "@/lib/admin-agent/owner-brief";
import { buildApiErrorSummary, getApiErrorSeverity } from "@/lib/admin-agent/api-error-summary";
import { buildMatchCollectionProgress } from "@/lib/admin-agent/match-collection-progress";
import { matchPlaybooks } from "@/lib/admin-agent/playbooks";
import { getAgentThresholds } from "@/lib/admin-agent/thresholds";
import { buildTrafficSummary } from "@/lib/admin-agent/traffic-summary";
import { withAuthGuard } from "@/utils/supabase/guard";

const clean = (value: string | undefined) => (value || "").replace(/['";\s]+/g, "").trim();
type MonitorSeverity = "ok" | "warn" | "critical";
type MonitorAlert = {
  type: string;
  severity: MonitorSeverity;
  message: string;
  value?: unknown;
};

export async function GET(request: Request) {
  return runMonitor(request);
}

export async function POST(request: Request) {
  return runMonitor(request);
}

async function runMonitor(request: Request) {
  const authContext = await resolveMonitorAuth(request);
  if ("response" in authContext) return authContext.response;

  const { supabase, userId, source } = authContext;
  const runId = await createAgentRun(supabase, {
    userId: userId || null,
    message: source === "cron" ? "scheduled operational monitor" : "manual operational monitor",
    systemPrompt: "admin-agent-monitor"
  });

  try {
    const snapshot = await buildOperationalSnapshot(supabase, {
      runId,
      requestedBy: userId,
      source
    });
    const notification = await sendDiscordMonitorAlert(snapshot, supabase);
    const snapshotWithNotification = { ...snapshot, notification };
    await completeAgentRun(supabase, runId, {
      status: "completed",
      summary: JSON.stringify(snapshotWithNotification)
    });
    const deliveryFailed = notification.configured && !notification.sent
      && ["http_error", "receipt_missing", "timeout", "send_failed"].includes(notification.reason);
    return NextResponse.json(snapshotWithNotification, { status: deliveryFailed ? 502 : 200 });
  } catch (error: any) {
    const failureSnapshot = {
      generatedAt: new Date().toISOString(),
      severity: "critical",
      alerts: [{ type: "monitor_failed", severity: "critical", message: error.message || String(error) }],
      recommendations: ["운영 점검 API 자체가 실패했습니다. /admin/bot 또는 server logs에서 확인하세요."]
    };
    await sendDiscordMonitorAlert(failureSnapshot, supabase);
    await completeAgentRun(supabase, runId, {
      status: "failed",
      error: error.message || String(error)
    });
    return NextResponse.json({ error: error.message || "운영 점검 실패" }, { status: 500 });
  }
}

async function resolveMonitorAuth(request: Request) {
  const cronSecret = process.env.ADMIN_AGENT_CRON_SECRET || process.env.CRON_SECRET;
  const authorization = request.headers.get("authorization") || "";
  const headerSecret = request.headers.get("x-admin-agent-secret") || "";
  const providedSecret = authorization.replace(/^Bearer\s+/i, "") || headerSecret;

  if (cronSecret && providedSecret === cronSecret) {
    return {
      source: "cron" as const,
      userId: null,
      supabase: createSupabaseAdminClient(
        clean(process.env.NEXT_PUBLIC_SUPABASE_URL),
        clean(process.env.SUPABASE_SERVICE_ROLE_KEY)
      )
    };
  }

  const auth = await withAuthGuard();
  if (auth.error) return { response: auth.error };
  const adminError = await verifyAdminRole(auth.supabaseAdmin, auth.user.id);
  if (adminError) return { response: adminError };

  return {
    source: "manual" as const,
    userId: auth.user.id,
    supabase: auth.supabaseAdmin
  };
}

async function buildOperationalSnapshot(
  supabase: any,
  options: { runId?: string | null; requestedBy?: string | null; source: "cron" | "manual" }
) {
  const thresholds = getAgentThresholds();
  const since = new Date(Date.now() - thresholds.windowHours * 60 * 60 * 1000).toISOString();
  const [apiErrors, aiUsage, pendingApprovals, approvalGateSummary, telemetryRows, latestPubgStatus, deploymentHealth, trafficSummary, dataQualityAudit, matchCollection] = await Promise.all([
    fetchApiErrors(supabase, since),
    fetchAiUsage(supabase, since),
    fetchApprovalQueueSummary(supabase),
    fetchApprovalGateSummary(supabase),
    countTable(supabase, "processed_match_telemetry"),
    fetchLatestPubgStatus(supabase),
    fetchVercelDeploymentHealth(),
    buildTrafficSummary(supabase, thresholds.windowHours),
    fetchDataQualityAudit(supabase),
    fetchMatchCollectionProgress(supabase)
  ]);
  const dataQualityApproval = await ensureDataQualityApproval(supabase, dataQualityAudit, options);

  const alerts: MonitorAlert[] = [];
  if (dataQualityAudit.error) {
    alerts.push({
      type: "data_quality_audit_failed",
      severity: "warn",
      message: `전적 분석 identity 감사 실패: ${dataQualityAudit.error}`,
      value: dataQualityAudit
    });
  } else if (dataQualityAudit.missingPlatformColumnRows > 0) {
    alerts.push({
      type: "data_quality_schema_incomplete",
      severity: "critical",
      message: `processed_match_telemetry platform 컬럼 미확인 row ${dataQualityAudit.missingPlatformColumnRows}건. identity 정리 전 마이그레이션 확인 필요`,
      value: dataQualityAudit
    });
  }
  if (!dataQualityAudit.error && dataQualityAudit.mismatchCount > 0) {
    alerts.push({
      type: "data_quality_identity_mismatch",
      severity: dataQualityAudit.mismatchCount >= 500 ? "critical" : "warn",
      message: `processed_match_telemetry identity mismatch ${dataQualityAudit.mismatchCount}건 감지${dataQualityApproval.approvalId ? `, 승인 요청 ${dataQualityApproval.approvalId} 생성/유지` : ""}`,
      value: {
        ...dataQualityAudit,
        approval: dataQualityApproval
      }
    });
  }
  if (apiErrors.error) {
    alerts.push({
      type: "api_errors_unavailable",
      severity: "warn",
      message: "PUBG API 오류 집계를 불러오지 못했습니다. 오류 수가 0건이라는 뜻은 아닙니다."
    });
  }
  if (apiErrors.actionableTotal > 0) {
    alerts.push({
      type: "api_errors",
      severity: getApiErrorSeverity(apiErrors, thresholds.apiErrorsCritical),
      message: `최근 ${thresholds.windowHours}시간 PUBG API 확인 필요 ${apiErrors.actionableTotal}건 (서버 오류 ${apiErrors.serverErrorCount}건, 429 ${apiErrors.rateLimitedCount}건, 기타 요청 오류 ${apiErrors.otherClientErrorCount}건)`,
      value: {
        byStatus: apiErrors.byStatus,
        expected404And409: apiErrors.expectedCount
      }
    });
  }
  if (matchCollection.available && matchCollection.stalled) {
    alerts.push({
      type: "match_collection_stalled",
      severity: "warn",
      message: `매치 수집 대기 ${matchCollection.waitingCount}건 중 1시간 넘은 항목이 있고, 해당 항목이 등록된 뒤 저장 기록이 없습니다. 수집 정체 여부를 확인하세요.`,
      value: matchCollection
    });
  } else if (!matchCollection.available) {
    alerts.push({
      type: "match_collection_unavailable",
      severity: "warn",
      message: "매치 수집 대기열과 마지막 저장 시각을 확인하지 못했습니다. 대기 건수가 0이라는 뜻은 아닙니다."
    });
  }
  if (aiUsage.totalCostUsd > thresholds.aiCostWarnUsd) {
    alerts.push({
      type: "ai_cost",
      severity: aiUsage.totalCostUsd > thresholds.aiCostCriticalUsd ? "critical" : "warn",
      message: `최근 ${thresholds.windowHours}시간 AI 비용 $${aiUsage.totalCostUsd} 사용`,
      value: aiUsage.byModel
    });
  }
  if (pendingApprovals.count > 0) {
    alerts.push({
      type: "pending_approvals",
      severity: pendingApprovals.staleCount > 0 ? "critical" : "warn",
      message: pendingApprovals.staleCount > 0
        ? `${thresholds.approvalStaleHours}시간 이상 방치된 승인 대기 ${pendingApprovals.staleCount}건 존재`
        : `승인 대기 작업 ${pendingApprovals.count}건 존재`,
      value: {
        count: pendingApprovals.count,
        highRiskCount: pendingApprovals.highRiskCount,
        staleCount: pendingApprovals.staleCount,
        oldestAgeHours: pendingApprovals.oldestAgeHours
      }
    });
  }
  if (approvalGateSummary.blockCount > 0) {
    alerts.push({
      type: "approval_gate_block",
      severity: "critical",
      message: `Execution Gate block 승인 요청 ${approvalGateSummary.blockCount}건 존재`,
      value: {
        blockCount: approvalGateSummary.blockCount,
        sampledCount: approvalGateSummary.sampledCount,
        blocked: approvalGateSummary.items
          .filter((item) => item.gate.status === "block")
          .slice(0, 5)
          .map((item) => ({
            id: item.id,
            actionType: item.actionType,
            title: item.title,
            reasons: item.gate.reasons
          }))
      }
    });
  }
  if (latestPubgStatus?.remaining !== undefined && latestPubgStatus.remaining < thresholds.pubgQuotaWarnRemaining) {
    alerts.push({
      type: "pubg_quota",
      severity: latestPubgStatus.remaining < thresholds.pubgQuotaCriticalRemaining ? "critical" : "warn",
      message: `PUBG API remaining quota 낮음: ${latestPubgStatus.remaining}`,
      value: latestPubgStatus.remaining
    });
  }
  if (deploymentHealth.configured && deploymentHealth.severity !== "ok") {
    alerts.push({
      type: "deployment_failure",
      severity: deploymentHealth.severity,
      message: deploymentHealth.message,
      value: {
        latest: deploymentHealth.latest,
        recentFailures: deploymentHealth.recentFailures.length,
        error: deploymentHealth.error
      }
    });
  }
  const severity = getOverallSeverity(alerts);
  const nextActions = buildNextBestActions({
    pendingApprovals: pendingApprovals.count,
    staleApprovals: pendingApprovals.staleCount,
    highRiskApprovals: pendingApprovals.highRiskCount,
    failedRuns: 0,
    apiErrors: apiErrors.serverErrorCount + apiErrors.otherClientErrorCount,
    aiCost: aiUsage.totalCostUsd,
    deploymentHealth,
    contentRecommendations: [],
    thresholds
  });
  const dailyCheckout = buildAgentDailyCheckout({
    severity,
    pendingApprovals,
    approvalGateSummary,
    failedRuns: { count: 0 },
    apiErrors: { total: apiErrors.serverErrorCount + apiErrors.otherClientErrorCount },
    aiUsage,
    deploymentSeverity: deploymentHealth.severity,
    nextActions,
    latestReport: { item: null }
  });
  const recommendations = buildRecommendations(alerts, dailyCheckout);
  const playbooks = matchPlaybooks(alerts);
  const latestMonitorSnapshot = {
    item: {
      severity,
      alerts,
      approvalGateSummary,
      dailyCheckout,
      nextActions
    }
  };
  const operatorValue = buildOperatorValueScorecard({
    recentAgentActivity: {
      totalRuns: 1,
      completedRuns: 1,
      failedRuns: 0,
      monitorRuns: 1
    },
    approvalOutcomes: { executed: 0, rejected: 0, failed: 0 },
    pendingApprovals,
    approvalGateSummary,
    failedRuns: { count: 0 },
    apiErrors,
    aiUsage,
    latestMonitorSnapshot,
    todayActionBoard: null,
    relatedMemories: { items: [] },
    contentPerformance: undefined
  });
  const growthRoadmap = buildAgentGrowthRoadmap({
    severity,
    dailyCheckout,
    nextActions,
    operatorValue,
    approvalGateSummary,
    pendingApprovals,
    memorySuggestions: []
  });
  const ownerBrief = buildAgentOwnerBrief({
    severity,
    dailyCheckout,
    growthRoadmap,
    operatorValue,
    pendingApprovals,
    approvalGateSummary,
    latestMonitorSnapshot
  });

  return {
    generatedAt: new Date().toISOString(),
    windowHours: thresholds.windowHours,
    thresholds,
    severity,
    alerts,
    apiErrors,
    matchCollection,
    aiUsage,
    pendingApprovals,
    approvalGateSummary,
    dailyCheckout,
    nextActions,
    ownerBrief,
    operatorValue: {
      score: operatorValue.score,
      label: operatorValue.label,
      summary: operatorValue.summary,
      nextLeverage: operatorValue.nextLeverage.slice(0, 2)
    },
    growthRoadmap: {
      status: growthRoadmap.status,
      summary: growthRoadmap.summary,
      primaryPrompt: growthRoadmap.primaryPrompt,
      now: growthRoadmap.lanes.now.slice(0, 2),
      thisWeek: growthRoadmap.lanes.thisWeek.slice(0, 2)
    },
    cacheHealth: {
      processedTelemetryRows: typeof telemetryRows === "number" ? telemetryRows : 0,
      processedTelemetryRowsError: typeof telemetryRows === "object" ? telemetryRows.error : undefined,
      identityMismatchRows: dataQualityAudit.mismatchCount,
      identityAuditRecentDays: dataQualityAudit.recentDays,
      identityRepairApprovalId: dataQualityApproval.approvalId || null
    },
    dataQuality: {
      processedTelemetryIdentity: dataQualityAudit,
      approval: dataQualityApproval
    },
    trafficSummary,
    pubgApi: latestPubgStatus,
    deploymentHealth,
    playbooks,
    recommendations
  };
}

function getOverallSeverity(alerts: MonitorAlert[]): MonitorSeverity {
  if (alerts.some((alert) => alert.severity === "critical")) return "critical";
  if (alerts.some((alert) => alert.severity === "warn")) return "warn";
  return "ok";
}

function buildRecommendations(alerts: MonitorAlert[], dailyCheckout?: { status: string; summary: string; handoffPrompt: string }) {
  if (alerts.length === 0) return ["운영 상태가 정상 범위입니다."];
  return [
    ...alerts.map((alert) => {
      if (alert.type === "api_errors") return "PUBG API 에러가 감지되었습니다. /admin/bot에서 route/status별 원인을 확인하세요.";
      if (alert.type === "api_errors_unavailable") return "오류 집계가 확인되지 않았습니다. /admin/bot의 최근 실행 기록과 PUBG API 오류 기록을 확인하세요.";
      if (alert.type === "match_collection_stalled") return "전적 수집 대기열과 마지막 저장 시각을 확인하세요. 대기 건수만으로는 수집 완료 여부를 판단할 수 없습니다.";
      if (alert.type === "match_collection_unavailable") return "전적 수집 상태를 확인하지 못했습니다. Supabase 연결과 pubg_player_match_discovery 테이블 접근을 확인하세요.";
      if (alert.type === "ai_cost") return "AI 비용이 임계치를 넘었습니다. 고비용 모델/분석 타입을 점검하세요.";
      if (alert.type === "pending_approvals") return "승인 대기 작업이 있습니다. /admin/bot 승인 패널에서 오래된 작업과 high risk 작업부터 검토하세요.";
      if (alert.type === "approval_gate_block") return "Execution Gate block 요청이 있습니다. 필수 대상값 누락을 해결하기 전에는 승인하지 마세요.";
      if (alert.type === "data_quality_identity_mismatch") return "전적 분석 identity mismatch가 감지되었습니다. Agent가 만든 승인 요청의 impact와 샘플을 확인한 뒤 필요한 범위만 승인하세요.";
      if (alert.type === "data_quality_schema_incomplete") return "전적 분석 identity 정리 전에 Supabase platform 컬럼 마이그레이션 적용 여부를 먼저 확인하세요.";
      if (alert.type === "data_quality_audit_failed") return "데이터 품질 감사가 실패했습니다. Supabase env와 processed_match_telemetry 스키마를 확인하세요.";
      if (alert.type === "pubg_quota") return "PUBG API quota가 낮습니다. 강제 재분석/스크래핑을 잠시 보류하세요.";
      if (alert.type === "deployment_failure") return "Vercel 배포 상태가 불안정합니다. /admin/bot에서 배포 조회 후 실패 배포 로그를 확인하세요.";
      return alert.message;
    }),
    ...(dailyCheckout?.status === "blocked" ? [`Daily Checkout: ${dailyCheckout.summary} / 추천 프롬프트: ${dailyCheckout.handoffPrompt}`] : [])
  ];
}

function monitorSeverityLabel(severity: MonitorSeverity): string {
  if (severity === "critical") return "🚨 긴급";
  if (severity === "warn") return "⚠️ 주의";
  return "✅ 정상";
}

function cleanDiscordLine(value: unknown, fallback = "내용 없음"): string {
  const line = String(value ?? "")
    .replace(/[\r\n\t]+/g, " ")
    .replace(/\s{2,}/g, " ")
    .trim();
  return (line || fallback).slice(0, 280);
}

function buildMonitorDiscordContent(snapshot: any): string {
  const severity = (snapshot.severity || "warn") as MonitorSeverity;
  const alerts = Array.isArray(snapshot.alerts) ? snapshot.alerts.slice(0, 6) : [];
  const checkout = snapshot.dailyCheckout;
  const ownerBrief = snapshot.ownerBrief;
  const topAction = snapshot.nextActions?.[0];
  const gateBlockCount = snapshot.approvalGateSummary?.blockCount;
  const lines = alerts.map((alert: MonitorAlert) => (
    `- ${monitorSeverityLabel(alert.severity)}: ${cleanDiscordLine(alert.message)}`
  ));

  return [
    `**BGMS 운영 신호 점검 · ${monitorSeverityLabel(severity)}**`,
      `범위: 최근 ${Number.isFinite(snapshot.windowHours) ? snapshot.windowHours : "확인 불가"}시간 · CI 상태와 별도인 운영 점검입니다.`,
    "",
    "**현재 문제**",
    ...(lines.length ? lines : ["- 감지된 운영 경고가 없습니다."]),
    ...(checkout ? [
      "",
      `**운영 점검 참고값**: ${checkout.status === "blocked" ? "확인 필요" : checkout.status === "attention" ? "주의" : checkout.status === "clear" ? "양호" : "확인 불가"}`,
      Number.isFinite(checkout.score) ? `- 점검 참고 점수 ${checkout.score}/100` : "- 점검 점수: 확인 불가",
    ] : []),
    ...(snapshot.matchCollection?.available ? [
      "",
      `**전적 수집**: 대기 ${snapshot.matchCollection.waitingCount}건 · worker 처리 중 ${snapshot.matchCollection.runningCount}건 · 상태 ${snapshot.matchCollection.stalled ? "정체 의심" : snapshot.matchCollection.runningCount > 0 ? "처리 중" : snapshot.matchCollection.waitingCount > 0 ? "대기/재시도" : "대기 없음"}`,
      `- 마지막 저장: ${snapshot.matchCollection.lastSavedAt || "저장 기록 없음"}`,
      `- 마지막 저장/미취득 처리: ${snapshot.matchCollection.lastProgressAt || "처리 기록 없음"}`,
    ] : ["", "**전적 수집**: 상태 확인 불가 (대기 0건으로 단정하지 않음)" ]),
    ...(ownerBrief ? [
      "",
      `**운영 요약**: ${cleanDiscordLine(ownerBrief.headline)}`,
      ownerBrief.doNow?.prompt ? `- 지금 할 일: ${cleanDiscordLine(ownerBrief.doNow.prompt)}` : "",
    ] : []),
    ...(typeof gateBlockCount === "number" ? [
      "",
      `**승인 차단**: ${gateBlockCount}건 (대상과 영향 확인 전에는 승인하지 마세요.)`,
    ] : []),
    ...(topAction ? [
      "",
      "**다음 조치**",
      `- ${cleanDiscordLine(topAction.title)}`,
      topAction.prompt ? `- ${cleanDiscordLine(topAction.prompt)}` : "",
    ] : []),
    ...(snapshot.playbooks?.length ? [
      "",
      `**참고 절차**: ${cleanDiscordLine(snapshot.playbooks[0].title)}`,
    ] : []),
    "",
    "확인 위치: `/admin/bot` 최근 운영 점검·오류 기록",
  ].filter(Boolean).join("\n").slice(0, 1900);
}

async function sendDiscordMonitorAlert(snapshot: any, supabase?: any) {
  if (!snapshot?.alerts?.length) return { provider: "discord", configured: Boolean(process.env.DISCORD_WEBHOOK_URL), sent: false, reason: "no_alerts" };
  const webhookUrl = process.env.DISCORD_WEBHOOK_URL;
  if (!webhookUrl) return { provider: "discord", configured: false, sent: false, reason: "webhook_missing" };

  try {
    const cooldown = await findRecentDiscordAlert(supabase, snapshot);
    if (cooldown) {
      return {
        provider: "discord",
        configured: true,
        sent: false,
        reason: "cooldown",
        cooldownMinutes: cooldown.cooldownMinutes,
        lastSentAt: cooldown.lastSentAt
      };
    }

    const deliveryUrl = new URL(webhookUrl);
    deliveryUrl.searchParams.set("wait", "true");
    const response = await fetch(deliveryUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        content: buildMonitorDiscordContent(snapshot),
        allowed_mentions: { parse: [] }
      }),
      signal: AbortSignal.timeout(8_000)
    });
    if (!response.ok) {
      return {
        provider: "discord",
        configured: true,
        sent: false,
        reason: "http_error",
        httpStatus: response.status
      };
    }
    const receipt = await response.json().catch(() => null);
    if (typeof receipt?.id !== "string" || !receipt.id) {
      return { provider: "discord", configured: true, sent: false, reason: "receipt_missing", httpStatus: response.status };
    }
    return {
      provider: "discord",
      configured: true,
      sent: true,
      reason: "alert_sent",
      httpStatus: response.status,
      messageId: receipt.id,
      deliveredAt: new Date().toISOString()
    };
  } catch (error: any) {
    const timedOut = error?.name === "TimeoutError" || error?.name === "AbortError";
    console.warn("[ADMIN-AGENT] Discord monitor alert failed:", timedOut ? "timeout" : "request_failed");
    return { provider: "discord", configured: true, sent: false, reason: timedOut ? "timeout" : "send_failed" };
  }
}

async function fetchDataQualityAudit(supabase: any): Promise<ProcessedTelemetryIdentityAudit> {
  const recentDays = Number(process.env.DATA_QUALITY_AUDIT_RECENT_DAYS || 2);
  const maxRows = Number(process.env.DATA_QUALITY_AUDIT_MAX_ROWS || 1000);
  const targetLimit = Number(process.env.DATA_QUALITY_APPROVAL_TARGET_LIMIT || 50);

  try {
    return await auditProcessedTelemetryIdentity(supabase, {
      recentDays,
      maxRows,
      sampleLimit: 10,
      targetLimit
    });
  } catch (error: any) {
    return {
      mode: "dry-run",
      table: "processed_match_telemetry",
      recentDays,
      maxRows,
      scannedRows: 0,
      mismatchCount: 0,
      missingPlatformColumnRows: 0,
      deletionCandidateCount: 0,
      samples: [],
      deletionTargets: [],
      truncated: false,
      generatedAt: new Date().toISOString(),
      error: error.message || String(error)
    };
  }
}

async function ensureDataQualityApproval(
  supabase: any,
  audit: ProcessedTelemetryIdentityAudit,
  options: { runId?: string | null; requestedBy?: string | null; source: "cron" | "manual" }
) {
  if (audit.error || audit.mismatchCount === 0) {
    return { created: false, reason: audit.error ? "audit_failed" : "no_mismatch" };
  }
  if (audit.deletionTargets.length === 0) {
    return { created: false, reason: "no_deletion_targets" };
  }

  const { data: existing, error } = await supabase
    .from("agent_approvals")
    .select("id, created_at, payload")
    .eq("status", "pending")
    .eq("action_type", "repair_processed_telemetry_identity")
    .order("created_at", { ascending: false })
    .limit(1);

  if (!error && existing?.[0]) {
    return {
      created: false,
      approvalId: existing[0].id,
      reason: "pending_approval_exists",
      createdAt: existing[0].created_at
    };
  }

  const payload = buildProcessedTelemetryIdentityRepairPayload(
    audit,
    Number(process.env.DATA_QUALITY_APPROVAL_TARGET_LIMIT || 50)
  );
  const approvalId = await createApprovalRequest(supabase, {
    runId: options.runId,
    requestedBy: options.requestedBy || null,
    toolName: "agent_monitor_data_quality",
    actionType: "repair_processed_telemetry_identity",
    payload: {
      ...payload,
      source: options.source,
      monitorRunId: options.runId || null
    }
  });

  return {
    created: Boolean(approvalId),
    approvalId: approvalId || null,
    reason: approvalId ? "created" : "create_failed"
  };
}

async function findRecentDiscordAlert(supabase: any, snapshot: any) {
  const cooldownMinutes = numberEnv("ADMIN_AGENT_DISCORD_COOLDOWN_MINUTES", 60);
  if (!supabase || cooldownMinutes <= 0) return null;

  const since = new Date(Date.now() - cooldownMinutes * 60 * 1000).toISOString();
  const { data, error } = await supabase
    .from("agent_runs")
    .select("summary, completed_at")
    .eq("status", "completed")
    .gte("completed_at", since)
    .order("completed_at", { ascending: false })
    .limit(10);

  if (error) return null;
  const currentSignature = getAlertSignature(snapshot);
  const recent = (data || []).find((run: any) => {
    const parsed = parseJson(run.summary);
    return parsed?.notification?.sent === true
      && typeof parsed?.notification?.messageId === "string"
      && parsed?.severity === snapshot.severity
      && getAlertSignature(parsed) === currentSignature;
  });

  return recent ? { cooldownMinutes, lastSentAt: recent.completed_at || null } : null;
}

function getAlertSignature(snapshot: any) {
  return (snapshot?.alerts || [])
    .map((alert: any) => `${alert.type}:${alert.severity}`)
    .sort()
    .join("|");
}

function parseJson(value?: string | null) {
  if (!value) return null;
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

function numberEnv(name: string, fallback: number) {
  const value = Number(process.env[name]);
  return Number.isFinite(value) ? value : fallback;
}

async function fetchApiErrors(supabase: any, since: string) {
  const [countResult, clientResult, expectedResult404, expectedResult409, rateLimitResult, serverResult, latestResult] = await Promise.all([
    supabase
      .from("pubg_api_errors")
      .select("id", { count: "exact", head: true })
      .gte("created_at", since),
    supabase
      .from("pubg_api_errors")
      .select("id", { count: "exact", head: true })
      .gte("created_at", since)
      .gte("status", 400)
      .lt("status", 500),
    supabase
      .from("pubg_api_errors")
      .select("id", { count: "exact", head: true })
      .gte("created_at", since)
      .eq("status", 404)
      .eq("error_code", "PUBG_MATCH_NOT_FOUND")
      .eq("route", "/api/pubg/match")
      .eq("source", "user"),
    supabase
      .from("pubg_api_errors")
      .select("id", { count: "exact", head: true })
      .gte("created_at", since)
      .eq("status", 409)
      .eq("error_code", "PUBG_MATCH_ANALYSIS_IN_PROGRESS")
      .eq("route", "/api/pubg/match")
      .eq("source", "user"),
    supabase
      .from("pubg_api_errors")
      .select("id", { count: "exact", head: true })
      .gte("created_at", since)
      .eq("status", 429),
    supabase
      .from("pubg_api_errors")
      .select("id", { count: "exact", head: true })
      .gte("created_at", since)
      .gte("status", 500),
    supabase
      .from("pubg_api_errors")
      .select("route, status, error_code, failure_stage, source, created_at")
      .gte("created_at", since)
      .order("created_at", { ascending: false })
      .limit(200)
  ]);

  const error = countResult.error || clientResult.error || expectedResult404.error || expectedResult409.error || rateLimitResult.error || serverResult.error || latestResult.error;
  if (error) {
    return { total: 0, actionableTotal: 0, expectedCount: 0, rateLimitedCount: 0, serverErrorCount: 0, otherClientErrorCount: 0, byStatus: {}, error: "PUBG API error metrics unavailable" };
  }

  const data = latestResult.data || [];
  return {
    ...buildApiErrorSummary({
      total: typeof countResult.count === "number" ? countResult.count : data.length,
      expectedCount: (expectedResult404.count || 0) + (expectedResult409.count || 0),
      rateLimitedCount: rateLimitResult.count || 0,
      serverErrorCount: serverResult.count || 0,
      otherClientErrorCount: Math.max(0, (clientResult.count || 0) - (expectedResult404.count || 0) - (expectedResult409.count || 0) - (rateLimitResult.count || 0)),
      rows: data
    }),
    latest: data.slice(0, 5)
  };
}

async function fetchMatchCollectionProgress(supabase: any) {
  const activeStates = ["pending", "retry"];
  const now = new Date().toISOString();
  const [waiting, running, oldestWaiting, latestSettled, latestSaved, latestRetry, ready, expired, oldestExpired] = await Promise.all([
    supabase.from("pubg_player_match_discovery").select("match_id", { count: "exact", head: true }).in("state", activeStates),
    supabase.from("pubg_player_match_discovery").select("match_id", { count: "exact", head: true }).eq("state", "running").gt("lease_expires_at", now),
    supabase.from("pubg_player_match_discovery").select("first_seen_at").in("state", activeStates).lte("next_attempt_at", now).order("first_seen_at", { ascending: true }).limit(1),
    supabase.from("pubg_player_match_discovery").select("next_attempt_at, saved_at, state").in("state", ["saved", "unavailable"]).order("next_attempt_at", { ascending: false }).limit(1),
    supabase.from("pubg_player_match_discovery").select("saved_at").eq("state", "saved").order("saved_at", { ascending: false }).limit(1),
    supabase.from("pubg_player_match_discovery").select("next_attempt_at").eq("state", "retry").order("next_attempt_at", { ascending: false }).limit(1),
    supabase.from("pubg_player_match_discovery").select("match_id", { count: "exact", head: true }).in("state", activeStates).lte("next_attempt_at", now),
    supabase.from("pubg_player_match_discovery").select("match_id", { count: "exact", head: true }).eq("state", "running").lte("lease_expires_at", now),
    supabase.from("pubg_player_match_discovery").select("first_seen_at").eq("state", "running").lte("lease_expires_at", now).order("first_seen_at", { ascending: true }).limit(1)
  ]);
  if ([waiting, running, oldestWaiting, latestSettled, latestSaved, latestRetry, ready, expired, oldestExpired].some((result) => result.error)) {
    return { available: false as const, status: "unknown" as const };
  }

  const waitingCount = Number(waiting.count || 0) + Number(expired.count || 0);
  const runningCount = Number(running.count || 0);
  const oldestQueuedAt = [oldestWaiting.data?.[0]?.first_seen_at, oldestExpired.data?.[0]?.first_seen_at]
    .filter((value): value is string => typeof value === "string" && Number.isFinite(Date.parse(value)))
    .sort()[0] || null;
  const lastSavedAt = latestSaved.data?.[0]?.saved_at || null;
  const lastProgressAt = latestSettled.data?.[0]?.next_attempt_at || null;
  const lastRetryScheduledAt = latestRetry.data?.[0]?.next_attempt_at || null;
  return buildMatchCollectionProgress({
    waitingCount,
    runningCount,
    readyCount: Number(ready.count || 0) + Number(expired.count || 0),
    oldestQueuedAt,
    lastSavedAt,
    lastProgressAt,
    lastRetryScheduledAt
  });
}

async function fetchAiUsage(supabase: any, since: string) {
  const { data, error } = await supabase
    .from("ai_usage_logs")
    .select("model_name, analysis_type, cost_usd, prompt_tokens, completion_tokens, created_at")
    .gte("created_at", since)
    .limit(1000);

  if (error) return { totalRequests: 0, totalCostUsd: 0, error: error.message };
  const totalCostUsd = (data || []).reduce((sum: number, row: any) => sum + Number(row.cost_usd || 0), 0);
  const byModel: Record<string, number> = {};
  (data || []).forEach((row: any) => {
    const key = row.model_name || "unknown";
    byModel[key] = Number(((byModel[key] || 0) + Number(row.cost_usd || 0)).toFixed(6));
  });
  return {
    totalRequests: data?.length || 0,
    totalCostUsd: Number(totalCostUsd.toFixed(6)),
    byModel
  };
}

async function fetchLatestPubgStatus(supabase: any) {
  const { data, error } = await supabase
    .from("pubg_api_status")
    .select("api_limit, remaining, reset_at, updated_at")
    .order("updated_at", { ascending: false })
    .limit(1)
    .maybeSingle();

  if (error) return { error: error.message };
  return data || null;
}

async function countTable(supabase: any, table: string, column?: string, value?: string) {
  let query = supabase
    .from(table)
    .select("*", { count: "exact", head: true });
  if (column && value !== undefined) query = query.eq(column, value);

  const { count, error } = await query;
  if (error) return { count: 0, error: error.message };
  return { count: count || 0 };
}
