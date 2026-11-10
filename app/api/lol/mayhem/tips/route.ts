import { NextResponse } from "next/server";
import { guardLolPublicRequest } from "@/lib/lol/publicAccess.server";
import { getCachedLolAugmentCatalog } from "@/lib/lol/augments/catalog.server";
import { getLolChampions } from "@/lib/lol/champions.server";
import { checkProfanity } from "@/lib/board/profanityFilter";
import { withAuthGuard } from "@/utils/supabase/guard";
import { parseMayhemTipInput } from "@/lib/lol/mayhemTips";
import { createMayhemTip, getMayhemTipItems, listMayhemTips } from "@/lib/lol/mayhemTips.server";
export const dynamic = "force-dynamic";
const headers = { "Cache-Control": "private, no-store", "X-Content-Type-Options": "nosniff" };
const reply = (value: unknown, status = 200) => NextResponse.json(value, { status, headers });
const unavailable = () => reply({ error: "조합 제보를 불러오지 못했습니다. 잠시 후 다시 시도해 주세요." }, 503);

// 제보는 현재 증강 도감 패치에만 쌓는다.
async function currentPatch() {
  return (await getCachedLolAugmentCatalog(null))?.view ?? null;
}

const tipsEnabled = () => process.env.LOL_MAYHEM_TIPS_ENABLED === "true";
const notFound = () => reply({ error: "요청한 자료를 찾을 수 없습니다." }, 404);

export async function GET(request: Request) {
  if (!tipsEnabled()) return notFound();
  const denied = await guardLolPublicRequest(request, "read");
  if (denied) return denied;
  const params = new URL(request.url).searchParams, champion = params.get("champion"), rawOffset = params.get("offset") ?? "0";
  if ([...params.keys()].some(key => !["champion", "offset"].includes(key) || params.getAll(key).length !== 1) || !/^(0|[1-9][0-9]{0,3})$/.test(rawOffset)
    || (champion !== null && champion !== "common" && !/^[1-9][0-9]{0,5}$/.test(champion))) return reply({ error: "조회 조건을 확인해 주세요." }, 400);
  try {
    const catalog = await currentPatch();
    if (!catalog) return unavailable();
    const [page, auth] = await Promise.all([
      listMayhemTips(catalog.clientPatch, champion === null ? null : champion === "common" ? "common" : Number(champion), Number(rawOffset)),
      // 로그인 여부는 제보 칸을 열지 안내할지 정하는 데만 쓴다.
      withAuthGuard().catch(() => null),
    ]);
    return reply({ patch: catalog.clientPatch, offset: Number(rawOffset), signedIn: !!auth && !auth.error, ...page });
  } catch { return unavailable(); }
}

export async function POST(request: Request) {
  if (!tipsEnabled()) return notFound();
  const denied = await guardLolPublicRequest(request, "tip");
  if (denied) return denied;
  const auth = await withAuthGuard();
  if (auth.error) return reply({ error: "로그인 후 제보할 수 있습니다." }, 401);
  const text = await request.text();
  if (text.length > 8_192) return reply({ error: "제보 내용이 너무 깁니다." }, 413);
  let body: unknown;
  try { body = JSON.parse(text); } catch { return reply({ error: "제보 내용을 확인해 주세요." }, 400); }
  const input = parseMayhemTipInput(body);
  if (!input) return reply({ error: "증강 1~6개, 아이템 6개 이하, 한줄평 2~60자로 입력해 주세요." }, 400);
  if (checkProfanity(`${input.summary} ${input.usage}`).blocked) return reply({ error: "부적절한 표현이 포함되어 있습니다." }, 400);
  try {
    const [catalog, champions] = await Promise.all([currentPatch(), getLolChampions()]);
    if (!catalog || !champions) return unavailable();
    const items = await getMayhemTipItems(champions.version);
    const augments = new Set(catalog.augments.map(a => a.id)), itemIds = new Set(items.map(i => i.id));
    if (input.augmentIds.some(id => !augments.has(id)) || input.itemIds.some(id => !itemIds.has(id))
      || (input.championId !== null && !champions.champions.some(c => c.id === input.championId))) return reply({ error: "현재 패치에 없는 챔피언·증강·아이템이 있습니다." }, 400);
    const tip = await createMayhemTip(auth.user.id, catalog.clientPatch, input);
    if (tip === "daily_limit") return reply({ error: "조합 제보는 하루 10개까지 할 수 있습니다." }, 429);
    return reply({ tip }, 201);
  } catch { return unavailable(); }
}
