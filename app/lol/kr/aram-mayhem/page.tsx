import type { Metadata } from "next";
import { requireLolPublicPage } from "@/lib/lol/publicAccess.server";
import { getCachedLolAugmentCatalog } from "@/lib/lol/augments/catalog.server";
import LolMayhemView from "@/components/lol/LolMayhemView";
import { getPublicMayhemDataset } from "@/lib/lol/mayhemDatasetStore.server";
// 새 저장 경로를 활성화하기 전의 공개 화면을 유지하는 전환용 자료다.
import tierSnapshot from "@/lib/lol/data/mayhem-champion-tiers.json";
import { parseMayhemChampionTiers } from "@/lib/lol/mayhemChampionTiers";
import { getLolChampions } from "@/lib/lol/champions.server";
import { getPublicReference, referencePublicEnabled } from "@/lib/lol/mayhemReferenceStore.server";

export const metadata: Metadata = { title: { absolute: "BGMS | LoL 증바람 증강" } };

export default async function LolAramMayhemPage() {
  requireLolPublicPage();
  // 조회 실패(undefined)와 아직 게시본이 없는 상태(null)의 안내를 나눈다.
  const catalog = await getCachedLolAugmentCatalog(null).catch(() => undefined);
  const dataset = catalog ? await getPublicMayhemDataset(catalog.view.clientPatch).catch(() => null) : null;
  const championStatsEnabled = process.env.LOL_MAYHEM_CHAMPION_DATASET_ENABLED === "true";
  const itemsEnabled = process.env.LOL_MAYHEM_ITEMS_ENABLED === "true";
  const champions = dataset || championStatsEnabled || itemsEnabled ? await getLolChampions() : null;
  const championTiers = referencePublicEnabled()
    ? catalog ? await getPublicReference("champion_tiers", catalog.view.clientPatch).catch(() => null) : null
    : parseMayhemChampionTiers(tierSnapshot);
  return <LolMayhemView catalog={catalog?.view ?? null} error={catalog === undefined} dataset={dataset} champions={champions?.champions} championStatsEnabled={championStatsEnabled} championVersion={champions?.version} itemsEnabled={itemsEnabled} championTiers={championTiers} patchRankingsEnabled />;
}
