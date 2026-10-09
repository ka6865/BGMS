import { NextRequest, NextResponse } from "next/server";
import { revalidateTag } from "next/cache";
import { authorizeBearerSecret } from "@/lib/server/secretAuth";

/**
 * [ISR V1.0] 온디맨드 캐시 소각 어드민 API
 *
 * 배포 완료 또는 수동 갱신 시 호출하여 특정 캐시 태그를 즉시 만료(Stale) 마킹합니다.
 * Next.js의 revalidateTag를 사용해 다음 요청에서 백그라운드 갱신을 시작합니다.
 *
 * 사용법 (curl):
 * curl -X POST "https://your-app.vercel.app/api/admin/revalidate?tag=match-analysis" \
 *   -H "Authorization: Bearer $ADMIN_REVALIDATE_TOKEN"
 *
 * 지원 태그:
 * - match-analysis: 모든 매치 분석 결과 캐시 소각
 */
export async function POST(request: NextRequest) {
  try {
    const { searchParams } = new URL(request.url);
    const tag = searchParams.get("tag");
    // 어드민 토큰 검증
    if (!authorizeBearerSecret(request, ["ADMIN_REVALIDATE_TOKEN"])) {
      return NextResponse.json(
        { error: "Unauthorized access" },
        { status: 401 }
      );
    }

    if (!tag) {
      return NextResponse.json(
        { error: "Target tag parameter is missing. Use ?tag=match-analysis" },
        { status: 400 }
      );
    }

    // Next.js 16 캐시 백그라운드 무효화 실행 (stale-while-revalidate 시맨틱)
    revalidateTag(tag, 'max');

    console.log(`[ADMIN-REVALIDATE] Tag [${tag}] successfully revalidated at ${new Date().toISOString()}`);

    return NextResponse.json({
      success: true,
      message: `Tag [${tag}] has been successfully revalidated (marked as stale).`,
      timestamp: new Date().toISOString()
    });

  } catch (err: any) {
    console.error(`[ADMIN-REVALIDATE] Error:`, err);
    return NextResponse.json(
      { error: err.message },
      { status: 500 }
    );
  }
}
