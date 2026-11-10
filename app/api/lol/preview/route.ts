import { NextResponse } from "next/server";
import { guardLolPublicRequest } from "@/lib/lol/publicAccess.server";
import { checkLolPreviewPassword, createLolPreviewToken, LOL_PREVIEW_COOKIE, LOL_PREVIEW_MAX_AGE, lolPreviewPasswordEnabled } from "@/lib/lol/previewAccess";

export const dynamic = "force-dynamic";
export const maxDuration = 5;

const reply = (body: unknown, status: number) => NextResponse.json(body, {
  status, headers: { "Cache-Control": "private, no-store", "X-Robots-Tag": "noindex, nofollow" },
});

export async function POST(request: Request) {
  if (!lolPreviewPasswordEnabled()) return reply({ error: "요청한 페이지를 찾을 수 없습니다." }, 404);
  const denied = await guardLolPublicRequest(request, "preview");
  if (denied) return denied;
  let password: unknown;
  try {
    const raw = await request.text();
    if (new TextEncoder().encode(raw).byteLength > 1024) return reply({ error: "요청이 너무 큽니다." }, 413);
    password = (JSON.parse(raw) as { password?: unknown } | null)?.password;
  } catch {
    return reply({ error: "비밀번호를 입력해 주세요." }, 400);
  }
  if (typeof password !== "string" || !password || password.length > 200) return reply({ error: "비밀번호를 입력해 주세요." }, 400);
  const token = checkLolPreviewPassword(password) ? createLolPreviewToken() : null;
  if (!token) return reply({ error: "비밀번호가 맞지 않습니다." }, 401);
  const response = reply({ ok: true }, 200);
  response.cookies.set(LOL_PREVIEW_COOKIE, token, { httpOnly: true, secure: true, sameSite: "lax", path: "/", maxAge: LOL_PREVIEW_MAX_AGE });
  return response;
}
