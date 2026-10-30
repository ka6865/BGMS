import type { Metadata } from "next";
import { requireLolLivePage } from "@/lib/lol/publicAccess.server";
import { LOL_RIOT_ID_ERROR, lolRiotIdPath, parseLolRiotIdParam } from "@/lib/lol/riotId";
import LolLiveGamePanel from "@/components/lol/LolLiveGamePanel";

type Props = { params: Promise<{ riotId: string }> };

async function resolveRiotId(params: Props["params"]) {
  return parseLolRiotIdParam((await params).riotId);
}

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  requireLolLivePage();
  const riotId = await resolveRiotId(params);
  return {
    title: { absolute: riotId ? `${riotId} 진행 중인 게임 - BGMS LoL` : "BGMS LoL 진행 중인 게임" },
    robots: { index: false, follow: false },
  };
}

export default async function LolLiveGamePage({ params }: Props): Promise<React.ReactNode> {
  requireLolLivePage();
  const riotId = await resolveRiotId(params);
  const backHref = riotId ? lolRiotIdPath(riotId, "/lol/kr") ?? "/lol/kr" : "/lol/kr";
  return <LolLiveGamePanel publicView apiBase="/api/lol" backHref={backHref} initialRiotId={riotId ?? undefined}
    initialError={riotId ? undefined : LOL_RIOT_ID_ERROR} />;
}
