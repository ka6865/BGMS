import React, { useState, useRef, useEffect } from "react";
import { HelpCircle, Trophy, Target, Swords, Shield, Clock, Crosshair, Users } from "lucide-react";
import { getTierIconPath } from "@/utils/tier";

const getKDA = (k: number, a: number, d: number) => ((k + a) / (d || 1)).toFixed(2);
const getWinRate = (w: number, p: number) => (p > 0 ? ((w / p) * 100).toFixed(1) : "0.0");
const getAvgDmg = (dmg: number, p: number) => (p > 0 ? (dmg / p).toFixed(0) : "0");
const getAvgKnockouts = (dbno: number, p: number) => (p > 0 ? (dbno / p).toFixed(1) : "0.0");
const getHeadshot = (h: number, k: number) => (k > 0 ? ((h / k) * 100).toFixed(1) : "0.0");
const getSurvivalTime = (time: number, p: number) => {
  if (p === 0) return "0분 0초";
  const avgSec = Math.floor(time / p);
  return `${Math.floor(avgSec / 60)}분 ${avgSec % 60}초`;
};

export const StatSummaryCard = ({ title, data, isRanked, isMobile }: { title: string; data: any; isRanked: boolean; isMobile: boolean }) => {
  const [showTooltip, setShowTooltip] = useState(false);
  const tooltipRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!showTooltip || !isMobile) return;

    const handleClickOutside = (event: MouseEvent) => {
      if (tooltipRef.current && !tooltipRef.current.contains(event.target as Node)) {
        setShowTooltip(false);
      }
    };

    document.addEventListener("mousedown", handleClickOutside);
    return () => document.removeEventListener("mousedown", handleClickOutside);
  }, [showTooltip, isMobile]);

  if (!data || data.roundsPlayed === 0) {
    return (
      <div className="flex-1 min-w-[340px] h-[480px] bg-black/40 border border-white/5 rounded-[40px] flex items-center justify-center text-white/20 font-black uppercase tracking-widest backdrop-blur-md">
        {title} 기록 없음
      </div>
    );
  }

  const top10 = isRanked ? (data.top10Ratio * 100).toFixed(1) : getWinRate(data.top10s, data.roundsPlayed);

  return (
    <div className="flex-1 min-w-[340px] h-[480px] bg-black/60 border border-white/10 rounded-[40px] overflow-hidden shadow-2xl backdrop-blur-2xl group transition-all hover:border-indigo-500/30 flex flex-col">
      {/* Header Section */}
      <div className={`p-8 bg-gradient-to-br ${isRanked ? 'from-amber-600/20 to-transparent' : 'from-gray-600/20 to-transparent'} relative shrink-0`}>
        <div className="absolute top-0 right-0 p-6 opacity-10 group-hover:scale-110 transition-transform">
          {isRanked ? <Trophy size={64} className="text-amber-500" /> : <Shield size={64} className="text-gray-400" />}
        </div>
        
        <div className="flex flex-col gap-2 relative z-10">
          <div className="flex items-center gap-3">
            <span className={`px-3 py-1 rounded-full text-[10px] font-black uppercase tracking-wider ${isRanked ? 'bg-amber-500/20 text-amber-500 border border-amber-500/30' : 'bg-gray-500/20 text-gray-400 border border-gray-500/30'}`}>
              {isRanked ? "경쟁전" : "일반전"}
            </span>
            <span className="text-white/40 font-black text-xs uppercase tracking-tighter">{title} 기록</span>
          </div>
          
          <div className="flex justify-between items-center mt-1">
            <div className="flex items-center gap-2.5 min-w-0">
              {isRanked && (
                <img
                  src={getTierIconPath(data.currentTier?.tier, data.currentTier?.subTier)}
                  alt={data.currentTier?.tier || "Rank Icon"}
                  className="w-10 h-10 object-contain shrink-0"
                />
              )}
              <h4 className="text-xl md:text-2xl font-black text-white tracking-tight truncate">
                {isRanked ? (data.currentTier?.tier || "랭크 정보 없음") : title}
              </h4>
            </div>
            {isRanked && (
              <div className="text-right shrink-0">
                <div className="text-amber-500 font-black text-xl leading-none">{data.currentRankPoint || 0} <span className="text-xs">RP</span></div>
                <div className="text-[10px] text-white/50 font-bold uppercase tracking-widest">{data.currentTier?.subTier || ""} 티어</div>
              </div>
            )}
          </div>
        </div>
      </div>

      {/* Stats Grid */}
      <div className="p-8 grid grid-cols-3 gap-y-10 gap-x-6">
        <div className="flex flex-col gap-1">
          <div className="flex items-center gap-2 text-white/30">
            <Target size={12} />
            <span className="text-[10px] font-black uppercase tracking-wider">KDA</span>
          </div>
          <div className="text-2xl font-black text-amber-500 tracking-tighter">
            {getKDA(data.kills, data.assists, data.deaths || data.losses)}
          </div>
        </div>

        <div className="flex flex-col gap-1">
          <div className="flex items-center gap-2 text-white/30">
            <Crosshair size={12} />
            <span className="text-[10px] font-black uppercase tracking-wider">승률</span>
          </div>
          <div className="text-2xl font-black text-white tracking-tighter">
            {getWinRate(data.wins, data.roundsPlayed)}%
          </div>
        </div>

        <div className="flex flex-col gap-1">
          <div className="flex items-center gap-2 text-white/30">
            <Users size={12} />
            <span className="text-[10px] font-black uppercase tracking-wider">Top 10</span>
          </div>
          <div className="text-2xl font-black text-white tracking-tighter">{top10}%</div>
        </div>

        <div className="flex flex-col gap-1">
          <div className="flex items-center gap-2 text-white/30">
            <Trophy size={12} />
            <span className="text-[10px] font-black uppercase tracking-wider">우승</span>
          </div>
          <div className="text-xl font-black text-amber-500">{data.wins} <span className="text-[10px] text-white/20">회</span></div>
        </div>

        <div className="flex flex-col gap-1 relative" ref={tooltipRef}>
          <div className="flex items-center gap-2 text-white/30">
            <Swords size={12} />
            <span className="text-[10px] font-black uppercase tracking-wider">평균 기절시킴 (DBNO)</span>
            <button 
              onMouseEnter={() => !isMobile && setShowTooltip(true)} 
              onMouseLeave={() => !isMobile && setShowTooltip(false)} 
              onClick={() => isMobile && setShowTooltip(!showTooltip)}
              className={`transition-colors ${showTooltip ? 'text-amber-500' : 'text-amber-500/50 hover:text-amber-500'}`}
            >
              <HelpCircle size={10} />
            </button>
          </div>
          <div className="text-xl font-black text-green-400">
            {getAvgKnockouts(data.dBNOs, data.roundsPlayed)}
          </div>
          {showTooltip && (
            <div className={`absolute left-0 mb-2 p-3 bg-black border border-amber-500/50 rounded-xl text-[10px] text-white/80 font-bold z-50 w-48 shadow-2xl animate-in fade-in slide-in-from-bottom-1 ${isMobile ? 'bottom-full mb-4' : 'bottom-full'}`}>
              DBNO(Down But Not Out): 적을 기절시킨 횟수를 의미합니다.
            </div>
          )}
        </div>

        <div className="flex flex-col gap-1">
          <div className="flex items-center gap-2 text-white/30">
            <Target size={12} />
            <span className="text-[10px] font-black uppercase tracking-wider">평균 딜량</span>
          </div>
          <div className="text-xl font-black text-green-400">
            {getAvgDmg(data.damageDealt, data.roundsPlayed)}
          </div>
        </div>

        <div className="flex flex-col gap-1">
          <div className="flex items-center gap-2 text-white/30">
            <Users size={12} />
            <span className="text-[10px] font-black uppercase tracking-wider">총 게임 수</span>
          </div>
          <div className="text-xl font-black text-white/70">{data.roundsPlayed}</div>
        </div>

        {isRanked ? (
          <div className="flex flex-col gap-1">
            <div className="flex items-center gap-2 text-white/30">
              <Users size={12} />
              <span className="text-[10px] font-black uppercase tracking-wider">어시스트</span>
            </div>
            <div className="text-xl font-black text-white/70">{data.assists}</div>
          </div>
        ) : (
          <div className="flex flex-col gap-1">
            <div className="flex items-center gap-2 text-white/30">
              <Swords size={12} />
              <span className="text-[10px] font-black uppercase tracking-wider">최다 킬</span>
            </div>
            <div className="text-xl font-black text-white/70">{data.roundMostKills}</div>
          </div>
        )}

        {!isRanked && (
          <div className="flex flex-col gap-1">
            <div className="flex items-center gap-2 text-white/30">
              <Clock size={12} />
              <span className="text-[10px] font-black uppercase tracking-wider">평균 생존</span>
            </div>
            <div className="text-xs font-black text-white/50">
              {getSurvivalTime(data.timeSurvived, data.roundsPlayed)}
            </div>
          </div>
        )}
      </div>
      
      {/* Footer Accent */}
      <div className={`mt-auto h-1 w-full bg-gradient-to-r ${isRanked ? 'from-amber-600 to-transparent' : 'from-indigo-600 to-transparent'} opacity-30 shrink-0`} />
    </div>
  );
};
