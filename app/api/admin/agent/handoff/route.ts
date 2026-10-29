import { NextResponse } from "next/server";
import { buildAgentHandoffPacket } from "@/lib/admin-agent/handoff";
import { approvalCreationFailedResponse, createApprovalRequest, verifyAdminRole } from "@/lib/admin-agent/logging";
import { withAuthGuard } from "@/utils/supabase/guard";

export async function GET(request: Request) {
  const auth = await withAuthGuard();
  if (auth.error) return auth.error;
  const { supabaseAdmin: supabase, user } = auth;

  const adminError = await verifyAdminRole(supabase, user.id);
  if (adminError) return adminError;

  const { searchParams } = new URL(request.url);
  const packet = await buildAgentHandoffPacket(supabase, {
    hours: Number(searchParams.get("hours") || 24)
  });

  if (searchParams.get("format") === "markdown") {
    return NextResponse.json({ markdown: packet.markdown, packet });
  }

  return NextResponse.json({ packet });
}

export async function POST(request: Request) {
  const auth = await withAuthGuard();
  if (auth.error) return auth.error;
  const { supabaseAdmin: supabase, user } = auth;

  const adminError = await verifyAdminRole(supabase, user.id);
  if (adminError) return adminError;

  const body = await request.json().catch(() => ({}));
  const packet = await buildAgentHandoffPacket(supabase, {
    hours: Number(body.hours || 24)
  });
  const title = body.title || `BGMS 운영 인수인계 ${new Date().toLocaleDateString("ko-KR")}`;
  const approvalId = await createApprovalRequest(supabase, {
    requestedBy: user.id,
    toolName: "request_handoff_report",
    actionType: "save_agent_report",
    payload: {
      category: "report",
      title,
      body: packet.markdown,
      metadata: {
        source: "handoff-packet",
        active: true,
        reason: body.reason || "운영 인수인계 기록 보존",
        handoff: {
          generatedAt: packet.generatedAt,
          windowHours: packet.windowHours,
          severity: packet.severity,
          pendingApprovals: {
            count: packet.pendingApprovals.count,
            highRiskCount: packet.pendingApprovals.highRiskCount,
            staleCount: packet.pendingApprovals.staleCount
          },
          incidentSummary: packet.incidentTimeline.summary
        }
      }
    }
  });

  if (!approvalId) return approvalCreationFailedResponse("운영 인수인계 리포트 저장", { packet });

  return NextResponse.json({
    success: true,
    approvalId,
    packet
  });
}
