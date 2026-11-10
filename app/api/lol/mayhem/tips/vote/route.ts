import { NextResponse } from "next/server";
import { guardLolPublicRequest } from "@/lib/lol/publicAccess.server";
import { withAuthGuard } from "@/utils/supabase/guard";
import { parseMayhemTipId } from "@/lib/lol/mayhemTips";
import { voteMayhemTip } from "@/lib/lol/mayhemTips.server";
export const dynamic = "force-dynamic";
const headers = { "Cache-Control": "private, no-store", "X-Content-Type-Options": "nosniff" };
const reply = (value: unknown, status = 200) => NextResponse.json(value, { status, headers });

// value 1은 추천, -1은 비추천, 0은 표 취소다.
export async function POST(request: Request) {
  if (process.env.LOL_MAYHEM_TIPS_ENABLED !== "true") return reply({ error: "요청한 자료를 찾을 수 없습니다." }, 404);
  const denied = await guardLolPublicRequest(request, "vote");
  if (denied) return denied;
  const auth = await withAuthGuard();
  if (auth.error) return reply({ error: "로그인 후 투표할 수 있습니다." }, 401);
  const text = await request.text();
  let body: { id?: unknown; value?: unknown } | null = null;
  try { body = text.length <= 256 ? JSON.parse(text) : null; } catch { body = null; }
  const id = parseMayhemTipId(body?.id), value = body?.value;
  if (!id || (value !== -1 && value !== 0 && value !== 1)) return reply({ error: "투표 내용을 확인해 주세요." }, 400);
  try {
    const result = await voteMayhemTip(auth.user.id, id, value);
    if (result === "not_found") return reply({ error: "제보를 찾을 수 없습니다." }, 404);
    if (result === "own_tip") return reply({ error: "본인 제보에는 투표할 수 없습니다." }, 403);
    return reply({ ...result, myVote: value });
  } catch { return reply({ error: "투표를 처리하지 못했습니다. 잠시 후 다시 시도해 주세요." }, 503); }
}
