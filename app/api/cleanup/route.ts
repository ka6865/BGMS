import { NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";
import { authorizeBearerSecret } from "@/lib/server/secretAuth";

/**
 * 30일 이상 방치된 저신뢰 마커 제보를 정리합니다.
 *
 * 인증: Authorization: Bearer <ADMIN_SECRET_TOKEN>
 * 쿼리 파라미터 토큰은 지원하지 않습니다. URL 에 담긴 비밀값은 접근 로그와
 * Referer 헤더에 남기 때문입니다.
 */
export async function GET(request: Request) {
  try {
    if (!authorizeBearerSecret(request, ["ADMIN_SECRET_TOKEN", "CRON_SECRET"])) {
      return NextResponse.json(
        { error: "Unauthorized. Authorization: Bearer <ADMIN_SECRET_TOKEN> 헤더가 필요합니다." },
        { status: 401 }
      );
    }

    const supabaseAdmin = createClient(
      process.env.NEXT_PUBLIC_SUPABASE_URL!,
      process.env.SUPABASE_SERVICE_ROLE_KEY!
    );

    // 🌟 30일이 지난 pending 데이터 삭제 로직
    // 신뢰도가 낮고(예: 2점 미만) 생성된 지 30일이 넘은 데이터 색출
    const thirtyDaysAgo = new Date();
    thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30);

    const { data, error } = await supabaseAdmin
      .from("pending_markers")
      .delete()
      .lt("weight", 3) // 신뢰도 3점 미만이고
      .lt("created_at", thirtyDaysAgo.toISOString()) // 30일 넘은 것
      .select();

    if (error) throw error;

    return NextResponse.json({
      success: true,
      message: `청소 완료: ${data?.length || 0}개의 유령 제보 삭제됨.`,
    });
  } catch (error: any) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}
