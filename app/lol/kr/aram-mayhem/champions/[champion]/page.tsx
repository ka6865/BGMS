import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { requireLolPublicPage } from "@/lib/lol/publicAccess.server";
import { getLolChampions } from "@/lib/lol/champions.server";
import { getPublicChampionStats } from "@/lib/lol/mayhemChampionDatasetStore.server";
import { listMayhemTips } from "@/lib/lol/mayhemTips.server";
import { loadMayhemPage } from "@/lib/lol/mayhemPage.server";
import { mayhemChampionPath, mayhemMetadata } from "@/lib/lol/mayhemSeo";
import LolMayhemView from "@/components/lol/LolMayhemView";
import { LolMayhemChampionLinks, LolMayhemTipLinks } from "@/components/lol/LolMayhemSeoSections";

type Props = { params: Promise<{ champion: string }> };

async function findChampion(params: Props["params"]) {
  const slug = (await params).champion.toLowerCase();
  if (!/^[a-z0-9]{1,40}$/.test(slug)) return null;
  return (await getLolChampions().catch(() => null))?.champions.find(item => item.imageId.toLowerCase() === slug) ?? null;
}

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  requireLolPublicPage();
  const champion = await findChampion(params);
  if (!champion) return { title: { absolute: "BGMS LoL 증바람" }, robots: { index: false, follow: false } };
  return mayhemMetadata(`${champion.name} 증바람 증강 추천·선택률 - BGMS LoL`,
    `무작위 총력전: 아수라장(증바람) ${champion.name} 추천 증강과 선택률, 증바람 아이템, 유저 조합 제보를 확인하세요.`, mayhemChampionPath(champion.imageId));
}

export default async function LolMayhemChampionPage({ params }: Props) {
  requireLolPublicPage();
  const slug = (await params).champion.toLowerCase();
  const data = await loadMayhemPage();
  const champion = data.champions?.champions.find(item => item.imageId.toLowerCase() === slug);
  if (!champion) notFound();
  const patch = data.catalog?.view.clientPatch;
  // 요약은 부가 정보라 읽지 못하면 화면 본문만 보여준다.
  const [stats, tips] = await Promise.all([
    patch && data.championStatsEnabled ? getPublicChampionStats(patch, champion.id, { fallback: true }).catch(() => null) : null,
    patch && data.tipsEnabled ? listMayhemTips(patch, champion.id, null, "top", 0, null).then(page => page.rows.slice(0, 10)).catch(() => []) : [],
  ]);
  const names = new Map(data.catalog?.view.augments.map(augment => [augment.id, augment.name]));
  const top = (stats?.rows ?? []).filter(row => row.reportedPickRate !== null && names.has(row.augmentPlatformId))
    .sort((a, b) => Number(b.reportedPickRate) - Number(a.reportedPickRate)).slice(0, 10);
  return <LolMayhemView catalog={data.catalog?.view ?? null} error={data.catalog === undefined} dataset={data.dataset} champions={data.champions?.champions} championStatsEnabled={data.championStatsEnabled}
    championVersion={data.champions?.version} itemsEnabled={data.itemsEnabled} championTiers={data.championTiers} patchRankingsEnabled patchNotes={data.patchNotes} tipItems={data.tipItems}
    offerRules={data.offerRules} title={`${champion.name} 증바람 증강`} initialChampionId={champion.id}>
    {top.length > 0 && <section className="mt-8">
      <h2 className="text-base font-semibold">{champion.name} 증바람 많이 고르는 증강</h2>
      <ol className="mt-2 list-decimal space-y-1 pl-5 text-sm text-zinc-300">{top.map(row => <li key={row.augmentPlatformId}>
        {names.get(row.augmentPlatformId)} <span className="text-zinc-500">선택률 {(Number(row.reportedPickRate) * 100).toFixed(2)}%</span>
      </li>)}</ol>
    </section>}
    <LolMayhemTipLinks heading={`${champion.name} 유저 조합 제보·질문`} tips={tips} />
    <LolMayhemChampionLinks champions={data.champions?.champions ?? []} />
  </LolMayhemView>;
}
