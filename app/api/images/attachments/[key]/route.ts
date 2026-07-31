import { NextResponse } from "next/server";
import { downloadBufferFromR2 } from "@/lib/pubg-analysis/r2Service";

// 존재하지 않는 키의 응답을 짧게 캐시해 깨진 이미지의 반복 함수 실행을 막는다.
const MISS_CACHE_SECONDS = 3600;

export async function GET(
  request: Request,
  { params }: { params: Promise<{ key: string }> }
) {
  const { key } = await params;
  if (!key) {
    return new NextResponse("Key is required", { status: 400 });
  }

  const r2Key = `attachments/${key}`;

  try {
    // 1. R2 버킷에서 이미지 바이너리 획득 시도
    const buffer = await downloadBufferFromR2(r2Key);
    if (!buffer) {
      return new NextResponse("Image not found", {
        status: 404,
        headers: { "Cache-Control": `public, max-age=${MISS_CACHE_SECONDS}, s-maxage=${MISS_CACHE_SECONDS}` },
      });
    }

    return new Response(new Uint8Array(buffer), {
      headers: {
        "Content-Type": "image/webp",
        "Cache-Control": "public, max-age=31536000, immutable", // 강력한 캐싱 설정
      },
    });
  } catch (error) {
    console.error("Attachment image proxy error:", error);
    return new NextResponse("Internal Server Error", {
      status: 500,
      headers: { "Cache-Control": "public, max-age=300, s-maxage=300" },
    });
  }
}
