import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { requireLolPublicPage } from "@/lib/lol/publicAccess.server";
import { getLolChampions } from "@/lib/lol/champions.server";
import { getLolChampionDetailStats } from "@/lib/lol/championStats.server";
import { getLolBuildCatalog } from "@/lib/lol/riotSearch.server";
import { LOL_STAT_POSITIONS, lolStatTierFilter, type LolStatPosition } from "@/lib/lol/championStats";
import LolChampionDetail from "@/components/lol/LolChampionDetail";

type Props = { params: Promise<{ champion: string }>; searchParams: Promise<Record<string, string | string[] | undefined>> };

async function findChampion(params: Props["params"]) {
  const slug = (await params).champion.toLowerCase();
  if (!/^[a-z0-9]{1,40}$/.test(slug)) return { data: null, champion: null };
  const data = await getLolChampions().catch(() => null);
  return { data, champion: data?.champions.find(item => item.imageId.toLowerCase() === slug) ?? null };
}

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  requireLolPublicPage();
  const { champion } = await findChampion(params);
  return { title: { absolute: champion ? `${champion.name} 통계 - BGMS LoL` : "BGMS LoL 챔피언" }, robots: { index: false, follow: false } };
}

export default async function LolChampionDetailPage({ params, searchParams }: Props) {
  requireLolPublicPage();
  const { data, champion } = await findChampion(params);
  if (!data) return <main className="mx-auto w-full max-w-5xl px-4 py-6 text-sm text-amber-300">챔피언 정보를 불러오지 못했습니다. 잠시 후 다시 확인해 주세요.</main>;
  if (!champion) notFound();
  const query = await searchParams;
  const tier = lolStatTierFilter(typeof query.tier === "string" ? query.tier : undefined);
  const [stats, catalog] = await Promise.all([
    getLolChampionDetailStats(champion.id, tier.tiers).catch(() => null),
    getLolBuildCatalog().catch(() => null),
  ]);
  const requested = LOL_STAT_POSITIONS.find(item => item === query.position) as LolStatPosition | undefined;
  const position = stats?.positions.find(item => item.team_position === requested)?.team_position
    ?? stats?.positions[0]?.team_position ?? requested ?? null;
  return <LolChampionDetail champion={champion} champions={data.champions} version={data.version} stats={stats}
    catalog={catalog} position={position} tierFilter={tier.id} />;
}
