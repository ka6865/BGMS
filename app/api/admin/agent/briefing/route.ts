import { NextResponse } from "next/server";
import { buildAgentBriefing, renderBriefingText } from "@/lib/admin-agent/briefing";
import { approvalCreationFailedResponse, createApprovalRequest, verifyAdminRole } from "@/lib/admin-agent/logging";
import { withAuthGuard } from "@/utils/supabase/guard";

export async function GET(request: Request) {
  const auth = await withAuthGuard();
  if (auth.error) return auth.error;
  const { supabaseAdmin: supabase, user } = auth;

  const adminError = await verifyAdminRole(supabase, user.id);
  if (adminError) return adminError;

  const { searchParams } = new URL(request.url);
  const hours = clampBriefingHours(searchParams.get("hours"));
  const briefing = await buildAgentBriefing(supabase, hours);

  return NextResponse.json({
    briefing,
    text: renderBriefingText(briefing)
  });
}

export async function POST(request: Request) {
  const auth = await withAuthGuard();
  if (auth.error) return auth.error;
  const { supabaseAdmin: supabase, user } = auth;

  const adminError = await verifyAdminRole(supabase, user.id);
  if (adminError) return adminError;

  const body = await request.json().catch(() => ({}));
  const hours = clampBriefingHours(body.hours ?? 24);
  const briefing = body.snapshot ? null : await buildAgentBriefing(supabase, hours);
  const text = body.snapshot ? renderMonitorSnapshotReport(body.snapshot) : renderBriefingText(briefing!);
  const title = body.title || `BGMS 운영 브리핑 ${new Date().toLocaleDateString("ko-KR")}`;

  const approvalId = await createApprovalRequest(supabase, {
    requestedBy: user.id,
    toolName: "request_agent_briefing_report",
    actionType: "save_agent_report",
    payload: {
      category: "report",
      title,
      body: text,
      metadata: {
        source: body.snapshot ? "manual-monitor-snapshot" : "briefing-api",
        active: true,
        briefing,
        snapshot: body.snapshot || null
      }
    }
  });

  if (!approvalId) return approvalCreationFailedResponse("운영 브리핑 리포트 저장", { briefing, text });

  return NextResponse.json({ success: true, approvalId, briefing, text });
}

// 브리핑 조회 범위는 1시간~7일(168시간)로 제한한다. 숫자가 아니면 기본 24시간을 쓴다.
function clampBriefingHours(value: unknown) {
  const parsed = Number(value ?? 24);
  if (!Number.isFinite(parsed)) return 24;
  return Math.min(Math.max(Math.floor(parsed), 1), 168);
}

function renderMonitorSnapshotReport(snapshot: any) {
  const alerts = Array.isArray(snapshot.alerts) ? snapshot.alerts : [];
  const recommendations = Array.isArray(snapshot.recommendations) ? snapshot.recommendations : [];
  const lines = [
    `[BGMS 수동 운영 점검] ${snapshot.severity || "unknown"}`,
    `- 점검 시각: ${snapshot.generatedAt || new Date().toISOString()}`,
    `- 기준: 최근 ${snapshot.windowHours || "unknown"}시간`,
    `- 상태: ${snapshot.severity || "unknown"}`,
    `- Alert: ${alerts.length}건`
  ];
  const gate = snapshot.approvalGateSummary || {};
  const checkout = snapshot.dailyCheckout || {};
  const topAction = Array.isArray(snapshot.nextActions) ? snapshot.nextActions[0] : null;

  if (snapshot.approvalGateSummary || snapshot.dailyCheckout || topAction) {
    lines.push("", "Operational Decision:");
    if (snapshot.approvalGateSummary) {
      lines.push(`- Execution Gate: pass/review/block ${Number(gate.passCount || 0)}/${Number(gate.reviewCount || 0)}/${Number(gate.blockCount || 0)}`);
    }
    if (snapshot.dailyCheckout) {
      lines.push(`- Daily Checkout: ${checkout.label || checkout.status || "unknown"} (${Number(checkout.score || 0)}/100)`);
      if (checkout.summary) lines.push(`- Checkout Summary: ${checkout.summary}`);
    }
    if (topAction) {
      lines.push(`- Top Action: ${topAction.title || topAction.id || "unknown"} (${topAction.priority || "unknown"}, score ${topAction.urgencyScore ?? "-"})`);
    }
  }

  if (alerts.length) {
    lines.push("", "Alerts:");
    alerts.forEach((alert: any) => lines.push(`- [${alert.severity || "unknown"}] ${alert.message || alert.type || "unknown"}`));
  }

  if (recommendations.length) {
    lines.push("", "Recommendations:");
    recommendations.forEach((recommendation: string) => lines.push(`- ${recommendation}`));
  }

  return lines.join("\n");
}
