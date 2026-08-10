import { Metadata } from 'next';
import { getTabSeo } from '@/lib/seo-config';
import StatSearch from '@/components/stat/StatSearch';
import { redirect } from 'next/navigation';
import { parseStatsPlatform, parseStatsSectionTab } from '@/lib/stats/statsPageModel';

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
  
  const baseUrl = process.env.NEXT_PUBLIC_SITE_URL || "https://bgms.kr";
  let canonicalUrl = `${baseUrl}/stats/${platform}/${nickname}`;
  
  if (tab) {
    canonicalUrl += `?tab=${encodeURIComponent(tab)}`;
    if (groupKey) {
      canonicalUrl += `&groupKey=${encodeURIComponent(groupKey)}`;
    }
  }

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
      ? `${decodedNickname} AI 스쿼드 분석 리포트 | BGMS`
      : `${decodedNickname} 전적 분석 | BGMS`,
    description: isSquad
      ? `${decodedNickname}님의 PUBG AI 스쿼드 협동 분석 리포트를 확인하세요. 스쿼드 밸런스 등급, 백업 시간, 대열 유지율 및 Gemini tactical 코칭을 확인하세요.`
      : `${decodedNickname}님의 PUBG AI 정밀 전술 분석 리포트를 확인하세요. KDA, 평균 딜량, 생존 시간, 전술 티어를 BGMS에서 분석합니다.`,
    alternates: {
      canonical: canonicalUrl,
    },
    openGraph: {
      title: isSquad
        ? `${decodedNickname} AI 스쿼드 분석 리포트 | BGMS`
        : `${decodedNickname} 전적 분석 | BGMS`,
      description: isSquad
        ? `${decodedNickname}님의 PUBG AI 스쿼드 협동 분석 리포트`
        : `${decodedNickname}님의 PUBG AI 전술 분석을 확인하세요.`,
      url: canonicalUrl,
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

  return (
    <StatSearch
      initialPlatform={validPlatform}
      initialNickname={decodedNickname}
      initialTab={parseStatsSectionTab(tab)}
      initialGroupKey={groupKey}
    />
  );
}
