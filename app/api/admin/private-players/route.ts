import { NextResponse } from "next/server";
import { requireAdmin } from "@/lib/server/adminGuard";
import { recordAdminAudit } from "@/lib/server/adminAudit";
import {
  getPrivatePlayersList,
  addPrivatePlayer,
  removePrivatePlayer,
} from "@/lib/pubg/privatePlayers";

// 1. GET: 비공개 플레이어 목록 조회
export async function GET() {
  try {
    const adminContext = await requireAdmin();
    if (!adminContext.ok) return adminContext.error;

    const list = await getPrivatePlayersList();
    return NextResponse.json({ success: true, players: list });
  } catch (error: any) {
    console.error("[PRIVATE-PLAYERS] list failed:", error?.message || error);
    return NextResponse.json({ error: "비공개 플레이어 목록을 불러오지 못했습니다." }, { status: 500 });
  }
}

// 2. POST: 비공개 플레이어 추가
export async function POST(request: Request) {
  try {
    const adminContext = await requireAdmin();
    if (!adminContext.ok) return adminContext.error;

    const body = await request.json().catch(() => null);
    const { platform = "steam", nickname, account_id: accountId } = body || {};

    if (!nickname || !nickname.trim()) {
      return NextResponse.json({ error: "닉네임을 입력해 주세요." }, { status: 400 });
    }

    const updatedList = await addPrivatePlayer(
      platform,
      nickname.trim(),
      typeof accountId === "string" ? accountId : undefined,
    );
    await recordAdminAudit(adminContext.supabaseAdmin, {
      actorId: adminContext.user.id,
      action: "private_players.add",
      targetType: "pubg_player",
      targetId: `${platform}:${nickname.trim()}`,
      phase: "succeeded",
      detail: { platform, hasAccountId: typeof accountId === "string" && accountId.length > 0 }
    });
    return NextResponse.json({ success: true, players: updatedList });
  } catch (error: any) {
    console.error("[PRIVATE-PLAYERS] add failed:", error?.message || error);
    return NextResponse.json({ error: "비공개 플레이어를 추가하지 못했습니다." }, { status: 500 });
  }
}

// 3. DELETE: 비공개 플레이어 제거(공개 전환)
export async function DELETE(request: Request) {
  try {
    const adminContext = await requireAdmin();
    if (!adminContext.ok) return adminContext.error;

    const { searchParams } = new URL(request.url);
    const platform = searchParams.get("platform") || "steam";
    const nickname = searchParams.get("nickname");

    if (!nickname || !nickname.trim()) {
      return NextResponse.json({ error: "닉네임을 입력해 주세요." }, { status: 400 });
    }

    const updatedList = await removePrivatePlayer(platform, nickname.trim());
    await recordAdminAudit(adminContext.supabaseAdmin, {
      actorId: adminContext.user.id,
      action: "private_players.remove",
      targetType: "pubg_player",
      targetId: `${platform}:${nickname.trim()}`,
      phase: "succeeded",
      detail: { platform }
    });
    return NextResponse.json({ success: true, players: updatedList });
  } catch (error: any) {
    console.error("[PRIVATE-PLAYERS] remove failed:", error?.message || error);
    return NextResponse.json({ error: "비공개 플레이어를 해제하지 못했습니다." }, { status: 500 });
  }
}
