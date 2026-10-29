import { NextResponse } from "next/server";
import { buildIncidentTimeline } from "@/lib/admin-agent/incident-timeline";
import { approvalCreationFailedResponse, createApprovalRequest, verifyAdminRole } from "@/lib/admin-agent/logging";
import { withAuthGuard } from "@/utils/supabase/guard";

export async function GET(request: Request) {
  const auth = await withAuthGuard();
  if (auth.error) return auth.error;
  const { supabaseAdmin: supabase, user } = auth;

  const adminError = await verifyAdminRole(supabase, user.id);
  if (adminError) return adminError;

  const { searchParams } = new URL(request.url);
  const timeline = await buildIncidentTimeline(supabase, {
    hours: Number(searchParams.get("hours") || 24),
    limit: Number(searchParams.get("limit") || 80)
  });

  if (searchParams.get("format") === "markdown") {
    return NextResponse.json({ markdown: timeline.markdown, timeline });
  }

  return NextResponse.json({ timeline });
}

export async function POST(request: Request) {
  const auth = await withAuthGuard();
  if (auth.error) return auth.error;
  const { supabaseAdmin: supabase, user } = auth;

  const adminError = await verifyAdminRole(supabase, user.id);
  if (adminError) return adminError;

  const body = await request.json().catch(() => ({}));
  const timeline = await buildIncidentTimeline(supabase, {
    hours: Number(body.hours || 24),
    limit: Number(body.limit || 80)
  });
  const title = body.title || `BGMS 사고 타임라인 ${new Date().toLocaleDateString("ko-KR")}`;
  const approvalId = await createApprovalRequest(supabase, {
    requestedBy: user.id,
    toolName: "request_incident_timeline_report",
    actionType: "save_agent_report",
    payload: {
      category: "report",
      title,
      body: timeline.markdown,
      metadata: {
        source: "incident-timeline",
        active: true,
        reason: body.reason || "운영 사고 타임라인 보존",
        timeline: {
          generatedAt: timeline.generatedAt,
          windowHours: timeline.windowHours,
          severity: timeline.severity,
          summary: timeline.summary
        }
      }
    }
  });

  if (!approvalId) return approvalCreationFailedResponse("사고 타임라인 리포트 저장", { timeline });

  return NextResponse.json({
    success: true,
    approvalId,
    timeline
  });
}
