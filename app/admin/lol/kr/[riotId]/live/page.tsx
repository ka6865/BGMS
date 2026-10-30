import type { Metadata } from "next";
import { requireLolDevPageAdmin } from "@/lib/lol/access.server";
import { LOL_RIOT_ID_ERROR, lolRiotIdPath, parseLolRiotIdParam } from "@/lib/lol/riotId";
import LolLiveGamePanel from "@/components/lol/LolLiveGamePanel";

type Props = { params: Promise<{ riotId: string }> };

async function resolveRiotId(params: Props["params"]) {
  return parseLolRiotIdParam((await params).riotId);
}

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  await requireLolDevPageAdmin();
  const riotId = await resolveRiotId(params);
  return {
    title: { absolute: riotId ? `${riotId} 진행 중인 게임 - LoL 비공개 개발` : "LoL 비공개 개발" },
    robots: { index: false, follow: false },
  };
}

// 관리자 확인 화면은 LOL_LIVE_ENABLED와 무관하게 기존 관리자 가드만 거친다.
export default async function LolAdminLiveGamePage({ params }: Props): Promise<React.ReactNode> {
  await requireLolDevPageAdmin();
  const riotId = await resolveRiotId(params);
  const backHref = riotId ? lolRiotIdPath(riotId, "/admin/lol/kr") ?? "/admin/lol" : "/admin/lol";
  return <LolLiveGamePanel apiBase="/api/admin/lol" backHref={backHref} initialRiotId={riotId ?? undefined}
    initialError={riotId ? undefined : LOL_RIOT_ID_ERROR} />;
}
