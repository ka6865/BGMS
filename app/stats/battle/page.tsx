// app/stats/battle/page.tsx
// Server Component — searchParams로 OG 메타데이터를 생성하고 BattleClient를 렌더링합니다.

import { Metadata } from "next";
import BattleClient from "./BattleClient";

const baseUrl = process.env.NEXT_PUBLIC_SITE_URL || "https://bgms.kr";

interface Props {
  searchParams: Promise<{
    nick1?: string;
    nick2?: string;
    matchType?: string;
    score1?: string;
    score2?: string;
    winner?: string;
    platform1?: string;
    platform2?: string;
  }>;
}

export async function generateMetadata({ searchParams }: Props): Promise<Metadata> {
  const params = await searchParams;
  const nick1 = params?.nick1 || "";
  const nick2 = params?.nick2 || "";
  const score1 = params?.score1 || "";
  const score2 = params?.score2 || "";
  const winner = params?.winner || "";
  const platform1 = params?.platform1 || "";
  const platform2 = params?.platform2 || "";

  const hasPlayers = nick1 && nick2;
  const hasScore = score1 !== "" && score2 !== "";

  const title = hasPlayers
    ? `${nick1} vs ${nick2} 전적 비교 | BGMS`
    : "전적 비교 배틀 | BGMS";

  const description = hasPlayers && hasScore
    ? `${nick1} ${score1} : ${score2} ${nick2} — BGMS 전적 비교 결과. KDA, 딜량, 생존 시간 등 항목별 비교를 확인하세요.`
    : hasPlayers
    ? `${nick1}과 ${nick2}의 PUBG 전적을 AI로 항목별 비교합니다. KDA, 딜량, 생존 시간 등을 BGMS에서 확인하세요.`
    : "두 플레이어의 PUBG 전적을 AI로 항목별 비교 대결합니다.";

  // OG 이미지 API Route에 score, winner 포함
  const ogParams = new URLSearchParams();
  if (nick1) ogParams.set("nick1", nick1);
  if (nick2) ogParams.set("nick2", nick2);
  if (platform1) ogParams.set("platform1", platform1);
  if (platform2) ogParams.set("platform2", platform2);
  if (hasScore) {
    ogParams.set("score1", score1);
    ogParams.set("score2", score2);
  }
  if (winner) ogParams.set("winner", winner);

  const ogImageUrl = `${baseUrl}/api/og/battle?${ogParams.toString()}`;

  return {
    title,
    description,
    openGraph: {
      title,
      description,
      url: `${baseUrl}/stats/battle`,
      siteName: "BGMS",
      locale: "ko_KR",
      type: "website",
      images: [{ url: ogImageUrl, width: 1200, height: 630, alt: title }],
    },
    twitter: {
      card: "summary_large_image",
      title,
      description,
      images: [ogImageUrl],
    },
  };
}

export default function BattlePage() {
  return <BattleClient />;
}
