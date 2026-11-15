"use client";


import { useEffect, useState, useMemo, useCallback, useRef } from "react";
import { 
  Wrench, 
  Plus, 
  Check, 
  SlidersHorizontal,
  TrendingDown,
  RotateCcw,
  Sparkles,
  Info
} from "lucide-react";
import { supabase } from "../../lib/supabase";
import { trackEvent } from "../../lib/analytics";
import AdSenseBanner from "../../components/ads/AdSenseBanner";
import { InlineIconLabel } from "@/components/common/InlineIconLabel";
import { ADSENSE_SLOTS } from "@/lib/ads/adsenseUnits";
import type { OfficialItem } from "@/lib/patch-notes/officialCatalog";
import { CAPACITY_SOURCE, getSupportedSlots, isAttachmentCompatible, resolveOfficialWeaponId, simulateWeapon } from "@/lib/weapons/simulator";

// ----------------------------------------------------
// 1. 파츠 DB 인터페이스 (Supabase attachments 테이블 기반)
// ----------------------------------------------------
interface AttachmentData {
  id: string;
  name: string;
  type: string;
  slot: string | null;
  vertical_recoil: number;
  horizontal_recoil: number;
  reload_speed: number;
  ads_speed: number;
  r2_key: string | null;
}

export default function WeaponsClient({ requestedItem, officialItems = [] }: { requestedItem?: OfficialItem | null; officialItems?: OfficialItem[] }) {
  const builderRef = useRef<HTMLDivElement>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState(false);
  const [weapons, setWeapons] = useState<any[]>([]);

  // Filters & State
  const [activeType, setActiveType] = useState<string>("ALL");
  const [sortBy, setSortBy] = useState<"Default" | "DamageDesc" | "SpeedDesc">("Default");
  const [viewMode, setViewMode] = useState<"CARD" | "TABLE">("CARD");

  // 시뮬레이터 대상 총기 및 파츠 조립 상태
  const [weaponSelection, setWeaponSelection] = useState<{ request: typeof requestedItem; id: string } | null>(null);
  const [selectedAttachments, setSelectedAttachments] = useState<Record<string, Record<string, string | null>>>({});
  const [activeSlot, setActiveSlot] = useState<string | null>(null);

  const selectWeapon = useCallback((id: string, type: string) => {
    setWeaponSelection({ request: requestedItem, id });
    setActiveSlot(null);
    requestAnimationFrame(() => {
      builderRef.current?.scrollIntoView({ block: "start", behavior: "instant" });
      builderRef.current?.focus({ preventScroll: true });
    });
    trackEvent({
      name: "weapon_viewed",
      params: {
        weapon_id: id,
        category: type
      }
    });
  }, [requestedItem]);

  // 이미지 에러 여부를 추적하여 Fallback UI 트리거
  const [imageErrors, setImageErrors] = useState<Record<string, boolean>>({});

  // DB에서 파츠 데이터 동적 로드
  const [attachmentList, setAttachmentList] = useState<AttachmentData[]>([]);

  const fetchData = useCallback(async () => {
      setLoading(true);
      setLoadError(false);
      try {
        // 무기 + 파츠를 병렬 fetch
        const [weaponRes, attachRes] = await Promise.all([
          // 게임에서 제거된 무기는 도감에 노출하지 않는다.
          // 행은 소프트 삭제로 남아 있어 관리자가 되돌릴 수 있다.
          supabase
            .from("weapons")
            .select("*")
            .is("removed_at", null)
            .order("name", { ascending: true }),
          supabase.from("attachments")
            .select("id, name, type, slot, vertical_recoil, horizontal_recoil, reload_speed, ads_speed, r2_key")
            .is("removed_at", null)
            .not("slot", "is", null),
        ]);

        if (weaponRes.error) throw weaponRes.error;
        if (attachRes.error) throw attachRes.error;
        const list = weaponRes.data || [];
        setWeapons(list);
        setAttachmentList(attachRes.data || []);

      } catch (error) {
        console.error("무기 데이터 조회 오류:", error);
        setLoadError(true);
      } finally {
        setLoading(false);
      }
  }, []);

  useEffect(() => {
    void fetchData();
  }, [fetchData]);

  // DB 파츠를 id → AttachmentData 맵으로 변환 (O(1) 조회용)
  const attachmentMap = useMemo<Record<string, AttachmentData>>(() => {
    const map: Record<string, AttachmentData> = {};
    attachmentList.forEach(a => { map[a.id] = a; });
    return map;
  }, [attachmentList]);

  const filteredWeapons = useMemo(() => {
    let result = weapons;
    if (activeType !== "ALL") {
      result = result.filter(w => w.type === activeType);
    }
    
    result = [...result];
    if (sortBy === "DamageDesc") {
      result.sort((a, b) => b.damage - a.damage);
    } else if (sortBy === "SpeedDesc") {
      result.sort((a, b) => b.bullet_speed - a.bullet_speed);
    }
    return result;
  }, [weapons, activeType, sortBy]);

  const requestedWeaponId = requestedItem ? resolveOfficialWeaponId(requestedItem, weapons) : null;
  const selectedWeaponId = weaponSelection && weaponSelection.request === requestedItem ? weaponSelection.id
    : requestedItem ? requestedWeaponId : (weapons.find((weapon) => weapon.id === "ar_m416")?.id ?? weapons[0]?.id ?? null);
  const selectedWeapon = useMemo(() => weapons.find((weapon) => weapon.id === selectedWeaponId) ?? null, [weapons, selectedWeaponId]);
  useEffect(() => { setActiveSlot(null); }, [requestedItem]);

  const selectedOfficialItem = useMemo(() => {
    if (!selectedWeapon) return null;
    const matches = officialItems.filter((item) => resolveOfficialWeaponId(item, weapons) === selectedWeapon.id);
    return matches.length === 1 ? matches[0] : null;
  }, [officialItems, selectedWeapon, weapons]);
  const supportedSlots = getSupportedSlots(selectedOfficialItem, attachmentList);
  const slotOptions = useMemo(() => Object.fromEntries(["muzzle", "grip", "magazine", "sight", "stock"].map((slot) => [slot,
    attachmentList.filter((part) => part.slot === slot && isAttachmentCompatible(selectedOfficialItem, part)).map((part) => part.id),
  ])), [attachmentList, selectedOfficialItem]);

  // 장착된 파츠 데이터 조회 헬퍼
  const getEquippedPart = useCallback((slot: string) => {
    if (!selectedWeaponId) return null;
    const parts = selectedAttachments[selectedWeaponId];
    const id = parts?.[slot];
    return id && attachmentMap[id] && isAttachmentCompatible(selectedOfficialItem, attachmentMap[id]) ? id : null;
  }, [selectedWeaponId, selectedAttachments, attachmentMap, selectedOfficialItem]);

  // 파츠 장착/해제 핸들러
  const handleEquipAttachment = useCallback((slot: string, partId: string | null) => {
    if (!selectedWeaponId || (partId && !slotOptions[slot]?.includes(partId))) return;
    setSelectedAttachments(prev => {
      const current = prev[selectedWeaponId] || { muzzle: null, grip: null, magazine: null, sight: null, stock: null };
      return {
        ...prev,
        [selectedWeaponId]: {
          ...current,
          [slot]: partId
        }
      };
    });
    setActiveSlot(null);
    requestAnimationFrame(() => builderRef.current?.querySelector<HTMLButtonElement>(`[data-slot="${slot}"]`)?.focus({ preventScroll: true }));
  }, [selectedWeaponId, slotOptions]);

  // 모든 파츠 초기화
  const handleResetAttachments = useCallback(() => {
    if (!selectedWeaponId) return;
    setSelectedAttachments(prev => ({
      ...prev,
      [selectedWeaponId]: { muzzle: null, grip: null, magazine: null, sight: null, stock: null }
    }));
    setActiveSlot(null);
  }, [selectedWeaponId]);

  const simulatedStats = useMemo(() => {
    if (!selectedWeapon) return null;
    const parts = Object.values(selectedAttachments[selectedWeapon.id] ?? {})
      .filter((id): id is string => !!id).map((id) => attachmentMap[id]).filter(Boolean);
    return simulateWeapon(selectedWeapon.id, selectedOfficialItem, parts);
  }, [selectedWeapon, selectedOfficialItem, selectedAttachments, attachmentMap]);

  const handleImageError = useCallback((id: string) => {
    setImageErrors(prev => ({ ...prev, [id]: true }));
  }, []);

  if (loading) {
    return (
      <div className="flex flex-col items-center justify-center h-screen bg-[#070a13] text-[#F2A900] gap-4">
        <div className="animate-spin rounded-full h-12 w-12 border-b-2 border-[#F2A900]"></div>
        <p className="font-extrabold text-sm tracking-widest animate-pulse">무기고 개방 중...</p>
      </div>
    );
  }

  if (loadError) {
    return (
      <div className="flex min-h-screen flex-col items-center justify-center gap-4 bg-[#070a13] px-6 text-center text-white">
        <p className="text-base font-bold">일시적인 문제가 발생했습니다. 잠시 후 다시 시도해 주세요.</p>
        <button
          type="button"
          onClick={() => void fetchData()}
          className="rounded-xl bg-[#F2A900] px-5 py-3 text-sm font-black text-black transition-colors hover:bg-[#d49400]"
        >
          다시 시도
        </button>
      </div>
    );
  }

  const weaponTypes = ["ALL", "AR", "DMR", "SR", "SMG", "SG", "LMG"];

  // 테이블 뷰 렌더러
  const renderTableView = () => (
    <div className="w-full overflow-x-auto rounded-2xl border border-slate-800 bg-slate-900/20 backdrop-blur-md">
      <table className="w-full text-left text-sm text-gray-300">
        <thead className="bg-slate-950/60 text-[#F2A900] font-black tracking-wider border-b border-slate-800">
          <tr>
            <th className="px-5 py-4">이름</th>
            <th className="px-5 py-4">타입</th>
            <th className="px-5 py-4">탄약</th>
            <th className="px-5 py-4">데미지</th>
            <th className="px-5 py-4">탄속(m/s)</th>
            <th className="px-5 py-4 text-right">시뮬레이션</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-slate-850">
          {filteredWeapons.map((w) => (
            <tr key={w.id} className={`hover:bg-slate-900/40 transition-colors ${selectedWeaponId === w.id ? "bg-slate-900/50" : ""}`}>
              <td className="px-5 py-4 font-bold text-white flex items-center gap-3">
                <div className="w-10 h-7 bg-slate-950/60 rounded flex items-center justify-center p-1 border border-slate-800 overflow-hidden shrink-0">
                  {imageErrors[w.id] ? (
                    <div className="w-full h-full bg-gradient-to-br from-slate-800 to-slate-900 rounded" />
                  ) : (
                    <img 
                      src={`/api/images/weapons/${w.id}.webp`}
                      alt={w.name}
                      className="object-contain max-h-full"
                      onError={() => handleImageError(w.id)}
                    />
                  )}
                </div>
                {w.name}
              </td>
              <td className="px-5 py-4 text-xs font-semibold text-[#F2A900]">{w.type}</td>
              <td className="px-5 py-4 text-gray-400 font-mono text-xs">{w.ammo}</td>
              <td className="px-5 py-4 text-red-400 font-black">{w.damage}</td>
              <td className="px-5 py-4 text-blue-300 font-mono">{w.bullet_speed}</td>
              <td className="px-5 py-4 text-right">
                <button type="button" aria-label={`${w.name} 파츠 설정`} aria-pressed={selectedWeaponId === w.id}
                  className={`min-h-11 px-3 py-1.5 rounded-lg text-xs font-bold transition-all ${
                    selectedWeaponId === w.id 
                      ? "bg-[#F2A900] text-black shadow" 
                      : "bg-slate-950 border border-slate-800 text-slate-400 hover:text-white"
                  }`}
                  onClick={(e) => {
                    e.stopPropagation();
                    selectWeapon(w.id, w.type);
                  }}
                >
                  {selectedWeaponId === w.id ? "활성화됨" : "장착"}
                </button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );

  // 카드 뷰 렌더러
  const renderCardView = () => (
    <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-4 w-full">
      {filteredWeapons.map((w) => {
        const dmgPercent = Math.min((w.damage / 105) * 100, 100);
        const isSelected = selectedWeaponId === w.id;
        return (
          <div 
            key={w.id} 
            className={`bg-slate-900/30 border rounded-2xl overflow-hidden shadow-lg transition-all duration-300 cursor-pointer flex flex-col justify-between ${
              isSelected 
                ? "border-[#F2A900] shadow-[0_0_15px_rgba(242,169,0,0.15)] bg-slate-900/50 transform -translate-y-1" 
                : "border-slate-850 hover:-translate-y-0.5 hover:border-slate-700"
            }`}
          >
            <div className="bg-slate-950/60 p-4 flex justify-between items-center border-b border-slate-850">
              <span className="font-extrabold text-white text-base tracking-tight">{w.name}</span>
              <span className="bg-[#F2A900]/10 text-[#F2A900] border border-[#F2A900]/20 text-[10px] font-black px-2 py-0.5 rounded-full uppercase">{w.type}</span>
            </div>
            
            <div className="p-4 flex flex-col gap-4 flex-1">
              {/* R2 실물 이미지 쇼케이스 */}
              <div className="w-full h-24 bg-slate-950/40 rounded-xl border border-slate-850/50 p-2 flex items-center justify-center relative overflow-hidden group">
                <div className="absolute inset-0 bg-radial-gradient(circle_at_center,rgba(242,169,0,0.03)_0%,transparent_80%) pointer-events-none" />
                {imageErrors[w.id] ? (
                  <div className="flex flex-col items-center gap-1.5 opacity-30">
                    <TrendingDown className="w-7 h-7 text-slate-500" />
                    <span className="text-[10px] text-slate-500 font-bold uppercase tracking-widest">Image N/A</span>
                  </div>
                ) : (
                  <img 
                    src={`/api/images/weapons/${w.id}.webp`}
                    alt={w.name}
                    className="object-contain max-h-20 transform group-hover:scale-105 transition-transform duration-500"
                    onError={() => handleImageError(w.id)}
                  />
                )}
              </div>

              <div className="space-y-2">
                <div>
                  <div className="flex justify-between text-[11px] mb-1">
                    <span className="text-slate-400 font-semibold">데미지</span>
                    <span className="text-red-400 font-black">{w.damage}</span>
                  </div>
                  <div className="w-full bg-slate-950 rounded-full h-1 overflow-hidden">
                    <div className="bg-red-500 h-1 rounded-full" style={{ width: `${dmgPercent}%` }}></div>
                  </div>
                </div>

                <div className="flex justify-between items-center text-xs border-t border-slate-850/50 pt-2.5 mt-1">
                  <span className="text-slate-400 font-semibold">탄약 종류</span>
                  <span className="text-white font-mono bg-slate-950 px-2 py-0.5 rounded text-[10px]">{w.ammo}</span>
                </div>
                
                <div className="flex justify-between items-center text-xs">
                  <span className="text-slate-400 font-semibold">초속 탄속</span>
                  <span className="text-blue-300 font-mono text-[11px]">{w.bullet_speed} <span className="text-[9px] text-slate-500">m/s</span></span>
                </div>

                <div className="flex justify-between items-center text-xs">
                  <span className="text-slate-400 font-semibold">인게임 스폰</span>
                  <span className="text-green-400 font-bold text-[10px]">{w.availability}</span>
                </div>
              </div>
              
              {w.patch_notes && (
                <div className="text-[9px] text-yellow-500/70 bg-slate-950/60 p-2 rounded-lg italic border border-yellow-950/30 line-clamp-2" title={w.patch_notes}>
                  <InlineIconLabel icon="file" iconSize={11}>{w.patch_notes}</InlineIconLabel>
                </div>
              )}
              {w.patch_version && (
                <span
                  className="inline-flex w-fit items-center rounded-full border border-[#F2A900]/30 bg-[#F2A900]/10 px-2 py-0.5 text-[9px] font-black text-[#F2A900]"
                  title={`패치 적용 버전: ${w.patch_version}`}
                >
                  {w.patch_version}
                </span>
              )}
            </div>

            <div className="p-3 bg-slate-950/40 border-t border-slate-850 flex justify-end">
              <button 
                type="button" aria-label={`${w.name} 파츠 설정`} aria-pressed={isSelected} className={`min-h-11 w-full py-1.5 rounded-lg text-xs font-black transition-all ${
                  isSelected 
                    ? "bg-[#F2A900] text-black shadow" 
                    : "bg-slate-950 border border-slate-800 text-slate-400 hover:text-white"
                }`}
                onClick={(e) => {
                  e.stopPropagation();
                  selectWeapon(w.id, w.type);
                }}
              >
                <InlineIconLabel icon="tool">
                  {isSelected ? "개조 모드 활성화됨" : "파츠 시뮬레이션"}
                </InlineIconLabel>
              </button>
            </div>
          </div>
        );
      })}
    </div>
  );

  return (
    <div className="min-h-screen w-full bg-[#070a13] p-4 pb-20 text-white safe-top safe-bottom sm:p-6">
      <div className="relative max-w-[1200px] mx-auto w-full flex flex-col gap-6">
        
        <header>
          <h2 className="text-2xl font-black text-[#F2A900]">파츠 시뮬레이터</h2>
          <p className="mt-2 text-sm leading-6 text-slate-300">기본 수치와 파츠 보정은 BGMS 계산 자료입니다. 공식 도감의 항목별 수정일·수집일과 적용 시점이 다를 수 있습니다.</p>
          <p className="mt-2 text-xs leading-5 text-slate-400">반동·장전은 미장착 100에 파츠 보정을 단순 합산한 상대 지표입니다. 하한은 반동 30, 장전 40이며 낮을수록 작습니다. 자세·연사·조준경 효과를 재현하는 게임 실측값이 아닙니다.</p>
          {requestedItem && !requestedWeaponId && <p role="status" className="mt-3 text-sm text-amber-300">{requestedItem.name}에 연결된 BGMS 무기 자료가 없습니다. 다른 무기로 대체하지 않았습니다.</p>}
        </header>

        {/* ----------------------------------------------------
            상단: 웅장한 파츠 시뮬레이션 (Weapon Builder Dashboard)
            ---------------------------------------------------- */}
        <div ref={builderRef} tabIndex={-1} aria-label="무기 파츠 조작 영역" className="scroll-mt-20 focus-visible:outline-2 focus-visible:outline-amber-400 bg-slate-900/20 border border-slate-800/80 rounded-3xl p-5 sm:p-6 relative overflow-hidden backdrop-blur-md shadow-2xl">
          <div className="absolute inset-0 bg-radial-gradient(circle_at_center,rgba(242,169,0,0.02)_0%,transparent_70%) pointer-events-none" />
          
          {selectedWeapon ? (
            <div className="grid min-w-0 grid-cols-1 lg:grid-cols-12 gap-6 relative z-10">
              
              {/* 좌측: 총기 개조 모델링 비주얼 (5/12 비율) */}
              <div className="min-w-0 lg:col-span-5 flex flex-col items-center justify-center bg-slate-950/40 rounded-2xl border border-slate-850/60 p-4 sm:p-6 relative">
                <div className="absolute top-3 left-3 bg-[#F2A900]/10 border border-[#F2A900]/20 text-[#F2A900] text-[9px] font-black px-2.5 py-0.5 rounded-full uppercase tracking-wider">
                  BGMS 파츠 계산
                </div>
                
                {/* 큼직한 무기 메인 이미지 */}
                <div className="w-full aspect-[2/1] flex items-center justify-center p-2 mt-4 relative group">
                  {imageErrors[selectedWeapon.id] ? (
                    <div className="flex flex-col items-center gap-2 opacity-20">
                      <Sparkles className="w-12 h-12 text-slate-500 animate-pulse" />
                      <span className="text-xs text-slate-500 font-extrabold uppercase tracking-widest">Image unavailable</span>
                    </div>
                  ) : (
                    <img 
                      src={`/api/images/weapons/${selectedWeapon.id}.webp`}
                      alt={selectedWeapon.name}
                      className="object-contain max-h-36 drop-shadow-[0_10px_20px_rgba(0,0,0,0.7)] transform group-hover:scale-105 transition-all duration-500"
                      onError={() => handleImageError(selectedWeapon.id)}
                    />
                  )}
                </div>

                <h2 className="text-xl font-black text-white mt-4 flex items-center gap-1.5">
                  {selectedWeapon.name}
                  <span className="text-xs font-semibold text-slate-500">({selectedWeapon.type})</span>
                </h2>

                {/* 개조 파츠 슬롯 HUD */}
                <div className="grid grid-cols-5 gap-1.5 w-full mt-6 border-t border-slate-850/50 pt-4">
                  {["sight", "muzzle", "grip", "magazine", "stock"].map(slot => {
                    const isSupported = supportedSlots.includes(slot);
                    const equippedId = getEquippedPart(slot);
                    
                    let label = "";
                    if (slot === "sight") label = "조준경";
                    else if (slot === "muzzle") label = "총구";
                    else if (slot === "grip") label = "손잡이";
                    else if (slot === "magazine") label = "탄창";
                    else if (slot === "stock") label = "개머리판";
                    
                    if (!isSupported) {
                      return (
                        <div key={slot} className="flex flex-col items-center opacity-20 cursor-not-allowed">
                          <div className="w-11 h-11 rounded-lg bg-slate-950 border border-dashed border-slate-800 flex items-center justify-center text-[10px] text-slate-600 font-bold">
                            N/A
                          </div>
                          <span className="text-[9px] text-slate-600 font-semibold mt-1">{label}</span>
                        </div>
                      );
                    }

                    return (
                      <div key={slot} className="relative flex flex-col items-center group">
                        <button type="button" data-slot={slot} aria-label={`${label} 파츠 선택`} aria-expanded={activeSlot === slot}
                          className="flex min-h-11 flex-col items-center focus-visible:outline-2 focus-visible:outline-amber-400"
                          onClick={() => setActiveSlot(activeSlot === slot ? null : slot)}>
                        <div className={`w-11 h-11 rounded-lg bg-slate-950 border transition-all flex items-center justify-center p-1 relative ${
                          equippedId 
                            ? "border-[#F2A900] shadow-[0_0_10px_rgba(242,169,0,0.15)] bg-slate-900/60" 
                            : "border-slate-850 hover:border-slate-700 bg-slate-950"
                        } ${activeSlot === slot ? "ring-1 ring-[#F2A900]" : ""}`}>
                          {equippedId ? (() => {
                            const eqAtt = attachmentMap[equippedId];
                            const eqImgSrc = eqAtt?.r2_key ? `/api/images/attachments/${eqAtt.r2_key}.webp` : null;
                            return eqImgSrc ? (
                              <img 
                                src={eqImgSrc}
                                alt={eqAtt?.name || equippedId}
                                className="object-contain max-h-full"
                              />
                            ) : (
                              <Wrench className="w-4 h-4 text-[#F2A900]" />
                            );
                          })() : (
                            <Plus className="w-4 h-4 text-slate-600 group-hover:text-slate-400 transition-colors" />
                          )}
                          
                        </div>
                        <span className={`text-[9px] font-semibold mt-1 transition-colors ${
                          equippedId ? "text-[#F2A900]" : "text-slate-500 group-hover:text-slate-300"
                        }`}>{label}</span>
                        </button>
                        {equippedId && <button type="button" aria-label={`${label} 파츠 제거`} onClick={() => handleEquipAttachment(slot, null)}
                          className="mt-1 min-h-11 px-1 text-xs text-red-300 underline">제거</button>}
                      </div>
                    );
                  })}
                </div>
              </div>

              {/* 우측: 실시간 시뮬레이션 상세 수치 보정판 (7/12 비율) */}
              <div className="min-w-0 lg:col-span-7 flex flex-col justify-between bg-slate-950/20 rounded-2xl border border-slate-850/60 p-4 sm:p-6 relative">
                
                {/* HUD 타이틀 */}
                <div className="flex flex-wrap justify-between items-center gap-2 border-b border-slate-850/50 pb-3">
                  <div className="flex items-center gap-1.5">
                    <SlidersHorizontal className="w-4 h-4 text-[#F2A900]" />
                    <h3 className="font-extrabold text-sm text-slate-200">파츠 적용 상대 지표</h3>
                  </div>
                  <button 
                    onClick={handleResetAttachments}
                    className="min-h-11 text-[10px] font-black text-slate-400 hover:text-white flex items-center gap-1 bg-slate-950 border border-slate-850 px-2.5 py-1.5 rounded-lg active:scale-95 transition-all"
                  >
                    <RotateCcw className="w-3 h-3" />
                    부품 일괄 제거
                  </button>
                </div>

                {/* 파츠 슬롯별 장착 리스트 팝오버 확장 영역 */}
                {activeSlot && (
                  <div className="bg-slate-950/80 border border-slate-800 rounded-xl p-3 my-3 shadow-xl animate-[fadeIn_0.2s_ease-out]">
                    <div className="flex justify-between items-center border-b border-slate-850 pb-2 mb-2">
                      <span className="text-[10px] text-[#F2A900] font-black tracking-wider uppercase">
                        {activeSlot === "sight" ? "조준경" : activeSlot === "muzzle" ? "총구" : activeSlot === "grip" ? "손잡이" : activeSlot === "magazine" ? "탄창" : "개머리판"} 슬롯 호환 파츠 선택
                      </span>
                      <button 
                        className="min-h-11 px-2 text-xs text-slate-300 hover:text-white font-bold"
                        onClick={() => {
                          setActiveSlot(null);
                          builderRef.current?.querySelector<HTMLButtonElement>(`[data-slot="${activeSlot}"]`)?.focus({ preventScroll: true });
                        }}
                      >
                        닫기
                      </button>
                    </div>
                    <div className="grid grid-cols-1 sm:grid-cols-2 gap-2 max-h-36 overflow-y-auto">
                      {slotOptions[activeSlot]?.map(partId => {
                        const att = attachmentMap[partId];
                        if (!att) return null;
                        const isEquipped = getEquippedPart(activeSlot) === partId;
                        const imgSrc = att.r2_key ? `/api/images/attachments/${att.r2_key}.webp` : null;
                        return (
                          <button type="button"
                            key={partId} aria-pressed={isEquipped}
                            onClick={() => handleEquipAttachment(activeSlot, partId)}
                            className={`min-h-11 p-2 rounded-lg border text-left cursor-pointer transition-all flex items-center gap-2.5 hover:bg-slate-900/50 ${
                              isEquipped 
                                ? "bg-slate-900/40 border-[#F2A900] text-white" 
                                : "bg-slate-950 border-slate-850 text-slate-400 hover:border-slate-700"
                            }`}
                          >
                            <div className="w-7 h-7 bg-slate-950 rounded flex items-center justify-center p-0.5 border border-slate-800 shrink-0">
                              {imgSrc ? (
                                <img 
                                  src={imgSrc}
                                  alt={att.name}
                                  className="object-contain max-h-full"
                                />
                              ) : (
                                <Wrench className="w-3.5 h-3.5 text-slate-600" />
                              )}
                            </div>
                            <div className="min-w-0 flex-1">
                              <div className="text-[10px] font-extrabold truncate flex items-center justify-between">
                                {att.name}
                                {isEquipped && <Check className="w-3 h-3 text-[#F2A900]" />}
                              </div>
                              <div className="text-[8px] text-slate-500 truncate">
                                {att.vertical_recoil !== 0 && `수직반동 ${att.vertical_recoil}% `}
                                {att.horizontal_recoil !== 0 && `수평반동 ${att.horizontal_recoil}% `}
                                {att.reload_speed !== 0 && `장전시간 ${att.reload_speed}% `}
                                {att.ads_speed !== 0 && `조준속도 +${att.ads_speed}%`}
                              </div>
                            </div>
                          </button>
                        );
                      })}
                    </div>
                  </div>
                )}

                {/* 실시간 시뮬레이션 연산 게이지 바 */}
                {simulatedStats && (
                  <div className="space-y-4 my-4 flex-1">
                    {/* 데미지 (기본스탯) */}
                    <div>
                      <div className="flex justify-between text-xs mb-1">
                        <span className="text-slate-400 font-semibold">데미지 (기본)</span>
                        <span className="text-red-400 font-black">{selectedWeapon.damage}</span>
                      </div>
                      <div className="w-full bg-slate-950 rounded-full h-1.5 overflow-hidden">
                        <div className="bg-red-500 h-1.5 rounded-full" style={{ width: `${Math.min((selectedWeapon.damage / 105) * 100, 100)}%` }}></div>
                      </div>
                    </div>

                    {/* 초속 탄속 (기본스탯) */}
                    <div>
                      <div className="flex justify-between text-xs mb-1">
                        <span className="text-slate-400 font-semibold">초속 탄속 (기본)</span>
                        <span className="text-blue-300 font-black">{selectedWeapon.bullet_speed} <span className="text-[10px] text-slate-500">m/s</span></span>
                      </div>
                      <div className="w-full bg-slate-950 rounded-full h-1.5 overflow-hidden">
                        <div className="bg-blue-500 h-1.5 rounded-full" style={{ width: `${Math.min((selectedWeapon.bullet_speed / 1000) * 100, 100)}%` }}></div>
                      </div>
                    </div>

                    {/* 수직 반동 (파츠변동 - 낮을수록 우수) */}
                    <div>
                      <div className="flex justify-between text-xs mb-1">
                        <span className="text-slate-400 font-semibold">수직 반동 지표</span>
                        <div className="flex items-center gap-1.5">
                          <span className="text-white font-mono font-bold">{simulatedStats.verticalRecoil}</span>
                          {simulatedStats.verticalDiff !== 0 && (
                            <span className="text-green-400 font-mono text-[10px] font-black flex items-center">
                              ({simulatedStats.verticalDiff}점)
                            </span>
                          )}
                        </div>
                      </div>
                      <div className="w-full bg-slate-950 rounded-full h-1.5 overflow-hidden relative">
                        <div 
                          className="bg-emerald-500 h-1.5 rounded-full transition-all duration-300" 
                          style={{ width: `${simulatedStats.verticalRecoil}%` }}
                        ></div>
                      </div>
                    </div>

                    {/* 수평 반동 (파츠변동 - 낮을수록 우수) */}
                    <div>
                      <div className="flex justify-between text-xs mb-1">
                        <span className="text-slate-400 font-semibold">수평 반동 지표</span>
                        <div className="flex items-center gap-1.5">
                          <span className="text-white font-mono font-bold">{simulatedStats.horizontalRecoil}</span>
                          {simulatedStats.horizontalDiff !== 0 && (
                            <span className="text-green-400 font-mono text-[10px] font-black flex items-center">
                              ({simulatedStats.horizontalDiff}점)
                            </span>
                          )}
                        </div>
                      </div>
                      <div className="w-full bg-slate-950 rounded-full h-1.5 overflow-hidden relative">
                        <div 
                          className="bg-emerald-500 h-1.5 rounded-full transition-all duration-300" 
                          style={{ width: `${simulatedStats.horizontalRecoil}%` }}
                        ></div>
                      </div>
                    </div>

                    {/* 장전 속도 (파츠변동 - 낮을수록 우수) */}
                    <div>
                      <div className="flex justify-between text-xs mb-1">
                        <span className="text-slate-400 font-semibold">재장전 시간 지표</span>
                        <div className="flex items-center gap-1.5">
                          <span className="text-white font-mono font-bold">{simulatedStats.reloadSpeed}</span>
                          {simulatedStats.reloadDiff !== 0 && (
                            <span className="text-green-400 font-mono text-[10px] font-black flex items-center">
                              ({simulatedStats.reloadDiff}점)
                            </span>
                          )}
                        </div>
                      </div>
                      <div className="w-full bg-slate-950 rounded-full h-1.5 overflow-hidden relative">
                        <div 
                          className="bg-teal-500 h-1.5 rounded-full transition-all duration-300" 
                          style={{ width: `${simulatedStats.reloadSpeed}%` }}
                        ></div>
                      </div>
                    </div>

                    {/* 탄창 장탄수 (파츠변동 - 높을수록 우수) */}
                    <div>
                      <div className="flex justify-between text-xs mb-1">
                        <span className="text-slate-400 font-semibold">장착 후 탄창 용량</span>
                        <div className="flex items-center gap-1.5">
                          <span className="text-white font-mono font-bold">{simulatedStats.capacity === null ? "공식 수치 미확인" : `${simulatedStats.capacity}발`}</span>
                          {simulatedStats.capacityDiff !== null && simulatedStats.capacityDiff !== 0 && (
                            <span className="text-green-400 font-mono text-[10px] font-black">
                              (+{simulatedStats.capacityDiff}발)
                            </span>
                          )}
                        </div>
                      </div>
                      <div className="w-full bg-slate-950 rounded-full h-1.5 overflow-hidden relative">
                        <div 
                          className="bg-indigo-500 h-1.5 rounded-full transition-all duration-300" 
                          style={{ width: `${Math.min(((simulatedStats.capacity ?? 0) / 100) * 100, 100)}%` }}
                        ></div>
                      </div>
                    </div>
                  </div>
                )}

                <p className="text-xs leading-5 text-slate-400">호환은 수집된 공식 무기별 부착물 목록과 일치하는 BGMS 파츠만 표시합니다. 목록이나 파츠 식별이 없으면 장착을 허용하지 않습니다.</p>
                {!selectedOfficialItem && <p className="mt-2 text-xs text-amber-300">이 무기의 공식 호환 자료를 확인할 수 없습니다.</p>}
                {selectedWeapon.id === "ar_m416" && <a className="mt-2 text-xs text-amber-300 underline" href={CAPACITY_SOURCE} target="_blank" rel="noreferrer">탄창 용량 확인 근거: 공식 15.1 패치 노트 (현재 게임 실측 아님)</a>}
                <p className="mt-2 text-xs text-slate-300">BGMS 무기 패치 적용: {selectedWeapon.patch_version || "버전 미확인"}{selectedWeapon.patch_applied_at ? ` · 적용일 ${new Date(selectedWeapon.patch_applied_at).toLocaleDateString("ko-KR", { timeZone: "Asia/Seoul" })}` : " · 적용일 미확인"}</p>
                <p className="mt-1 text-xs text-slate-400">파츠 보정 수치의 적용 버전은 별도로 확인되지 않았습니다.</p>
                {/* 무기 세부 설명 정보 */}
                <div className="bg-slate-950/40 border border-slate-850/50 rounded-xl p-3 flex gap-2.5 text-xs text-slate-400 leading-relaxed mt-2">
                  <Info className="w-4 h-4 text-[#F2A900] shrink-0 mt-0.5" />
                  <div>
                    <span className="text-slate-200 font-bold">인게임 기본 습득처: </span> 
                    {selectedWeapon.availability} ({selectedWeapon.spawn_maps})
                    {selectedWeapon.patch_notes && (
                      <p className="mt-1.5 text-yellow-500/80 italic border-t border-slate-850/50 pt-1.5">
                        <InlineIconLabel icon="file" iconSize={12}>{selectedWeapon.patch_notes}</InlineIconLabel>
                      </p>
                    )}
                    {selectedWeapon.patch_version && (
                      <span
                        className="mt-2 inline-flex items-center rounded-full border border-[#F2A900]/30 bg-[#F2A900]/10 px-2.5 py-1 text-[11px] font-black text-[#F2A900]"
                        title={`패치 적용 버전: ${selectedWeapon.patch_version}`}
                      >
                        {selectedWeapon.patch_version}
                      </span>
                    )}
                  </div>
                </div>

              </div>
            </div>
          ) : (
            <div className="flex flex-col items-center justify-center py-20 text-center text-slate-500 gap-3">
              <Wrench className="w-12 h-12 text-slate-700 animate-spin" />
              <p className="font-extrabold text-sm tracking-wide">도감 목록에서 총기를 클릭하여 시뮬레이션을 로드하세요.</p>
            </div>
          )}
        </div>

        {/* ----------------------------------------------------
            하단: 필터, 정렬, 그리고 무기 리스트
            ---------------------------------------------------- */}
        <details className="border-t border-slate-800 pt-4">
        <summary className="min-h-11 cursor-pointer py-3 text-sm font-bold">다른 무기 선택·BGMS 수치 보기</summary>
        <div className="flex flex-col lg:flex-row justify-between gap-4 bg-slate-900/10 p-3 rounded-2xl border border-slate-850">
          
          {/* 타입 필터 탭 */}
          <div className="flex flex-wrap gap-1.5">
            {weaponTypes.map(type => (
              <button
                key={type}
                onClick={() => setActiveType(type)} aria-pressed={activeType === type}
                className={`min-h-11 px-3 py-1.5 rounded-xl text-xs font-black transition-all cursor-pointer ${
                  activeType === type 
                    ? "bg-[#F2A900] text-black shadow" 
                    : "bg-slate-950 border border-slate-850 text-slate-400 hover:text-white"
                }`}
              >
                {type}
              </button>
            ))}
          </div>

          {/* 정렬 & 뷰 토글 */}
          <div className="flex max-w-full flex-wrap items-center gap-3 self-end lg:self-auto">
            <select 
              aria-label="BGMS 무기 정렬" id="weapon-sort-select"
              name="sort_by"
              className="bg-slate-950 border border-slate-850 text-slate-350 text-xs font-bold rounded-xl px-3 py-2 outline-none focus:border-[#F2A900]"
              value={sortBy}
              onChange={(e) => setSortBy(e.target.value as any)}
            >
              <option value="Default">기본 정렬</option>
              <option value="DamageDesc">데미지 높은 순</option>
              <option value="SpeedDesc">탄속 빠른 순</option>
            </select>

            <div className="flex bg-slate-950 rounded-xl overflow-hidden border border-slate-850 p-0.5">
              <button 
                onClick={() => setViewMode("CARD")} aria-pressed={viewMode === "CARD"}
                className={`min-h-11 px-3.5 py-1.5 text-xs font-black rounded-lg transition-all cursor-pointer ${viewMode === "CARD" ? "bg-[#F2A900] text-black shadow" : "text-slate-400 hover:text-slate-200"}`}
              >
                카드 뷰
              </button>
              <button 
                onClick={() => setViewMode("TABLE")} aria-pressed={viewMode === "TABLE"}
                className={`min-h-11 px-3.5 py-1.5 text-xs font-black rounded-lg transition-all cursor-pointer ${viewMode === "TABLE" ? "bg-[#F2A900] text-black shadow" : "text-slate-400 hover:text-slate-200"}`}
              >
                리스트 뷰
              </button>
            </div>
          </div>
          
        </div>

        {/* 결과 무기 리스트 */}
        {viewMode === "CARD" ? renderCardView() : renderTableView()}

        {filteredWeapons.length === 0 && (
          <div className="text-center py-20 text-slate-500 bg-slate-950/40 rounded-2xl border border-slate-850 border-dashed">
            조건에 맞는 무기가 무기고에 없습니다.
          </div>
        )}

        </details>

        <div className="flex justify-center md:hidden" aria-label="광고">
          <AdSenseBanner
            slot={ADSENSE_SLOTS.weaponsBottom}
            width={320}
            height={100}
            className="max-w-full"
          />
        </div>

        <div className="hidden justify-center md:flex 2xl:hidden" aria-label="광고">
          <AdSenseBanner
            slot={ADSENSE_SLOTS.weaponsBottom}
            width={728}
            height={90}
            className="max-w-full"
          />
        </div>

        <aside className="hidden min-[1880px]:block absolute right-[calc(100%+24px)] top-0 bottom-0 w-[160px] h-auto" aria-label="왼쪽 광고">
          <div className="sticky top-20 h-[600px] w-[160px]">
            <AdSenseBanner
              placementId="weapons-rail-left"
              slot={ADSENSE_SLOTS.weaponsRailLeft}
            />
          </div>
        </aside>
        <aside className="hidden min-[1880px]:block absolute left-[calc(100%+24px)] top-0 bottom-0 w-[160px] h-auto" aria-label="오른쪽 광고">
          <div className="sticky top-20 h-[600px] w-[160px]">
            <AdSenseBanner
              placementId="weapons-rail-right"
              slot={ADSENSE_SLOTS.weaponsRailRight}
            />
          </div>
        </aside>

      </div>
    </div>
  );
}
