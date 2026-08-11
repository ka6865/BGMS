import { NextResponse } from "next/server";
import { createClient as createAdminClient } from "@supabase/supabase-js";
import { withAuthGuard } from "@/utils/supabase/guard";

/**
 * @fileoverview 신고 관리 API (어드민 전용)
 *
 * GET: 신고 대기 목록 조회
 * POST: 신고 판정 실행 (블라인드 / 기각 / IP 차단)
 */

const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL!;
const supabaseServiceKey = process.env.SUPABASE_SERVICE_ROLE_KEY!;

async function verifyAdmin(userId: string, supabaseAdmin: any): Promise<boolean> {
  const { data } = await supabaseAdmin
    .from("profiles")
    .select("role")
    .eq("id", userId)
    .single();
  return data?.role === "admin";
}

// 신고 대기 목록 조회
export async function GET(request: Request) {
  try {
    const auth = await withAuthGuard();
    if (auth.error) return auth.error;
    const { user } = auth;

    const supabaseAdmin = createAdminClient(supabaseUrl, supabaseServiceKey);
    const isAdmin = await verifyAdmin(user.id, supabaseAdmin);
    if (!isAdmin) {
      return NextResponse.json({ error: "관리자 권한이 필요합니다." }, { status: 403 });
    }

    const { searchParams } = new URL(request.url);
    const status = searchParams.get("status") || "pending";

    const { data, error } = await supabaseAdmin
      .from("reports")
      .select("*")
      .eq("status", status)
      .order("created_at", { ascending: false });

    if (error) {
      console.error("[Admin Reports GET] DB error:", error);
      return NextResponse.json({ error: "신고 목록 조회 중 오류가 발생했습니다." }, { status: 500 });
    }

    const reports = data ?? [];
    const reporterIds = Array.from(
      new Set(
        reports
          .map((report: any) => report.reporter_id)
          .filter((reporterId: unknown): reporterId is string => typeof reporterId === "string"),
      ),
    );

    let reporterNames = new Map<string, string>();
    if (reporterIds.length > 0) {
      const { data: profiles, error: profileError } = await supabaseAdmin
        .from("profiles")
        .select("id, nickname")
        .in("id", reporterIds);

      if (profileError) {
        console.warn("[Admin Reports GET] reporter profile lookup failed:", profileError.message);
      } else {
        reporterNames = new Map(
          (profiles ?? [])
            .filter((profile: any) => profile.id)
            .map((profile: any) => [profile.id, profile.nickname ?? ""]),
        );
      }
    }

    const enrichedReports = reports.map((report: any) => ({
      ...report,
      reporter_nickname: report.reporter_id
        ? reporterNames.get(report.reporter_id) || null
        : null,
    }));

    return NextResponse.json({ success: true, data: enrichedReports });
  } catch (err: any) {
    console.error("[Admin Reports GET] Unexpected error:", err);
    return NextResponse.json({ error: "서버 오류가 발생했습니다." }, { status: 500 });
  }
}

// 신고 판정 실행
export async function POST(request: Request) {
  try {
    const auth = await withAuthGuard();
    if (auth.error) return auth.error;
    const { user } = auth;

    const supabaseAdmin = createAdminClient(supabaseUrl, supabaseServiceKey);
    const isAdmin = await verifyAdmin(user.id, supabaseAdmin);
    if (!isAdmin) {
      return NextResponse.json({ error: "관리자 권한이 필요합니다." }, { status: 403 });
    }

    const body = await request.json();
    const { reportId, action, adminNote } = body;
    // action: 'blind' | 'dismiss' | 'ban_ip'

    if (!reportId || !action) {
      return NextResponse.json({ error: "필수 입력값이 누락되었습니다." }, { status: 400 });
    }
    if (!["blind", "dismiss", "ban_ip"].includes(action)) {
      return NextResponse.json({ error: "유효하지 않은 액션입니다." }, { status: 400 });
    }

    // 신고 정보 조회
    const { data: report, error: fetchError } = await supabaseAdmin
      .from("reports")
      .select("*")
      .eq("id", Number(reportId))
      .single();

    if (fetchError || !report) {
      return NextResponse.json({ error: "신고를 찾을 수 없습니다." }, { status: 404 });
    }

    if (action === "blind") {
      // 게시글 블라인드: status를 'hidden'으로 변경
      if (report.target_type === "post") {
        await supabaseAdmin
          .from("posts")
          .update({ status: "hidden" })
          .eq("id", report.target_id);
      }
      // 댓글 블라인드: content를 마스킹 처리
      if (report.target_type === "comment") {
        await supabaseAdmin
          .from("comments")
          .update({ content: "[관리자에 의해 숨김 처리된 댓글입니다.]" })
          .eq("id", report.target_id);
      }
      // 관련 신고 모두 resolved 처리
      await supabaseAdmin
        .from("reports")
        .update({ status: "resolved", admin_note: adminNote || "블라인드 처리" })
        .eq("target_type", report.target_type)
        .eq("target_id", report.target_id);
    }

    if (action === "dismiss") {
      await supabaseAdmin
        .from("reports")
        .update({ status: "dismissed", admin_note: adminNote || "기각" })
        .eq("target_type", report.target_type)
        .eq("target_id", report.target_id);
    }

    if (action === "ban_ip") {
      // 대상 글/댓글의 IP 조회
      const table = report.target_type === "post" ? "posts" : "comments";
      const { data: target } = await supabaseAdmin
        .from(table)
        .select("ip_address")
        .eq("id", report.target_id)
        .single();

      if (!target?.ip_address) {
        return NextResponse.json({ error: "차단할 IP 정보가 없습니다." }, { status: 400 });
      }

      // IP 차단 목록에 추가 (중복 시 무시)
      await supabaseAdmin
        .from("ip_blacklist")
        .upsert([{ ip_address: target.ip_address, reason: adminNote || "신고 누적으로 인한 차단" }], { onConflict: "ip_address" });

      // 관련 신고 resolved 처리
      await supabaseAdmin
        .from("reports")
        .update({ status: "resolved", admin_note: adminNote || "IP 차단 처리" })
        .eq("target_type", report.target_type)
        .eq("target_id", report.target_id);
    }

    return NextResponse.json({ success: true });
  } catch (err: any) {
    console.error("[Admin Reports POST] Unexpected error:", err);
    return NextResponse.json({ error: "서버 오류가 발생했습니다." }, { status: 500 });
  }
}
