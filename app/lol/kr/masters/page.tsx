import { notFound } from "next/navigation";
import { requireLolPublicPage } from "@/lib/lol/publicAccess.server";
import { getLolChampions } from "@/lib/lol/champions.server";
import { getCachedLolMasterBoard } from "@/lib/lol/ranking.server";
import { lolMastersPublic } from "@/lib/lol/ranking";
import LolMastersView from "@/components/lol/LolMastersView";

type Props = { searchParams: Promise<Record<string, string | string[] | undefined>> };

export default async function LolMastersPage({ searchParams }: Props) {
  requireLolPublicPage();
  // 장인 탭은 LOL_MASTERS_PUBLIC=true일 때만 열고, 꺼져 있으면 경로 자체를 404로 둔다.
  if (!lolMastersPublic()) notFound();
  const params = await searchParams;
  const selected = typeof params.champion === "string" ? Number(params.champion) : Number.NaN;
  const [data, board] = await Promise.all([
    getLolChampions().catch(() => null),
    getCachedLolMasterBoard().then(value => ({ board: value, error: false }), () => ({ board: null, error: true })),
  ]);
  return <LolMastersView
    champions={data?.champions ?? []}
    version={data?.version ?? null}
    championsError={data === null}
    board={board.board}
    boardError={board.error}
    selectedId={Number.isSafeInteger(selected) ? selected : undefined}
  />;
}
