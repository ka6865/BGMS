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
import { getMayhemPatchNotes } from "@/lib/lol/augments/patchNotes.server";
import { getMayhemTipItems } from "@/lib/lol/mayhemTips.server";

export const metadata: Metadata = { title: { absolute: "BGMS | LoL 증바람 증강" } };

export default async function LolAramMayhemPage() {
  requireLolPublicPage();
  // 조회 실패(undefined)와 아직 게시본이 없는 상태(null)의 안내를 나눈다.
  const catalog = await getCachedLolAugmentCatalog(null).catch(() => undefined);
  const dataset = catalog ? await getPublicMayhemDataset(catalog.view.clientPatch).catch(() => null) : null;
  const championStatsEnabled = process.env.LOL_MAYHEM_CHAMPION_DATASET_ENABLED === "true";
  const itemsEnabled = process.env.LOL_MAYHEM_ITEMS_ENABLED === "true";
  // 조합 제보는 운영 DB에 테이블을 만든 뒤 켠다.
  const tipsEnabled = process.env.LOL_MAYHEM_TIPS_ENABLED === "true";
  const champions = dataset || championStatsEnabled || itemsEnabled || tipsEnabled ? await getLolChampions() : null;
  // 아이템 목록을 못 불러와도 증강만으로 제보할 수 있게 빈 목록으로 연다.
  const tipItems = tipsEnabled && catalog && champions ? await getMayhemTipItems(champions.version).catch(() => []) : null;
  const championTiers = referencePublicEnabled()
    ? await getPublicReference("champion_tiers").catch(() => null)
    : parseMayhemChampionTiers(tierSnapshot);
  // 패치노트는 부가 정보라 실패해도 나머지 화면은 그대로 보여준다.
  const patchNotes = catalog ? await getMayhemPatchNotes(catalog.view.clientPatch).catch(() => []) : [];
  return <LolMayhemView catalog={catalog?.view ?? null} error={catalog === undefined} dataset={dataset} champions={champions?.champions} championStatsEnabled={championStatsEnabled} championVersion={champions?.version} itemsEnabled={itemsEnabled} championTiers={championTiers} patchRankingsEnabled patchNotes={patchNotes} tipItems={tipItems} />;
}
