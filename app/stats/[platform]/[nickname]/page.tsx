import { Metadata } from 'next';
import { getTabSeo } from '@/lib/seo-config';
import StatSearch from '@/components/stat/StatSearch';
import { redirect } from 'next/navigation';
import { parseStatsPlatform, parseStatsSectionTab } from '@/lib/stats/statsPageModel';
import { getPlayerSeoState } from '@/lib/stats/playerSeo.server';

interface Props {
  params: Promise<{
    platform: string;
    nickname: string;
  }>;
  searchParams: Promise<{ [key: string]: string | string[] | undefined }>;
}

export async function generateMetadata({ params, searchParams }: Props): Promise<Metadata> {
  const { platform, nickname } = await params;
  const sParams = await searchParams;
  
  const tab = typeof sParams.tab === "string" ? sParams.tab : undefined;
  const groupKey = typeof sParams.groupKey === "string" ? sParams.groupKey : undefined;
  
  const decodedNickname = decodeURIComponent(nickname);
  const seo = await getTabSeo("Stats");
  const validPlatform = parseStatsPlatform(platform);
  const seoState = validPlatform ? await getPlayerSeoState(validPlatform, decodedNickname) : { status: "unknown" as const };
  // 비공개 요청 플레이어는 검색 제외와 함께 제목·설명에도 닉네임을 넣지 않는다.
  if (seoState.status === "private") {
    return { ...seo, title: "전적 검색", alternates: undefined, openGraph: undefined, twitter: undefined, robots: { index: false, follow: false } };
  }

  const baseUrl = process.env.NEXT_PUBLIC_SITE_URL || "https://bgms.kr";
  // 탭은 같은 플레이어의 다른 보기라 정식 주소는 플레이어 주소 하나로 둔다.
  const canonicalUrl = `${baseUrl}/stats/${platform}/${nickname}`;
  let shareUrl = canonicalUrl;
  if (tab) {
    shareUrl += `?tab=${encodeURIComponent(tab)}`;
    if (groupKey) {
      shareUrl += `&groupKey=${encodeURIComponent(groupKey)}`;
    }
  }
  const summary = seoState.status === "public" ? seoState.summary : null;

  // tab === "squad" 일 경우 동적 스쿼드 OG 이미지 주입
  const isSquad = tab === "squad";
  const ogImages = isSquad
    ? [
        {
          url: `${baseUrl}/api/og/squad?nickname=${encodeURIComponent(decodedNickname)}&platform=${platform}${
            groupKey ? `&groupKey=${encodeURIComponent(groupKey)}` : ""
          }`,
        },
      ]
    : undefined;

  return {
    ...seo,
    title: isSquad
      ? `${decodedNickname} AI 팀 분석 리포트`
      : `${decodedNickname} 배그 전적 분석`,
    description: isSquad
      ? `${decodedNickname}님의 PUBG AI 팀 협동 분석 리포트를 확인하세요. 팀 기절 후 복수 시간, 소생 기록과 Gemini 코칭을 확인하세요.`
      : summary
        ? `${decodedNickname}님의 배그 최근 시즌 전체 모드 ${summary.rounds}경기 평균 딜량 ${summary.avgDamage}, 경기당 ${summary.killsPerRound}킬, 우승 ${summary.wins}회. AI 전술 분석과 티어를 BGMS에서 확인하세요.`
        : `${decodedNickname}님의 PUBG AI 정밀 전술 분석 리포트를 확인하세요. KDA, 평균 딜량, 생존 시간, 전술 티어를 BGMS에서 분석합니다.`,
    alternates: {
      canonical: canonicalUrl,
    },
    // 실제 검색된 공개 플레이어만 노출한다. 수집만 된 닉네임이나 없는 닉네임은 내용이 비어 제외한다.
    robots: seoState.status === "public" ? undefined : { index: false, follow: true },
    openGraph: {
      title: isSquad
        ? `${decodedNickname} AI 스쿼드 분석 리포트 | BGMS`
        : `${decodedNickname} 전적 분석 | BGMS`,
      description: isSquad
        ? `${decodedNickname}님의 PUBG AI 스쿼드 협동 분석 리포트`
        : `${decodedNickname}님의 PUBG AI 전술 분석을 확인하세요.`,
      url: shareUrl,
      siteName: "BGMS",
      images: ogImages,
      locale: "ko_KR",
      type: "profile",
    },
    twitter: {
      card: "summary_large_image",
      title: isSquad
        ? `${decodedNickname} AI 스쿼드 분석 리포트 | BGMS`
        : `${decodedNickname} 전적 분석 | BGMS`,
      description: isSquad
        ? `${decodedNickname}님의 PUBG AI 스쿼드 협동 분석 리포트 — bgms.kr`
        : `${decodedNickname}님의 PUBG AI 전술 분석 — bgms.kr`,
      images: ogImages ? ogImages.map((img) => img.url) : undefined,
    },
  };
}


export default async function PlayerStatsPage({ params, searchParams }: Props) {
  const [{ platform, nickname }, query] = await Promise.all([params, searchParams]);
  const validPlatform = parseStatsPlatform(platform);
  if (!validPlatform) redirect('/stats');
  const decodedNickname = decodeURIComponent(nickname);
  const tab = typeof query.tab === 'string' ? query.tab : undefined;
  const groupKey = typeof query.groupKey === 'string' ? query.groupKey : undefined;

  const seoState = validPlatform ? await getPlayerSeoState(validPlatform, decodedNickname) : null;
  const summary = seoState?.status === "public" ? seoState.summary : null;

  // 저장된 시즌 합계는 설명 문구에 쓰고, 화면에서는 최근 20경기 요약 위 카드로 보여준다.
  return (
    <StatSearch
      initialPlatform={validPlatform}
      initialNickname={decodedNickname}
      initialTab={parseStatsSectionTab(tab)}
      initialGroupKey={groupKey}
      initialSeasonSummary={summary && seoState?.status === "public" ? { nickname: seoState.nickname, ...summary } : undefined}
    />
  );
}
