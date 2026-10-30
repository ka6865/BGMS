import { requireLolPublicPage } from "@/lib/lol/publicAccess.server";
import { getLolLadderDaily } from "@/lib/lol/ladder.server";
import { getCachedLolRankingBoard } from "@/lib/lol/ranking.server";
import { lolKstDay } from "@/lib/lol/ladder";
import LolLadderView from "@/components/lol/LolLadderView";

export default async function LolLadderPage() {
  requireLolPublicPage();
  const [rows, ranking] = await Promise.all([
    getLolLadderDaily().catch(() => null),
    getCachedLolRankingBoard().then(board => ({ board, error: false }), () => ({ board: null, error: true })),
  ]);
  return <LolLadderView rows={rows ?? []} today={lolKstDay()} error={rows === null} ranking={ranking.board} rankingError={ranking.error} />;
}
