import { NextResponse } from "next/server";
import { requireAdmin } from "@/lib/server/adminGuard";
import {
  isProposalStatus,
  listWeaponPatchProposals,
} from "@/lib/patch-notes/weaponProposalQuery";

export async function GET(request: Request) {
  const admin = await requireAdmin();
  if (!admin.ok) return admin.error;

  const { searchParams } = new URL(request.url);
  const statusParam = searchParams.get("status");
  const limitParam = Number(searchParams.get("limit") ?? "");

  if (statusParam !== null && !isProposalStatus(statusParam)) {
    return NextResponse.json({ error: "유효하지 않은 status 값입니다." }, { status: 400 });
  }

  try {
    const proposals = await listWeaponPatchProposals(admin.supabaseAdmin, {
      status: statusParam === null ? undefined : statusParam,
      limit: Number.isFinite(limitParam) && limitParam > 0 ? limitParam : undefined,
    });
    return NextResponse.json({ proposals });
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : "제안 조회에 실패했습니다.";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
