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
    return NextResponse.json(snapshotWithNotification);
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
  const [apiErrors, aiUsage, pendingApprovals, approvalGateSummary, telemetryRows, latestPubgStatus, deploymentHealth, trafficSummary, dataQualityAudit] = await Promise.all([
    fetchApiErrors(supabase, since),
    fetchAiUsage(supabase, since),
    fetchApprovalQueueSummary(supabase),
    fetchApprovalGateSummary(supabase),
    countTable(supabase, "processed_match_telemetry"),
    fetchLatestPubgStatus(supabase),
    fetchVercelDeploymentHealth(),
    buildTrafficSummary(supabase, thresholds.windowHours),
    fetchDataQualityAudit(supabase)
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
  if (apiErrors.total > 0) {
    alerts.push({
      type: "api_errors",
      severity: apiErrors.total >= thresholds.apiErrorsCritical ? "critical" : "warn",
      message: `최근 ${thresholds.windowHours}시간 PUBG API 에러 ${apiErrors.total}건 감지`,
      value: apiErrors.byStatus
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
    apiErrors: apiErrors.total,
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
    apiErrors,
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
    `**BGMS 운영 점검 알림 · ${monitorSeverityLabel(severity)}**`,
    "",
    "**현재 문제**",
    ...(lines.length ? lines : ["- 감지된 운영 경고가 없습니다."]),
    ...(checkout ? [
      "",
      `**마감 상태**: ${cleanDiscordLine(checkout.label || checkout.status)} (${checkout.score ?? "-"}/100)`,
      checkout.summary ? `- ${cleanDiscordLine(checkout.summary)}` : "",
    ] : []),
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
    "확인 위치: `/admin/bot` 승인 패널 및 최근 실행 기록",
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

    await fetch(webhookUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        content: buildMonitorDiscordContent(snapshot)
      })
    });
    return { provider: "discord", configured: true, sent: true, reason: "alert_sent" };
  } catch (error: any) {
    console.warn("[ADMIN-AGENT] Discord monitor alert failed:", error.message || error);
    return { provider: "discord", configured: true, sent: false, reason: "send_failed", error: error.message || String(error) };
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
  const [countResult, latestResult] = await Promise.all([
    supabase
      .from("pubg_api_errors")
      .select("id", { count: "exact", head: true })
      .gte("created_at", since),
    supabase
      .from("pubg_api_errors")
      .select("route, status, message, created_at")
      .gte("created_at", since)
      .order("created_at", { ascending: false })
      .limit(200)
  ]);

  if (countResult.error || latestResult.error) {
    return { total: 0, error: countResult.error?.message || latestResult.error?.message };
  }

  const data = latestResult.data || [];
  const byStatus: Record<string, number> = {};
  data.forEach((row: any) => {
    const key = String(row.status || "unknown");
    byStatus[key] = (byStatus[key] || 0) + 1;
  });
  return {
    total: typeof countResult.count === "number" ? countResult.count : data.length,
    byStatus,
    latest: data.slice(0, 5)
  };
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
