import { NextResponse, type NextRequest } from 'next/server'
import { updateSession } from '@/lib/supabase-middleware'
import { hasLolRiotAccess, LOL_PREVIEW_COOKIE, LOL_PREVIEW_PATH, lolRiotLockedPath } from '@/lib/lol/previewAccess'

// Riot API 데이터 화면은 운영 키 승인 전까지 심사용 미리보기 쿠키가 있어야 열린다.
function lolPreviewGate(request: NextRequest): NextResponse | null {
  const locked = lolRiotLockedPath(request.nextUrl.pathname)
  if (!locked || hasLolRiotAccess(request.cookies.get(LOL_PREVIEW_COOKIE)?.value)) return null
  const headers = { 'Cache-Control': 'private, no-store', 'X-Robots-Tag': 'noindex, nofollow' }
  if (locked === 'api') {
    return NextResponse.json({ error: '개발 중인 기능입니다.', reasonCode: 'lol_preview_required' }, { status: 401, headers })
  }
  const target = new URL(LOL_PREVIEW_PATH, request.url)
  target.searchParams.set('next', `${request.nextUrl.pathname}${request.nextUrl.search}`)
  return NextResponse.rewrite(target, { headers })
}

export async function proxy(request: NextRequest) {
  return lolPreviewGate(request) ?? await updateSession(request)
}

export const config = {
  matcher: [
    /*
     * 다음 경로를 제외한 모든 경로에서 미들웨어 실행:
     * - _next/static (정적 파일)
     * - _next/image (이미지 최적화 파일)
     * - favicon.ico (파비콘)
     * - public 폴더 내부 파일들
     */
    '/((?!_next/static|_next/image|favicon.ico|.*\\.(?:svg|png|jpg|jpeg|gif|webp)$).*)',
  ],
}
