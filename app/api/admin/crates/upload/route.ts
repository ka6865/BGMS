import { NextResponse } from "next/server";
import { requireAdmin } from "@/lib/server/adminGuard";
import { uploadToR2 } from "@/lib/pubg-analysis/r2Service";
import { normalizeCrateItemName } from "@/lib/crates/assetMapping";

export async function POST(request: Request) {
  try {
    const adminContext = await requireAdmin();
    if (!adminContext.ok) return adminContext.error;

    const formData = await request.formData();
    const file = formData.get("file") as File | null;
    const requestedAssetKey = String(formData.get("assetKey") || "").trim();
    const displayName = String(formData.get("displayName") || "").trim();
    
    if (!file) {
      return NextResponse.json({ error: "업로드할 파일이 존재하지 않습니다." }, { status: 400 });
    }

    // 파일 데이터를 Buffer로 변환
    const arrayBuffer = await file.arrayBuffer();
    const buffer = Buffer.from(arrayBuffer);
    
    // 파일명 정규화 및 고유키 접미사 부여 (파일명 충돌 방지)
    const rawFilename = file.name;
    const lastDotIndex = rawFilename.lastIndexOf(".");
    const ext = lastDotIndex !== -1 ? rawFilename.substring(lastDotIndex) : ".png";
    const baseName = lastDotIndex !== -1 ? rawFilename.substring(0, lastDotIndex) : rawFilename;
    const normalizedDisplayName = normalizeCrateItemName(displayName);
    const sanitizedBase = (requestedAssetKey || normalizedDisplayName || baseName)
      .replace(/[^a-zA-Z0-9.\-_]/g, "_")
      .replace(/^_+|_+$/g, "");

    const uniqueId = Math.random().toString(36).substring(2, 8);
    const uniqueFilename = requestedAssetKey
      ? `${sanitizedBase}${ext}`
      : `${sanitizedBase || "crate_asset"}_${uniqueId}${ext}`;
    
    const r2Key = `crates/${uniqueFilename}`;

    // R2 버킷에 업로드 수행
    await uploadToR2(r2Key, buffer, file.type || "image/png");

    // 클라이언트가 Next.js 이미지 프록시를 통해 접근할 수 있는 상대 경로 반환
    const cdnUrl = `/api/images/crates/${uniqueFilename}`;

    return NextResponse.json({
      success: true,
      url: cdnUrl,
      asset_key: uniqueFilename.replace(/\.[^.]+$/, ""),
      r2_key: r2Key,
      filename: uniqueFilename
    });

  } catch (error: any) {
    console.error("Crate image upload error:", error);
    return NextResponse.json({ error: "R2 업로드 통신 실패" }, { status: 500 });
  }
}
