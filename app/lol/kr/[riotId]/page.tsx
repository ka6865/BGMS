import type { Metadata } from "next";
import { requireLolPublicPage } from "@/lib/lol/publicAccess.server";
import { LOL_RIOT_ID_ERROR, parseLolRiotIdParam } from "@/lib/lol/riotId";
import LolSearchPanel from "@/components/lol/LolSearchPanel";

type Props = { params: Promise<{ riotId: string }> };

async function resolveRiotId(params: Props["params"]) {
  return parseLolRiotIdParam((await params).riotId);
}

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  requireLolPublicPage();
  const riotId = await resolveRiotId(params);
  return {
    title: { absolute: riotId ? `${riotId} - BGMS LoL 전적` : "BGMS LoL 전적" },
    robots: { index: false, follow: false },
  };
}

export default async function LolRiotIdPage({ params }: Props): Promise<React.ReactNode> {
  requireLolPublicPage();
  const riotId = await resolveRiotId(params);
  return <LolSearchPanel publicView initialRiotId={riotId ?? undefined} initialError={riotId ? undefined : LOL_RIOT_ID_ERROR} />;
}
