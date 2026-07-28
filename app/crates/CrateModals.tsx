import React, { useState } from "react";
import { Coins, Box, Award, Ticket, Sparkles, History, AlertTriangle, Layers } from "lucide-react";
import type { CrateTemplate } from "@/types/crates";
import { HistoryItem } from "./types";
import { VaultCard, HistoryCard, getKoreanRarityName } from "./CrateCards";
import { AppModal } from "@/components/common/AppModal";
import { InlineIconLabel } from "@/components/common/InlineIconLabel";

function getOwnedCount(obtainedSkins: Record<string, number>, item: { name: string; asset_key?: string | null }) {
  return obtainedSkins[item.asset_key || item.name] || obtainedSkins[item.name] || 0;
}

// ----------------------------------------------------
// ChargeModal Props & Component
// ----------------------------------------------------
interface ChargeModalProps {
  isOpen: boolean;
  onClose: () => void;
  onCharge: (amount: number, price: number) => void;
  exchangeRate: number;
}

export function ChargeModal({ isOpen, onClose, onCharge, exchangeRate = 1500 }: ChargeModalProps) {
  return (
    <AppModal isOpen={isOpen} title="가상 G코인 충전소" onClose={onClose} panelClassName="max-w-xl">
      <div className="bg-slate-900 border border-slate-800 rounded-3xl p-6 w-full space-y-6 shadow-2xl relative max-h-[90vh] flex flex-col">
        
        {/* 닫기 버튼 */}
        <button
          onClick={onClose}
          aria-label="닫기"
          className="absolute top-4 right-4 text-slate-400 hover:text-white font-bold text-lg cursor-pointer px-2 py-1 rounded-lg hover:bg-slate-800 transition-all z-10"
        >
          ✕
        </button>

        <div className="text-center shrink-0">
          <h2 className="text-xl font-black text-amber-400 flex items-center justify-center gap-1.5">
            <Coins className="w-6 h-6 text-amber-500" />
            가상 G코인 충전소
          </h2>
          <p className="text-xs text-slate-400 mt-1">
            원하시는 가상 G코인 패키지를 충전하세요. 누적 충전액은 한화 환산액에 실시간 누적됩니다.
          </p>
        </div>

        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4 flex-1 overflow-y-auto pr-1">
          {[
            { amount: 11200, price: 99.99, badge: "최고 효율" },
            { amount: 5500, price: 49.99, badge: "인기" },
            { amount: 2700, price: 24.99 },
            { amount: 1050, price: 9.99 },
            { amount: 510, price: 4.99 },
            { amount: 100, price: 0.99 }
          ].map((pack) => (
            <div
              key={pack.amount}
              onClick={() => onCharge(pack.amount, pack.price)}
              className="bg-slate-950/60 hover:bg-slate-950 border border-slate-800 hover:border-amber-500/50 p-4 rounded-2xl flex flex-col justify-between items-start cursor-pointer hover:scale-[1.02] hover:shadow-[0_0_15px_rgba(245,158,11,0.05)] transition-all group relative overflow-hidden min-h-[112px]"
            >
              {pack.badge && (
                <span className="absolute top-2 right-2 bg-amber-500/10 border border-amber-500/30 text-amber-400 text-[8px] font-extrabold px-1.5 py-0.5 rounded uppercase tracking-wider">
                  {pack.badge}
                </span>
              )}
              <div>
                <span className="text-[10px] text-slate-500 font-bold uppercase tracking-wider">G코인 패키지</span>
                <h4 className="text-base font-black text-slate-200 mt-1 flex items-center gap-1 group-hover:text-amber-400 transition-colors">
                  <Coins className="w-4 h-4 text-amber-500" />
                  {pack.amount.toLocaleString()} G코인
                </h4>
              </div>
              <div className="mt-4 flex justify-between w-full items-center">
                <span className="text-xs text-slate-400 font-medium">
                  ~ {Math.round(pack.price * exchangeRate).toLocaleString()}원
                </span>
                <span className="text-xs font-black text-emerald-400 bg-emerald-950/40 border border-emerald-900/30 px-2 py-1 rounded-lg">
                  ${pack.price}
                </span>
              </div>
            </div>
          ))}
        </div>

        <div className="bg-slate-950/40 border border-slate-850 p-4 rounded-xl text-center shrink-0">
          <p className="text-[10px] text-slate-500 leading-relaxed">
            ※ 본 상자깡 시뮬레이터는 완전한 무료 체험판 게임입니다. <br />
            실제 결제는 발생하지 않으며, 임의의 소모 요율 측정 목적으로만 환전 요율이 적용됩니다.
          </p>
        </div>
      </div>
    </AppModal>
  );
}

// ----------------------------------------------------
// QuantityModal Props & Component
// ----------------------------------------------------
interface QuantityModalProps {
  isOpen: boolean;
  onClose: () => void;
  crateName: string | undefined;
  quantity: number;
  setQuantity: React.Dispatch<React.SetStateAction<number>>;
  paymentMethod: "gcoin" | "bp";
  onConfirm: (packType: "X1", quantity: number, paymentMethod: "gcoin" | "bp") => void;
}

export function QuantityModal({
  isOpen,
  onClose,
  crateName,
  quantity,
  setQuantity,
  paymentMethod,
  onConfirm
}: QuantityModalProps) {
  return (
    <AppModal isOpen={isOpen} title={`${crateName ?? '상자'} 구매`} onClose={onClose} panelClassName="max-w-sm">
      <div className="bg-slate-900 border border-slate-800 rounded-3xl p-6 w-full space-y-6 shadow-2xl relative max-h-[90vh] overflow-y-auto">
        
        {/* 닫기 버튼 */}
        <button
          onClick={onClose}
          aria-label="닫기"
          className="absolute top-4 right-4 text-slate-400 hover:text-white font-bold text-lg cursor-pointer px-2 py-1 rounded-lg hover:bg-slate-800 transition-all"
        >
          ✕
        </button>

        <div className="text-center">
          <span className={`text-[10px] px-2.5 py-0.5 rounded font-bold uppercase tracking-wider ${
            paymentMethod === "bp" 
              ? "bg-indigo-900/50 text-indigo-400 border border-indigo-800/50" 
              : "bg-amber-900/50 text-amber-400 border border-amber-800/50"
          }`}>
            {paymentMethod === "bp" ? "BP 결제" : "G코인 결제"}
          </span>
          <h2 className="text-lg font-black text-slate-200 mt-3 flex items-center justify-center gap-1.5">
            <Box className="w-5 h-5 text-amber-500" />
            {crateName} 구매
          </h2>
          <p className="text-[11px] text-slate-400 mt-1">
            원하시는 구매 수량을 선택해주세요.
          </p>
        </div>

        {/* 수량 조절기 */}
        <div className="flex items-center justify-center gap-4 bg-slate-950/60 p-4 rounded-2xl border border-slate-850">
          <button
            onClick={() => setQuantity((prev) => Math.max(1, prev - 1))}
            className="w-10 h-10 bg-slate-800 hover:bg-slate-700 active:scale-95 text-white font-black text-lg rounded-xl border border-slate-700 transition-all cursor-pointer flex items-center justify-center"
          >
            -
          </button>
          <input
            type="number"
            value={quantity}
            onChange={(e) => {
              const val = parseInt(e.target.value, 10);
              if (!isNaN(val) && val > 0) {
                setQuantity(val);
              }
            }}
            className="w-16 bg-transparent text-center font-black text-xl text-amber-400 focus:outline-none [appearance:textfield] [&::-webkit-outer-spin-button]:appearance-none [&::-webkit-inner-spin-button]:appearance-none"
          />
          <button
            onClick={() => setQuantity((prev) => prev + 1)}
            className="w-10 h-10 bg-slate-800 hover:bg-slate-700 active:scale-95 text-white font-black text-lg rounded-xl border border-slate-700 transition-all cursor-pointer flex items-center justify-center"
          >
            +
          </button>
        </div>

        {/* 예상 결제 요금 및 예상 보상 요약 */}
        <div className="space-y-2 bg-slate-950/40 p-4 rounded-xl border border-slate-850/60 text-xs">
          <div className="flex justify-between items-center text-slate-400">
            <span>예상 보상</span>
            <span className="font-extrabold text-slate-200">
              상자 {quantity}개 + 토큰 {quantity * 15}개
            </span>
          </div>
          <div className="flex justify-between items-center border-t border-slate-850 pt-2 text-slate-300 font-bold">
            <span>총 결제 금액</span>
            <span className="flex items-center gap-1 text-amber-400">
              {paymentMethod === "bp" ? (
                <>
                  <Award className="w-4 h-4 text-indigo-400" />
                  <span className="text-indigo-400">{(10000 * quantity).toLocaleString()} BP</span>
                </>
              ) : (
                <>
                  <Coins className="w-4 h-4 text-amber-500" />
                  <span>{(250 * quantity).toLocaleString()} G코인</span>
                </>
              )}
            </span>
          </div>
        </div>

        {/* 결제 실행 버튼 */}
        <button
          onClick={() => onConfirm("X1", quantity, paymentMethod)}
          className="w-full py-3.5 bg-gradient-to-r from-amber-500 to-orange-600 hover:from-amber-600 hover:to-orange-700 text-slate-950 font-black rounded-xl shadow-lg transition-all active:scale-95 flex items-center justify-center gap-2 cursor-pointer text-sm"
        >
          구매 확정
        </button>
      </div>
    </AppModal>
  );
}

// ----------------------------------------------------
// RefillModal Props & Component
// ----------------------------------------------------
interface RefillModalProps {
  isOpen: boolean;
  onClose: () => void;
  refillType: "gcoin" | "bp" | "coupon" | "crate";
  setRefillType: (type: "gcoin" | "bp" | "coupon" | "crate") => void;
  refillAmount: number;
  setRefillAmount: React.Dispatch<React.SetStateAction<number>>;
  onRefill: () => void;
  onRefillInfinite?: () => void;
}

export function RefillModal({
  isOpen,
  onClose,
  refillType,
  setRefillType,
  refillAmount,
  setRefillAmount,
  onRefill,
  onRefillInfinite
}: RefillModalProps) {
  return (
    <AppModal isOpen={isOpen} title="이벤트 재화 보충기" onClose={onClose} panelClassName="max-w-md">
      <div className="bg-slate-900 border border-slate-800 rounded-3xl p-6 w-full space-y-6 shadow-2xl relative max-h-[90vh] flex flex-col">
        
        {/* 닫기 버튼 */}
        <button
          onClick={onClose}
          aria-label="닫기"
          className="absolute top-4 right-4 text-slate-400 hover:text-white font-bold text-lg cursor-pointer px-2 py-1 rounded-lg hover:bg-slate-800 transition-all"
        >
          ✕
        </button>

        <div className="text-center shrink-0">
          <h2 className="text-xl font-black text-indigo-400 flex items-center justify-center gap-1.5">
            <Sparkles className="w-6 h-6 text-indigo-500 animate-pulse" />
            이벤트 재화 보충기
          </h2>
          <p className="text-xs text-slate-400 mt-1">
            시뮬레이션 전용 무제한 재화 보충 시스템입니다. 원하는 재화와 보충할 수량을 선택하세요.
          </p>
        </div>

        <div className="space-y-4 flex-1 overflow-y-auto pr-1">
          {/* 재화 유형 선택 */}
          <div className="space-y-2">
            <label className="text-xs font-bold text-slate-400">재화 종류 선택</label>
            <div className="grid grid-cols-2 gap-2">
              {[
                { id: "gcoin", label: "G코인", icon: Coins, color: "text-amber-400" },
                { id: "bp", label: "BP", icon: Award, color: "text-indigo-400" },
                { id: "coupon", label: "밀수품 쿠폰", icon: Ticket, color: "text-purple-400" },
                { id: "crate", label: "현재 선택된 상자", icon: Box, color: "text-emerald-400" },
              ].map((type) => {
                const Icon = type.icon;
                return (
                  <button
                    key={type.id}
                    onClick={() => setRefillType(type.id as any)}
                    className={`flex items-center gap-2 p-3 rounded-xl border text-xs font-bold transition-all cursor-pointer ${
                      refillType === type.id
                        ? "bg-slate-800 border-indigo-500/80 text-white"
                        : "bg-slate-950/60 border-slate-800 text-slate-400 hover:bg-slate-900/50"
                    }`}
                  >
                    <Icon className={`w-4 h-4 ${type.color}`} />
                    {type.label}
                  </button>
                );
              })}
            </div>
          </div>

          {/* 보충 수량 입력 */}
          <div className="space-y-2">
            <label className="text-xs font-bold text-slate-400">보충할 수량 입력</label>
            <div className="flex items-center gap-3 bg-slate-950/60 p-4 rounded-xl border border-slate-850">
              <input
                type="number"
                value={refillAmount}
                onChange={(e) => {
                  const val = parseInt(e.target.value, 10);
                  if (!isNaN(val)) {
                    setRefillAmount(val);
                  } else {
                    setRefillAmount(0);
                  }
                }}
                className="w-full bg-transparent font-black text-xl text-indigo-400 focus:outline-none [appearance:textfield] [&::-webkit-outer-spin-button]:appearance-none [&::-webkit-inner-spin-button]:appearance-none"
                placeholder="수량을 입력하세요"
              />
            </div>
            {/* 빠른 설정 뱃지 */}
            <div className="flex gap-2">
              {[10, 100, 1000, 10000, 100000].map((amount) => (
                <button
                  key={amount}
                  onClick={() => setRefillAmount(amount)}
                  className="px-2.5 py-1 bg-slate-950/60 hover:bg-slate-800 border border-slate-850 text-[10px] font-bold rounded-lg text-slate-400 transition-all cursor-pointer"
                >
                  +{amount.toLocaleString()}
                </button>
              ))}
            </div>
          </div>
        </div>

        {/* 보충 확정 버튼 */}
        <div className="flex flex-col gap-2.5 shrink-0">
          <button
            onClick={onRefill}
            className="w-full py-3.5 bg-gradient-to-r from-indigo-500 to-purple-600 hover:from-indigo-600 hover:to-purple-700 text-white font-black rounded-xl shadow-lg transition-all active:scale-95 flex items-center justify-center gap-2 cursor-pointer text-sm"
          >
            보충 완료
          </button>
          
          {onRefillInfinite && (
            <button
              onClick={onRefillInfinite}
              className="w-full py-3.5 bg-gradient-to-r from-amber-500 via-yellow-500 to-amber-600 hover:from-amber-600 hover:via-yellow-600 hover:to-amber-700 text-slate-950 font-black rounded-xl shadow-lg shadow-amber-500/10 transition-all active:scale-95 flex items-center justify-center gap-2 cursor-pointer text-sm"
            >
              <InlineIconLabel icon="zap">모든 재화 무제한 충전 (999M)</InlineIconLabel>
            </button>
          )}
        </div>
      </div>
    </AppModal>
  );
}

// ----------------------------------------------------
// Harley-Davidson Craftable Items Data
// ----------------------------------------------------
const HARLEY_CRAFTABLE_ITEMS = [
  {
    name: '"CVO™ Road Glide® ST (리미티드)" 모터사이클 도안',
    tokenCost: 4000,
    image_url: '/api/images/crates/________________________d1snmk.webp',
    rarity: 'ULTIMATE' as const,
    category: 'CVO™ ROAD GLIDE® ST (리미티드)'
  },
  {
    name: '"CVO™ Road Glide® ST" 모터사이클 도안',
    tokenCost: 2500,
    image_url: '/api/images/crates/_______________zhce2y.webp',
    rarity: 'ULTIMATE' as const,
    category: 'CVO™ ROAD GLIDE® ST'
  },
  {
    name: 'CVO™ ROAD GLIDE® ST (리미티드) 풀 세트 (골든 네이비 & 샴페인 골드) 도안',
    tokenCost: 3500,
    image_url: '/api/images/crates/harley_lim_schematic.png',
    rarity: 'ULTIMATE' as const,
    category: 'CVO™ ROAD GLIDE® ST (리미티드)'
  },
  {
    name: 'CVO™ ROAD GLIDE® ST (리미티드) 세트 (미드나잇 블레이즈 & 폴리시드 크롬) 도안',
    tokenCost: 2900,
    image_url: '/api/images/crates/harley_lim_schematic.png',
    rarity: 'ULTIMATE' as const,
    category: 'CVO™ ROAD GLIDE® ST (리미티드)'
  },
  {
    name: 'CVO™ ROAD GLIDE® ST (리미티드) 세트 (브론즈 플레임 & 액센티드 브론즈) 도안',
    tokenCost: 2600,
    image_url: '/api/images/crates/harley_lim_schematic.png',
    rarity: 'ULTIMATE' as const,
    category: 'CVO™ ROAD GLIDE® ST (리미티드)'
  },
  {
    name: 'CVO™ ROAD GLIDE® ST (리미티드) SET (볼드 아이보리 & 액센티드 글로스 BLACK) 도안',
    tokenCost: 2600,
    image_url: '/api/images/crates/harley_lim_schematic.png',
    rarity: 'ULTIMATE' as const,
    category: 'CVO™ ROAD GLIDE® ST (리미티드)'
  },
  {
    name: 'CVO™ ROAD GLIDE® ST 세트 (매트 나이트셰이드 & 알루미늄) 도안',
    tokenCost: 2000,
    image_url: '/api/images/crates/harley_std_schematic.png',
    rarity: 'ULTIMATE' as const,
    category: 'CVO™ ROAD GLIDE® ST'
  },
  {
    name: 'CVO™ Road Glide® ST (리미티드) 페인트 (샴페인 골드) 도안',
    tokenCost: 500,
    image_url: '/api/images/crates/harley_lim_schematic.png',
    rarity: 'ULTIMATE' as const,
    category: '페인트'
  },
  {
    name: 'CVO™ Road Glide® ST 페인트 (팬텀 포레스트) 도안',
    tokenCost: 250,
    image_url: '/api/images/crates/harley_std_schematic.png',
    rarity: 'ULTIMATE' as const,
    category: '페인트'
  },
  {
    name: 'CVO™ Road Glide® ST 페인트 (터콰이즈 타이드) 도안',
    tokenCost: 250,
    image_url: '/api/images/crates/harley_std_schematic.png',
    rarity: 'ULTIMATE' as const,
    category: '페인트'
  },
  {
    name: 'CVO™ Road Glide® ST 페인트 (골든 화이트 펄) 도안',
    tokenCost: 250,
    image_url: '/api/images/crates/harley_std_schematic.png',
    rarity: 'ULTIMATE' as const,
    category: '페인트'
  },
  {
    name: 'CVO™ Road Glide® ST 페인트 (일렉트릭 코스트) 도안',
    tokenCost: 250,
    image_url: '/api/images/crates/harley_std_schematic.png',
    rarity: 'ULTIMATE' as const,
    category: '페인트'
  },
  {
    name: '할리데이비슨® 블랙탑 바이커 세트 도안',
    tokenCost: 800,
    image_url: '/api/images/crates/harley_set_schematic.png',
    rarity: 'LEGENDARY' as const,
    category: '세트'
  },
  {
    name: '할리데이비슨® 스트리트 스마트 세트 도안',
    tokenCost: 800,
    image_url: '/api/images/crates/harley_set_schematic.png',
    rarity: 'LEGENDARY' as const,
    category: '세트'
  },
  {
    name: '할리데이비슨® 낙하산 도안',
    tokenCost: 400,
    image_url: '/api/images/crates/harley_gear_schematic.png',
    rarity: 'EPIC' as const,
    category: '장비'
  },
  {
    name: '할리데이비슨® - - 클로즈 업 도안',
    tokenCost: 200,
    image_url: '/api/images/crates/harley_gear_schematic.png',
    rarity: 'EPIC' as const,
    category: '장비'
  },
  {
    name: '할리데이비슨™ - 달리기 위해 살고, 살기 위해 달린다 도안',
    tokenCost: 200,
    image_url: '/api/images/crates/harley_gear_schematic.png',
    rarity: 'EPIC' as const,
    category: '장비'
  },
  {
    name: '할리데이비슨® 엔진 배지 도안',
    tokenCost: 150,
    image_url: '/api/images/crates/harley_gear_schematic.png',
    rarity: 'EPIC' as const,
    category: '장비'
  }
];

// ----------------------------------------------------
// CraftingModal Props & Component
// ----------------------------------------------------
interface CraftingModalProps {
  isOpen: boolean;
  onClose: () => void;
  tokens: number;
  obtainedSkins: Record<string, number>;
  onCraft: (itemName: string, tokenCost: number) => boolean;
  craftableItems: any[];
}

export function CraftingModal({ isOpen, onClose, tokens, obtainedSkins, onCraft, craftableItems }: CraftingModalProps) {
  const [activeSubTab, setActiveSubTab] = useState<string>("전체");
  
  const filteredItems = activeSubTab === "전체" 
    ? craftableItems 
    : craftableItems.filter(item => item.category === activeSubTab);

  const categories = ["전체", ...Array.from(new Set(craftableItems.map(item => item.category)))];

  return (
    <AppModal isOpen={isOpen} title="제작소 특수 제작" onClose={onClose} panelClassName="max-w-6xl">
      <div className="bg-slate-900 border border-slate-800 rounded-3xl w-full h-[90dvh] flex flex-col shadow-2xl relative overflow-hidden">
        
        {/* 헤더 */}
        <header className="p-6 border-b border-slate-800 flex justify-between items-center bg-slate-900/60 shrink-0">
          <div>
            <h2 className="text-xl font-black text-amber-400 flex items-center gap-2">
              <Sparkles className="w-6 h-6 text-amber-500 animate-pulse" />
              제작소 &gt; 특수 제작
            </h2>
            <p className="text-xs text-slate-400 mt-1">
              획득한 이벤트 토큰을 소모하여 당신만의 특별한 도안 아이템을 제작해 보세요.
            </p>
          </div>
          <div className="flex items-center gap-4">
            {/* 토큰 표시 */}
            <div className="flex items-center gap-2 px-4 py-2 bg-slate-950 border border-slate-800 rounded-xl">
              <Box className="w-5 h-5 text-pink-500" />
              <div className="text-right">
                <div className="text-[9px] text-slate-500 font-bold leading-none">내 보유 토큰</div>
                <div className="text-base font-black text-pink-500">{tokens}개</div>
              </div>
            </div>
            
            <button
              onClick={onClose}
              aria-label="닫기"
              className="text-slate-400 hover:text-white font-bold text-lg px-3 py-2 rounded-lg hover:bg-slate-800 transition-all cursor-pointer"
            >
              ✕ 닫기
            </button>
          </div>
        </header>

        {/* 탭 네비게이션 */}
        <div className="px-6 py-3 border-b border-slate-800 bg-slate-950/20 flex gap-2 overflow-x-auto shrink-0">
          {categories.map((tab) => (
            <button
              key={tab}
              onClick={() => setActiveSubTab(tab)}
              className={`px-4 py-2 rounded-lg text-xs font-black transition-all shrink-0 cursor-pointer ${
                activeSubTab === tab
                  ? "bg-amber-500 text-slate-950 shadow-md font-bold"
                  : "text-slate-400 hover:text-slate-200 hover:bg-slate-800/40 border border-slate-800"
              }`}
            >
              {tab}
            </button>
          ))}
        </div>

        {/* 컨텐츠 그리드 */}
        <div className="flex-1 overflow-y-auto p-6 bg-slate-950/40">
          <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 gap-6">
            {filteredItems.map((item) => {
              const ownedCount = getOwnedCount(obtainedSkins, item);
              const isAffordable = tokens >= item.tokenCost;
              return (
                <div
                  key={item.name}
                  className={`bg-slate-950 border rounded-2xl p-4 flex flex-col justify-between items-center transition-all ${
                    ownedCount > 0 
                      ? "border-amber-500/30 shadow-[0_0_15px_rgba(245,158,11,0.05)]" 
                      : "border-slate-800/60"
                  }`}
                >
                  <div className="w-full flex justify-between items-start">
                    <span className={`text-[8px] font-extrabold px-1.5 py-0.5 rounded tracking-wide ${
                      item.rarity === "ULTIMATE" 
                        ? "bg-gradient-to-r from-red-600 to-amber-500 text-white" 
                        : "bg-gradient-to-r from-purple-600 to-pink-500 text-white"
                    }`}>
                      {item.rarity}
                    </span>
                    {ownedCount > 0 && (
                      <span className="text-[9px] bg-amber-500/10 border border-amber-500/30 text-amber-400 font-extrabold px-2 py-0.5 rounded-full">
                        보유 중 (x{ownedCount})
                      </span>
                    )}
                  </div>

                  <div className="w-32 h-32 bg-slate-900 rounded-xl p-2 border border-slate-800/60 flex items-center justify-center relative overflow-hidden group mt-3">
                    <img
                      src={item.image_url}
                      alt={item.name}
                      className="object-contain max-h-full max-w-full drop-shadow-[0_4px_8px_rgba(0,0,0,0.5)] group-hover:scale-105 transition-transform"
                      onError={(e) => {
                        (e.target as any).style.display = "none";
                      }}
                    />
                    <Box className="w-10 h-10 text-slate-850 absolute inset-0 m-auto -z-10" />
                  </div>

                  <div className="text-center w-full mt-4 space-y-1">
                    <h4 className="font-extrabold text-xs text-slate-200 line-clamp-2 min-h-[32px] break-keep leading-tight px-1" title={item.name}>
                      {item.name}
                    </h4>
                    
                    {/* 토큰 소모 가격 */}
                    <div className="flex items-center justify-center gap-1 text-pink-400 font-black text-sm py-1 bg-slate-900/60 rounded-lg border border-slate-850">
                      <Box className="w-3.5 h-3.5" />
                      {item.tokenCost.toLocaleString()}
                    </div>
                  </div>

                  <button
                    onClick={() => onCraft(item.name, item.tokenCost)}
                    disabled={!isAffordable}
                    className={`w-full py-2 mt-4 font-black rounded-xl text-xs shadow-md transition-all active:scale-95 flex items-center justify-center gap-1 cursor-pointer ${
                      isAffordable
                        ? "bg-gradient-to-r from-pink-500 to-rose-600 hover:from-pink-600 hover:to-rose-700 text-white"
                        : "bg-slate-800 text-slate-500 border border-slate-850 cursor-not-allowed"
                    }`}
                  >
                    제작하기
                  </button>
                </div>
              );
            })}
          </div>
        </div>

        {/* 푸터 경고 */}
        <footer className="p-4 border-t border-slate-800 bg-slate-950/60 text-center flex items-center justify-center gap-2 text-[10px] text-slate-500 shrink-0">
          <AlertTriangle className="w-4 h-4 text-amber-500 shrink-0" />
          <span>※ 획득하신 이벤트 토큰은 시즌 종료 시점까지 사용 가능합니다. 기간 만료 시 소멸되며 타 상품으로 환불 및 교환이 불가능합니다.</span>
        </footer>
      </div>
    </AppModal>
  );
}

// ----------------------------------------------------
// DetailModal Props & Component
// ----------------------------------------------------
interface DetailModalProps {
  isOpen: boolean;
  onClose: () => void;
  activeCrate: CrateTemplate | undefined;
  obtainedSkins: Record<string, number>;
  history: HistoryItem[];
  getRarityBadgeStyle: (rarity: string) => string;
  onReset: () => void;
}

export function DetailModal({
  isOpen,
  onClose,
  activeCrate,
  obtainedSkins,
  history,
  getRarityBadgeStyle,
  onReset
}: DetailModalProps) {
  const [activeTab, setActiveTab] = useState<"vault" | "history" | "stats">("vault");
  const [probSubTab, setProbSubTab] = useState<"base" | "prime" | "bonus">("base");

  if (!activeCrate) return null;

  return (
    <AppModal isOpen={isOpen} title={`${activeCrate.name} 세부 정보`} onClose={onClose} panelClassName="max-w-5xl">
      <div className="bg-slate-900 border border-slate-800 rounded-3xl w-full h-[92dvh] sm:h-[85dvh] flex flex-col shadow-2xl relative overflow-hidden">
        
        {/* 헤더 */}
        <header className="p-6 border-b border-slate-800 flex justify-between items-center bg-slate-900/60 shrink-0">
          <div>
            <h2 className="text-xl font-black text-amber-400 flex items-center gap-2">
              <Layers className="w-6 h-6 text-amber-500" />
              {activeCrate.name} 세부 정보 (소장품 &amp; 확률표)
            </h2>
            <p className="text-xs text-slate-400 mt-1">
              아이템의 구성품, 확률표 및 뽑기 획득 기록을 확인하실 수 있습니다.
            </p>
          </div>
          <button
            onClick={onClose}
            aria-label="닫기"
            className="text-slate-400 hover:text-white font-bold text-lg px-3 py-2 rounded-lg hover:bg-slate-800 transition-all cursor-pointer"
          >
            ✕ 닫기
          </button>
        </header>

        {/* 탭 네비게이션 */}
        <div className="flex border-b border-slate-800 gap-1 overflow-x-auto bg-slate-950/60 p-2 shrink-0">
          <button
            onClick={() => setActiveTab("vault")}
            className={`min-w-[128px] flex-1 py-3 px-4 rounded-xl text-xs sm:text-sm font-black transition-all cursor-pointer flex items-center justify-center gap-1.5 ${
              activeTab === "vault"
                ? "bg-amber-500 text-slate-950 shadow-md font-bold"
                : "text-slate-400 hover:text-slate-200 hover:bg-slate-800/40"
            }`}
          >
            <Sparkles className="w-4 h-4" />
            스킨 컬렉션
          </button>
          <button
            onClick={() => setActiveTab("history")}
            className={`min-w-[112px] flex-1 py-3 px-4 rounded-xl text-xs sm:text-sm font-black transition-all cursor-pointer flex items-center justify-center gap-1.5 ${
              activeTab === "history"
                ? "bg-amber-500 text-slate-950 shadow-md font-bold"
                : "text-slate-400 hover:text-slate-200 hover:bg-slate-800/40"
            }`}
          >
            <History className="w-4 h-4" />
            획득 기록
          </button>
          <button
            onClick={() => setActiveTab("stats")}
            className={`min-w-[112px] flex-1 py-3 px-4 rounded-xl text-xs sm:text-sm font-black transition-all cursor-pointer flex items-center justify-center gap-1.5 ${
              activeTab === "stats"
                ? "bg-amber-500 text-slate-950 shadow-md font-bold"
                : "text-slate-400 hover:text-slate-200 hover:bg-slate-800/40"
            }`}
          >
            <Layers className="w-4 h-4" />
            공식 확률표
          </button>
        </div>

        {/* 컨텐츠 바디 */}
        <div className="flex-1 overflow-y-auto p-6 bg-slate-950/40">
          
          {/* 1. Vault 탭 */}
          {activeTab === "vault" && (
            <div className="space-y-6">
              <p className="text-xs text-slate-400">
                획득 가능한 핵심 도안 아이템의 소장 현황입니다. (획득한 아이템은 수량이 표기되며 선명하게 활성화됩니다.)
              </p>
              
              <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 gap-4">
                {activeCrate.items
                  .filter((item) => {
                    // 밀수품 상자(성장형 무기 가챠)
                    if (activeCrate.type === "contraband") {
                      return (
                        !item.name.includes("폴리머") && 
                        !item.name.includes("도면") && 
                        !item.name.includes("토큰")
                      );
                    }
                    // 블랙 마켓 화물 상자
                    return (
                      !item.name.includes("폴리머") && 
                      !item.name.includes("도면") && 
                      !item.name.includes("토큰") && 
                      !item.name.includes("크레딧")
                    );
                  })
                  .map((item) => {
                    const count = getOwnedCount(obtainedSkins, item);
                    const hasObtained = count > 0;
                    return (
                      <VaultCard
                        key={item.id}
                        item={item as any}
                        count={count}
                        hasObtained={hasObtained}
                        getRarityBadgeStyle={getRarityBadgeStyle}
                      />
                    );
                  })}
              </div>
            </div>
          )}

          {/* 2. 히스토리 탭 */}
          {activeTab === "history" && (
            <div className="space-y-6 flex flex-col h-full">
              <div className="flex justify-between items-center">
                <p className="text-xs text-slate-400">
                  실시간으로 획득한 보상 내역입니다. (데이터 전체 리셋 시 초기화됩니다.)
                </p>
                {history.length > 0 && (
                  <button
                    onClick={onReset}
                    className="px-3 py-1.5 bg-red-950/30 hover:bg-red-950/60 border border-red-900/40 hover:border-red-800 text-red-400 font-extrabold rounded-lg text-xs flex items-center gap-1 active:scale-95 transition-all cursor-pointer"
                  >
                    데이터 전체 리셋
                  </button>
                )}
              </div>

              {history.length === 0 ? (
                <div className="flex-1 flex flex-col justify-center items-center text-slate-500 py-16">
                  <History className="w-12 h-12 text-slate-700 mb-3" />
                  <p className="text-sm">아직 획득 기록이 없습니다.</p>
                </div>
              ) : (
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                  {history.map((item) => (
                    <HistoryCard key={item.id} item={item} getRarityBadgeStyle={getRarityBadgeStyle} />
                  ))}
                </div>
              )}
            </div>
          )}

          {/* 3. 확률표 탭 */}
          {activeTab === "stats" && (
            <div className="space-y-6">
              {activeCrate.type === "loot_crate" && (
                <div className="flex bg-slate-950 p-1 rounded-lg border border-slate-850 w-fit gap-1">
                  {["base", "prime", "bonus"].map((sub) => (
                    <button
                      key={sub}
                      onClick={() => setProbSubTab(sub as any)}
                      className={`px-4 py-1.5 rounded-md text-[11px] font-extrabold transition-all cursor-pointer ${
                        probSubTab === sub
                          ? "bg-slate-850 text-white shadow"
                          : "text-slate-400 hover:text-slate-200"
                      }`}
                    >
                      {sub === "base" ? "기본 전리품 상자" : sub === "prime" ? "최고급 꾸러미 구성" : "보너스 드롭 (27%)"}
                    </button>
                  ))}
                </div>
              )}

              <div className="overflow-x-auto border border-slate-850 rounded-xl bg-slate-950/60">
                <table className="min-w-[560px] w-full divide-y divide-slate-850">
                  <thead className="bg-slate-900/60">
                    <tr>
                      <th className="px-4 py-3 text-left text-[11px] font-extrabold text-slate-400 uppercase tracking-wider">아이템 이름</th>
                      <th className="px-4 py-3 text-center text-[11px] font-extrabold text-slate-400 uppercase tracking-wider w-24">등급</th>
                      <th className="px-4 py-3 text-right text-[11px] font-extrabold text-slate-400 uppercase tracking-wider w-28">공식 확률 (%)</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-850 text-xs">
                    {(() => {
                      let itemsToRender: any[] = [];
                      if (probSubTab === "base") itemsToRender = activeCrate.items || [];
                      if (probSubTab === "prime") itemsToRender = activeCrate.prime_parcel_items || [];
                      if (probSubTab === "bonus") itemsToRender = activeCrate.bonus_items || [];

                      if (itemsToRender.length === 0) {
                        return (
                          <tr>
                            <td colSpan={3} className="px-4 py-6 text-center text-slate-500">
                              확률표가 비어있습니다.
                            </td>
                          </tr>
                        );
                      }

                      // 확률이 낮은 순서(오름차순)로 정렬
                      const sortedItems = [...itemsToRender].sort((a, b) => {
                        const probA = a.probability !== undefined ? Number(a.probability) : 0;
                        const probB = b.probability !== undefined ? Number(b.probability) : 0;
                        return probA - probB;
                      });

                      return sortedItems.map((item, idx) => {
                        let displayProb = "0.00%";
                        if (item.probability !== undefined) {
                          const multiplier = 100;
                          displayProb = `${(item.probability * multiplier).toFixed(4)}%`;
                        }

                        return (
                          <tr key={item.id || idx} className="hover:bg-slate-900/20 transition-colors">
                            <td className="px-4 py-2.5 font-bold text-slate-300">{item.name}</td>
                            <td className="px-4 py-2.5 text-center">
                              <span className={`text-[9px] font-extrabold px-1.5 py-0.5 rounded ${getRarityBadgeStyle(item.rarity)}`}>
                                {getKoreanRarityName(item.rarity)}
                              </span>
                            </td>
                            <td className="px-4 py-2.5 text-right font-black text-amber-500 tabular-nums">
                              {displayProb}
                            </td>
                          </tr>
                        );
                      });
                    })()}
                  </tbody>
                </table>
              </div>

              <div className="bg-slate-950/20 border border-slate-850 p-4 rounded-xl flex items-start gap-2.5 text-[11px] text-slate-400 leading-relaxed">
                <AlertTriangle className="w-4 h-4 text-amber-500 shrink-0 mt-0.5" />
                <p>
                  {activeCrate.type === "loot_crate" ? (
                    <span>
                      ※ 전리품 상자 구성품 확률의 합계는 정확하게 100.00% 입니다. 보너스 드롭은 매 구매 시행 시마다 독립적인 27.00% 확률로 추가 생성되는 보너스 가챠입니다.
                    </span>
                  ) : (
                    <span>
                      ※ 밀수품 상자(성장형 무기 상자) 구성품 확률표는 공식 펍지 API 마이그레이션 데이터셋(합계 100.00%)을 완전히 반영하여 정합성을 보증합니다.
                    </span>
                  )}
                </p>
              </div>
            </div>
          )}

        </div>
      </div>
    </AppModal>
  );
}
