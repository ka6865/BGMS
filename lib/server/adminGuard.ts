/**
 * @fileoverview 관리자 전용 API 라우트에서 공통으로 사용하는 권한 검증 헬퍼입니다.
 *
 * withAuthGuard 가 Bearer 헤더와 쿠키 세션을 모두 처리하므로
 * 웹 브라우저와 Capacitor 앱이 같은 라우트를 사용할 수 있습니다.
 */

import { NextResponse } from "next/server";
import { withAuthGuard } from "@/utils/supabase/guard";

type AdminSuccess = {
  ok: true;
  user: { id: string; email?: string };
  supabaseAdmin: NonNullable<Awaited<ReturnType<typeof withAuthGuard>>["supabaseAdmin"]>;
  nickname: string | null;
  error?: undefined;
};

type AdminFailure = {
  ok: false;
  user?: undefined;
  supabaseAdmin?: undefined;
  nickname?: undefined;
  error: NextResponse;
};

export type AdminGuardResult = AdminSuccess | AdminFailure;

export async function requireAdmin(): Promise<AdminGuardResult> {
  const auth = await withAuthGuard();
  if (auth.error) return { ok: false, error: auth.error };

  const { data: profile } = await auth.supabaseAdmin
    .from("profiles")
    .select("role, nickname")
    .eq("id", auth.user.id)
    .single();

  if (profile?.role !== "admin") {
    return {
      ok: false,
      error: NextResponse.json({ error: "관리자 권한이 없습니다." }, { status: 403 }),
    };
  }

  return {
    ok: true,
    user: auth.user,
    supabaseAdmin: auth.supabaseAdmin,
    nickname: (profile?.nickname as string | null) ?? null,
  };
}
