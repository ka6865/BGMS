import { NextResponse } from "next/server";
import { buildContentDraft } from "@/lib/admin-agent/content";
import { approvalCreationFailedResponse, createApprovalRequest, verifyAdminRole } from "@/lib/admin-agent/logging";
import { withAuthGuard } from "@/utils/supabase/guard";

export async function GET(request: Request) {
  const auth = await withAuthGuard();
  if (auth.error) return auth.error;
  const { supabaseAdmin: supabase, user } = auth;

  const adminError = await verifyAdminRole(supabase, user.id);
  if (adminError) return adminError;

  const { searchParams } = new URL(request.url);
  const draft = await buildContentDraft(supabase, {
    draftType: searchParams.get("draftType") || undefined,
    hours: Number(searchParams.get("hours") || 168),
    tone: searchParams.get("tone") || undefined
  });

  return NextResponse.json({ draft });
}

export async function POST(request: Request) {
  const auth = await withAuthGuard();
  if (auth.error) return auth.error;
  const { supabaseAdmin: supabase, user } = auth;

  const adminError = await verifyAdminRole(supabase, user.id);
  if (adminError) return adminError;

  const body = await request.json().catch(() => ({}));
  const draft = await buildContentDraft(supabase, {
    draftType: body.draftType,
    hours: Number(body.hours || 168),
    tone: body.tone
  });

  const approvalId = await createApprovalRequest(supabase, {
    requestedBy: user.id,
    toolName: "request_content_post",
    actionType: "create_board_post",
    payload: {
      title: body.title || draft.title,
      content: body.content || draft.contentHtml,
      category: draft.category,
      reason: body.reason || "운영 데이터 기반 콘텐츠 초안 발행 요청",
      draft
    }
  });

  if (!approvalId) return approvalCreationFailedResponse("콘텐츠 초안 저장", { draft });

  return NextResponse.json({ success: true, approvalId, draft });
}
