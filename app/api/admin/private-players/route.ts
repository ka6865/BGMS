import { NextResponse } from "next/server";
import { createClient as createSupabaseServerClient } from "@/utils/supabase/server";
import {
  getPrivatePlayersList,
  addPrivatePlayer,
  removePrivatePlayer,
} from "@/lib/pubg/privatePlayers";

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

// 1. GET: 비공개 플레이어 목록 조회
export async function GET() {
  try {
    const adminContext = await verifyAdmin();
    if (!adminContext) {
      return NextResponse.json({ error: "🔒 관리자 권한이 없습니다." }, { status: 403 });
    }

    const list = await getPrivatePlayersList();
    return NextResponse.json({ success: true, players: list });
  } catch (error: any) {
    return NextResponse.json({ error: error.message || "Internal Server Error" }, { status: 500 });
  }
}

// 2. POST: 비공개 플레이어 추가
export async function POST(request: Request) {
  try {
    const adminContext = await verifyAdmin();
    if (!adminContext) {
      return NextResponse.json({ error: "🔒 관리자 권한이 없습니다." }, { status: 403 });
    }

    const body = await request.json().catch(() => null);
    const { platform = "steam", nickname } = body || {};

    if (!nickname || !nickname.trim()) {
      return NextResponse.json({ error: "닉네임을 입력해 주세요." }, { status: 400 });
    }

    const updatedList = await addPrivatePlayer(platform, nickname.trim());
    return NextResponse.json({ success: true, players: updatedList });
  } catch (error: any) {
    return NextResponse.json({ error: error.message || "Internal Server Error" }, { status: 500 });
  }
}

// 3. DELETE: 비공개 플레이어 제거(공개 전환)
export async function DELETE(request: Request) {
  try {
    const adminContext = await verifyAdmin();
    if (!adminContext) {
      return NextResponse.json({ error: "🔒 관리자 권한이 없습니다." }, { status: 403 });
    }

    const { searchParams } = new URL(request.url);
    const platform = searchParams.get("platform") || "steam";
    const nickname = searchParams.get("nickname");

    if (!nickname || !nickname.trim()) {
      return NextResponse.json({ error: "닉네임을 입력해 주세요." }, { status: 400 });
    }

    const updatedList = await removePrivatePlayer(platform, nickname.trim());
    return NextResponse.json({ success: true, players: updatedList });
  } catch (error: any) {
    return NextResponse.json({ error: error.message || "Internal Server Error" }, { status: 500 });
  }
}
