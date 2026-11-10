import { NextResponse } from "next/server";
import { guardLolPublicRequest } from "@/lib/lol/publicAccess.server";
import { checkProfanity } from "@/lib/board/profanityFilter";
import { withAuthGuard } from "@/utils/supabase/guard";
import { parseMayhemTipCommentInput } from "@/lib/lol/mayhemTips";
import { createMayhemTipComment, deleteMayhemTipComment, listMayhemTipComments } from "@/lib/lol/mayhemTips.server";
export const dynamic = "force-dynamic";
const headers = { "Cache-Control": "private, no-store", "X-Content-Type-Options": "nosniff" };
const reply = (value: unknown, status = 200) => NextResponse.json(value, { status, headers });
const unavailable = () => reply({ error: "댓글을 처리하지 못했습니다. 잠시 후 다시 시도해 주세요." }, 503);
const disabled = () => process.env.LOL_MAYHEM_TIPS_ENABLED !== "true" ? reply({ error: "요청한 자료를 찾을 수 없습니다." }, 404) : null;
const idParam = (request: Request, key: string) => {
  const params = new URL(request.url).searchParams, raw = params.get(key);
  return [...params.keys()].length === 1 && raw && /^[1-9][0-9]{0,15}$/.test(raw) && Number.isSafeInteger(Number(raw)) ? Number(raw) : null;
};

export async function GET(request: Request) {
  const off = disabled(); if (off) return off;
  const denied = await guardLolPublicRequest(request, "read");
  if (denied) return denied;
  const tipId = idParam(request, "tipId");
  if (!tipId) return reply({ error: "글을 찾을 수 없습니다." }, 400);
  try {
    const auth = await withAuthGuard().catch(() => null);
    const comments = await listMayhemTipComments(tipId, auth && !auth.error ? auth.user.id : null);
    return comments ? reply({ comments }) : reply({ error: "글을 찾을 수 없습니다." }, 404);
  } catch { return unavailable(); }
}

export async function POST(request: Request) {
  const off = disabled(); if (off) return off;
  const denied = await guardLolPublicRequest(request, "comment");
  if (denied) return denied;
  const auth = await withAuthGuard();
  if (auth.error) return reply({ error: "로그인 후 댓글을 달 수 있습니다." }, 401);
  const text = await request.text();
  let body: unknown = null;
  try { body = text.length <= 4_096 ? JSON.parse(text) : null; } catch { body = null; }
  const input = parseMayhemTipCommentInput(body);
  if (!input) return reply({ error: "댓글은 1~500자로 적어 주세요." }, 400);
  if (checkProfanity(input.body).blocked) return reply({ error: "부적절한 표현이 포함되어 있습니다." }, 400);
  try {
    const result = await createMayhemTipComment(auth.user.id, input);
    if (result === "not_found") return reply({ error: "글을 찾을 수 없습니다." }, 404);
    if (result === "bad_parent") return reply({ error: "답글을 달 댓글을 찾을 수 없습니다." }, 400);
    return reply({ comments: await listMayhemTipComments(input.tipId, auth.user.id) }, 201);
  } catch { return unavailable(); }
}

export async function DELETE(request: Request) {
  const off = disabled(); if (off) return off;
  const denied = await guardLolPublicRequest(request, "comment");
  if (denied) return denied;
  const auth = await withAuthGuard();
  if (auth.error) return reply({ error: "로그인 후 이용할 수 있습니다." }, 401);
  const id = idParam(request, "id");
  if (!id) return reply({ error: "지울 댓글을 찾을 수 없습니다." }, 400);
  try {
    return await deleteMayhemTipComment(auth.user.id, id) ? reply({ deleted: id }) : reply({ error: "본인이 쓴 댓글만 지울 수 있습니다." }, 404);
  } catch { return unavailable(); }
}
