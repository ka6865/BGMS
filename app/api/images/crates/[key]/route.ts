import { NextResponse } from "next/server";
import { getPresignedUrlFromR2, checkObjectExists } from "@/lib/pubg-analysis/r2Service";

// presigned URL 유효기간. 리다이렉트 캐시 기간은 이 값보다 짧아야 만료된 URL이 재사용되지 않는다.
const PRESIGNED_TTL_SECONDS = 3600;
// presigned 리다이렉트 캐시 기간. 만료 직전 요청도 안전하도록 TTL의 절반으로 둔다.
const PRESIGNED_REDIRECT_CACHE_SECONDS = 1800;
// 폴백 리다이렉트는 서명이 없어 장기 캐시가 가능하다.
const FALLBACK_REDIRECT_CACHE_SECONDS = 86400;
// 오류 응답을 짧게 캐시해 깨진 이미지의 반복 함수 실행을 막는다.
const ERROR_CACHE_SECONDS = 300;

function withCacheHeaders(response: NextResponse, maxAgeSeconds: number): NextResponse {
  const cacheControl = `public, max-age=${maxAgeSeconds}, s-maxage=${maxAgeSeconds}`;
  response.headers.set("Cache-Control", cacheControl);
  response.headers.set("CDN-Cache-Control", cacheControl);
  response.headers.set("Vercel-CDN-Cache-Control", cacheControl);
  return response;
}

export async function GET(
  request: Request,
  { params }: { params: Promise<{ key: string }> }
) {
  const { key } = await params;
  if (!key) {
    return new NextResponse("Key is required", { status: 400 });
  }

  const r2Key = `crates/${key}`;

  try {
    // 1. R2 버킷에 이미지 파일이 존재하는지 가볍게 검증 (메모리 다운로드 방지)
    const exists = await checkObjectExists(r2Key);
    if (!exists) {
      // 2. R2에 아직 파일이 마이그레이션되지 않았을 경우, 로컬 public 폴더 경로로 폴백 리다이렉트
      return withCacheHeaders(
        NextResponse.redirect(new URL(`/images/crates/${key}`, request.url)),
        FALLBACK_REDIRECT_CACHE_SECONDS,
      );
    }

    // 3. R2 Presigned URL을 발행하여 브라우저를 리다이렉트 처리
    //    리다이렉트 응답에 캐시 헤더가 없으면 CDN이 매 요청마다 함수를 실행해
    //    R2 존재 확인까지 반복되므로 반드시 캐시 헤더를 지정한다.
    const presignedUrl = await getPresignedUrlFromR2(r2Key, PRESIGNED_TTL_SECONDS);
    return withCacheHeaders(
      NextResponse.redirect(presignedUrl),
      PRESIGNED_REDIRECT_CACHE_SECONDS,
    );
  } catch (error) {
    console.error("Crate image proxy error:", error);
    return withCacheHeaders(
      new NextResponse("Internal Server Error", { status: 500 }),
      ERROR_CACHE_SECONDS,
    );
  }
}
