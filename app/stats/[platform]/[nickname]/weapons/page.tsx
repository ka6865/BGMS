import { Metadata } from 'next';
import { createClient } from '@/utils/supabase/server';
import { isPlayerPrivate } from '@/lib/pubg/privatePlayers';
import { notFound } from 'next/navigation';
import WeaponsClient from './WeaponsClient';

interface Props {
  params: Promise<{
    platform: string;
    nickname: string;
  }>;
}

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { nickname } = await params;
  const decodedNickname = decodeURIComponent(nickname);
  return {
    title: `${decodedNickname} 무기 마스터리 분석 | BGMS`,
    description: `${decodedNickname}님의 PUBG 주력 무기별 누적 킬수, 대미지, 평균 레벨 등 정밀 숙련도 통계 리포트`,
  };
}

export default async function PlayerWeaponsPage({ params }: Props) {
  const { platform, nickname } = await params;
  const decodedNickname = decodeURIComponent(nickname);
  const supabase = await createClient();

  const { data: cacheData } = await supabase
    .from('pubg_player_cache')
    .select('id, weapon_mastery_data, nickname, platform, mastery_updated_at')
    .eq('lower_nickname', decodedNickname.toLowerCase())
    .eq('platform', platform)
    .maybeSingle();

  try {
    if (await isPlayerPrivate(platform, decodedNickname, typeof cacheData?.id === 'string' ? cacheData.id : undefined)) {
      notFound();
    }
  } catch {
    // Do not render cached private-player data when the privacy registry cannot
    // be checked reliably.
    notFound();
  }

  return (
    <WeaponsClient
      nickname={decodedNickname}
      platform={platform}
      cacheData={cacheData}
    />
  );
}
