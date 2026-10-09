import { NextResponse } from "next/server";
import { verifyAdminRole } from "@/lib/admin-agent/logging";
import { redactForAgentLog } from "@/lib/admin-agent/redaction";
import { withAuthGuard } from "@/utils/supabase/guard";

type RouteContext = {
  params: Promise<{ id: string }>;
};

export async function POST(request: Request, context: RouteContext) {
  const auth = await withAuthGuard();
  if (auth.error) return auth.error;
  const { supabaseAdmin: supabase, user } = auth;

  const adminError = await verifyAdminRole(supabase, user.id);
  if (adminError) return adminError;

  const { id } = await context.params;
  const { data: approval, error: lookupError } = await supabase
    .from("agent_approvals")
    .select("status")
    .eq("id", id)
    .single();

  if (lookupError || !approval) {
    return NextResponse.json({ error: lookupError?.message || "승인 요청을 찾을 수 없습니다." }, { status: 404 });
  }

  if (approval.status !== "pending") {
    return NextResponse.json({ error: "이미 처리된 승인 요청입니다." }, { status: 409 });
  }

  const body = await request.json().catch(() => ({}));
  const reason = String(body.reason || "").trim();
  const result = {
    rejected: true,
    rejectedBy: user.id,
    rejectedAt: new Date().toISOString(),
    reason: reason || "사유 미입력"
  };

  const { data: rejected, error } = await supabase
    .from("agent_approvals")
    .update({
      status: "rejected",
      approved_by: user.id,
      decided_at: result.rejectedAt,
      result: JSON.stringify(redactForAgentLog(result))
    })
    .eq("id", id)
    .eq("status", "pending")
    .select("id")
    .maybeSingle();

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  if (!rejected) return NextResponse.json({ error: "이미 처리된 승인 요청입니다." }, { status: 409 });
  return NextResponse.json({ success: true, result });
}
