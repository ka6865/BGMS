import { NextResponse } from "next/server";
import { revalidateTag } from "next/cache";
import { requireLolDevAdmin } from "@/lib/lol/access.server";
import { isSameOriginLolRequest } from "@/lib/lol/http.server";
import { parseMayhemOfferRuleInput } from "@/lib/lol/mayhemOfferRules";
import { deleteMayhemOfferRule, listMayhemOfferRulesAdmin, MAYHEM_OFFER_RULES_TAG, saveMayhemOfferRule } from "@/lib/lol/mayhemOfferRules.server";

export const dynamic = "force-dynamic";
const reply = (body: unknown, status = 200) => NextResponse.json(body, { status, headers: { "Cache-Control": "private, no-store" } });
const ERRORS: Record<string, [string, number]> = {
  offer_rule_duplicate: ["같은 증강의 무작위 제외 규칙이나 같은 원문 후보가 이미 있습니다.", 409],
  offer_rule_invalid: ["게시하려면 대상 증강과 조건 문장이 필요합니다.", 400],
};

export async function GET() {
  const access = await requireLolDevAdmin();
  if (!access.ok) return access.error;
  try { return reply({ rules: await listMayhemOfferRulesAdmin() }); }
  catch { return reply({ error: "등장 조건을 불러오지 못했습니다." }, 503); }
}

// id가 있으면 고치고, 없으면 새로 만든다.
export async function POST(request: Request) {
  const access = await requireLolDevAdmin();
  if (!access.ok) return access.error;
  if (!isSameOriginLolRequest(request)) return reply({ error: "요청 출처를 확인해 주세요." }, 403);
  const body = await request.json().catch(() => null) as Record<string, unknown> | null;
  const input = parseMayhemOfferRuleInput(body);
  const id = body?.id === undefined || body.id === null ? null : Number.isSafeInteger(body.id) && (body.id as number) > 0 ? body.id as number : undefined;
  if (!input || id === undefined) return reply({ error: "입력 내용을 확인해 주세요." }, 400);
  try {
    const rule = await saveMayhemOfferRule(access.userId, input, id);
    if (!rule) return reply({ error: "규칙을 찾을 수 없습니다." }, 404);
    revalidateTag(MAYHEM_OFFER_RULES_TAG, "max");
    return reply({ rule }, id === null ? 201 : 200);
  } catch (error) {
    const [message, status] = ERRORS[error instanceof Error ? error.message : ""] ?? ["등장 조건을 저장하지 못했습니다.", 503];
    return reply({ error: message }, status);
  }
}

export async function DELETE(request: Request) {
  const access = await requireLolDevAdmin();
  if (!access.ok) return access.error;
  if (!isSameOriginLolRequest(request)) return reply({ error: "요청 출처를 확인해 주세요." }, 403);
  const raw = new URL(request.url).searchParams.get("id");
  const id = raw && /^[1-9][0-9]{0,15}$/.test(raw) ? Number(raw) : null;
  if (!id) return reply({ error: "지울 규칙을 선택해 주세요." }, 400);
  try {
    if (!await deleteMayhemOfferRule(id)) return reply({ error: "규칙을 찾을 수 없습니다." }, 404);
    revalidateTag(MAYHEM_OFFER_RULES_TAG, "max");
    return reply({ deleted: id });
  } catch { return reply({ error: "등장 조건을 지우지 못했습니다." }, 503); }
}
