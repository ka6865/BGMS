import { requireLolPublicPage } from "@/lib/lol/publicAccess.server";
import { getLolChampions } from "@/lib/lol/champions.server";
import { getLolChampionStats } from "@/lib/lol/championStats.server";
import { LOL_STAT_POSITIONS, lolStatTierFilter, type LolStatPosition } from "@/lib/lol/championStats";
import LolChampionList from "@/components/lol/LolChampionList";

type Props = { searchParams: Promise<Record<string, string | string[] | undefined>> };

export default async function LolChampionsPage({ searchParams }: Props) {
  requireLolPublicPage();
  const params = await searchParams;
  const tier = lolStatTierFilter(typeof params.tier === "string" ? params.tier : undefined);
  const position = LOL_STAT_POSITIONS.find(item => item === params.position) as LolStatPosition | undefined;
  const [data, stats] = await Promise.all([
    getLolChampions().catch(() => null),
    getLolChampionStats(tier.tiers).then(result => ({ ...result, error: false }), () => null),
  ]);
  return <LolChampionList
    champions={data?.champions ?? []}
    version={data?.version ?? null}
    error={data === null}
    initialPosition={position}
    stats={stats ? { patch: stats.patch, matches: stats.matches, rows: stats.rows, tierFilter: tier.id }
      : { patch: null, matches: 0, rows: [], tierFilter: tier.id, error: true }}
  />;
}
