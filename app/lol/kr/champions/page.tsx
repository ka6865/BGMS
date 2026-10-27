import { requireLolPublicPage } from "@/lib/lol/publicAccess.server";
import { getLolChampions } from "@/lib/lol/champions.server";
import LolChampionList from "@/components/lol/LolChampionList";

export default async function LolChampionsPage() {
  requireLolPublicPage();
  const data = await getLolChampions().catch(() => null);
  return <LolChampionList champions={data?.champions ?? []} version={data?.version ?? null} error={data === null} />;
}
