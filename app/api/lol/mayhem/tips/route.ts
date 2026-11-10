import { NextResponse } from "next/server";
import { guardLolPublicRequest } from "@/lib/lol/publicAccess.server";
import { getCachedLolAugmentCatalog } from "@/lib/lol/augments/catalog.server";
import { getLolChampions } from "@/lib/lol/champions.server";
import { checkProfanity } from "@/lib/board/profanityFilter";
import { withAuthGuard } from "@/utils/supabase/guard";
import { parseMayhemTipId, parseMayhemTipInput, type MayhemTipInput } from "@/lib/lol/mayhemTips";
import { createMayhemTip, deleteMayhemTip, getMayhemTipItems, listMayhemTips, updateMayhemTip } from "@/lib/lol/mayhemTips.server";
export const dynamic = "force-dynamic";
const headers = { "Cache-Control": "private, no-store", "X-Content-Type-Options": "nosniff" };
const reply = (value: unknown, status = 200) => NextResponse.json(value, { status, headers });
const unavailable = () => reply({ error: "조합 제보를 처리하지 못했습니다. 잠시 후 다시 시도해 주세요." }, 503);
const tipsEnabled = () => process.env.LOL_MAYHEM_TIPS_ENABLED === "true";
const notFound = () => reply({ error: "요청한 자료를 찾을 수 없습니다." }, 404);
const loginRequired = () => reply({ error: "로그인 후 이용할 수 있습니다." }, 401);

// 제보는 현재 증강 도감 패치에만 쌓는다.
async function currentPatch() {
  return (await getCachedLolAugmentCatalog(null))?.view ?? null;
}

async function readJson(request: Request): Promise<unknown | Response> {
  const text = await request.text();
  if (text.length > 8_192) return reply({ error: "제보 내용이 너무 깁니다." }, 413);
  try { return JSON.parse(text); } catch { return reply({ error: "제보 내용을 확인해 주세요." }, 400); }
}

// 형식·비속어·현재 패치 목록을 차례로 확인하고, 통과하면 제보와 패치를 돌려준다.
async function validTip(body: unknown): Promise<{ input: MayhemTipInput; patch: string } | Response> {
  const input = parseMayhemTipInput(body);
  if (!input) return reply({ error: "증강 1~6개, 아이템 6개 이하, 한줄평 2~60자로 입력해 주세요." }, 400);
  if (checkProfanity(`${input.summary} ${input.usage}`).blocked) return reply({ error: "부적절한 표현이 포함되어 있습니다." }, 400);
  const [catalog, champions] = await Promise.all([currentPatch(), getLolChampions()]);
  if (!catalog || !champions) return unavailable();
  const items = await getMayhemTipItems(champions.version);
  const augments = new Set(catalog.augments.map(a => a.id)), itemIds = new Set(items.map(i => i.id));
  if (input.augmentIds.some(id => !augments.has(id)) || input.itemIds.some(id => !itemIds.has(id))
    || (input.championId !== null && !champions.champions.some(c => c.id === input.championId))) return reply({ error: "현재 패치에 없는 챔피언·증강·아이템이 있습니다." }, 400);
  return { input, patch: catalog.clientPatch };
}

export async function GET(request: Request) {
  if (!tipsEnabled()) return notFound();
  const denied = await guardLolPublicRequest(request, "read");
  if (denied) return denied;
  const params = new URL(request.url).searchParams, champion = params.get("champion"), sort = params.get("sort") ?? "recent", rawOffset = params.get("offset") ?? "0";
  if ([...params.keys()].some(key => !["champion", "sort", "offset"].includes(key) || params.getAll(key).length !== 1) || !/^(0|[1-9][0-9]{0,3})$/.test(rawOffset)
    || (sort !== "recent" && sort !== "top") || (champion !== null && champion !== "common" && !/^[1-9][0-9]{0,5}$/.test(champion))) return reply({ error: "조회 조건을 확인해 주세요." }, 400);
  try {
    const [catalog, auth] = await Promise.all([currentPatch(), withAuthGuard().catch(() => null)]);
    if (!catalog) return unavailable();
    const viewer = auth && !auth.error ? auth.user.id : null;
    const page = await listMayhemTips(catalog.clientPatch, champion === null ? null : champion === "common" ? "common" : Number(champion), sort, Number(rawOffset), viewer);
    return reply({ patch: catalog.clientPatch, offset: Number(rawOffset), signedIn: viewer !== null, ...page });
  } catch { return unavailable(); }
}

export async function POST(request: Request) {
  if (!tipsEnabled()) return notFound();
  const denied = await guardLolPublicRequest(request, "tip");
  if (denied) return denied;
  const auth = await withAuthGuard();
  if (auth.error) return loginRequired();
  const body = await readJson(request);
  if (body instanceof Response) return body;
  try {
    const valid = await validTip(body);
    if (valid instanceof Response) return valid;
    const tip = await createMayhemTip(auth.user.id, valid.patch, valid.input);
    if (tip === "daily_limit") return reply({ error: "조합 제보는 하루 10개까지 할 수 있습니다." }, 429);
    return reply({ tip }, 201);
  } catch { return unavailable(); }
}

export async function PATCH(request: Request) {
  if (!tipsEnabled()) return notFound();
  const denied = await guardLolPublicRequest(request, "tip");
  if (denied) return denied;
  const auth = await withAuthGuard();
  if (auth.error) return loginRequired();
  const body = await readJson(request);
  if (body instanceof Response) return body;
  const id = parseMayhemTipId((body as { id?: unknown } | null)?.id);
  if (!id) return reply({ error: "고칠 제보를 찾을 수 없습니다." }, 400);
  try {
    const valid = await validTip(body);
    if (valid instanceof Response) return valid;
    const tip = await updateMayhemTip(auth.user.id, id, valid.input);
    return tip ? reply({ tip }) : reply({ error: "본인이 쓴 제보만 고칠 수 있습니다." }, 404);
  } catch { return unavailable(); }
}

export async function DELETE(request: Request) {
  if (!tipsEnabled()) return notFound();
  const denied = await guardLolPublicRequest(request, "tip");
  if (denied) return denied;
  const auth = await withAuthGuard();
  if (auth.error) return loginRequired();
  const raw = new URL(request.url).searchParams.get("id");
  const id = raw && /^[1-9][0-9]{0,15}$/.test(raw) ? parseMayhemTipId(Number(raw)) : null;
  if (!id) return reply({ error: "지울 제보를 찾을 수 없습니다." }, 400);
  try {
    return await deleteMayhemTip(auth.user.id, id) ? reply({ deleted: id }) : reply({ error: "본인이 쓴 제보만 지울 수 있습니다." }, 404);
  } catch { return unavailable(); }
}
