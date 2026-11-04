import { NextResponse } from "next/server";
import { guardLolPublicRequest } from "@/lib/lol/publicAccess.server";
import { validClientPatch } from "@/lib/lol/augments/ingest";
import { getLolChampions } from "@/lib/lol/champions.server";
import { getMayhemObservationHistory } from "@/lib/lol/mayhemObservationHistory.server";

export const dynamic = "force-dynamic";
const reply = (body: unknown, status = 200) => NextResponse.json(body, { status, headers: {
  "Cache-Control": "private, no-store", "X-Content-Type-Options": "nosniff",
} });

export async function GET(request: Request, { params }: { params: Promise<{ championId: string }> }) {
  if (process.env.LOL_MAYHEM_CHAMPION_DATASET_ENABLED !== "true") return reply({ error: "요청한 자료를 찾을 수 없습니다." }, 404);
  const denied = await guardLolPublicRequest(request, "read");
  if (denied) return denied;
  const { championId } = await params;
  const query = new URL(request.url).searchParams;
  const patch = query.get("patch");
  if (!/^[1-9][0-9]{0,4}$/.test(championId) || !patch || !validClientPatch(patch)
    || query.getAll("patch").length !== 1 || [...query.keys()].some(key => key !== "patch")) {
    return reply({ error: "챔피언과 패치를 확인해 주세요." }, 400);
  }
  try {
    const champions = await getLolChampions();
    if (!champions) return reply({ error: "챔피언 목록을 불러오지 못했습니다." }, 503);
    if (!champions.champions.some(champion => champion.id === Number(championId))) return reply({ error: "챔피언을 확인해 주세요." }, 400);
    return reply({ history: await getMayhemObservationHistory(patch, Number(championId)) });
  } catch {
    return reply({ error: "관측 이력을 불러오지 못했습니다." }, 503);
  }
}
