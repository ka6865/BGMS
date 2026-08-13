'use client';

import React, { useState, useTransition, useCallback } from 'react';
import { useRouter } from 'next/navigation';
import { Flame, Zap, Trophy, RefreshCw, ExternalLink, ChevronUp } from 'lucide-react';
import AdfitBanner from '@/components/ads/AdfitBanner';
import AdSenseBanner from '@/components/ads/AdSenseBanner';
import { BgmsIcon, type BgmsIconName } from '@/components/common/BgmsIcon';
import type { RankingEntry, GameModeFilter, MatchTypeFilter, PerspectiveFilter } from '@/actions/rankings';

type TabType = 'damage' | 'kills' | 'tier';

interface Props {
  initialDamage: RankingEntry[];
  initialKills: RankingEntry[];
  initialTier: RankingEntry[];
  updatedAt: string;
  initialDamageHasError?: boolean;
  initialKillsHasError?: boolean;
  initialTierHasError?: boolean;
}

const TIER_COLOR: Record<string, string> = {
  S: 'text-yellow-300',
  A: 'text-orange-400',
  B: 'text-blue-400',
  C: 'text-gray-400',
  D: 'text-gray-500',
};

const TIER_BG: Record<string, string> = {
  S: 'bg-yellow-400/15 border-yellow-400/30',
  A: 'bg-orange-400/15 border-orange-400/30',
  B: 'bg-blue-400/15 border-blue-400/30',
  C: 'bg-gray-400/10 border-gray-400/20',
  D: 'bg-gray-500/10 border-gray-500/20',
};

const RANK_MEDAL: Record<number, { icon: BgmsIconName; color: string; glow: string }> = {
  1: { icon: 'rank', color: 'text-yellow-400', glow: 'shadow-[0_0_20px_rgba(250,204,21,0.3)]' },
  2: { icon: 'award', color: 'text-gray-300', glow: 'shadow-[0_0_16px_rgba(209,213,219,0.2)]' },
  3: { icon: 'award', color: 'text-orange-400', glow: 'shadow-[0_0_16px_rgba(251,146,60,0.2)]' },
};

const MODE_FILTERS: { label: string; value: GameModeFilter }[] = [
  { label: '전체', value: 'all' },
  { label: '스쿼드', value: 'squad' },
  { label: '듀오', value: 'duo' },
  { label: '솔로', value: 'solo' },
];

const MATCH_TYPE_FILTERS: { label: string; value: MatchTypeFilter }[] = [
  { label: '전체', value: 'all' },
  { label: '경쟁전(랭크)', value: 'competitive' },
  { label: '일반', value: 'official' },
];

const PERSPECTIVE_FILTERS: { label: string; value: PerspectiveFilter }[] = [
  { label: '전체', value: 'all' },
  { label: 'FPP (1인칭)', value: 'fpp' },
  { label: 'TPP (3인칭)', value: 'tpp' },
];

const RANKINGS_MOBILE_AD_UNIT = 'DAN-tQGcqmddMC8tPpXA';
const RANKINGS_DESKTOP_AD_UNIT = 'DAN-RjyosR2uf8eSsVIC';
const RANKINGS_ADSENSE_SLOT = '7728921550';

function formatUpdatedAt(iso: string): string {
  const parts = new Intl.DateTimeFormat('en-US-u-nu-latn', {
    timeZone: 'Asia/Seoul',
    month: 'numeric',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(new Date(iso));
  const values = Object.fromEntries(parts.map(({ type, value }) => [type, value]));
  const hour = Number(values.hour);
  const displayHour = hour % 12 || 12;
  const period = hour < 12 ? '오전' : '오후';

  return `${values.month}월 ${values.day}일 ${period} ${displayHour}:${values.minute}`;
}

function timeAgo(iso: string, referenceIso: string): string {
  const diff = (new Date(referenceIso).getTime() - new Date(iso).getTime()) / 1000;
  if (diff < 3600) return `${Math.floor(diff / 60)}분 전`;
  if (diff < 86400) return `${Math.floor(diff / 3600)}시간 전`;
  return `${Math.floor(diff / 86400)}일 전`;
}

function RankRow({
  entry,
  tab,
  index,
  referenceTime,
}: {
  entry: RankingEntry;
  tab: TabType;
  index: number;
  referenceTime: string;
}) {
  const router = useRouter();
  const medal = RANK_MEDAL[entry.rank];
  const tierColor = TIER_COLOR[entry.tier || 'C'] || 'text-gray-400';
  const tierBg = TIER_BG[entry.tier || 'C'] || 'bg-gray-400/10 border-gray-400/20';

  const handleClick = () => {
    const displayName = entry.nickname || entry.player_id;
    router.push(`/stats/steam/${encodeURIComponent(displayName)}`);
  };

  return (
    <div
      onClick={handleClick}
      className="group flex items-center gap-3 md:gap-4 px-4 md:px-5 py-3.5 rounded-2xl cursor-pointer transition-all duration-200 hover:bg-white/5 active:scale-[0.99]"
      style={{
        borderBottom: '1px solid rgba(255,255,255,0.04)',
        animationDelay: `${index * 30}ms`,
      }}
    >
      {/* 순위 */}
      <div className="w-8 flex-shrink-0 text-center">
        {medal ? (
          <BgmsIcon name={medal.icon} size={22} className={`mx-auto ${medal.color}`} />
        ) : (
          <span className="text-sm font-bold text-gray-600">{entry.rank}</span>
        )}
      </div>

      {/* 닉네임 + 뱃지 */}
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2 flex-wrap">
          <span className={`font-bold text-sm md:text-base truncate ${medal ? medal.color : 'text-gray-200'} group-hover:text-white transition-colors`}>
            {entry.nickname || entry.player_id}
          </span>
          <span className={`inline-flex items-center px-2 py-0.5 rounded-lg text-[10px] font-bold border ${tierBg} ${tierColor} flex-shrink-0`}>
            {entry.tier || 'C'}
          </span>
        </div>
        <div className="flex items-center gap-2 mt-0.5 flex-wrap">
          <span className="text-[10px] text-gray-600">{entry.game_mode}</span>
          {entry.map_name && <span className="text-[10px] text-gray-600">· {entry.map_name}</span>}
          {entry.match_count && <span className="text-[10px] text-gray-600">· {entry.match_count}경기</span>}
          {entry.created_at && (
            <span className="text-[10px] text-gray-700">
              {timeAgo(entry.created_at, referenceTime)}
            </span>
          )}
        </div>
      </div>

      {/* 수치 */}
      <div className="flex-shrink-0 text-right">
        <div className={`text-lg md:text-xl font-black tabular-nums ${medal ? medal.color : 'text-white'}`}>
          {tab === 'tier'
            ? entry.value.toFixed(0)
            : tab === 'damage'
            ? entry.value.toLocaleString()
            : entry.value}
        </div>
        <div className="text-[10px] text-gray-600 mt-0.5">
          {tab === 'tier' && 'SCORE'}
          {tab === 'damage' && `${entry.secondary}킬`}
          {tab === 'kills' && `${entry.secondary?.toLocaleString()}딜`}
        </div>
      </div>

      {/* 외부 링크 아이콘 */}
      <ExternalLink size={14} className="text-gray-700 group-hover:text-gray-400 transition-colors flex-shrink-0" />
    </div>
  );
}

export default function RankingsClient({
  initialDamage,
  initialKills,
  initialTier,
  updatedAt,
  initialDamageHasError = false,
  initialKillsHasError = false,
  initialTierHasError = false,
}: Props) {
  const [tab, setTab] = useState<TabType>('damage');
  const [modeFilter, setModeFilter] = useState<GameModeFilter>('all');
  const [perspectiveFilter, setPerspectiveFilter] = useState<PerspectiveFilter>('all');
  const [matchTypeFilter, setMatchTypeFilter] = useState<MatchTypeFilter>('all');
  
  const [damageData, setDamageData] = useState(initialDamage);
  const [killsData, setKillsData] = useState(initialKills);
  const [tierData, setTierData] = useState(initialTier);
  const [damageHasError, setDamageHasError] = useState(initialDamageHasError);
  const [killsHasError, setKillsHasError] = useState(initialKillsHasError);
  const [tierHasError, setTierHasError] = useState(initialTierHasError);
  const [lastUpdated, setLastUpdated] = useState(updatedAt);
  const [isPending, startTransition] = useTransition();

  const fetchUpdatedData = useCallback((mode: GameModeFilter, perspective: PerspectiveFilter, matchType: MatchTypeFilter) => {
    startTransition(async () => {
      const { getWeeklyTopDamage, getWeeklyTopKills, getTopTierRanking } = await import('@/actions/rankings');
      const [d, k, t] = await Promise.all([
        getWeeklyTopDamage(mode, perspective, matchType),
        getWeeklyTopKills(mode, perspective, matchType),
        getTopTierRanking(mode, perspective, matchType),
      ]);
      setDamageData(d.data);
      setKillsData(k.data);
      setTierData(t.data);
      setDamageHasError(d.hasError);
      setKillsHasError(k.hasError);
      setTierHasError(t.hasError);
      setLastUpdated(new Date().toISOString());
    });
  }, []);

  const handleRefresh = useCallback(() => {
    fetchUpdatedData(modeFilter, perspectiveFilter, matchTypeFilter);
  }, [fetchUpdatedData, modeFilter, perspectiveFilter, matchTypeFilter]);

  const handleModeChange = useCallback((mode: GameModeFilter) => {
    setModeFilter(mode);
    fetchUpdatedData(mode, perspectiveFilter, matchTypeFilter);
  }, [fetchUpdatedData, perspectiveFilter, matchTypeFilter]);

  const handlePerspectiveChange = useCallback((perspective: PerspectiveFilter) => {
    setPerspectiveFilter(perspective);
    fetchUpdatedData(modeFilter, perspective, matchTypeFilter);
  }, [fetchUpdatedData, modeFilter, matchTypeFilter]);

  const handleMatchTypeChange = useCallback((matchType: MatchTypeFilter) => {
    setMatchTypeFilter(matchType);
    fetchUpdatedData(modeFilter, perspectiveFilter, matchType);
  }, [fetchUpdatedData, modeFilter, perspectiveFilter]);

  const currentData = tab === 'damage' ? damageData : tab === 'kills' ? killsData : tierData;
  const currentHasError = tab === 'damage' ? damageHasError : tab === 'kills' ? killsHasError : tierHasError;

  const tabs = [
    { id: 'damage' as TabType, label: '이번 주 딜량', icon: Flame, color: 'text-orange-400', activeBg: 'bg-orange-400/15 border-orange-400/30' },
    { id: 'kills' as TabType, label: '이번 주 킬', icon: Zap, color: 'text-yellow-400', activeBg: 'bg-yellow-400/15 border-yellow-400/30' },
    { id: 'tier' as TabType, label: 'BGMS 티어', icon: Trophy, color: 'text-indigo-400', activeBg: 'bg-indigo-400/15 border-indigo-400/30' },
  ];


  return (
    <div className="min-h-screen bg-[#080808] text-white">
      {/* 헤더 */}
      <div className="relative overflow-hidden">
        <div className="absolute inset-0 bg-gradient-to-b from-indigo-900/20 via-transparent to-transparent pointer-events-none" />
        <div className="absolute top-0 left-1/2 -translate-x-1/2 w-[600px] h-[200px] bg-indigo-500/10 rounded-full blur-3xl pointer-events-none" />
        <div className="relative max-w-2xl mx-auto px-4 pt-8 pb-4">
          <div className="flex items-center justify-between mb-2">
            <div>
              <h1 className="text-2xl md:text-3xl font-black tracking-tight flex items-center gap-2">
                <Trophy size={28} className="text-yellow-400" />
                랭킹
              </h1>
              <p className="text-gray-500 text-xs mt-1">아시아 서버 BGMS 분석 데이터 기준</p>
            </div>
            <button
              onClick={handleRefresh}
              disabled={isPending}
              className="flex items-center gap-1.5 px-3 py-2 bg-white/5 hover:bg-white/10 border border-white/10 rounded-xl text-xs text-gray-400 transition-all disabled:opacity-40"
            >
              <RefreshCw size={13} className={isPending ? 'animate-spin' : ''} />
              새로고침
            </button>
          </div>
          <p className="text-[10px] text-gray-700">
            업데이트: {formatUpdatedAt(lastUpdated)}
          </p>
        </div>
      </div>

      {/* 탭 */}
      <div className="relative max-w-2xl mx-auto px-4">
        <div className="flex gap-2 mb-4 overflow-x-auto no-scrollbar pb-1">
          {tabs.map((t) => {
            const isActive = tab === t.id;
            return (
              <button
                key={t.id}
                onClick={() => setTab(t.id)}
                className={`flex items-center gap-1.5 px-4 py-2 rounded-xl text-xs font-bold border whitespace-nowrap transition-all flex-shrink-0 ${
                  isActive
                    ? `${t.activeBg} ${t.color}`
                    : 'bg-white/3 border-white/8 text-gray-500 hover:text-gray-300 hover:bg-white/6'
                }`}
              >
                <t.icon size={13} />
                {t.label}
              </button>
            );
          })}
        </div>

        {/* 매치 종류 필터 */}
        <div className="mb-4">
          <div className="text-[10px] font-bold text-gray-500 mb-1.5 ml-1 uppercase tracking-wider">매치 종류</div>
          <div className="flex gap-1.5 overflow-x-auto no-scrollbar">
            {MATCH_TYPE_FILTERS.map((m) => (
              <button
                key={m.value}
                onClick={() => handleMatchTypeChange(m.value)}
                className={`px-3 py-1.5 rounded-lg text-[11px] font-bold transition-all whitespace-nowrap flex-shrink-0 border ${
                  matchTypeFilter === m.value
                    ? 'bg-indigo-500/15 border-indigo-500/30 text-indigo-400'
                    : 'bg-white/5 border-transparent text-gray-500 hover:text-gray-300 hover:bg-white/8'
                }`}
              >
                {m.label}
              </button>
            ))}
          </div>
        </div>

        {/* 시점 필터 */}
        <div className="mb-4">
          <div className="text-[10px] font-bold text-gray-500 mb-1.5 ml-1 uppercase tracking-wider">시점</div>
          <div className="flex gap-1.5 overflow-x-auto no-scrollbar">
            {PERSPECTIVE_FILTERS.map((p) => (
              <button
                key={p.value}
                onClick={() => handlePerspectiveChange(p.value)}
                className={`px-3 py-1.5 rounded-lg text-[11px] font-bold transition-all whitespace-nowrap flex-shrink-0 border ${
                  perspectiveFilter === p.value
                    ? 'bg-sky-500/15 border-sky-500/30 text-sky-400'
                    : 'bg-white/5 border-transparent text-gray-500 hover:text-gray-300 hover:bg-white/8'
                }`}
              >
                {p.label}
              </button>
            ))}
          </div>
        </div>

        {/* 게임 모드 필터 */}
        <div className="mb-5">
          <div className="text-[10px] font-bold text-gray-500 mb-1.5 ml-1 uppercase tracking-wider">게임 모드</div>
          <div className="flex gap-1.5 overflow-x-auto no-scrollbar">
            {MODE_FILTERS.map((m) => (
              <button
                key={m.value}
                onClick={() => handleModeChange(m.value)}
                className={`px-3 py-1.5 rounded-lg text-[11px] font-bold transition-all whitespace-nowrap flex-shrink-0 border ${
                  modeFilter === m.value
                    ? 'bg-[#F2A900]/15 border-[#F2A900]/30 text-[#F2A900]'
                    : 'bg-white/5 border-transparent text-gray-500 hover:text-gray-300 hover:bg-white/8'
                }`}
              >
                {m.label}
              </button>
            ))}
          </div>
        </div>

        {/* 탭 설명 */}
        <div className="mb-3 px-1">
          {tab === 'damage' && <p className="text-[11px] text-gray-600">최근 7일 내 단일 경기 최고 딜량 TOP 30 · 플레이어당 최고 기록만 표시</p>}
          {tab === 'kills' && <p className="text-[11px] text-gray-600">최근 7일 내 단일 경기 최고 킬 TOP 30 · 플레이어당 최고 기록만 표시</p>}
          {tab === 'tier' && <p className="text-[11px] text-gray-600">최근 7일 내 BGMS 전술 분석 점수 TOP 30 · 플레이어당 최고 점수 기준</p>}
        </div>

        <div className="mb-5 flex justify-center xl:hidden" aria-label="광고">
          <AdfitBanner
            adUnit={RANKINGS_MOBILE_AD_UNIT}
            adWidth={320}
            adHeight={100}
          />
        </div>

        {/* 랭킹 리스트 */}
        <div className="bg-white/[0.03] border border-white/[0.06] rounded-3xl overflow-hidden mb-8">
          {/* 컬럼 헤더 */}
          <div className="flex items-center gap-3 md:gap-4 px-4 md:px-5 py-2.5 border-b border-white/[0.06]">
            <div className="w-8 text-center text-[10px] text-gray-700 font-bold">#</div>
            <div className="flex-1 text-[10px] text-gray-700 font-bold">플레이어</div>
            <div className="text-[10px] text-gray-700 font-bold text-right">
              {tab === 'damage' ? '딜량' : tab === 'kills' ? '킬' : '점수'}
            </div>
            <div className="w-4" />
          </div>

          {isPending ? (
            // 스켈레톤
            Array.from({ length: 8 }).map((_, i) => (
              <div key={i} className="flex items-center gap-4 px-5 py-4 border-b border-white/[0.04]">
                <div className="w-8 h-4 bg-white/5 rounded animate-pulse" />
                <div className="flex-1 space-y-1.5">
                  <div className="h-3.5 w-32 bg-white/5 rounded animate-pulse" />
                  <div className="h-2.5 w-20 bg-white/5 rounded animate-pulse" />
                </div>
                <div className="h-5 w-16 bg-white/5 rounded animate-pulse" />
              </div>
            ))
          ) : currentHasError ? (
            <div className="py-16 text-center">
              <BgmsIcon name="message" size={30} className="mx-auto mb-3 text-red-400" />
              <p className="text-gray-300 text-sm">일시적인 문제가 발생했습니다. 잠시 후 다시 시도해 주세요.</p>
              <button
                type="button"
                onClick={handleRefresh}
                className="mt-4 inline-flex items-center gap-2 rounded-lg border border-white/10 bg-white/5 px-4 py-2 text-xs font-bold text-gray-200 transition-colors hover:bg-white/10"
              >
                <RefreshCw size={13} />
                다시 시도
              </button>
            </div>
          ) : currentData.length === 0 ? (
            <div className="py-16 text-center">
              <BgmsIcon name="message" size={30} className="mx-auto mb-3 text-gray-600" />
              <p className="text-gray-500 text-sm">이번 주 데이터가 없습니다</p>
              <p className="text-gray-700 text-xs mt-1">전적 검색 후 데이터가 쌓이면 표시됩니다</p>
            </div>
          ) : (
            currentData.map((entry, i) => (
              <RankRow
                key={`${entry.player_id}-${i}`}
                entry={entry}
                tab={tab}
                index={i}
                referenceTime={lastUpdated}
              />
            ))
          )}
        </div>

        {/* 하단 안내 */}
        <div className="flex items-center gap-2 justify-center pb-24 md:pb-8">
          <ChevronUp size={12} className="text-gray-700" />
          <p className="text-[10px] text-gray-700">닉네임 클릭 시 해당 플레이어 전적 페이지로 이동</p>
        </div>

        <aside className="hidden min-[1880px]:block w-[160px] absolute right-[calc(100%+24px)] top-0 bottom-0 h-auto" aria-label="왼쪽 광고">
          <div className="sticky top-20 h-[600px] w-[160px]">
            <AdSenseBanner
              placementId="rankings-rail-left"
              client="ca-pub-3993032200487955"
              slot={RANKINGS_ADSENSE_SLOT}
            />
          </div>
        </aside>
        <aside className="hidden min-[1880px]:block w-[160px] absolute left-[calc(100%+24px)] top-0 bottom-0 h-auto" aria-label="오른쪽 광고">
          <div className="sticky top-20 h-[600px] w-[160px]">
            <AdfitBanner
              placementId="rankings-rail-right"
              adUnit={RANKINGS_DESKTOP_AD_UNIT}
              adWidth={160}
              adHeight={600}
            />
          </div>
        </aside>
      </div>
    </div>
  );
}
