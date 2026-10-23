import type { Metadata } from "next";
import { requireLolDevPageAdmin } from "@/lib/lol/access.server";
import { LOL_RIOT_ID_ERROR, parseLolRiotIdParam } from "@/lib/lol/riotId";
import LolOpsPanel from "@/components/lol/LolOpsPanel";
import LolSearchPanel from "@/components/lol/LolSearchPanel";

type Props = { params: Promise<{ riotId: string }> };

async function resolveRiotId(params: Props["params"]) {
  return parseLolRiotIdParam((await params).riotId);
}

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  await requireLolDevPageAdmin();
  const riotId = await resolveRiotId(params);
  return {
    title: { absolute: riotId ? `${riotId} - LoL 비공개 개발` : "LoL 비공개 개발" },
    robots: { index: false, follow: false },
  };
}

export default async function LolRiotIdPage({ params }: Props): Promise<React.ReactNode> {
  await requireLolDevPageAdmin();
  const riotId = await resolveRiotId(params);
  return <LolSearchPanel adminTools={<LolOpsPanel />} initialRiotId={riotId ?? undefined} initialError={riotId ? undefined : LOL_RIOT_ID_ERROR} />;
}
