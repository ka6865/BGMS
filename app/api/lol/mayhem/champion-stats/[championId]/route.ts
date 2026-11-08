import { NextResponse } from "next/server";
import { guardLolPublicRequest } from "@/lib/lol/publicAccess.server";
import { validClientPatch } from "@/lib/lol/augments/ingest";
import { getLolChampions } from "@/lib/lol/champions.server";
import { getPublicChampionStats } from "@/lib/lol/mayhemChampionDatasetStore.server";

export const dynamic = "force-dynamic";
const headers = { "Cache-Control": "private, no-store", "X-Content-Type-Options": "nosniff" };
const reply = (body: unknown, status = 200) => NextResponse.json(body, { status, headers });

export async function GET(request: Request, { params }: { params: Promise<{ championId: string }> }) {
  if (process.env.LOL_MAYHEM_CHAMPION_DATASET_ENABLED !== "true") return reply({ error: "요청한 자료를 찾을 수 없습니다." }, 404);
  const denied = await guardLolPublicRequest(request, "read");
  if (denied) return denied;
  const { championId: rawId } = await params;
  if (!/^[1-9][0-9]{0,8}$/.test(rawId)) return reply({ error: "챔피언과 패치를 확인해 주세요." }, 400);
  const championId = Number(rawId);
  const url = new URL(request.url);
  const patch = url.searchParams.get("patch");
  if (!patch || !validClientPatch(patch) || [...url.searchParams.keys()].some(key => key !== "patch")) return reply({ error: "챔피언과 패치를 확인해 주세요." }, 400);
  try {
    const catalog = await getLolChampions();
    if (!catalog) return reply({ error: "챔피언 목록을 확인할 수 없습니다." }, 503);
    if (!catalog.champions.some(champion => champion.id === championId)) return reply({ error: "챔피언과 패치를 확인해 주세요." }, 400);
    return reply({ dataset: await getPublicChampionStats(patch, championId, { fallback: true }) });
  } catch {
    return reply({ error: "챔피언 통계를 불러오지 못했습니다." }, 503);
  }
}
