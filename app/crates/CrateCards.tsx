import React, { useState, useEffect, useRef } from "react";
import { Box, Sparkles } from "lucide-react";
import type { PrimeParcelItem } from "@/types/crates";
import { DrawnCard, HistoryItem } from "./types";

export const getKoreanRarityName = (rarity: string) => {
  switch (rarity) {
    case "ULTIMATE": return "얼티밋";
    case "LEGENDARY": return "레전더리";
    case "EPIC": return "에픽";
    case "RARE": return "레어";
    case "SPECIAL": return "스페셜";
    case "COMMON": return "일반";
    case "ELITE": return "엘리트";
    default: return rarity;
  }
};

/**
 * 금색 카드 뒤집기 특수 인게임 연출을 재생할 핵심 성장형 무기 스킨 및 크로마 스킨 목록 판별 함수
 */
export function isSpecialFlipEffectItem(itemName: string): boolean {
  const targetItems = [
    // 상상력 풀가동 - SLR 계열
    "상상력 풀가동 - SLR (네이비 레드)",
    "상상력 풀가동 - SLR",
    // 글라시아 계열
    "글라시아 도안",
    // 징글 벨 - 미니14 계열
    "징글 벨 - 미니14 (골드 블루)",
    "징글 벨 - 미니14",
    // 네온 드림 - AUG 계열
    "네온 드림 - AUG (화이트 오렌지)",
    "네온 드림 - AUG (마젠타)",
    "네온 드림 - AUG",
    // 레스트 인 핑크 - 드라구노프 계열
    "레스트 인 핑크 - 드라구노프 (핑크 옐로우)",
    "레스트 인 핑크 - 드라구노프 (청록색)",
    "레스트 인 핑크 - 드라구노프",
    // 악마의 손길 - ACE32 계열
    "악마의 손길 - ACE32 (퍼플 푸시아)",
    "악마의 손길 - ACE32 (청록색)",
    "악마의 손길 - ACE32",
    // 라이드 오어 다이 - M249 계열
    "라이드 오어 다이 - M249 (블랙 틸)",
    "라이드 오어 다이 - M249",
    // 코스믹 칼리버 - Kar98k 계열
    "코스믹 칼리버 - Kar98k (화이트 옐로우)",
    "코스믹 칼리버 - Kar98k"
  ];
  return targetItems.includes(itemName);
}

// ----------------------------------------------------
// CrateCard Props & Component
// ----------------------------------------------------
interface CrateCardProps {
  card: DrawnCard;
  isRevealed: boolean;
  onClick: () => void;
  getRarityBadgeStyle: (rarity: string) => string;
  getCardBorderGlow: (rarity: string, isBonus: boolean) => string;
}

export function CrateCard({ card, isRevealed, onClick, getRarityBadgeStyle, getCardBorderGlow }: CrateCardProps) {
  const [imageError, setImageError] = useState(false);
  const [bonusImageError, setBonusImageError] = useState(false);
  
  // 특수 카드 뒤집기 연출용 로컬 상태
  const [isAnimating, setIsAnimating] = useState(false);
  const [particles, setParticles] = useState<{ x: number; y: number; delay: number; duration: number }[]>([]);
  
  const wasRevealed = useRef(isRevealed);

  useEffect(() => {
    // 카드가 뒤집히기 시작하고, 대상 특수 무기/크로마인 경우에만 이펙트 구동
    if (isRevealed && !wasRevealed.current && isSpecialFlipEffectItem(card.name)) {
      setIsAnimating(true);
      
      // 약 15개의 골드 스파클 파티클의 방출 방향과 시간차 난수 계산
      const newParticles = Array.from({ length: 15 }).map(() => {
        const angle = Math.random() * Math.PI * 2;
        const velocity = 80 + Math.random() * 90; // 비산 거리 (px)
        const x = Math.cos(angle) * velocity;
        const y = Math.sin(angle) * velocity;
        const delay = Math.random() * 0.12; // 미세 시간차 (s)
        const duration = 0.8 + Math.random() * 0.4; // 지속 시간 (s)
        return { x, y, delay, duration };
      });
      setParticles(newParticles);

      const timer = setTimeout(() => {
        setIsAnimating(false);
      }, 1400); // 1.4초 후 애니메이션 종료

      return () => clearTimeout(timer);
    }
    wasRevealed.current = isRevealed;
  }, [isRevealed, card.name]);

  // Prevent spoiler: only show rarity glowing border/shadow when revealed
  const borderGlow = isRevealed 
    ? getCardBorderGlow(card.rarity, card.isBonus ?? false) 
    : "border-slate-800 shadow-none";

  const isHighRarity = card.rarity === "LEGENDARY" || card.rarity === "ULTIMATE";

  return (
    <div
      onClick={onClick}
      className={`w-full aspect-[3/4] min-h-[140px] perspective-1000 cursor-pointer group ${
        isAnimating ? "relative z-[101]" : ""
      }`}
    >
      {/* 1단계: 전체 화면 Spotlight 어두운 딤 배경 */}
      {isAnimating && (
        <div className="fixed inset-0 bg-slate-950/70 backdrop-blur-[3px] z-[100] pointer-events-none animate-dimBg" />
      )}

      {/* 2단계: 금색 광원 충격파 고리 */}
      {isAnimating && (
        <div className="absolute top-1/2 left-1/2 w-40 h-40 rounded-full border-4 border-amber-400/80 pointer-events-none animate-goldShockwave z-[102]" />
      )}

      {/* 3단계: 카드 뒤쪽에서 퍼지는 금색 스파클 파티클 */}
      {isAnimating && particles.map((p, i) => (
        <div
          key={i}
          className="absolute w-1.5 h-1.5 rounded-full bg-gradient-to-r from-amber-400 via-yellow-500 to-orange-500 pointer-events-none animate-particleOut z-[102]"
          style={{
            left: "50%",
            top: "50%",
            "--tw-particle-x": `${p.x}px`,
            "--tw-particle-y": `${p.y}px`,
            "--tw-particle-duration": `${p.duration}s`,
            animationDelay: `${p.delay}s`,
          } as React.CSSProperties}
        />
      ))}

      <div className={`relative w-full h-full preserve-3d ${
        isAnimating 
          ? "animate-goldBounceZoom" 
          : `transition-transform duration-500 ${isRevealed ? "" : "rotate-y-180"}`
      }`}>
        {/* 카드 앞면 (공개됨) */}
        <div className={`absolute inset-0 rounded-xl bg-slate-900 border-2 p-2 sm:p-2.5 flex flex-col justify-between items-center backface-hidden overflow-hidden ${borderGlow}`}>
          <div className="flex justify-between w-full items-center">
            {card.rarity !== "COMMON" ? (
              <span className={`text-[8px] font-extrabold px-1.5 py-0.5 rounded tracking-wide ${getRarityBadgeStyle(card.rarity)}`}>
                {getKoreanRarityName(card.rarity)}
              </span>
            ) : (
              <div />
            )}
            {card.probability !== undefined && card.probability > 0 && isRevealed && (
              <span className="text-[8px] text-slate-400 font-extrabold bg-slate-950/60 px-1.5 py-0.5 rounded border border-slate-800/40 z-10 select-none">
                {parseFloat((card.probability * 100).toFixed(4))}%
              </span>
            )}
          </div>
          
          {!imageError && card.image_url ? (
            <div className="w-full aspect-square max-h-[58%] sm:max-h-[60%] flex items-center justify-center bg-slate-950/50 rounded-lg p-1 border border-slate-800/80 relative group-hover:scale-105 transition-transform overflow-hidden">
              <Box className="w-8 h-8 text-slate-700 absolute inset-0 m-auto -z-10" />
              <img 
                src={card.image_url} 
                alt={card.name}
                className="object-contain max-h-full max-w-full drop-shadow-[0_4px_8px_rgba(0,0,0,0.5)]"
                onError={() => setImageError(true)}
              />
            </div>
          ) : (
            <div className="w-full flex-1 flex items-center justify-center p-1 text-center overflow-hidden">
              <span 
                className="font-black text-slate-200 tracking-tight break-all whitespace-normal block w-full text-center"
                style={{
                  wordBreak: 'keep-all',
                  overflowWrap: 'anywhere',
                  lineHeight: '1.1',
                  fontSize: card.name.length > 20 
                    ? '10px' 
                    : card.name.length > 12 
                      ? '11px' 
                      : '12px',
                  transform: card.name.length > 20 
                    ? 'scale(0.85)' 
                    : card.name.length > 12 
                      ? 'scale(0.9)' 
                      : 'scale(1)',
                  transformOrigin: 'center',
                }}
              >
                {card.name}
              </span>
            </div>
          )}

          {!imageError && card.image_url && (
            <div className="text-center w-full mt-1 overflow-hidden">
              <h4 
                className="font-bold text-slate-200 whitespace-normal block w-full text-center"
                style={{
                  fontSize: '10px',
                  lineHeight: '1.15',
                  wordBreak: 'keep-all',
                  overflowWrap: 'anywhere',
                  transform: card.name.length > 20 
                    ? 'scale(0.8)' 
                    : card.name.length > 12 
                      ? 'scale(0.9)' 
                      : 'scale(1)',
                  transformOrigin: 'center top',
                }}
                title={card.name}
              >
                {card.name}
              </h4>
            </div>
          )}

          {/* 확률 표시 위치 상단 헤더로 이동 완료 */}

          {/* 보너스 오버레이 박스 (카드 뒤집혔을 때만 팝업 - 스포 차단) */}
          {card.bonus && isRevealed && (
            <div className="absolute inset-0 rounded-xl bg-slate-950/95 border-2 border-amber-400 p-2 flex flex-col justify-between items-center z-20 animate-[fadeIn_0.3s_ease-out] shadow-[0_0_20px_rgba(245,158,11,0.5)]">
              {/* 보너스 헤더 뱃지 */}
              <div className="flex justify-between w-full items-center">
                <span className="text-[8px] font-extrabold bg-amber-500 text-slate-950 px-1.5 py-0.5 rounded-full flex items-center gap-0.5 shadow-md">
                  <Sparkles className="w-2.5 h-2.5 fill-current" />
                  보너스
                </span>
                {card.bonus.rarity !== "COMMON" && (
                  <span className={`text-[7px] font-extrabold px-1 py-0.5 rounded ${getRarityBadgeStyle(card.bonus.rarity)}`}>
                    {getKoreanRarityName(card.bonus.rarity)}
                  </span>
                )}
              </div>

              {/* 보너스 입자 애니메이션 데코 */}
              <div className="absolute inset-0 pointer-events-none overflow-hidden rounded-xl">
                {[...Array(4)].map((_, i) => (
                  <div
                    key={i}
                    className="absolute w-1.5 h-1.5 bg-amber-400 rounded-full"
                    style={{
                      left: `${20 + ((i * 17) % 60)}%`,
                      top: `${60 + ((i * 23) % 30)}%`,
                      animation: `particleUp ${1 + ((i * 13) % 10) / 10}s ease-out infinite`,
                      animationDelay: `${((i * 7) % 5) / 10}s`
                    }}
                  />
                ))}
              </div>

              {!bonusImageError && card.bonus.image_url ? (
                <div className="w-full aspect-square max-h-[58%] sm:max-h-[60%] flex items-center justify-center bg-slate-900 rounded-lg p-1 border border-amber-500/20 relative overflow-hidden">
                  <img 
                    src={card.bonus.image_url} 
                    alt={card.bonus.name}
                    className="object-contain max-h-full max-w-full drop-shadow-[0_2px_4px_rgba(245,158,11,0.3)]"
                    onError={() => setBonusImageError(true)}
                  />
                </div>
              ) : (
                <div className="w-full flex-1 flex items-center justify-center p-1 text-center overflow-hidden">
                  <span 
                    className="font-black text-amber-400 tracking-tight break-all whitespace-normal block w-full text-center"
                    style={{
                      wordBreak: 'keep-all',
                      overflowWrap: 'anywhere',
                      lineHeight: '1.1',
                      fontSize: card.bonus.name.length > 20 
                        ? '10px' 
                        : card.bonus.name.length > 12 
                          ? '11px' 
                          : '12px',
                      transform: card.bonus.name.length > 20 
                        ? 'scale(0.85)' 
                        : card.bonus.name.length > 12 
                          ? 'scale(0.9)' 
                          : 'scale(1)',
                      transformOrigin: 'center',
                    }}
                  >
                    {card.bonus.name}
                  </span>
                </div>
              )}

              <div className="text-center w-full z-10 overflow-hidden">
                {!bonusImageError && card.bonus.image_url && (
                  <h4 
                    className="font-black text-amber-400 whitespace-normal block w-full text-center"
                    style={{
                      fontSize: '10px',
                      lineHeight: '1.15',
                      wordBreak: 'keep-all',
                      overflowWrap: 'anywhere',
                      transform: card.bonus.name.length > 20 
                        ? 'scale(0.8)' 
                        : card.bonus.name.length > 12 
                          ? 'scale(0.9)' 
                          : 'scale(1)',
                      transformOrigin: 'center top',
                    }}
                    title={card.bonus.name}
                  >
                    {card.bonus.name}
                  </h4>
                )}
                {card.bonus.is_extra_crate && (
                  <div className="text-[7px] font-extrabold text-amber-300/90 mt-0.5 animate-pulse inline-flex items-center gap-0.5">
                    <Sparkles className="h-2 w-2" /> 상자 1개 환급 완료!
                  </div>
                )}
                {card.bonus.token_count > 0 && (
                  <div className="text-[7px] font-extrabold text-amber-300/90 mt-0.5 animate-pulse inline-flex items-center gap-0.5">
                    <Sparkles className="h-2 w-2" /> 토큰 +{card.bonus.token_count}개 자동지급!
                  </div>
                )}
                {card.bonus.is_prime_parcel && (
                  <div className="text-[7px] font-extrabold text-pink-400 mt-0.5 animate-pulse inline-flex items-center gap-0.5">
                    <Sparkles className="h-2 w-2" /> 최고급 꾸러미 획득!
                  </div>
                )}
              </div>

              {card.bonus.probability !== undefined && card.bonus.probability > 0 && (
                <div className="absolute bottom-8.5 left-2 text-[8px] sm:text-[9px] text-amber-400 font-extrabold bg-slate-950/70 px-1 py-0.2 rounded border border-amber-500/20 z-25 select-none">
                  {parseFloat((card.bonus.probability * 100).toFixed(4))}%
                </div>
              )}
            </div>
          )}
        </div>

        {/* 카드 뒷면 (가려짐) */}
        <div className={`absolute inset-0 rounded-xl flex flex-col items-center justify-center backface-hidden rotate-y-180 border ${
          isHighRarity
            ? "bg-gradient-to-br from-amber-950 via-slate-950 to-amber-950 border-amber-500 shadow-[0_0_20px_rgba(245,158,11,0.6)] animate-pulse"
            : "bg-gradient-to-br from-slate-950 via-slate-900 to-slate-950 border-slate-800 shadow-md"
        }`}>
          <div className={`w-10 h-10 rounded-full border flex items-center justify-center group-hover:scale-110 transition-transform ${
            isHighRarity
              ? "bg-amber-950/60 border-amber-400/50 shadow-[0_0_10px_rgba(245,158,11,0.4)]"
              : "bg-slate-900 border-slate-800 shadow-[inset_0_0_10px_rgba(0,0,0,0.8)]"
          }`}>
            <Box className={`w-5 h-5 ${
              isHighRarity ? "text-amber-400 drop-shadow-[0_0_5px_rgba(245,158,11,0.8)]" : "text-amber-500"
            }`} />
          </div>
          <span className={`text-[9px] uppercase mt-2 tracking-widest ${
            isHighRarity ? "text-amber-400 font-black" : "text-slate-500 font-bold"
          }`}>
            뒤집기
          </span>
        </div>
      </div>
    </div>
  );
}

// ----------------------------------------------------
// VaultCard Props & Component
// ----------------------------------------------------
interface VaultCardProps {
  item: PrimeParcelItem;
  count: number;
  hasObtained: boolean;
  getRarityBadgeStyle: (rarity: string) => string;
}

export function VaultCard({ item, count, hasObtained, getRarityBadgeStyle }: VaultCardProps) {
  const [imageError, setImageError] = useState(false);

  return (
    <div
      className={`relative bg-slate-950/80 border rounded-2xl p-4 flex flex-col justify-between items-center transition-all ${
        hasObtained
          ? "border-amber-500/50 shadow-[0_0_15px_rgba(245,158,11,0.15)] animate-[fadeIn_0.5s_ease-out]"
          : "border-slate-800/80 opacity-55"
      }`}
    >
      {hasObtained && (
        <span className="absolute top-2 right-2 bg-gradient-to-r from-amber-500 to-orange-600 text-slate-950 font-black text-xs px-2 py-0.5 rounded-full shadow-md z-10">
          x{count}
        </span>
      )}

      {!imageError && item.image_url ? (
        <div className="w-full aspect-square bg-slate-900 rounded-xl p-2 border border-slate-800/60 flex items-center justify-center relative overflow-hidden group">
          <img
            src={item.image_url}
            alt={item.name}
            className={`object-contain max-h-full max-w-full drop-shadow-[0_4px_8px_rgba(0,0,0,0.5)] transition-all duration-350 ${
              hasObtained ? "grayscale-0 group-hover:scale-105" : "grayscale"
            }`}
            onError={() => setImageError(true)}
          />
        </div>
      ) : (
        <div className="w-full aspect-square bg-slate-900 rounded-xl p-4 border border-slate-800/60 flex items-center justify-center text-center overflow-hidden">
          <span 
            className={`font-black leading-[1.1] tracking-tight break-all whitespace-normal block w-full text-center ${
              hasObtained ? "text-slate-200" : "text-slate-500 grayscale"
            }`}
            style={{
              wordBreak: 'keep-all',
              overflowWrap: 'anywhere',
              fontSize: item.name.length > 20 
                ? '10px' 
                : item.name.length > 12 
                  ? '11px' 
                  : '12px',
              transform: item.name.length > 20 
                ? 'scale(0.85)' 
                : item.name.length > 12 
                  ? 'scale(0.9)' 
                  : 'scale(1)',
              transformOrigin: 'center',
            }}
          >
            {item.name}
          </span>
        </div>
      )}

      <div className="text-center w-full mt-4">
        {item.rarity !== "COMMON" && (
          <span className={`text-[9px] font-extrabold px-2 py-0.5 rounded tracking-wide inline-block mb-1.5 ${getRarityBadgeStyle(item.rarity)}`}>
            {getKoreanRarityName(item.rarity)}
          </span>
        )}
        {!imageError && item.image_url && (
          <h4 
            className="font-black text-slate-200 whitespace-normal block w-full text-center"
            style={{
              fontSize: '10px',
              lineHeight: '1.15',
              wordBreak: 'keep-all',
              overflowWrap: 'anywhere',
              transform: item.name.length > 20 
                ? 'scale(0.85)' 
                : item.name.length > 12 
                  ? 'scale(0.9)' 
                  : 'scale(1)',
              transformOrigin: 'center top',
            }}
            title={item.name}
          >
            {item.name}
          </h4>
        )}
        <p className="text-[10px] text-slate-500 mt-1">
          {hasObtained ? "소장 완료" : "미획득"}
        </p>
      </div>
    </div>
  );
}

// ----------------------------------------------------
// HistoryCard Props & Component
// ----------------------------------------------------
interface HistoryCardProps {
  item: HistoryItem;
  getRarityBadgeStyle: (rarity: string) => string;
}

export function HistoryCard({ item, getRarityBadgeStyle }: HistoryCardProps) {
  const [imageError, setImageError] = useState(false);

  return (
    <div
      className="bg-slate-950/80 border border-slate-800/80 p-3 rounded-xl flex items-center gap-4 hover:border-slate-700 transition-all"
    >
      <div className="w-12 h-12 bg-slate-900 rounded border border-slate-800 p-1 flex items-center justify-center shrink-0">
        {!imageError && item.image_url ? (
          <img
            src={item.image_url}
            alt={item.name}
            className="max-h-full max-w-full object-contain"
            onError={() => setImageError(true)}
          />
        ) : (
          <Box className="w-6 h-6 text-slate-700" />
        )}
      </div>
      <div className="flex-1 min-w-0">
        <div className="flex flex-wrap items-center gap-1.5">
          {item.rarity !== "COMMON" && (
            <span className={`text-[8px] font-extrabold px-1.5 py-0.5 rounded ${getRarityBadgeStyle(item.rarity)}`}>
              {getKoreanRarityName(item.rarity)}
            </span>
          )}
          {item.isFromPrimeParcel && (
            <span className="text-[8px] font-extrabold bg-pink-900/60 text-pink-400 px-1.5 py-0.5 rounded">
              꾸러미
            </span>
          )}
          {item.isBonus && (
            <span className="text-[8px] font-extrabold bg-amber-500 text-slate-950 px-1.5 py-0.5 rounded flex items-center gap-0.5">
              <Sparkles className="h-2.5 w-2.5" /> 보너스
            </span>
          )}
        </div>
        <h4 
          className="text-xs font-bold text-slate-200 whitespace-normal block w-full mt-1"
          style={{
            wordBreak: 'keep-all',
            overflowWrap: 'anywhere',
            lineHeight: '1.2',
          }}
          title={item.name}
        >
          {item.name}
        </h4>
        <span className="text-[10px] text-slate-500 mt-0.5 block">
          {item.timestamp.toLocaleTimeString()}
        </span>
      </div>
    </div>
  );
}
