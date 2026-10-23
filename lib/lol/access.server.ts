import "server-only";
import { NextResponse } from "next/server";
import { notFound, redirect } from "next/navigation";
import { requireAdmin } from "@/lib/server/adminGuard";

export type LolDevAccessResult = { ok: true } | { ok: false; error: NextResponse };

function denied(status: number, message: string): LolDevAccessResult {
  const error = NextResponse.json({ error: message }, { status });
  error.headers.set("Cache-Control", "private, no-store");
  return { ok: false, error };
}

export async function requireLolDevAdmin(): Promise<LolDevAccessResult> {
  if (process.env.LOL_DEV_ENABLED !== "true") {
    return denied(404, "요청한 개발 공간을 찾을 수 없습니다.");
  }

  try {
    const admin = await requireAdmin();
    if (!admin.ok) return denied(admin.error.status, "접근 권한을 확인할 수 없습니다.");
    return { ok: true };
  } catch {
    return denied(500, "접근 권한을 확인할 수 없습니다.");
  }
}

export async function requireLolDevPageAdmin(): Promise<void> {
  const access = await requireLolDevAdmin();
  if (access.ok) return;
  if (access.error.status === 401) redirect("/login");
  if (access.error.status === 403 || access.error.status === 404) notFound();
  throw new Error("접근 권한을 확인할 수 없습니다.");
}
