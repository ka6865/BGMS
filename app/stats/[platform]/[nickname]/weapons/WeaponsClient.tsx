"use client";

import React, { useState, useMemo } from 'react';
import Link from 'next/link';
import { AlertCircle, ArrowLeft, Crosshair, RefreshCw, Trophy, Award, Calendar } from 'lucide-react';
import { WEAPON_NAMES } from '@/lib/pubg-analysis/constants';
import { normalizeWeaponMasteryItems, type WeaponMasteryCategory } from '@/lib/pubg/weaponMastery';
import AdSenseBanner from "@/components/ads/AdSenseBanner";
import { ADSENSE_SLOTS } from "@/lib/ads/adsenseUnits";

interface WeaponsClientProps {
  nickname: string;
  platform: string;
  cacheData: any;
}

// 투척물 및 특수 무기, 근접 무기까지 모두 한글화하여 추가
const WEAPON_NAME_MAP: Record<string, string> = {
  Item_Weapon_HK416_C: "M416",
  Item_Weapon_ACE32_C: "ACE32",
  Item_Weapon_BerylM762_C: "베릴 M762",
  Item_Weapon_AKM_C: "AKM",
  Item_Weapon_AK47_C: "AKM",
  Item_Weapon_SCAR_C: "SCAR-L",
  Item_Weapon_SCAR_L_C: "SCAR-L",
  "Item_Weapon_SCAR-L_C": "SCAR-L",
  Item_Weapon_G36C_C: "G36C",
  Item_Weapon_FAMASG2_C: "FAMAS",
  Item_Weapon_K2_C: "K2",
  Item_Weapon_Mk47Mutant_C: "Mk47 Mutant",
  Item_Weapon_Mk12_C: "Mk12",
  Item_Weapon_Mini14_C: "Mini-14",
  Item_Weapon_Mk14_C: "Mk14",
  Item_Weapon_QBZ95_C: "QBZ95",
  Item_Weapon_QBU88_C: "QBU",
  Item_Weapon_Dragunov_C: "드라구노프",
  Item_Weapon_AUG_C: "AUG",
  Item_Weapon_Groza_C: "Groza",
  Item_Weapon_M16A4_C: "M16A4",
  Item_Weapon_M249_C: "M249",
  Item_Weapon_DP28_C: "DP-28",
  Item_Weapon_MG3_C: "MG3",
  Item_Weapon_AWM_C: "AWM",
  Item_Weapon_Kar98k_C: "Kar98k",
  Item_Weapon_M24_C: "M24",
  Item_Weapon_L6_C: "링스 AMR",
  Item_Weapon_Mosin_C: "모신나강",
  Item_Weapon_Win1894_C: "Win94",
  Item_Weapon_SLR_C: "SLR",
  Item_Weapon_FNFal_C: "SLR",
  Item_Weapon_SKS_C: "SKS",
  Item_Weapon_VSS_C: "VSS",
  Item_Weapon_Vector_C: "Vector",
  Item_Weapon_UMP_C: "UMP45",
  Item_Weapon_UMP45_C: "UMP45",
  Item_Weapon_Bizon_C: "PP-19 Bizon",
  Item_Weapon_BizonPP19_C: "PP-19 Bizon",
  Item_Weapon_MP5K_C: "MP5K",
  Item_Weapon_MP9_C: "MP9",
  Item_Weapon_P90_C: "P90",
  Item_Weapon_Thompson_C: "Tommy Gun",
  Item_Weapon_UZI_C: "Micro UZI",
  Item_Weapon_Saiga12_C: "S12K",
  Item_Weapon_Shotgun_C: "S12K",
  Item_Weapon_Winchester_C: "Win94",
  Item_Weapon_Lynx_C: "Lynx AMR",
  Item_Weapon_DBS_C: "DBS",
  Item_Weapon_DP12_C: "DBS",
  Item_Weapon_O12_C: "O12",
  Item_Weapon_OriginS12_C: "O12",
  Item_Weapon_Berreta686_C: "S686",
  Item_Weapon_Sawnoff_C: "소드오프",
  Item_Weapon_SawedOff_C: "소드오프",

  // 권총
  Item_Weapon_M9_C: "P92",
  Item_Weapon_M1911_C: "M1911",
  Item_Weapon_NagantM1895_C: "R1895",
  Item_Weapon_DesertEagle_C: "데저트 이글",
  
  // 투척 무기 및 유틸리티
  Item_Weapon_Grenade_C: "수류탄",
  Item_Weapon_Molotov_C: "화염병",
  Item_Weapon_SmokeBomb_C: "연막탄",
  Item_Weapon_FlashBang_C: "섬광탄",
  Item_Weapon_C4_C: "C4",
  Item_Weapon_BluezoneGrenade_C: "블루존 수류탄",
  Item_Weapon_SpikeStrip_C: "접이식 스파이크",
  Item_Weapon_DecoyGrenade_C: "디코이 수류탄",
  
  // 기타 특수 무기
  Item_Weapon_Mortar_C: "박격포",
  Item_Weapon_PanzerFaust_C: "판저파우스트",
  Item_Weapon_M79_C: "M79",
  
  // 근접 무기
  Item_Weapon_Pan_C: "프라이팬",
  Item_Weapon_Sickle_C: "낫",
  Item_Weapon_Machete_C: "마체테",
  Item_Weapon_Crowbar_C: "빠루",
};

function getWeaponLabel(id: string): string {
  const compactId = id.replace(/^Item_Weapon_/g, "").replace(/_C$/g, "");
  return WEAPON_NAME_MAP[id] ?? WEAPON_NAMES[id] ?? WEAPON_NAMES[compactId] ?? compactId;
}

function getWeaponImageUrl(weaponId: string): string {
  return `https://raw.githubusercontent.com/pubg/api-assets/master/Assets/Item/Weapon/Main/${weaponId}.png`;
}

type MasteryMode = 'all' | 'normal' | 'ranked';
type CategoryFilter = '전체' | WeaponMasteryCategory;

const CATEGORY_FILTERS: CategoryFilter[] = ['전체', 'AR', 'SMG', 'DMR', 'SR', '샷건', 'LMG', '권총', '투척류', '근접/특수', '기타'];

function getKillsByMode(item: any, mode: MasteryMode) {
  if (mode === 'normal') return item.kills ?? 0;
  if (mode === 'ranked') return item.rankKills ?? 0;
  return (item.kills ?? 0) + (item.rankKills ?? 0);
}

function getDisplayStats(item: any, mode: MasteryMode) {
  if (mode === 'normal') {
    return {
      kills: item.kills ?? 0,
      damage: Math.round(item.damagePlayer ?? 0),
      headshots: item.headShots ?? 0,
      longest: item.longestDefeat ?? 0
    };
  }

  if (mode === 'ranked') {
    return {
      kills: item.rankKills ?? 0,
      damage: Math.round(item.rankDamagePlayer ?? 0),
      headshots: item.rankHeadShots ?? 0,
      longest: item.rankLongestDefeat ?? 0
    };
  }

  return {
    kills: (item.kills ?? 0) + (item.rankKills ?? 0),
    damage: Math.round((item.damagePlayer ?? 0) + (item.rankDamagePlayer ?? 0)),
    headshots: (item.headShots ?? 0) + (item.rankHeadShots ?? 0),
    longest: Math.max(item.longestDefeat ?? 0, item.rankLongestDefeat ?? 0)
  };
}

function StatCell({ label, value }: { label: string; value: string }) {
  return (
    <div className="hidden md:block">
      <div className="text-[10px] text-gray-400 font-bold uppercase tracking-wider">{label}</div>
      <div className="text-sm font-black text-gray-200 tabular-nums mt-0.5">{value}</div>
    </div>
  );
}

export default function WeaponsClient({ nickname, platform, cacheData }: WeaponsClientProps) {
  const [masteryMode, setMasteryMode] = useState<MasteryMode>('all');
  const [activeCategory, setActiveCategory] = useState<CategoryFilter>('전체');
  const [imgErrors, setImgErrors] = useState<Record<string, boolean>>({});
  const [weaponMastery, setWeaponMastery] = useState<any[]>(() =>
    normalizeWeaponMasteryItems(Array.isArray(cacheData?.weapon_mastery_data) ? cacheData.weapon_mastery_data : [])
  );
  const [masteryUpdatedAt, setMasteryUpdatedAt] = useState<string | null>(cacheData?.mastery_updated_at ?? null);
  const [refreshing, setRefreshing] = useState(false);
  const [refreshError, setRefreshError] = useState<string | null>(null);
  const [refreshSource, setRefreshSource] = useState<'cache' | 'api' | null>(null);
  
  const hasWeapons = weaponMastery.length > 0;

  // 선택한 모드 기준으로 킬수가 높은 순서로 정렬하여 무기 분석 수행
  const rankedWeapons = useMemo(() => {
    return [...weaponMastery]
      .sort((a, b) => {
        const valA = getKillsByMode(a, masteryMode);
        const valB = getKillsByMode(b, masteryMode);
        if (valB !== valA) return valB - valA;
        if ((b.level ?? 0) !== (a.level ?? 0)) return (b.level ?? 0) - (a.level ?? 0);
        return (b.xp ?? 0) - (a.xp ?? 0);
      });
  }, [weaponMastery, masteryMode]);

  const topWeapons = useMemo(() => rankedWeapons.slice(0, 10), [rankedWeapons]);

  const categoryWeapons = useMemo(() => {
    if (activeCategory === '전체') return rankedWeapons;
    return rankedWeapons.filter((item) => (item.category || '기타') === activeCategory);
  }, [rankedWeapons, activeCategory]);

  const handleImgError = (weaponId: string) => {
    setImgErrors(prev => ({ ...prev, [weaponId]: true }));
  };

  const refreshWeaponMastery = async () => {
    if (refreshing) return;

    setRefreshing(true);
    setRefreshError(null);
    setRefreshSource(null);

    try {
      const res = await fetch('/api/pubg/player/weapon-mastery', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ nickname, platform })
      });
      const data = await res.json();

      if (!res.ok || !data.success) {
        throw new Error(data.error || '무기 숙련도 갱신에 실패했습니다.');
      }

      setWeaponMastery(normalizeWeaponMasteryItems(Array.isArray(data.weaponMastery) ? data.weaponMastery : []));
      setMasteryUpdatedAt(data.masteryUpdatedAt || null);
      setRefreshSource(data.source || null);
    } catch (error: any) {
      setRefreshError(error.message || '무기 숙련도 갱신에 실패했습니다.');
    } finally {
      setRefreshing(false);
    }
  };

  return (
    <div className="min-h-screen bg-[#080808] text-white">
      {/* 백그라운드 그라데이션 및 비주얼 이펙트 */}
      <div className="absolute inset-0 bg-gradient-to-b from-rose-900/10 via-transparent to-transparent pointer-events-none" />
      <div className="absolute top-0 left-1/2 -translate-x-1/2 w-[800px] h-[300px] bg-rose-500/5 rounded-full blur-3xl pointer-events-none" />

      <div className="max-w-4xl mx-auto px-4 py-8 relative z-10">
        {/* 상단 네비게이션 헤더 */}
        <div className="flex items-center gap-4 mb-8">
          <Link
            href={`/stats/${platform}/${encodeURIComponent(nickname)}`}
            className="p-2.5 bg-white/5 hover:bg-white/10 border border-white/10 rounded-xl transition-all active:scale-95 text-gray-400 hover:text-white"
          >
            <ArrowLeft size={20} />
          </Link>
          <div>
            <div className="flex items-center gap-2 text-xs text-rose-400 font-bold uppercase tracking-wider">
              <Crosshair size={12} />
              <span>무기 마스터리</span>
            </div>
            <h1 className="text-xl md:text-2xl font-black text-white mt-0.5">
              {nickname} 무기 마스터리 분석
            </h1>
          </div>
        </div>

        <div className="mb-8 flex justify-center xl:hidden" aria-label="광고">
          <AdSenseBanner
            slot={ADSENSE_SLOTS.weaponMasteryTop}
            width={320}
            height={100}
            className="max-w-full"
          />
        </div>

        {/* 무기 통계 메인 바디 */}
        {!hasWeapons ? (
          <div className="bg-white/[0.03] border border-white/[0.06] rounded-3xl p-12 text-center my-12">
            <div className="w-16 h-16 bg-rose-500/10 rounded-full flex items-center justify-center mx-auto mb-4 border border-rose-500/20 text-rose-400">
              <Crosshair size={32} />
            </div>
            <h3 className="text-lg font-black text-white">무기 마스터리 캐시 없음</h3>
            <p className="text-sm text-gray-500 mt-2 max-w-sm mx-auto leading-relaxed">
              무기 숙련도는 이 페이지에서만 갱신합니다. 전적 검색을 한 번 완료한 유저라면 버튼 한 번으로 최신 무기 데이터를 불러올 수 있습니다.
            </p>
            {refreshError && (
              <div className="mt-5 mx-auto max-w-md flex items-center justify-center gap-2 rounded-2xl border border-rose-500/20 bg-rose-500/10 px-4 py-3 text-xs font-bold text-rose-200">
                <AlertCircle size={14} />
                <span>{refreshError}</span>
              </div>
            )}
            <div className="flex flex-col sm:flex-row items-center justify-center gap-3 mt-6">
              <button
                onClick={refreshWeaponMastery}
                disabled={refreshing}
                className="inline-flex items-center gap-2 px-5 py-2.5 bg-rose-600 hover:bg-rose-500 disabled:bg-rose-950 disabled:text-rose-300/50 text-white font-bold text-sm rounded-xl transition-all active:scale-95"
              >
                <RefreshCw size={15} className={refreshing ? 'animate-spin' : ''} />
                <span>{refreshing ? '갱신 중...' : '무기 숙련도 갱신'}</span>
              </button>
              <Link
                href={`/stats/${platform}/${encodeURIComponent(nickname)}`}
                className="inline-flex items-center gap-2 px-5 py-2.5 bg-white/5 hover:bg-white/10 text-gray-300 font-bold text-sm rounded-xl transition-all active:scale-95"
              >
                <span>전적 검색 페이지로 가기</span>
              </Link>
            </div>
          </div>
        ) : (
          <div className="space-y-6">
            {/* 상단 분석 요약 카드 */}
            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              <div className="bg-white/[0.02] border border-white/[0.05] rounded-3xl p-6 flex items-center gap-4">
                <div className="p-3.5 bg-rose-500/10 rounded-2xl text-rose-400 border border-rose-500/20">
                  <Award size={24} />
                </div>
                <div>
                  <div className="text-[11px] font-black text-gray-500 uppercase tracking-widest">선호 무기</div>
                  <div className="text-lg font-black text-white mt-0.5">
                    {getWeaponLabel(rankedWeapons[0]?.weaponId)} (Lv.{rankedWeapons[0]?.level})
                  </div>
                </div>
              </div>
              
              <div className="bg-white/[0.02] border border-white/[0.05] rounded-3xl p-6 flex items-center gap-4">
                <div className="p-3.5 bg-indigo-500/10 rounded-2xl text-indigo-400 border border-indigo-500/20">
                  <Calendar size={24} />
                </div>
                <div>
                  <div className="text-[11px] font-black text-gray-500 uppercase tracking-widest">마지막 갱신</div>
                  <div className="text-lg font-black text-white mt-0.5">
                    {masteryUpdatedAt
                      ? new Date(masteryUpdatedAt).toLocaleDateString('ko-KR', { year: 'numeric', month: 'long', day: 'numeric', hour: '2-digit', minute: '2-digit' })
                      : "기록 없음"
                    }
                  </div>
                </div>
              </div>
            </div>

            <div className="flex flex-col sm:flex-row items-start sm:items-center justify-between gap-3 rounded-3xl border border-white/[0.06] bg-white/[0.02] p-4">
              <div>
                <div className="text-sm font-black text-white">최신 무기 숙련도 갱신</div>
                <div className="text-xs text-gray-500 mt-1">
                  최근 3시간 내 갱신 기록이 있으면 PUBG API를 다시 호출하지 않고 캐시를 사용합니다.
                  {refreshSource && <span className="text-rose-300 font-bold"> 방금 {refreshSource === 'api' ? '공식 API로 갱신됨' : '캐시로 확인됨'}.</span>}
                </div>
                {refreshError && (
                  <div className="mt-2 flex items-center gap-2 text-xs font-bold text-rose-300">
                    <AlertCircle size={13} />
                    <span>{refreshError}</span>
                  </div>
                )}
              </div>
              <button
                onClick={refreshWeaponMastery}
                disabled={refreshing}
                className="inline-flex items-center gap-2 px-4 py-2 bg-rose-600 hover:bg-rose-500 disabled:bg-rose-950 disabled:text-rose-300/50 text-white font-black text-xs rounded-xl transition-all active:scale-95"
              >
                <RefreshCw size={14} className={refreshing ? 'animate-spin' : ''} />
                <span>{refreshing ? '확인 중...' : '갱신'}</span>
              </button>
            </div>

            {/* 타이틀 및 일반/경쟁전 모드 전환 필터 */}
            <div className="flex items-center justify-between mt-8 mb-4 flex-wrap gap-3">
              <h2 className="text-sm font-black text-rose-400 uppercase tracking-wider flex items-center gap-2">
                <Trophy size={14} />
                <span>전체 주력 무기 순위 (TOP 10)</span>
              </h2>
              <div className="flex gap-1.5">
                {(['all', 'normal', 'ranked'] as const).map((m) => (
                  <button
                    key={m}
                    onClick={() => setMasteryMode(m)}
                    className={`px-3 py-1.5 rounded-lg text-[11px] font-bold border transition-all duration-200 active:scale-95 cursor-pointer ${
                      masteryMode === m
                        ? 'bg-rose-500/15 border-rose-500/30 text-rose-400'
                        : 'bg-white/5 border-transparent text-gray-500 hover:text-gray-300 hover:bg-white/8'
                    }`}
                  >
                    {m === 'all' ? '통합' : m === 'normal' ? '일반전' : '경쟁전'}
                  </button>
                ))}
              </div>
            </div>

            {/* 개별 무기 랭킹 그리드 */}
            <div className="grid grid-cols-1 gap-4">
              {topWeapons.map((item: any, index: number) => {
                const stats = getDisplayStats(item, masteryMode);

                // 랭킹 넘버를 자릿수 맞춰 표기 (RANK 01 ~ RANK 10)
                const rankNumber = String(index + 1).padStart(2, '0');

                return (
                  <div
                    key={item.weaponId}
                    className="relative overflow-hidden rounded-3xl border transition-all duration-300 hover:bg-white/[0.04]"
                    style={{
                      background: "linear-gradient(135deg, rgba(255,255,255,0.01) 0%, rgba(255,255,255,0.02) 100%)",
                      borderColor: "rgba(255,255,255,0.05)",
                    }}
                  >
                    {/* 카드 순위 뱃지 오버레이 */}
                    <div className="absolute top-0 left-0 px-4 py-2 bg-rose-500/10 border-r border-b border-rose-500/15 rounded-br-2xl text-xs font-black text-rose-400">
                      RANK {rankNumber}
                    </div>

                    <div className="p-6 md:p-8 flex flex-col md:flex-row items-center justify-between gap-6">
                      {/* 무기 이미지 및 명칭 */}
                      <div className="flex items-center gap-6 self-start md:self-center mt-4 md:mt-0">
                        <div className="w-24 h-14 bg-white/[0.02] border border-white/5 rounded-2xl p-1 flex items-center justify-center shrink-0">
                          {imgErrors[item.weaponId] ? (
                            <Crosshair size={22} className="text-gray-600 animate-pulse" />
                          ) : (
                            <img
                              src={getWeaponImageUrl(item.weaponId)}
                              alt={getWeaponLabel(item.weaponId)}
                              className="max-h-full max-w-full object-contain filter drop-shadow-[0_2px_8px_rgba(0,0,0,0.5)]"
                              onError={() => handleImgError(item.weaponId)}
                            />
                          )}
                        </div>
                        <div>
                          <div className="text-xl font-black text-white">{getWeaponLabel(item.weaponId)}</div>
                          <span className="inline-flex items-center gap-1.5 px-2.5 py-0.5 bg-rose-500/10 border border-rose-500/20 rounded-md text-[10px] font-black text-rose-400 uppercase tracking-wide mt-1.5">
                            LEVEL {item.level}
                          </span>
                        </div>
                      </div>

                      {/* 주요 스탯 리스트 (md에서 고정너비 지정으로 자릿수가 제각각이어도 수직 열이 완벽히 맞춰지게 수정) */}
                      <div className="grid grid-cols-2 md:flex md:items-center md:gap-0 w-full md:w-auto border-t md:border-t-0 border-white/5 pt-4 md:pt-0">
                        <div className="md:w-28 text-left md:text-center">
                          <div className="text-[10px] text-gray-400 font-bold uppercase tracking-wider">누적 킬</div>
                          <div className="text-base md:text-lg font-black text-white tracking-tight mt-0.5 tabular-nums">
                            {stats.kills.toLocaleString()}
                          </div>
                        </div>

                        <div className="md:w-32 text-left md:text-center">
                          <div className="text-[10px] text-gray-400 font-bold uppercase tracking-wider">누적 대미지</div>
                          <div className="text-base md:text-lg font-black text-white tracking-tight mt-0.5 tabular-nums">
                            {stats.damage.toLocaleString()}
                          </div>
                        </div>

                        <div className="md:w-28 text-left md:text-center">
                          <div className="text-[10px] text-gray-400 font-bold uppercase tracking-wider">최대 헤드샷</div>
                          <div className="text-base md:text-lg font-black text-gray-400 tracking-tight mt-0.5 tabular-nums">
                            {stats.headshots.toLocaleString()}
                          </div>
                        </div>

                        <div className="md:w-28 text-left md:text-center">
                          <div className="text-[10px] text-gray-400 font-bold uppercase tracking-wider">최장 킬</div>
                          <div className="text-base md:text-lg font-black text-gray-400 tracking-tight mt-0.5 tabular-nums">
                            {stats.longest ? `${Math.round(stats.longest)}m` : "-"}
                          </div>
                        </div>
                      </div>
                    </div>
                  </div>
                );
              })}
            </div>

            <div className="space-y-4 pt-6">
              <div className="flex items-center justify-between gap-3 flex-wrap">
                <h2 className="text-sm font-black text-rose-400 uppercase tracking-wider flex items-center gap-2">
                  <Crosshair size={14} />
                  <span>카테고리별 전체 무기 순위</span>
                </h2>
                <div className="text-[11px] font-bold text-gray-500">
                  {activeCategory} · {categoryWeapons.length}개
                </div>
              </div>

              <div className="flex gap-2 overflow-x-auto pb-2">
                {CATEGORY_FILTERS.map((category) => (
                  <button
                    key={category}
                    onClick={() => setActiveCategory(category)}
                    className={`shrink-0 px-3 py-1.5 rounded-lg text-[11px] font-bold border transition-all duration-200 active:scale-95 cursor-pointer ${
                      activeCategory === category
                        ? 'bg-rose-500/15 border-rose-500/30 text-rose-300'
                        : 'bg-white/5 border-white/5 text-gray-500 hover:text-gray-300 hover:bg-white/8'
                    }`}
                  >
                    {category}
                  </button>
                ))}
              </div>

              {categoryWeapons.length === 0 ? (
                <div className="rounded-3xl border border-white/[0.06] bg-white/[0.02] p-8 text-center text-sm font-bold text-gray-500">
                  이 카테고리에 기록된 무기가 없습니다.
                </div>
              ) : (
                <div className="overflow-hidden rounded-3xl border border-white/[0.06] bg-white/[0.02]">
                  {categoryWeapons.map((item: any, index: number) => {
                    const stats = getDisplayStats(item, masteryMode);
                    return (
                      <div
                        key={`${activeCategory}-${item.weaponId}`}
                        className="grid grid-cols-[48px_1fr] md:grid-cols-[64px_1.2fr_0.8fr_0.8fr_0.8fr_0.8fr] gap-3 items-center border-b border-white/[0.05] px-4 py-3 last:border-b-0"
                      >
                        <div className="text-xs font-black text-rose-300 tabular-nums">#{index + 1}</div>
                        <div className="flex items-center gap-3 min-w-0">
                          <div className="w-16 h-10 bg-white/[0.02] border border-white/5 rounded-xl p-1 flex items-center justify-center shrink-0">
                            {imgErrors[item.weaponId] ? (
                              <Crosshair size={16} className="text-gray-600" />
                            ) : (
                              <img
                                src={getWeaponImageUrl(item.weaponId)}
                                alt={getWeaponLabel(item.weaponId)}
                                className="max-h-full max-w-full object-contain"
                                onError={() => handleImgError(item.weaponId)}
                              />
                            )}
                          </div>
                          <div className="min-w-0">
                            <div className="text-sm font-black text-white truncate">{getWeaponLabel(item.weaponId)}</div>
                            <div className="text-[10px] font-bold text-gray-400">Lv.{item.level} · {item.category || '기타'}</div>
                          </div>
                        </div>
                        <StatCell label="킬" value={stats.kills.toLocaleString()} />
                        <StatCell label="딜량" value={stats.damage.toLocaleString()} />
                        <StatCell label="헤드샷" value={stats.headshots.toLocaleString()} />
                        <StatCell label="최장 킬" value={stats.longest ? `${Math.round(stats.longest)}m` : '-'} />
                      </div>
                    );
                  })}
                </div>
              )}
            </div>

            {/* 안내 문구 */}
            <p className="text-center text-[10px] text-gray-700 pt-6">
              ※ 이 무기 숙련도 정보는 PUBG 공식 API로부터 동기화되어 DB 캐시에 보관 중인 스펙입니다.
            </p>
          </div>
        )}

        <aside className="hidden xl:block absolute left-[calc(100%+24px)] top-8 w-[160px] h-full" aria-label="광고">
          <div className="sticky top-24">
            <AdSenseBanner
              slot={ADSENSE_SLOTS.weaponMasteryRailRight}
            />
          </div>
        </aside>
      </div>
    </div>
  );
}
