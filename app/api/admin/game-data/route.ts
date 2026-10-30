import { NextResponse } from "next/server";
import { requireAdmin } from "@/lib/server/adminGuard";
import { isPatchableTable, PATCHABLE_TABLES } from "@/lib/patch-notes/weaponSchema";

/**
 * 이 라우트는 service_role 키로 RLS 를 우회하므로 대상 테이블을 화이트리스트로 제한합니다.
 * 화이트리스트는 lib/patch-notes/weaponSchema.ts 를 공유해 패치노트 자동 갱신 경로와 일치시킵니다.
 */
function assertPatchableTable(category: unknown) {
  if (!isPatchableTable(category)) {
    return NextResponse.json(
      { error: `허용되지 않은 카테고리입니다. (허용: ${PATCHABLE_TABLES.join(", ")})` },
      { status: 400 }
    );
  }
  return null;
}

export async function POST(request: Request) {
  const adminContext = await requireAdmin();
  if (!adminContext.ok) return adminContext.error;

  const { category, item } = await request.json().catch(() => ({}));
  if (!category || !item) return NextResponse.json({ error: "잘못된 요청 데이터입니다." }, { status: 400 });

  const categoryError = assertPatchableTable(category);
  if (categoryError) return categoryError;

  const { error } = await adminContext.supabaseAdmin
    .from(category)
    .upsert(item);

  if (error) {
    console.error("[GAME-DATA] upsert failed:", category, error.message || error);
    return NextResponse.json({ error: "게임 데이터를 저장하지 못했습니다." }, { status: 500 });
  }

  return NextResponse.json({ success: true });
}

export async function DELETE(request: Request) {
  const adminContext = await requireAdmin();
  if (!adminContext.ok) return adminContext.error;

  const { searchParams } = new URL(request.url);
  const category = searchParams.get("category");
  const id = searchParams.get("id");

  if (!category || !id) return NextResponse.json({ error: "ID와 카테고리가 필요합니다." }, { status: 400 });

  const categoryError = assertPatchableTable(category);
  if (categoryError) return categoryError;

  const { error } = await adminContext.supabaseAdmin
    .from(category)
    .delete()
    .eq("id", id);

  if (error) {
    console.error("[GAME-DATA] delete failed:", category, error.message || error);
    return NextResponse.json({ error: "게임 데이터를 삭제하지 못했습니다." }, { status: 500 });
  }

  return NextResponse.json({ success: true });
}
