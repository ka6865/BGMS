import { NextResponse } from "next/server";
import { createClient as createSupabaseServerClient } from "@/utils/supabase/server";
import { createClient as createSupabaseAdminClient } from "@supabase/supabase-js";

const clean = (val: string | undefined) => (val || '').replace(/['";\s]+/g, '').trim();
const EDITABLE_SETTINGS = new Set(["notice_display_days", "notice_active_id"]);

// 1. 관리자 권한 검증 및 세션 체크
async function verifyAdmin() {
  const supabaseServer = await createSupabaseServerClient();
  const { data: { user } } = await supabaseServer.auth.getUser();
  if (!user) return null;

  const { data: profile } = await supabaseServer
    .from("profiles")
    .select("role")
    .eq("id", user.id)
    .single();
  
  if (profile?.role === "admin") {
    return { user };
  }
  return null;
}

// 2. GET: 현재 설정 리스트 조회 (비관리자도 읽기 가능)
export async function GET() {
  try {
    const supabaseServer = await createSupabaseServerClient();
    const { data: settings, error } = await supabaseServer
      .from("system_settings")
      .select("*")
      .neq("key", "private_players_list");

    if (error) {
      return NextResponse.json({ error: error.message }, { status: 500 });
    }

    // 배열 형태의 설정을 키-값 맵으로 변환하여 반환
    const settingsMap = (settings || []).reduce((acc: any, cur: any) => {
      acc[cur.key] = cur.value;
      return acc;
    }, {});

    return NextResponse.json({ success: true, settings: settingsMap });
  } catch (error: any) {
    return NextResponse.json({ error: error.message || "Internal Server Error" }, { status: 500 });
  }
}

// 3. POST: 전역 설정 변경 (관리자 전용)
export async function POST(request: Request) {
  try {
    const adminContext = await verifyAdmin();
    if (!adminContext) {
      return NextResponse.json({ error: "🔒 관리자 권한이 없습니다." }, { status: 403 });
    }

    const body = await request.json().catch(() => null);
    if (!body || typeof body.settings !== "object" || body.settings === null || Array.isArray(body.settings)) {
      return NextResponse.json({ error: "설정 데이터가 올바르지 않습니다." }, { status: 400 });
    }

    const { settings } = body;
    if (Object.keys(settings).some((key) => !EDITABLE_SETTINGS.has(key))) {
      return NextResponse.json({ error: "변경할 수 없는 설정이 포함되어 있습니다." }, { status: 400 });
    }
    const errors: string[] = [];

    // 값 검증
    if (settings.notice_display_days !== undefined) {
      const days = parseInt(settings.notice_display_days, 10);
      if (isNaN(days) || days < 0) {
        errors.push("공지 노출 기간은 0 이상의 정수여야 합니다.");
      }
    }

    if (settings.notice_active_id !== undefined && settings.notice_active_id !== "" && settings.notice_active_id !== "none") {
      const activeId = parseInt(settings.notice_active_id, 10);
      if (isNaN(activeId) || (activeId <= 0 && activeId !== -1)) {
        errors.push("공지글 ID는 양의 정수, -1 또는 'none'이어야 합니다.");
      }
    }

    if (errors.length > 0) {
      return NextResponse.json({ error: errors.join(" ") }, { status: 400 });
    }

    // Service Role 권한의 Admin 클라이언트 생성 (RLS 쓰기 차단 우회)
    const supabaseAdmin = createSupabaseAdminClient(
      clean(process.env.NEXT_PUBLIC_SUPABASE_URL),
      clean(process.env.SUPABASE_SERVICE_ROLE_KEY)
    );

    // 트랜잭션 대신 개별 업데이트 병렬 실행
    const updatePromises = Object.entries(settings).map(([key, value]) => {
      return supabaseAdmin
        .from("system_settings")
        .update({ value: String(value), updated_at: new Date().toISOString() })
        .eq("key", key);
    });

    const results = await Promise.all(updatePromises);
    const failedUpdate = results.find(r => r.error);
    if (failedUpdate) {
      return NextResponse.json({ error: "설정 저장 중 오류가 발생했습니다: " + (failedUpdate.error?.message || "알 수 없는 오류") }, { status: 500 });
    }

    return NextResponse.json({ success: true });
  } catch (error: any) {
    return NextResponse.json({ error: error.message || "Internal Server Error" }, { status: 500 });
  }
}
