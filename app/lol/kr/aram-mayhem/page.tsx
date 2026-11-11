import type { Metadata } from "next";
import { requireLolPublicPage } from "@/lib/lol/publicAccess.server";
import LolMayhemView from "@/components/lol/LolMayhemView";
import { LolMayhemChampionLinks } from "@/components/lol/LolMayhemSeoSections";
import { loadMayhemPage } from "@/lib/lol/mayhemPage.server";
import { MAYHEM_PATH, mayhemMetadata } from "@/lib/lol/mayhemSeo";

export const metadata: Metadata = mayhemMetadata("증바람 증강 도감·챔피언별 추천 증강 - BGMS LoL",
  "LoL 무작위 총력전: 아수라장(증바람) 증강 도감과 챔피언별 증강 선택률, 패치별 증강 순위, 유저 조합 제보와 질문을 확인하세요.", MAYHEM_PATH);

type Props = { searchParams: Promise<Record<string, string | string[] | undefined>> };

export default async function LolAramMayhemPage({ searchParams }: Props) {
  requireLolPublicPage();
  const { view } = await searchParams;
  const data = await loadMayhemPage();
  return <LolMayhemView catalog={data.catalog?.view ?? null} error={data.catalog === undefined} dataset={data.dataset} champions={data.champions?.champions} championStatsEnabled={data.championStatsEnabled}
    championVersion={data.champions?.version} itemsEnabled={data.itemsEnabled} championTiers={data.championTiers} patchRankingsEnabled patchNotes={data.patchNotes} tipItems={data.tipItems}
    offerRules={data.offerRules} initialView={typeof view === "string" ? view : undefined}>
    <LolMayhemChampionLinks champions={data.champions?.champions ?? []} />
  </LolMayhemView>;
}
