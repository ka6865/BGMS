import { NextResponse } from "next/server";
import { guardLolPublicRequest } from "@/lib/lol/publicAccess.server";
import { validClientPatch } from "@/lib/lol/augments/ingest";
import { archivePage, isMayhemAvailability } from "@/lib/lol/mayhemArchive";
import { getPublicMayhemArchive } from "@/lib/lol/mayhemArchive.server";
import { getCachedLolAugmentCatalog } from "@/lib/lol/augments/catalog.server";
import { LOL_AUGMENT_ICON_PATH } from "@/lib/lol/augments/catalog";
import retiredIcons from "@/lib/lol/data/mayhem-retired-icons.json";
export const dynamic = "force-dynamic";
const headers = { "Cache-Control": "private, no-store", "X-Content-Type-Options": "nosniff" };
const reply = (value: unknown, status = 200) => NextResponse.json(value, { status, headers });
export async function GET(request: Request) {
  if (process.env.LOL_MAYHEM_DATASET_ENABLED !== "true") return reply({ error: "요청한 자료를 찾을 수 없습니다." }, 404);
  const denied = await guardLolPublicRequest(request, "read");
  if (denied) return denied;
  const params = new URL(request.url).searchParams, patch = params.get("patch"), kind = params.get("kind") ?? "combos", status = params.get("status") ?? "active", query = params.get("q") ?? "";
  const rawOffset = params.get("offset") ?? "0", rawChampion = params.get("championId");
  if ([...params.keys()].some(key => !["patch", "kind", "status", "q", "offset", "championId"].includes(key) || params.getAll(key).length !== 1)
    || !patch || !validClientPatch(patch) || (kind !== "augments" && kind !== "combos") || (status !== "all" && !isMayhemAvailability(status))
    || query.length > 100 || /[\u0000-\u001f\u007f]/.test(query) || !/^(0|[1-9][0-9]{0,3})$/.test(rawOffset)
    || (rawChampion !== null && (!/^[1-9][0-9]{0,5}$/.test(rawChampion) || Number(rawChampion) > 100000))) return reply({ error: "자료 종류와 검색 조건을 확인해 주세요." }, 400);
  try {
    const result = await getPublicMayhemArchive(patch);
    if (!result) return reply({ error: "공개된 보존 자료가 없습니다." }, 404);
    const catalog = await getCachedLolAugmentCatalog(patch).catch(() => null);
    const artwork = Object.fromEntries([
      ...Object.entries(catalog?.artwork ?? {}).filter(([, icon]) => typeof icon === "string" && LOL_AUGMENT_ICON_PATH.test(icon))
        .map(([id, icon]) => [`official:${id}`, `/api/lol/augment-icons/${patch}/${icon}`]),
      ...(retiredIcons.clientPatch === patch ? retiredIcons.images.map(icon => [`external:${icon.externalId}`, `/lol/augment-art/${icon.hash}.webp`]) : []),
    ]);
    return reply(archivePage(result.archive, { kind, status, query, offset: Number(rawOffset), championId: rawChampion === null ? null : Number(rawChampion) }, result.publishedAt, artwork));
  } catch { return reply({ error: "증강 상태와 조합 자료를 불러오지 못했습니다. 잠시 후 다시 시도해 주세요." }, 503); }
}
