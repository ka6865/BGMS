import { requireLolPublicPage } from "@/lib/lol/publicAccess.server";
import { getLolLadderDaily } from "@/lib/lol/ladder.server";
import { lolKstDay } from "@/lib/lol/ladder";
import LolLadderView from "@/components/lol/LolLadderView";

export default async function LolLadderPage() {
  requireLolPublicPage();
  const rows = await getLolLadderDaily().catch(() => null);
  return <LolLadderView rows={rows ?? []} today={lolKstDay()} error={rows === null} />;
}
