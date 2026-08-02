"use client";

import React, { useState, useEffect } from "react";
import { 
  Coins, 
  Sparkles, 
  Layers, 
  Box, 
  ShoppingCart,
  Package,
  Ticket,
  AlertTriangle,
  ChevronDown,
  ChevronUp
} from "lucide-react";

import type { CrateTemplate } from "@/types/crates";
import { CrateCard, getKoreanRarityName, isSpecialFlipEffectItem } from "./CrateCards";
import { 
  ChargeModal, 
  QuantityModal, 
  RefillModal, 
  CraftingModal, 
  DetailModal 
} from "./CrateModals";
import { useCratesState } from "./useCratesState";
import { getCraftableItems } from "../actions/crates";
import { toast } from "sonner";
import ConfirmModal from "@/components/common/ConfirmModal";
import AdfitBanner from "@/components/ads/AdfitBanner";
import AdSenseBanner from "@/components/ads/AdSenseBanner";
import { InlineIconLabel } from "@/components/common/InlineIconLabel";

interface CratesClientProps {
  initialCrates: CrateTemplate[];
  exchangeRate: number;
}

// ----------------------------------------------------
// Rarity & Style Helpers (Typesafe Badges)
// ----------------------------------------------------
const getRarityBadgeStyle = (rarity: string) => {
  switch (rarity) {
    case "ULTIMATE":
      return "bg-gradient-to-r from-red-600 to-amber-500 text-white shadow-lg shadow-red-500/30";
    case "LEGENDARY":
      return "bg-gradient-to-r from-purple-600 to-pink-500 text-white shadow-lg shadow-purple-500/30";
    case "EPIC":
      return "bg-gradient-to-r from-blue-600 to-cyan-500 text-white shadow-lg shadow-blue-500/20";
    case "SPECIAL":
      return "bg-gradient-to-r from-teal-600 to-emerald-500 text-white shadow-lg shadow-teal-500/20";
    case "COMMON":
    default:
      return "bg-slate-700 text-slate-200";
  }
};

const getCardBorderGlow = (rarity: string, isBonus: boolean) => {
  if (isBonus) {
    return "border-amber-400 shadow-[0_0_20px_rgba(245,158,11,0.8)]";
  }
  switch (rarity) {
    case "ULTIMATE":
      return "border-amber-500 shadow-[0_0_15px_rgba(245,158,11,0.6)]";
    case "LEGENDARY":
      return "border-pink-500 shadow-[0_0_15px_rgba(236,72,153,0.5)]";
    case "EPIC":
      return "border-cyan-500 shadow-[0_0_15px_rgba(6,182,212,0.4)]";
    case "SPECIAL":
      return "border-teal-500 shadow-[0_0_15px_rgba(20,184,166,0.4)]";
    case "COMMON":
    default:
      return "border-slate-800 shadow-none";
  }
};

export default function CratesClient({ initialCrates, exchangeRate = 1500 }: CratesClientProps) {
  // 선택된 상자 ID (최상단 동기화)
  const [selectedCrateId, setSelectedCrateId] = useState<string>(
    initialCrates.length > 0 ? initialCrates[0].id : ""
  );

  // 모달 제어 상태
  const [isDetailModalOpen, setIsDetailModalOpen] = useState(false);
  const [isCraftingModalOpen, setIsCraftingModalOpen] = useState(false);
  const [isLineupOpen, setIsLineupOpen] = useState(false);

  // 특수 제작소 아이템 데이터 상태
  const [craftableItems, setCraftableItems] = useState<any[]>([]);

  // 골드 스킨 단독 쇼케이스 모달 상태 및 큐
  const [showcaseQueue, setShowcaseQueue] = useState<any[]>([]);
  const [currentShowcaseCard, setCurrentShowcaseCard] = useState<any | null>(null);

  // Dequeue Effect: 큐에 아이템이 있고 현재 보여주는 쇼케이스 카드가 없을 때 하나씩 디큐
  useEffect(() => {
    if (showcaseQueue.length > 0 && !currentShowcaseCard) {
      const [nextCard, ...restQueue] = showcaseQueue;
      // 카드가 뒤집히기 시작하고 3D 바운스 연출 중반에 웅장하게 모달이 떠오르도록 지연(400ms) 추가
      const timer = setTimeout(() => {
        setCurrentShowcaseCard(nextCard);
        setShowcaseQueue(restQueue);
      }, 400);
      return () => clearTimeout(timer);
    }
  }, [showcaseQueue, currentShowcaseCard]);

  // ESC 단축키 리스너 바인딩
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape" && currentShowcaseCard) {
        setCurrentShowcaseCard(null);
      }
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [currentShowcaseCard]);

  // 비즈니스 로직 및 가챠 정산 훅 호출
  const {
    bp,
    gcoin,
    coupons,
    couponWeeklyBuyCount,
    bpBuyCount,
    blackmarketTickets,
    contrabandTenDrawCompleted,
    inventoryCrates,
    primeParcels,
    tokens,
    spentUsd,
    spentGcoin,
    spentBp,
    isDrawing,
    hasBonusEffect,
    drawMode,
    drawnCards,
    setDrawnCards,
    revealedCards,
    obtainedSkins,
    history,
    isChargeModalOpen,
    setIsChargeModalOpen,
    isQuantityModalOpen,
    setIsQuantityModalOpen,
    isRefillModalOpen,
    setIsRefillModalOpen,
    quantityToBuy,
    setQuantityToBuy,
    quantityPaymentMethod,
    refillType,
    setRefillType,
    refillAmount,
    setRefillAmount,
    drawSubTab,
    setDrawSubTab,
    selectedInventoryItem,
    setSelectedInventoryItem,

    // 핸들러 바인딩
    handleChargeGCoin,
    handleBuyPackage,
    executeBuyPackage,
    handleOpenInventoryCrates,
    handleOpenPrimeParcel,
    handleCardClick,
    handleRevealAll,
    handleOpenContrabandCrateWithGCoin,
    handleOpenContrabandWithCoupons,
    handleBuyCoupons,
    handleRefillAsset,
    handleRefillInfinite,
    handleResetSimulator,
    collectRemainingCards,
    handleCraftItem,
    handleBuyBlackmarketTickets,
    handleOpenLootCrateDirect,
    isResetModalOpen,
    setIsResetModalOpen,
    executeResetSimulator
  } = useCratesState({ initialCrates, selectedCrateId });

  // 카드 뒤집기 핸들러 래핑 (골드 스킨 감지 시 쇼케이스 큐에 적재)
  const handleCardClickWrapper = (index: number) => {
    const card = drawnCards[index];
    if (card && !revealedCards[index] && isSpecialFlipEffectItem(card.name)) {
      setShowcaseQueue((prev) => [...prev, card]);
    }
    handleCardClick(index);
  };

  // 전체 뒤집기 핸들러 래핑
  const handleRevealAllWrapper = () => {
    const newShowcaseCards = drawnCards.filter(
      (card, idx) => !revealedCards[idx] && isSpecialFlipEffectItem(card.name)
    );
    if (newShowcaseCards.length > 0) {
      setShowcaseQueue((prev) => [...prev, ...newShowcaseCards]);
    }
    handleRevealAll();
  };

  // 컴포넌트 마운트 시 특수 제작 아이템 로드
  useEffect(() => {
    const loadCraftableItems = async () => {
      const items = await getCraftableItems("2026_blackmarket");
      setCraftableItems(items);
    };
    loadCraftableItems();
  }, []);

  const activeCrate = initialCrates.find((c) => c.id === selectedCrateId);

  // ----------------------------------------------------
  // D-Day 실시간 타이머 구현
  // ----------------------------------------------------
  const [timeLeft, setTimeLeft] = useState<{
    days: number;
    hours: number;
    minutes: number;
    seconds: number;
    isExpired: boolean;
  }>({ days: 0, hours: 0, minutes: 0, seconds: 0, isExpired: false });

  useEffect(() => {
    if (!activeCrate?.end_date) {
      setTimeLeft({ days: 0, hours: 0, minutes: 0, seconds: 0, isExpired: false });
      return;
    }

    const targetDate = new Date(activeCrate.end_date).getTime();

    const updateTimer = () => {
      const now = new Date().getTime();
      const diff = targetDate - now;

      if (diff <= 0) {
        setTimeLeft({ days: 0, hours: 0, minutes: 0, seconds: 0, isExpired: true });
        return;
      }

      const days = Math.floor(diff / (1000 * 60 * 60 * 24));
      const hours = Math.floor((diff % (1000 * 60 * 60 * 24)) / (1000 * 60 * 60));
      const minutes = Math.floor((diff % (1000 * 60 * 60)) / (1000 * 60));
      const seconds = Math.floor((diff % (1000 * 60)) / 1000);

      setTimeLeft({ days, hours, minutes, seconds, isExpired: false });
    };

    updateTimer();
    const interval = setInterval(updateTimer, 1000);
    return () => clearInterval(interval);
  }, [activeCrate?.end_date]);

  // 특수 제작 확정 처리 래퍼
  const handleCraftItemWrapper = (itemName: string, tokenCost: number) => {
    return handleCraftItem(itemName, tokenCost);
  };

  const isTenDrawCompleted = activeCrate ? (contrabandTenDrawCompleted[activeCrate.id] || false) : false;
  const areAllCardsRevealed = drawnCards.length > 0 && revealedCards.slice(0, drawnCards.length).every(Boolean);
  const gcoinCostForTen = isTenDrawCompleted ? 1800 : 1000;

  return (
    <div className="min-h-screen bg-[#070b13] text-slate-100 py-8 px-4 sm:px-6 lg:px-8">
      {/* GPU 가속 CSS 애니메이션 정의 */}
      <style>{`
        @keyframes shake {
          0%, 100% { transform: translate(0, 0) scale(1); }
          10%, 30%, 50%, 70%, 90% { transform: translate(-4px, -2px) rotate(-1.5deg) scale(1.02); }
          20%, 40%, 60%, 80% { transform: translate(4px, 2px) rotate(1.5deg) scale(1.02); }
        }
        @keyframes goldGlowEffect {
          0%, 100% { 
            box-shadow: 0 0 15px rgba(245,158,11,0.2), inset 0 0 10px rgba(245,158,11,0.1); 
            border-color: rgba(245,158,11,0.3);
          }
          50% { 
            box-shadow: 0 0 50px rgba(245,158,11,0.8), inset 0 0 20px rgba(245,158,11,0.4); 
            border-color: rgba(245,158,11,0.8);
          }
        }
        @keyframes particleUp {
          0% { transform: translateY(0) scale(0.5); opacity: 0; }
          20% { opacity: 1; }
          100% { transform: translateY(-100px) scale(1.2); opacity: 0; }
        }
        @keyframes fadeIn {
          from { opacity: 0; transform: scale(0.9); }
          to { opacity: 1; transform: scale(1); }
        }
        @keyframes dimBg {
          0% { background-color: rgba(0, 0, 0, 0); backdrop-filter: blur(0px); }
          100% { background-color: rgba(0, 0, 0, 0.75); backdrop-filter: blur(6px); }
        }
        @keyframes goldShockwave {
          0% { 
            transform: translate(-50%, -50%) scale(0.5); 
            opacity: 1; 
            border-color: rgba(245, 158, 11, 0.9); 
            box-shadow: 0 0 15px rgba(245, 158, 11, 0.9), inset 0 0 15px rgba(245, 158, 11, 0.9); 
          }
          100% { 
            transform: translate(-50%, -50%) scale(2.5); 
            opacity: 0; 
            border-color: rgba(245, 158, 11, 0); 
            box-shadow: 0 0 60px rgba(245, 158, 11, 0), inset 0 0 60px rgba(245, 158, 11, 0); 
          }
        }
        @keyframes particleOut {
          0% { transform: translate(-50%, -50%) translate(0, 0) scale(1); opacity: 1; }
          100% { transform: translate(-50%, -50%) translate(var(--tw-particle-x, 120px), var(--tw-particle-y, -120px)) scale(0.2); opacity: 0; }
        }
        @keyframes goldBounceZoom {
          0% { transform: scale(1) rotateY(180deg); }
          15% { transform: scale(1.22) rotateY(120deg) translateZ(40px); }
          40% { transform: scale(1.28) rotateY(0deg) translateZ(80px); }
          65% { transform: scale(1.06) rotateY(0deg) translateZ(15px); }
          100% { transform: scale(1) rotateY(0deg); }
        }
        .animate-dimBg {
          animation: dimBg 0.4s cubic-bezier(0.16, 1, 0.3, 1) forwards;
        }
        .animate-goldShockwave {
          animation: goldShockwave 0.8s cubic-bezier(0.1, 0.8, 0.3, 1) forwards;
        }
        .animate-particleOut {
          animation: particleOut var(--tw-particle-duration, 1.2s) cubic-bezier(0.1, 0.8, 0.3, 1) forwards;
        }
        .animate-goldBounceZoom {
          animation: goldBounceZoom 1.3s cubic-bezier(0.25, 1, 0.5, 1) forwards;
        }
        .anim-shake {
          animation: shake 1.2s ease-in-out infinite;
        }
        .gold-glow-active {
          animation: goldGlowEffect 1.2s ease-in-out infinite alternate;
        }
        .perspective-1000 {
          perspective: 1000px;
        }
        .preserve-3d {
          transform-style: preserve-3d;
        }
        .backface-hidden {
          backface-visibility: hidden;
        }
        .rotate-y-180 {
          transform: rotateY(180deg);
        }
        summary::-webkit-details-marker {
          display: none;
        }
      `}</style>

      <div className="w-full max-w-[1280px] px-4 mx-auto xl:grid xl:grid-cols-[160px_minmax(0,960px)_160px] xl:justify-center xl:gap-5">
        <div className="w-full min-w-0 space-y-6 xl:col-start-2">

        {/* BETA 서비스 공지 배너 (접이식 details/summary 적용) */}
        <details className="bg-slate-900/60 border-2 border-amber-500/20 rounded-3xl p-5 text-slate-300 text-xs sm:text-sm backdrop-blur-[12px] shadow-2xl relative overflow-hidden group transition-all duration-300">
          <summary className="list-none cursor-pointer flex items-center gap-4 focus:outline-none select-none">
            <div className="absolute inset-0 bg-gradient-to-r from-amber-500/5 to-transparent pointer-events-none" />
            <AlertTriangle className="w-6 h-6 text-amber-500 shrink-0 mt-0.5 animate-pulse" />
            <div className="flex-1 min-w-0 flex flex-wrap justify-between items-center gap-x-3 gap-y-1.5 z-10">
              <h4 className="min-w-0 font-black text-amber-500 tracking-wide flex items-center gap-1.5 text-sm uppercase">
                시뮬레이터 BETA 서비스 안내
              </h4>
              <span className="shrink-0 text-[10px] bg-slate-800 text-slate-400 border border-slate-700/60 px-2 py-0.5 rounded font-black group-open:text-amber-400 group-open:border-amber-500/30 transition-all select-none">
                클릭하여 안내 읽기
              </span>
            </div>
          </summary>
          <div className="mt-4 pl-10 space-y-1.5 z-10 relative">
            <p className="text-slate-300/90 font-bold leading-relaxed">
              본 시뮬레이터는 아직 <span className="text-amber-400">BETA 서비스</span> 단계이므로 실제 인게임 확률 및 계산 결과와 100% 일치하지 않을 수 있습니다. 
              일부 최신 또는 희귀 구성품의 이미지는 아직 준비 중이거나 대체 처리되어 노출될 수 있으니 양해 부탁드립니다. 
              더욱 정확하고 풍성한 경험을 위해 지속적으로 기능 보정 및 리소스 추가가 진행되고 있습니다.
            </p>
          </div>
        </details>
        
        {/* 전체 그리드 레이아웃: 좌측 패널 (lg:col-span-4) vs 우측 메인 영역 (lg:col-span-8) */}
        <div className="grid grid-cols-1 lg:grid-cols-12 gap-6">

          {/* ====================================================
              좌측 패널 (4/12 비율) - 재화 + 상점 목록 + 모달 버튼
              ==================================================== */}
          <div className="lg:col-span-4 space-y-6">
            
            {/* 1. 컴팩트 재화 바 & 충전소 (인게임 대시보드 위젯) */}
            <div className="bg-slate-900 border border-slate-800 rounded-2xl p-4 space-y-4 shadow-xl">
              <h2 className="text-sm font-black text-slate-400 uppercase tracking-widest flex items-center gap-1.5">
                <Box className="w-4 h-4 text-amber-500" />
                내 자산 현황
              </h2>

              <div className="grid grid-cols-2 gap-2 text-xs">
                {/* BP */}
                <div className="flex min-w-0 items-center gap-2.5 p-2.5 bg-slate-950/80 rounded-xl border border-slate-850">
                  <span className="w-4 h-4 bg-indigo-900/50 text-indigo-400 font-black text-[9px] rounded flex items-center justify-center border border-indigo-850 shrink-0">BP</span>
                  <div className="min-w-0">
                    <div className="text-[9px] text-slate-500 leading-none">BP</div>
                    <div className="font-extrabold text-indigo-400 tabular-nums leading-tight">{bp.toLocaleString()}</div>
                  </div>
                </div>

                {/* G-Coin */}
                <div className="flex min-w-0 items-center gap-2.5 p-2.5 bg-slate-950/80 rounded-xl border border-slate-850">
                  <Coins className="w-4 h-4 text-amber-400 shrink-0" />
                  <div className="min-w-0">
                    <div className="text-[9px] text-slate-500 leading-none">G코인</div>
                    <div className="font-extrabold text-amber-400 tabular-nums leading-tight">{gcoin.toLocaleString()}</div>
                  </div>
                </div>

                {/* 쿠폰 */}
                <div className="col-span-2 flex min-w-0 items-center gap-2.5 p-2.5 bg-slate-950/80 rounded-xl border border-slate-850">
                  <Ticket className="w-4 h-4 text-purple-400 shrink-0" />
                  <div className="min-w-0 flex-1">
                    <div className="text-[9px] text-slate-500 leading-none">밀수품 쿠폰</div>
                    <div className="font-extrabold text-purple-400 tabular-nums leading-tight">{coupons}장</div>
                  </div>
                </div>
              </div>

              {/* 누적 충전액 */}
              <div className="flex justify-center items-center bg-slate-950/40 p-2.5 rounded-xl border border-slate-850/60 text-xs">
                <div className="text-[10px] text-slate-500">
                  누적 충전액: <span className="font-extrabold text-emerald-400">{Math.round(spentUsd * exchangeRate).toLocaleString()}원</span>
                </div>
              </div>

              {/* 충전 및 보충 버튼 바 */}
              <div className="grid grid-cols-2 gap-2 pt-2">
                <button
                  onClick={() => setIsRefillModalOpen(true)}
                  className="py-2 bg-slate-950 hover:bg-slate-850 text-indigo-400 border border-indigo-900/40 hover:border-indigo-800/80 font-black rounded-lg text-[10px] active:scale-95 transition-all cursor-pointer flex items-center justify-center gap-1"
                >
                  <InlineIconLabel icon="award">무제한 보충기</InlineIconLabel>
                </button>
                <button
                  onClick={() => setIsChargeModalOpen(true)}
                  className="py-2 bg-gradient-to-r from-amber-500 to-orange-600 hover:from-amber-600 hover:to-orange-700 text-slate-950 font-black rounded-lg text-[10px] active:scale-95 transition-all cursor-pointer flex items-center justify-center gap-1"
                >
                  <InlineIconLabel icon="zap">G코인 충전소</InlineIconLabel>
                </button>
              </div>

              {/* 밀수품 쿠폰 구매 슬롯 추가 */}
              <div className="pt-2">
                <button
                  onClick={() => handleBuyCoupons(10)}
                  disabled={couponWeeklyBuyCount >= 50}
                  className="w-full py-2 bg-slate-950 hover:bg-slate-850 text-indigo-300 border border-indigo-900/40 hover:border-indigo-800/80 font-bold rounded-lg text-[10px] active:scale-95 transition-all cursor-pointer flex items-center justify-center gap-1 disabled:opacity-40 disabled:cursor-not-allowed"
                >
                  밀수품 쿠폰 10장 구매 (8,000 BP) - ({couponWeeklyBuyCount}/50회)
                </button>
              </div>
            </div>

            {/* 2. 상점 라인업 선택 리스트 */}
            <div className="bg-slate-900 border border-slate-800 p-4 rounded-2xl space-y-3 shadow-xl">
              <div 
                className="flex justify-between items-center cursor-pointer md:cursor-default"
                onClick={() => setIsLineupOpen(!isLineupOpen)}
              >
                <h2 className="text-sm font-black text-slate-400 uppercase tracking-widest flex items-center gap-1.5 selection:bg-transparent">
                  <Layers className="w-4 h-4 text-amber-500" />
                  상점 상자 라인업
                </h2>
                <button className="md:hidden text-slate-400 hover:text-slate-200 focus:outline-none cursor-pointer">
                  {isLineupOpen ? <ChevronUp className="w-4 h-4" /> : <ChevronDown className="w-4 h-4" />}
                </button>
              </div>
              
              <div className={`${isLineupOpen ? "block animate-[fadeIn_0.2s_ease-out]" : "hidden md:block"} space-y-2`}>
                {initialCrates.map((crate) => {
                  const isSelected = crate.id === selectedCrateId;
                  return (
                    <button
                      key={crate.id}
                      onClick={() => {
                        setSelectedCrateId(crate.id);
                        setDrawnCards([]);
                        setSelectedInventoryItem(crate.type === "loot_crate" ? "loot_crate" : "coupon");
                        setIsLineupOpen(false); // 모바일에서 선택 완료 시 자동 접기
                      }}
                      className={`w-full text-left p-3.5 rounded-xl border transition-all relative flex flex-col justify-between cursor-pointer ${
                        isSelected
                          ? "bg-gradient-to-br from-slate-850 to-slate-900 border-amber-500/80 shadow-md shadow-amber-500/5"
                          : "bg-slate-950/60 border-slate-850 hover:bg-slate-900/30 hover:border-slate-700"
                      }`}
                    >
                      <div className="flex justify-between items-start w-full">
                        <div>
                          <span className={`text-[8px] px-1.5 py-0.5 rounded font-black uppercase tracking-wider ${
                            crate.type === "loot_crate" 
                              ? "bg-pink-950 text-pink-400 border border-pink-900/30" 
                              : "bg-cyan-950 text-cyan-400 border border-cyan-900/30"
                          }`}>
                            {crate.type === "loot_crate" ? "블랙 마켓 화물" : "성장형 무기 밀수품"}
                          </span>
                          <h3 className="font-extrabold text-slate-200 mt-1.5 text-sm">{crate.name}</h3>
                        </div>
                      </div>
                    </button>
                  );
                })}
              </div>
            </div>

            {/* 3. 모달 호출 버튼 바 (세부 정보 및 특수 제작소) */}
            <div className="grid grid-cols-1 gap-3">
              {/* 특수 제작소 (Crafting) 버튼 - 보너스 토큰 재화가 있는 상자일 때 노출 */}
              {activeCrate?.bonus_currency_code && (
                <button
                  onClick={() => setIsCraftingModalOpen(true)}
                  className="w-full py-3.5 bg-gradient-to-r from-pink-500 via-rose-500 to-red-500 hover:from-pink-600 hover:to-red-600 text-white font-black rounded-2xl shadow-xl shadow-pink-500/10 active:scale-98 transition-all flex items-center justify-center gap-2 cursor-pointer border border-pink-400/20 text-sm"
                >
                  <Sparkles className="w-4 h-4 animate-pulse" />
                  특수 제작소 (Crafting)
                </button>
              )}

              {/* 세부 정보 버튼 */}
              <button
                onClick={() => setIsDetailModalOpen(true)}
                className="w-full py-3 bg-slate-900 hover:bg-slate-850 text-slate-300 font-extrabold rounded-2xl border border-slate-800/80 active:scale-98 transition-all flex items-center justify-center gap-2 cursor-pointer text-xs"
              >
                <Layers className="w-4 h-4 text-slate-400" />
                상자 세부정보 및 확률표
              </button>
            </div>

          </div>

          {/* ====================================================
              우측 영역 (8/12 비율) - 메인 은신처 상점 & 보관함
              ==================================================== */}
          <div className="lg:col-span-8 flex flex-col space-y-4">
            
            {/* 상점 / 보관함 탭 스위처 및 실시간 누적 재화 소비량 노출 */}
            <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3 shrink-0">
              <div className="flex bg-slate-950/80 p-1 rounded-xl border border-slate-850 w-fit shrink-0">
                <button
                  onClick={() => setDrawSubTab("shop")}
                  className={`flex items-center gap-1.5 px-6 py-2.5 rounded-lg text-xs font-black transition-all cursor-pointer ${
                    drawSubTab === "shop"
                      ? "bg-slate-850 text-white shadow"
                      : "text-slate-400 hover:text-slate-200"
                  }`}
                >
                  <ShoppingCart className="w-4 h-4" />
                  은신처 상점
                </button>
                <button
                  onClick={() => setDrawSubTab("inventory")}
                  className={`flex items-center gap-1.5 px-6 py-2.5 rounded-lg text-xs font-black transition-all cursor-pointer ${
                    drawSubTab === "inventory"
                      ? "bg-slate-850 text-white shadow"
                      : "text-slate-400 hover:text-slate-200"
                  }`}
                >
                  <Package className="w-4 h-4" />
                  제작소 보관함
                  {(inventoryCrates[selectedCrateId] || 0) > 0 && (
                    <span className="px-1.5 py-0.5 rounded-full bg-amber-500 text-slate-950 text-[9px] font-black">
                      {inventoryCrates[selectedCrateId]}
                    </span>
                  )}
                </button>
              </div>

              {/* 누적 소비량 컴포넌트 */}
              <div className="flex items-center gap-3 px-4 py-2 bg-slate-950/50 rounded-xl border border-slate-850/80 text-[11px] font-black text-slate-300 shadow-sm shrink-0">
                <InlineIconLabel icon="package" className="text-slate-500">누적 소비 :</InlineIconLabel>
                <span className="text-amber-500 font-extrabold">{spentGcoin.toLocaleString()} G-Coin</span>
                <span className="text-slate-700">|</span>
                <span className="text-indigo-400 font-extrabold">{spentBp.toLocaleString()} BP</span>
              </div>
            </div>

            {/* 1. 개봉 애니메이션 진행 및 카드 결과 노출은 탭에 상관없이 즉시 화면을 덮도록 설정 */}
            {isDrawing && activeCrate ? (
              <div className="bg-slate-900/30 border border-slate-800/80 rounded-3xl p-6 flex flex-col justify-between items-center relative overflow-hidden min-h-[550px] flex-1">
                {/* 배경 그라데이션 광 효과 */}
                <div className="absolute inset-0 bg-[radial-gradient(circle_at_center,rgba(30,58,138,0.1)_0%,transparent_80%)] pointer-events-none" />
                <div className="flex-1 flex flex-col items-center justify-center space-y-5 z-10 py-10">
                  <div className="relative w-36 h-36 flex items-center justify-center">
                    <div className={`absolute inset-0 rounded-full blur-3xl ${
                      hasBonusEffect ? "bg-amber-500/40 gold-glow-active" : "bg-amber-500/5 animate-ping"
                    }`} />
                    <Box className={`w-24 h-24 text-amber-500 anim-shake rounded-2xl ${
                      hasBonusEffect ? "border border-amber-400/80 gold-glow-active shadow-2xl" : ""
                    }`} />
                  </div>
                  <div className="text-center">
                    <h3 className="text-lg font-black text-amber-400 tracking-wide">
                      {drawMode === "prime" ? "최고급 꾸러미 해제 중..." : "상자 해제 중..."}
                    </h3>
                    {hasBonusEffect ? (
                      <div className="mt-1 text-[10px] text-amber-400 font-black animate-pulse inline-flex items-center justify-center gap-1">
                        <Sparkles className="h-3 w-3" /> 보너스 전리품 당첨! 금색 광 방출 중
                      </div>
                    ) : (
                      <p className="text-[10px] text-slate-500 mt-1">상자가 흔들리며 구성품이 인벤토리에 지급되고 있습니다.</p>
                    )}
                  </div>
                </div>
              </div>
            ) : drawnCards.length > 0 && activeCrate ? (
              <div className="bg-slate-900/30 border border-slate-800/80 rounded-3xl p-6 flex flex-col justify-between items-center relative overflow-hidden min-h-[550px] flex-1">
                {/* 배경 그라데이션 광 효과 */}
                <div className="absolute inset-0 bg-[radial-gradient(circle_at_center,rgba(30,58,138,0.1)_0%,transparent_80%)] pointer-events-none" />
                {/* 가챠 결과 카드 리스트 노출 */}
                <div className="flex-1 flex flex-col justify-start space-y-6 my-4 z-10 w-full overflow-hidden">
                  <div className="flex justify-between items-center border-b border-slate-800 pb-2 gap-4">
                    <span className="text-[10px] sm:text-xs text-slate-400 font-bold whitespace-nowrap shrink-0">개봉 결과 목록</span>
                    <div className="flex gap-2 flex-wrap justify-end">
                      <button
                        onClick={handleRevealAllWrapper}
                        className="text-[10px] font-black text-amber-400 hover:text-amber-300 border border-amber-950 px-2.5 py-1 rounded bg-amber-950/10 transition-all cursor-pointer"
                      >
                        전체 뒤집기
                      </button>
                      
                      {/* 쿠폰으로 이어서 열기: 밀수품 상자이고 쿠폰이 10장 이상인 경우 노출 */}
                      {activeCrate?.type === "contraband" && coupons >= 10 && (
                        <button
                          onClick={() => {
                            collectRemainingCards();
                            setDrawnCards([]);
                            handleOpenContrabandWithCoupons(coupons >= 100 ? "ten" : "one");
                          }}
                          disabled={!areAllCardsRevealed}
                          className="text-[10px] font-black text-indigo-300 hover:text-indigo-200 border border-indigo-800 px-2.5 py-1 rounded bg-indigo-950/30 hover:bg-indigo-950/60 disabled:opacity-40 disabled:cursor-not-allowed transition-all cursor-pointer flex items-center gap-1"
                        >
                          <Ticket className="w-3 h-3" />
                          {coupons >= 100 ? `이어서 10개 열기 (100장)` : `이어서 1개 열기 (10장)`}
                        </button>
                      )}

                      {/* G코인으로 이어서 열기: 밀수품 상자이고 G코인이 200 이상인 경우 노출 */}
                      {activeCrate?.type === "contraband" && gcoin >= 200 && (
                        <button
                          onClick={() => {
                            collectRemainingCards();
                            setDrawnCards([]);
                            handleOpenContrabandCrateWithGCoin(gcoin >= gcoinCostForTen ? "ten" : "one");
                          }}
                          disabled={!areAllCardsRevealed}
                          className="text-[10px] font-black text-amber-400 hover:text-amber-300 border border-amber-950 px-2.5 py-1 rounded bg-amber-950/10 hover:bg-amber-950/30 disabled:opacity-40 disabled:cursor-not-allowed transition-all cursor-pointer flex items-center gap-1"
                        >
                          <Coins className="w-3 h-3 text-amber-500" />
                          {gcoin >= gcoinCostForTen ? `이어서 10개 열기 (${gcoinCostForTen.toLocaleString()} G코인)` : "이어서 1개 열기 (200 G코인)"}
                        </button>
                      )}

                      {/* 화물 상자(loot_crate)로 이어서 열기: 남은 개수가 1개 이상인 경우 노출 */}
                      {activeCrate?.type === "loot_crate" && (inventoryCrates[activeCrate.id] || 0) >= 1 && (
                        <button
                          onClick={() => {
                            const count = inventoryCrates[activeCrate.id] || 0;
                            let mode: "one" | "five" | "ten" = "one";
                            if (count >= 10) mode = "ten";
                            else if (count >= 5) mode = "five";
                            
                            collectRemainingCards();
                            setDrawnCards([]);
                            handleOpenInventoryCrates(mode);
                          }}
                          disabled={!areAllCardsRevealed}
                          className="text-[10px] font-black text-pink-300 hover:text-pink-200 border border-pink-850 px-2.5 py-1 rounded bg-pink-950/30 hover:bg-pink-950/60 disabled:opacity-40 disabled:cursor-not-allowed transition-all cursor-pointer flex items-center gap-1"
                        >
                          <Package className="w-3 h-3 text-pink-400" />
                          {(() => {
                            const count = inventoryCrates[activeCrate.id] || 0;
                            if (count >= 10) return `이어서 10개 열기 (보유: ${count}개)`;
                            if (count >= 5) return `이어서 5개 열기 (보유: ${count}개)`;
                            return `이어서 1개 열기 (보유: ${count}개)`;
                          })()}
                        </button>
                      )}

                      {/* 화물 상자 G-Coin으로 이어서 열기 (보유 상자가 부족할 때 대안 노출) */}
                      {activeCrate?.type === "loot_crate" && gcoin >= (activeCrate.price_gcoin || 250) && (
                        <button
                          onClick={() => {
                            collectRemainingCards();
                            setDrawnCards([]);
                            handleOpenLootCrateDirect(gcoin >= (activeCrate.bundle_price_gcoin || 2500) ? "ten" : "one", "gcoin");
                          }}
                          disabled={!areAllCardsRevealed}
                          className="text-[10px] font-black text-amber-400 hover:text-amber-300 border border-amber-950 px-2.5 py-1 rounded bg-amber-950/10 hover:bg-amber-950/30 disabled:opacity-40 disabled:cursor-not-allowed transition-all cursor-pointer flex items-center gap-1"
                        >
                          <Coins className="w-3 h-3 text-amber-500" />
                          {gcoin >= (activeCrate.bundle_price_gcoin || 2500) 
                            ? `이어서 10개 열기 (${(activeCrate.bundle_price_gcoin || 2500).toLocaleString()} G코인)` 
                            : `이어서 1개 열기 (${(activeCrate.price_gcoin || 250).toLocaleString()} G코인)`}
                        </button>
                      )}

                      {/* 화물 상자 티켓으로 이어서 열기 (티켓이 1장 이상 있는 경우 대안 노출) */}
                      {activeCrate?.type === "loot_crate" && blackmarketTickets >= (activeCrate.ticket_price_single || 1) && (
                        <button
                          onClick={() => {
                            collectRemainingCards();
                            setDrawnCards([]);
                            handleOpenLootCrateDirect(blackmarketTickets >= (activeCrate.ticket_price_bundle || 10) ? "ten" : "one", "ticket");
                          }}
                          disabled={!areAllCardsRevealed}
                          className="text-[10px] font-black text-indigo-300 hover:text-indigo-200 border border-indigo-800 px-2.5 py-1 rounded bg-indigo-950/30 hover:bg-indigo-950/60 disabled:opacity-40 disabled:cursor-not-allowed transition-all cursor-pointer flex items-center gap-1"
                        >
                          <Ticket className="w-3 h-3 text-indigo-400" />
                          {blackmarketTickets >= (activeCrate.ticket_price_bundle || 10) 
                            ? `이어서 10개 열기 (티켓 ${(activeCrate.ticket_price_bundle || 10)}장)` 
                            : `이어서 1개 열기 (티켓 ${(activeCrate.ticket_price_single || 1)}장)`}
                        </button>
                      )}

                      <button
                        onClick={() => {
                          collectRemainingCards();
                          setDrawnCards([]);
                        }}
                        className="text-[10px] font-black text-slate-400 hover:text-slate-300 border border-slate-800 px-2.5 py-1 rounded bg-slate-950/50 transition-all cursor-pointer"
                      >
                        결과 닫기
                      </button>
                    </div>
                  </div>

                  <div className="flex-1 overflow-y-auto w-full pr-1 max-h-[440px] sm:max-h-[480px] scrollbar-thin">
                    <div className={`grid gap-3 justify-center mt-2 ${
                      drawnCards.length === 1 
                        ? "grid-cols-1 max-w-[160px] mx-auto" 
                        : "grid-cols-2 sm:grid-cols-5"
                    }`}>
                      {drawnCards.map((card, idx) => (
                        <CrateCard
                          key={card.id}
                          card={card}
                          isRevealed={revealedCards[idx]}
                          onClick={() => handleCardClickWrapper(idx)}
                          getRarityBadgeStyle={getRarityBadgeStyle}
                          getCardBorderGlow={getCardBorderGlow}
                        />
                      ))}
                    </div>
                  </div>
                </div>
              </div>
            ) : (
              <>
                {/* 1. 은신처 상점 탭 */}
                {drawSubTab === "shop" && activeCrate && (
                  <div className="bg-slate-900/30 border border-slate-800/80 rounded-3xl p-6 flex flex-col justify-between items-center relative overflow-hidden min-h-[550px] flex-1">
                    
                    {/* 배경 그라데이션 광 효과 */}
                    <div className="absolute inset-0 bg-[radial-gradient(circle_at_center,rgba(30,58,138,0.1)_0%,transparent_80%)] pointer-events-none" />

                    {/* 중앙 상단: 상자 타이틀 및 실시간 D-Day 타이머 */}
                    <div className="text-center z-10 space-y-2 mt-2">
                      {activeCrate.end_date && (
                        <div className="inline-flex items-center gap-1.5 px-3 py-1 bg-slate-950/80 border border-slate-800 text-[10px] text-amber-500 font-extrabold rounded-full shadow-md">
                          <span className="w-1.5 h-1.5 bg-amber-500 rounded-full animate-ping" />
                          판매 종료까지: {timeLeft.isExpired ? "판매 종료됨" : `${timeLeft.days}일 ${timeLeft.hours}시간 ${timeLeft.minutes}분 ${timeLeft.seconds}초`}
                        </div>
                      )}
                      <h2 className="text-3xl font-black text-slate-100 tracking-tight">{activeCrate.name}</h2>
                      <p className="text-xs text-slate-400 max-w-md mx-auto">{activeCrate.description}</p>
                    </div>

                    {/* 중앙 메인: 웅장한 쇼케이스 이미지 */}
                    <div className="relative w-full max-w-xs aspect-square flex items-center justify-center my-6 z-10 group">
                      <div className="absolute inset-0 bg-amber-500/5 rounded-full blur-3xl group-hover:bg-amber-500/10 transition-colors pointer-events-none" />
                      <img
                        src={activeCrate.image_url}
                        alt={activeCrate.name}
                        className="object-contain max-h-56 drop-shadow-[0_15px_30px_rgba(0,0,0,0.8)] transform group-hover:scale-105 transition-all duration-500 ease-out"
                        onError={(e) => {
                          (e.target as any).style.display = "none";
                        }}
                      />
                      {/* 이미지 에러시 대체 카드 */}
                      <Box className="w-20 h-20 text-slate-800 absolute inset-0 m-auto -z-10 animate-pulse" />
                    </div>

                    {/* 하단 제어부: 밀수품 vs 전리품 각각의 상점 구매 버튼 */}
                    <div className="w-full max-w-xl z-10 border-t border-slate-800/80 pt-5 space-y-4">
                      
                      {activeCrate.type === "contraband" ? (
                        /* [사진 1] 밀수품 상자용 버튼 세트 */
                        <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
                          
                          {/* 1회 열기 (200 G코인) */}
                          <button
                            onClick={() => handleOpenContrabandCrateWithGCoin("one")}
                            disabled={timeLeft.isExpired}
                            className="py-3.5 bg-slate-850 hover:bg-slate-800 text-white font-extrabold rounded-xl border border-slate-700 active:scale-95 shadow-lg flex flex-col items-center justify-center gap-1 cursor-pointer transition-all disabled:opacity-50 disabled:cursor-not-allowed"
                          >
                            <span className="text-slate-400 text-[10px] font-bold">1회 열기</span>
                            <div className="flex items-center gap-1 text-xs">
                              <Coins className="w-4 h-4 text-amber-500" />
                              <span>200 G코인</span>
                            </div>
                          </button>

                          {/* 10회 열기 (할인 노출) */}
                          <button
                            onClick={() => handleOpenContrabandCrateWithGCoin("ten")}
                            disabled={timeLeft.isExpired}
                            className="py-3.5 bg-gradient-to-r from-amber-500 to-orange-600 hover:from-amber-600 hover:to-orange-700 text-slate-950 font-black rounded-xl active:scale-95 shadow-xl shadow-orange-500/10 flex flex-col items-center justify-center gap-1 cursor-pointer transition-all disabled:opacity-50 disabled:cursor-not-allowed relative overflow-hidden"
                          >
                            {/* 10% 또는 50% 할인 동적 뱃지 */}
                            <div className="absolute top-1 right-1 text-[8px] font-black bg-red-600 text-white px-1 py-0.2 rounded uppercase">
                              {isTenDrawCompleted ? "10% 할인" : "50% 할인"}
                            </div>
                            <span className="text-slate-950 text-[10px] font-black">10회 열기</span>
                            <div className="flex items-center gap-1 text-xs">
                              <Coins className="w-4 h-4 text-slate-950" />
                              <span className="line-through text-slate-950/50 text-[9px]">2,000 G코인</span>
                              <span className="font-black">{isTenDrawCompleted ? "1,800" : "1,000"} G코인</span>
                            </div>
                          </button>

                          {/* 쿠폰으로 열기 */}
                          <button
                            onClick={() => handleOpenContrabandWithCoupons("one")}
                            disabled={timeLeft.isExpired || coupons < 10}
                            className={`py-3.5 bg-indigo-950/80 hover:bg-indigo-900/90 text-indigo-200 font-extrabold rounded-xl border border-indigo-700/60 active:scale-95 shadow-lg flex flex-col items-center justify-center gap-1 cursor-pointer transition-all disabled:opacity-40 disabled:cursor-not-allowed`}
                          >
                            <span className="text-indigo-400 text-[10px] font-bold">쿠폰으로 열기</span>
                            <div className="flex items-center gap-1 text-xs text-indigo-300">
                              <Ticket className="w-4 h-4 text-indigo-400" />
                              <span>10장 보유: {coupons}/10</span>
                            </div>
                          </button>

                        </div>
                      ) : (
                        /* 전리품 상자용 제어부 */
                        activeCrate.ticket_currency_code ? (
                          /* [고도화] 즉시 개봉 및 티켓 병행 결제 UI (블랙 마켓 전리품 상자) */
                          <div className="space-y-4">
                            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                              {/* G-Coin 1회 열기 */}
                              <button
                                onClick={() => handleOpenLootCrateDirect("one", "gcoin")}
                                disabled={timeLeft.isExpired}
                                className="py-3.5 bg-slate-850 hover:bg-slate-800 text-white font-extrabold rounded-xl border border-slate-700 active:scale-95 shadow-lg flex flex-col items-center justify-center gap-1 cursor-pointer transition-all disabled:opacity-50 disabled:cursor-not-allowed"
                              >
                                <span className="text-slate-400 text-[10px] font-bold">1회 열기 (G-Coin)</span>
                                <div className="flex items-center gap-1 text-xs">
                                  <Coins className="w-4 h-4 text-amber-500" />
                                  <span>{(activeCrate.price_gcoin || 250).toLocaleString()} G코인</span>
                                </div>
                                <span className="text-[8px] text-pink-500 font-bold leading-none mt-0.5">보너스: 토큰 x{(activeCrate.bonus_amount_single || 10)}</span>
                              </button>

                              {/* G-Coin 10회 열기 */}
                              <button
                                onClick={() => handleOpenLootCrateDirect("ten", "gcoin")}
                                disabled={timeLeft.isExpired}
                                className="py-3.5 bg-gradient-to-r from-amber-500 to-orange-600 hover:from-amber-600 hover:to-orange-700 text-slate-950 font-black rounded-xl active:scale-95 shadow-xl shadow-orange-500/10 flex flex-col items-center justify-center gap-1 cursor-pointer transition-all disabled:opacity-50 disabled:cursor-not-allowed"
                              >
                                <span className="text-slate-950 text-[10px] font-black">10회 열기 (G-Coin)</span>
                                <div className="flex items-center gap-1 text-xs">
                                  <Coins className="w-4 h-4 text-slate-950" />
                                  <span className="font-black">{(activeCrate.bundle_price_gcoin || 2500).toLocaleString()} G코인</span>
                                </div>
                                <span className="text-[8px] text-red-950 font-bold leading-none mt-0.5">보너스: 토큰 x{(activeCrate.bonus_amount_bundle || 100)}</span>
                              </button>

                              {/* 티켓 1회 열기 */}
                              <button
                                onClick={() => handleOpenLootCrateDirect("one", "ticket")}
                                disabled={timeLeft.isExpired || blackmarketTickets < (activeCrate.ticket_price_single || 1)}
                                className="py-3.5 bg-slate-950 hover:bg-slate-900 text-slate-200 font-extrabold rounded-xl border border-slate-800 hover:border-slate-700 active:scale-95 shadow-lg flex flex-col items-center justify-center gap-1 cursor-pointer transition-all disabled:opacity-40 disabled:cursor-not-allowed"
                              >
                                <span className="text-slate-500 text-[10px] font-bold">1회 열기 (티켓)</span>
                                <div className="flex items-center gap-1.5 text-xs">
                                  <Ticket className="w-4 h-4 text-amber-500" />
                                  <span>화물 티켓 {(activeCrate.ticket_price_single || 1)}장 소모</span>
                                </div>
                                <span className="text-[8px] text-slate-400 font-bold mt-0.5">보유: {blackmarketTickets} / {(activeCrate.ticket_price_single || 1)}</span>
                              </button>

                              {/* 티켓 10회 열기 */}
                              <button
                                onClick={() => handleOpenLootCrateDirect("ten", "ticket")}
                                disabled={timeLeft.isExpired || blackmarketTickets < (activeCrate.ticket_price_bundle || 10)}
                                className="py-3.5 bg-slate-950 hover:bg-slate-900 text-slate-200 font-extrabold rounded-xl border border-slate-800 hover:border-slate-700 active:scale-95 shadow-lg flex flex-col items-center justify-center gap-1 cursor-pointer transition-all disabled:opacity-40 disabled:cursor-not-allowed"
                              >
                                <span className="text-slate-500 text-[10px] font-bold">10회 열기 (티켓)</span>
                                <div className="flex items-center gap-1.5 text-xs">
                                  <Ticket className="w-4 h-4 text-amber-500" />
                                  <span>화물 티켓 {(activeCrate.ticket_price_bundle || 10)}장 소모</span>
                                </div>
                                <span className="text-[8px] text-slate-400 font-bold mt-0.5">보유: {blackmarketTickets} / {(activeCrate.ticket_price_bundle || 10)}</span>
                              </button>
                            </div>

                            {/* BP로 티켓 구매 슬롯 */}
                            {activeCrate.price_bp && (
                              <div className="pt-2 border-t border-slate-850/80">
                                <button
                                  onClick={() => handleBuyBlackmarketTickets(1)}
                                  disabled={timeLeft.isExpired || bpBuyCount >= (activeCrate.price_bp_limit || 50)}
                                  className="w-full py-3 bg-indigo-950/20 hover:bg-indigo-950/50 border border-indigo-900/40 text-indigo-300 font-extrabold rounded-xl flex items-center justify-center gap-2 active:scale-95 transition-all cursor-pointer disabled:opacity-40 text-xs shadow-sm"
                                >
                                  <Ticket className="w-4 h-4 text-indigo-400" />
                                  화물 티켓 1개 구매 ({(activeCrate.price_bp || 10000).toLocaleString()} BP) - (BP 구매 횟수: {bpBuyCount}/{(activeCrate.price_bp_limit || 50)}회)
                                </button>
                              </div>
                            )}
                          </div>
                        ) : (
                          /* 레거시 패키지 구매 버튼바 (하위 호환성) */
                          <div className="space-y-4">
                            <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
                              {/* X55 */}
                              <button
                                onClick={() => handleBuyPackage("X55")}
                                disabled={timeLeft.isExpired}
                                className="p-3 bg-slate-950 hover:bg-slate-850 border border-slate-800 hover:border-amber-500/50 rounded-xl text-center active:scale-95 transition-all cursor-pointer flex flex-col items-center justify-between min-h-[90px] disabled:opacity-50"
                              >
                                <span className="text-[10px] font-black text-amber-500">화물 상자 55개</span>
                                <div className="text-[8px] text-slate-500 mt-1 leading-tight">상자55+토큰800</div>
                                <span className="text-xs font-black text-slate-300 mt-2">12,500 G코인</span>
                              </button>

                              {/* X27 */}
                              <button
                                onClick={() => handleBuyPackage("X27")}
                                disabled={timeLeft.isExpired}
                                className="p-3 bg-slate-950 hover:bg-slate-850 border border-slate-800 hover:border-slate-700 rounded-xl text-center active:scale-95 transition-all cursor-pointer flex flex-col items-center justify-between min-h-[90px] disabled:opacity-50"
                              >
                                <span className="text-[10px] font-black text-slate-200">화물 상자 27개</span>
                                <div className="text-[8px] text-slate-500 mt-1 leading-tight">상자27+토큰400</div>
                                <span className="text-xs font-black text-slate-355 mt-2">6,250 G코인</span>
                              </button>

                              {/* X11 */}
                              <button
                                onClick={() => handleBuyPackage("X11")}
                                disabled={timeLeft.isExpired}
                                className="p-3 bg-slate-950 hover:bg-slate-850 border border-slate-800 hover:border-slate-700 rounded-xl text-center active:scale-95 transition-all cursor-pointer flex flex-col items-center justify-between min-h-[90px] disabled:opacity-50"
                              >
                                <span className="text-[10px] font-black text-slate-200">화물 상자 11개</span>
                                <div className="text-[8px] text-slate-500 mt-1 leading-tight">상자11+토큰150</div>
                                <span className="text-xs font-black text-slate-355 mt-2">2,500 G코인</span>
                              </button>

                              {/* X1 */}
                              <button
                                onClick={() => handleBuyPackage("X1", "gcoin")}
                                disabled={timeLeft.isExpired}
                                className="p-3 bg-slate-950 hover:bg-slate-850 border border-slate-800 hover:border-slate-700 rounded-xl text-center active:scale-95 transition-all cursor-pointer flex flex-col items-center justify-between min-h-[90px] disabled:opacity-50"
                              >
                                <span className="text-[10px] font-black text-slate-200">화물 상자 1개</span>
                                <div className="text-[8px] text-slate-500 mt-1 leading-tight">상자1+토큰15</div>
                                <span className="text-xs font-black text-slate-355 mt-2">250 G코인</span>
                              </button>
                            </div>

                            {/* BP로 X1 전리품 상자 구매 추가 슬롯 */}
                            <div className="pt-1">
                              <button
                                onClick={() => handleBuyPackage("X1", "bp")}
                                disabled={timeLeft.isExpired || bpBuyCount >= 50}
                                className="w-full py-2.5 bg-indigo-950/30 hover:bg-indigo-950/60 border border-indigo-900/40 text-indigo-300 font-extrabold rounded-lg flex items-center justify-center gap-1 active:scale-95 transition-all cursor-pointer disabled:opacity-40 text-xs"
                              >
                                상자 1개 구매 (10,000 BP) - ({bpBuyCount}/50회)
                              </button>
                            </div>
                          </div>
                        )
                      )}

                    </div>
                  </div>
                )}

                {/* 2. 제작소 보관함 탭 */}
                {drawSubTab === "inventory" && activeCrate && (
                  <div className="bg-slate-900/20 border border-slate-800/80 rounded-3xl p-5 flex flex-col justify-between relative overflow-hidden min-h-[550px] flex-1">
                    
                    {/* 2-A. 보유 목록 셀렉터 */}
                    <div className="grid gap-3 shrink-0 z-10 grid-cols-1">
                      {activeCrate.type === "loot_crate" ? (
                        /* 전리품 상자 */
                        <div
                          onClick={() => {
                            collectRemainingCards();
                            setSelectedInventoryItem("loot_crate");
                            setDrawnCards([]);
                          }}
                          className={`p-3.5 rounded-xl border cursor-pointer transition-all flex items-center gap-2.5 relative ${
                            selectedInventoryItem === "loot_crate"
                              ? "bg-slate-850 border-amber-500 shadow-md shadow-amber-500/10 font-bold"
                              : "bg-slate-950/60 border-slate-850 hover:border-slate-700"
                          }`}
                        >
                          <Package className="w-7 h-7 text-amber-500 shrink-0" />
                          <div className="min-w-0">
                            <h4 className="text-[11px] font-black text-slate-200 truncate">{activeCrate.name}</h4>
                            <p className="text-[9px] text-slate-500 mt-0.5">
                              보유: <span className="font-extrabold text-amber-500">{(inventoryCrates[activeCrate.id] || 0)}</span> 개
                            </p>
                          </div>
                        </div>
                      ) : (
                        <div
                          onClick={() => {
                            collectRemainingCards();
                            setSelectedInventoryItem("coupon");
                            setDrawnCards([]);
                          }}
                          className={`p-3.5 rounded-xl border cursor-pointer transition-all flex items-center gap-2.5 relative ${
                            selectedInventoryItem === "coupon"
                              ? "bg-slate-850 border-indigo-500 shadow-md shadow-indigo-500/10 font-bold"
                              : "bg-slate-950/60 border-slate-850 hover:border-slate-700"
                          }`}
                        >
                          <Ticket className="w-7 h-7 text-indigo-400 shrink-0" />
                          <div className="min-w-0">
                            <h4 className="text-[11px] font-black text-slate-200 truncate">밀수품 쿠폰</h4>
                            <p className="text-[9px] text-slate-500 mt-0.5">
                              보유: <span className="font-extrabold text-indigo-400">{coupons}</span> 장
                            </p>
                          </div>
                        </div>
                      )}
                    </div>

                    {/* [사진 2] 보관함 개봉 대기 상태 - (좌: 상자 그래픽 / 우: 구성품 명세 구조) */}
                    <div className="flex-1 flex flex-col md:flex-row gap-6 my-6 z-10 items-stretch">
                      
                      {/* 좌측: 상자 대형 이미지 및 개봉 상태 */}
                      <div className="flex-1 bg-slate-950/50 rounded-2xl border border-slate-850/60 p-6 flex flex-col items-center justify-center text-center">
                        <div className="w-28 h-28 flex items-center justify-center relative mb-4">
                          {selectedInventoryItem === "coupon" ? (
                            <Ticket className="w-16 h-16 text-indigo-400 anim-float" />
                          ) : (
                            <img
                              src={activeCrate.image_url}
                              alt={activeCrate.name}
                              className="max-h-24 object-contain drop-shadow-[0_8px_16px_rgba(0,0,0,0.6)]"
                            />
                          )}
                        </div>
                        
                        <h3 className="text-base font-black text-slate-200">
                          {selectedInventoryItem === "coupon" 
                            ? "밀수품 쿠폰 사용" 
                            : `${activeCrate.name} 열기`}
                        </h3>
                        
                        <p className="text-[10px] text-slate-400 mt-1">
                          보유량:{" "}
                          <span className="font-extrabold text-amber-500">
                            {selectedInventoryItem === "coupon" 
                              ? coupons 
                              : (inventoryCrates[activeCrate.id] || 0)}
                          </span>
                          {selectedInventoryItem === "coupon" ? "장" : "개"}
                        </p>
                      </div>



                    </div>

                    {/* 2-C. 개봉 버튼바 */}
                    <div className="mt-4 border-t border-slate-850/80 pt-4 shrink-0">
                      {selectedInventoryItem === "coupon" ? (
                        <div className="flex flex-wrap gap-2 justify-center w-full">
                          <button
                            onClick={() => handleOpenContrabandWithCoupons("one")}
                            disabled={isDrawing || coupons < 10}
                            className="flex-1 min-w-[100px] py-3 bg-slate-850 hover:bg-slate-800 text-white font-extrabold rounded-xl border border-slate-700 active:scale-95 transition-all text-xs cursor-pointer disabled:opacity-50 disabled:cursor-not-allowed text-center"
                          >
                            1개 열기 (10장)
                          </button>
                          {coupons >= 50 && coupons < 100 && (
                            <button
                              onClick={() => handleOpenContrabandWithCoupons("five")}
                              disabled={isDrawing}
                              className="flex-1 min-w-[100px] py-3 bg-slate-850 hover:bg-slate-800 text-white font-extrabold rounded-xl border border-slate-700 active:scale-95 transition-all text-xs cursor-pointer text-center"
                            >
                              5개 열기 (50장)
                            </button>
                          )}
                          {coupons >= 100 && (
                            <button
                              onClick={() => handleOpenContrabandWithCoupons("ten")}
                              disabled={isDrawing}
                              className="flex-1 min-w-[100px] py-3 bg-slate-850 hover:bg-slate-800 text-white font-extrabold rounded-xl border border-slate-700 active:scale-95 transition-all text-xs cursor-pointer text-center"
                            >
                              10개 열기 (100장)
                            </button>
                          )}
                          {coupons >= 20 && (
                            <button
                              onClick={() => handleOpenContrabandWithCoupons("all")}
                              disabled={isDrawing}
                              className="flex-1 min-w-[120px] py-3 bg-gradient-to-r from-indigo-500 to-purple-600 hover:from-indigo-600 hover:to-purple-700 text-white font-black rounded-xl active:scale-95 transition-all text-xs cursor-pointer text-center"
                            >
                              전체 열기 ({Math.floor(coupons / 10)}개)
                            </button>
                          )}
                        </div>
                      ) : (
                        <div className="flex flex-wrap gap-2 justify-center w-full">
                          <button
                            onClick={() => handleOpenInventoryCrates("one")}
                            disabled={isDrawing || (inventoryCrates[activeCrate.id] || 0) < 1}
                            className="flex-1 min-w-[100px] py-3 bg-slate-850 hover:bg-slate-800 text-white font-extrabold rounded-xl border border-slate-700 active:scale-95 transition-all text-xs cursor-pointer disabled:opacity-50 disabled:cursor-not-allowed text-center"
                          >
                            1개 열기 (1개)
                          </button>
                          {(inventoryCrates[activeCrate.id] || 0) >= 5 && (inventoryCrates[activeCrate.id] || 0) < 10 && (
                            <button
                              onClick={() => handleOpenInventoryCrates("five")}
                              disabled={isDrawing}
                              className="flex-1 min-w-[100px] py-3 bg-slate-850 hover:bg-slate-800 text-white font-extrabold rounded-xl border border-slate-700 active:scale-95 transition-all text-xs cursor-pointer text-center"
                            >
                              5개 열기 (5개)
                            </button>
                          )}
                          {(inventoryCrates[activeCrate.id] || 0) >= 10 && (
                            <button
                              onClick={() => handleOpenInventoryCrates("ten")}
                              disabled={isDrawing}
                              className="flex-1 min-w-[100px] py-3 bg-slate-850 hover:bg-slate-800 text-white font-extrabold rounded-xl border border-slate-700 active:scale-95 transition-all text-xs cursor-pointer text-center"
                            >
                              10개 열기 (10개)
                            </button>
                          )}
                          {(inventoryCrates[activeCrate.id] || 0) >= 55 && (
                            <button
                              onClick={() => handleOpenInventoryCrates("fiftyfive")}
                              disabled={isDrawing}
                              className="flex-1 min-w-[100px] py-3 bg-slate-850 hover:bg-slate-800 text-white font-extrabold rounded-xl border border-slate-700 active:scale-95 transition-all text-xs cursor-pointer text-center"
                            >
                              55개 열기 (55개)
                            </button>
                          )}
                          {(inventoryCrates[activeCrate.id] || 0) >= 2 && (
                            <button
                              onClick={() => handleOpenInventoryCrates("all")}
                              disabled={isDrawing}
                              className="flex-1 min-w-[120px] py-3 bg-gradient-to-r from-amber-500 to-orange-600 hover:from-amber-600 hover:to-orange-700 text-slate-950 font-black rounded-xl active:scale-95 transition-all text-xs cursor-pointer text-center"
                            >
                              전체 열기 ({(inventoryCrates[activeCrate.id] || 0)}개)
                            </button>
                          )}
                        </div>
                      )}
                    </div>

                  </div>
                )}
              </>
            )}

          </div>

        </div>

        </div>

        {/* 모바일/일반 화면 하단 광고 — xl 미만에서만 표시, 320x100 가로 배너 */}
        <div className="my-6 flex justify-center xl:hidden">
          <AdfitBanner
            adUnit="DAN-tQGcqmddMC8tPpXA"
            adWidth={320}
            adHeight={100}
          />
        </div>

        {/* 좌측 레일은 고정하지 않고 문서 흐름에 배치한다. 좌우 동시 고정 광고는 정책 위반이다. */}
        <aside
          className="hidden [@media(min-width:1280px)_and_(min-height:680px)]:block xl:col-start-1 xl:row-start-1 self-start"
          aria-label="광고"
        >
          <div className="h-[600px] w-[160px]">
            <AdfitBanner adUnit="DAN-RjyosR2uf8eSsVIC" adWidth={160} adHeight={600} />
          </div>
        </aside>
        {/* 뷰포트 고정 광고는 우측 한 곳만 유지한다. self-start를 제거해 컬럼 전체 높이를 확보한다. */}
        <aside
          className="hidden [@media(min-width:1280px)_and_(min-height:680px)]:block xl:col-start-3 xl:row-start-1"
          aria-label="광고"
        >
          <div className="sticky top-20 h-[600px] w-[160px]">
            <AdSenseBanner client="ca-pub-3993032200487955" slot="1650598365" />
          </div>
        </aside>

      </div>

      {/* G-Coin 충전소 모달 */}
      <ChargeModal
        isOpen={isChargeModalOpen}
        onClose={() => setIsChargeModalOpen(false)}
        onCharge={handleChargeGCoin}
        exchangeRate={exchangeRate}
      />

      {/* 구매 수량 선택 모달 */}
      <QuantityModal
        isOpen={isQuantityModalOpen}
        onClose={() => setIsQuantityModalOpen(false)}
        crateName={activeCrate?.name}
        quantity={quantityToBuy}
        setQuantity={setQuantityToBuy}
        paymentMethod={quantityPaymentMethod}
        onConfirm={executeBuyPackage}
      />

      {/* 이벤트 재화 보충기 모달 */}
      <RefillModal
        isOpen={isRefillModalOpen}
        onClose={() => setIsRefillModalOpen(false)}
        refillType={refillType}
        setRefillType={setRefillType}
        refillAmount={refillAmount}
        setRefillAmount={setRefillAmount}
        onRefill={handleRefillAsset}
        onRefillInfinite={handleRefillInfinite}
      />

      {/* 특수 제작소 (Crafting) 모달 */}
      <CraftingModal
        isOpen={isCraftingModalOpen}
        onClose={() => setIsCraftingModalOpen(false)}
        tokens={tokens}
        obtainedSkins={obtainedSkins}
        onCraft={handleCraftItemWrapper}
        craftableItems={craftableItems}
      />

      {/* 상자 세부정보 (Vault, 히스토리, 확률표) 모달 */}
      <DetailModal
        isOpen={isDetailModalOpen}
        onClose={() => setIsDetailModalOpen(false)}
        activeCrate={activeCrate}
        obtainedSkins={obtainedSkins}
        history={history}
        getRarityBadgeStyle={getRarityBadgeStyle}
        onReset={handleResetSimulator}
      />

      {/* 시뮬레이터 초기화 확인 모달 */}
      <ConfirmModal
        isOpen={isResetModalOpen}
        title="시뮬레이터 초기화"
        description="시뮬레이터 진행 데이터를 초기화하시겠습니까? (소모 금액 및 히스토리 포함)"
        confirmText="초기화"
        cancelText="취소"
        type="warning"
        onConfirm={executeResetSimulator}
        onCancel={() => setIsResetModalOpen(false)}
      />

      {/* 고등급 스킨 단독 쇼케이스 연출 모달 */}
      {currentShowcaseCard && (
        <div className="fixed inset-0 z-[10000] flex flex-col items-center justify-center bg-[#070b13]/95 backdrop-blur-md animate-[fadeIn_0.35s_cubic-bezier(0.16,1,0.3,1)] select-none">
          {/* 뒷배경 황금색 원형 글로우 */}
          <div className="absolute w-[600px] h-[600px] rounded-full bg-amber-500/10 blur-[120px] pointer-events-none animate-pulse" />
          <div className="absolute w-[300px] h-[300px] rounded-full bg-yellow-500/15 blur-[60px] pointer-events-none animate-[ping_4s_infinite]" />

          {/* 상단 텍스트 */}
          <h1 className="text-3xl sm:text-4xl font-black text-slate-100 tracking-wider mb-12 animate-[fadeIn_0.5s_ease-out] drop-shadow-[0_2px_4px_rgba(0,0,0,0.8)]">
            축하합니다!
          </h1>

          {/* 가로형 황금색 데코 날개 배너 및 카드 영역 */}
          <div className="relative w-full max-w-4xl flex items-center justify-center py-12 animate-[fadeIn_0.6s_ease-out]">
            
            {/* 왼쪽 날개 배너 */}
            <div className="hidden sm:block absolute left-4 right-1/2 mr-36 h-[90px] bg-gradient-to-l from-amber-500/20 via-amber-950/10 to-transparent border-y border-amber-500/30 transform skew-x-[-15deg] pointer-events-none">
              <div className="absolute right-4 top-0 bottom-0 w-1 bg-amber-400/50" />
              <div className="absolute right-8 top-1/2 -translate-y-1/2 w-1.5 h-1.5 bg-amber-400 rotate-45" />
            </div>

            {/* 오른쪽 날개 배너 */}
            <div className="hidden sm:block absolute right-4 left-1/2 ml-36 h-[90px] bg-gradient-to-r from-amber-500/20 via-amber-950/10 to-transparent border-y border-amber-500/30 transform skew-x-[15deg] pointer-events-none">
              <div className="absolute left-4 top-0 bottom-0 w-1 bg-amber-400/50" />
              <div className="absolute left-8 top-1/2 -translate-y-1/2 w-1.5 h-1.5 bg-amber-400 rotate-45" />
            </div>

            {/* 중앙 웅장한 카드 쇼케이스 박스 */}
            <div className="relative z-10 w-64 h-84 sm:w-80 sm:h-[420px] rounded-3xl bg-slate-900 border-[3px] border-amber-500 p-6 flex flex-col justify-between items-center shadow-[0_0_50px_rgba(245,158,11,0.4)] animate-[goldBounceZoom_1.3s_cubic-bezier(0.25,1,0.5,1)]">
              
              {/* 골드 뱃지 */}
              <div className="flex justify-center w-full">
                <span className={`text-[10px] font-black px-3 py-1 rounded shadow-lg ${getRarityBadgeStyle(currentShowcaseCard.rarity)}`}>
                  {getKoreanRarityName(currentShowcaseCard.rarity)}
                </span>
              </div>

              {/* 이미지 박스 */}
              <div className="w-48 h-48 sm:w-60 sm:h-60 flex items-center justify-center bg-slate-950/60 rounded-2xl p-4 border border-slate-800/80 relative shadow-[inset_0_0_20px_rgba(0,0,0,0.8)]">
                <img 
                  src={currentShowcaseCard.image_url || ""} 
                  alt={currentShowcaseCard.name}
                  className="object-contain max-h-full max-w-full drop-shadow-[0_10px_20px_rgba(0,0,0,0.8)]"
                />
              </div>

              {/* 등급명 + 무기 이름 텍스트 */}
              <div className="text-center w-full space-y-1.5">
                <div className={`text-xs font-black tracking-widest ${
                  currentShowcaseCard.rarity === "ULTIMATE" ? "text-red-500" : "text-purple-400"
                }`}>
                  {currentShowcaseCard.rarity === "ULTIMATE" ? "얼티밋 크로마" : "레전더리 성장"}
                </div>
                <h2 className="font-extrabold text-base sm:text-lg text-slate-100 line-clamp-1 break-keep leading-tight px-1" title={currentShowcaseCard.name}>
                  {currentShowcaseCard.name}
                </h2>
              </div>

            </div>
          </div>

          {/* 하단 확인 버튼 */}
          <button
            onClick={() => setCurrentShowcaseCard(null)}
            className="mt-12 px-10 py-3 bg-slate-900 hover:bg-slate-850 active:scale-95 text-slate-300 font-extrabold border border-slate-800 rounded-lg shadow-lg cursor-pointer transition-all flex items-center gap-2 text-sm z-10"
          >
            <span className="text-[10px] px-1.5 py-0.5 bg-slate-800 text-slate-500 rounded border border-slate-750 font-black">ESC</span>
            확인
          </button>
        </div>
      )}

    </div>
  );
}
