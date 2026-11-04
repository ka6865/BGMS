import { NextResponse } from "next/server";
import { guardLolPublicRequest } from "@/lib/lol/publicAccess.server";
import { getLolChampions } from "@/lib/lol/champions.server";
import { getMayhemItemRatings } from "@/lib/lol/mayhemItems.server";
export const dynamic = "force-dynamic";
const reply = (body: unknown, status = 200) => NextResponse.json(body, { status, headers: { "Cache-Control": "private, no-store", "X-Content-Type-Options": "nosniff" } });
export async function GET(request: Request, { params }: { params: Promise<{ championId: string }> }) {
  if (process.env.LOL_MAYHEM_ITEMS_ENABLED !== "true") return reply({ error: "요청한 자료를 찾을 수 없습니다." }, 404);
  const denied = await guardLolPublicRequest(request,"read"); if (denied) return denied;
  const { championId } = await params;
  if (!/^[1-9][0-9]{0,4}$/.test(championId) || new URL(request.url).searchParams.size) return reply({ error: "챔피언을 확인해 주세요." }, 400);
  try {
    const champions = await getLolChampions(); if (!champions) return reply({ error: "챔피언 목록을 불러오지 못했습니다." }, 503);
    if (!champions.champions.some(champion => champion.id === Number(championId))) return reply({ error: "챔피언을 확인해 주세요." }, 400);
    return reply({ dataset: await getMayhemItemRatings(Number(championId)) });
  } catch { return reply({ error: "증바람 아이템 자료를 불러오지 못했습니다." }, 503); }
}
