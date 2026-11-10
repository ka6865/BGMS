import { NextResponse } from "next/server";
import { guardLolPublicRequest } from "@/lib/lol/publicAccess.server";
import { validClientPatch } from "@/lib/lol/augments/ingest";
import { archivePage, isMayhemAvailability } from "@/lib/lol/mayhemArchive";
import { getPublicMayhemArchive } from "@/lib/lol/mayhemArchive.server";
export const dynamic = "force-dynamic";
const headers = { "Cache-Control": "private, no-store", "X-Content-Type-Options": "nosniff" };
const reply = (value: unknown, status = 200) => NextResponse.json(value, { status, headers });
export async function GET(request: Request) {
  if (process.env.LOL_MAYHEM_DATASET_ENABLED !== "true") return reply({ error: "요청한 자료를 찾을 수 없습니다." }, 404);
  const denied = await guardLolPublicRequest(request, "read");
  if (denied) return denied;
  const params = new URL(request.url).searchParams, patch = params.get("patch"), kind = params.get("kind") ?? "combos", status = params.get("status") ?? "active", query = params.get("q") ?? "";
  const rawOffset = params.get("offset") ?? "0", rawChampion = params.get("championId"), type = params.get("type");
  if ([...params.keys()].some(key => !["patch", "kind", "status", "q", "offset", "championId", "type"].includes(key) || params.getAll(key).length !== 1)
    || !patch || !validClientPatch(patch) || (kind !== "augments" && kind !== "combos") || (status !== "all" && !isMayhemAvailability(status))
    || query.length > 100 || /[\u0000-\u001f\u007f]/.test(query) || !/^(0|[1-9][0-9]{0,3})$/.test(rawOffset)
    || (rawChampion !== null && (!/^[1-9][0-9]{0,5}$/.test(rawChampion) || Number(rawChampion) > 100000)) || (type !== null && (kind !== "combos" || !/^[A-Za-z][A-Za-z0-9_-]{0,31}$/.test(type)))) return reply({ error: "자료 종류와 검색 조건을 확인해 주세요." }, 400);
  try {
    const result = await getPublicMayhemArchive(patch);
    if (!result) return reply({ error: "공개된 보존 자료가 없습니다." }, 404);
    return reply(archivePage(result.archive, { kind, status, query, offset: Number(rawOffset), championId: rawChampion === null ? null : Number(rawChampion), type }, result.publishedAt));
  } catch { return reply({ error: "증강 상태와 조합 자료를 불러오지 못했습니다. 잠시 후 다시 시도해 주세요." }, 503); }
}
