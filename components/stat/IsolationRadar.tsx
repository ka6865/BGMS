"use client";

import React, { useState, useRef, useEffect } from "react";
import { ShieldAlert, Zap, ArrowUpCircle, Users, HelpCircle, X } from "lucide-react";
import { formatBenchmarkProvenance } from "@/lib/pubg-analysis/benchmarkAdapter";

interface IsolationData {
  isolationIndex?: unknown;
  minDist?: unknown;
  heightDiff?: unknown;
  isCrossfire: boolean;
  teammateCount?: unknown;
  userTier?: string;
  benchmarkIsolationIndex?: number;
  benchmarkMinDist?: number;
  benchmarkScope?: {
    gameMode?: string;
    matchType?: string;
    tier?: string;
    sampleCount?: number;
    metricSampleCounts?: Record<string, number>;
  };
}

interface IsolationRadarProps {
  data: IsolationData | null;
  loading?: boolean;
  isMobile?: boolean;
}

function finiteOrNull(value: unknown): number | null {
  const numeric = typeof value === "number"
    ? value
    : typeof value === "string" && value.trim() !== ""
      ? Number(value)
      : null;
  return numeric !== null && Number.isFinite(numeric) ? numeric : null;
}

function finiteNonNegative(value: unknown): number | null {
  const numeric = finiteOrNull(value);
  return numeric !== null && numeric >= 0 ? numeric : null;
}

export const IsolationRadar = ({ data, loading, isMobile }: IsolationRadarProps) => {
  const [activeTooltip, setActiveTooltip] = useState<string | null>(null);
  const tooltipRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const handleClickOutside = (event: MouseEvent) => {
      if (tooltipRef.current && !tooltipRef.current.contains(event.target as Node)) {
        setActiveTooltip(null);
      }
    };

    if (activeTooltip) {
      document.addEventListener("mousedown", handleClickOutside);
    }
    return () => {
      document.removeEventListener("mousedown", handleClickOutside);
    };
  }, [activeTooltip]);

  if (loading) return null; // 부모에서 Skeleton 처리

  if (!data) return null;

  // [V11.8] 서버에서 이미 미터(m) 단위로 정규화되어 넘어옴
  // A missing measurement is not an observed zero. Keep it nullable so the
  // score, status, and progress bar can stay unavailable instead of implying
  // a perfect result. Explicit numeric zero remains a real measurement.
  const isolationIndex = finiteNonNegative(data.isolationIndex);
  const distInMeters = finiteNonNegative(data.minDist);
  const heightInMeters = finiteNonNegative(data.heightDiff);
  const teammateCount = finiteNonNegative(data.teammateCount);
  const benchmarkIsolationIndex = finiteNonNegative(data.benchmarkIsolationIndex);
  const benchmarkMinDist = finiteNonNegative(data.benchmarkMinDist);
  const isCrossfire = data.isCrossfire === true;
  const benchmarkScope = data.benchmarkScope;
  const benchmarkContext = {
    gameMode: benchmarkScope?.gameMode,
    matchType: benchmarkScope?.matchType,
    tier: benchmarkScope?.tier ?? data.userTier,
  };
  const benchmarkLabelFor = (metric: string) => formatBenchmarkProvenance(benchmarkScope?.sampleCount, {
    ...benchmarkContext,
    metricSampleCount: benchmarkScope?.metricSampleCounts?.[metric],
  });

  const normIsolation = isolationIndex === null
    ? null
    : Math.max(0, Math.min(100, 100 - (isolationIndex * 20)));
  const normDist = distInMeters === null
    ? null
    : Math.max(0, Math.min(100, 100 - (distInMeters / 2.0))); // [V24] 200m 초과 시 0점 (기존 150m)
  const normHeight = heightInMeters === null
    ? null
    : Math.max(0, Math.min(100, 100 - (heightInMeters * 10))); // 10m 차이 시 0점
  const normPressure = isCrossfire ? 30 : 95;

  const stats = [
    { 
      label: "공간 안정성", 
      value: normIsolation, 
      icon: <Users size={14} />, 
      color: "text-emerald-400", 
      desc: isolationIndex === null
        ? "측정 불가 (위치 텔레메트리 샘플 없음)"
        : benchmarkIsolationIndex !== null
        ? `${benchmarkLabelFor("avgIsolationIndex")} 평균 고립지수: ${benchmarkIsolationIndex}`
        : "점유 중인 위치의 전술적 안전도",
      formula: "100 - (고립 지수 * 20)",
      detail: "고립 지수 = (아군 거리 / 적군 거리). 1.0 이하면 매우 안전한 포지셔닝입니다."
    },
    { 
      label: "교전 지원 가능성", 
      value: normDist, 
      icon: <Zap size={14} />, 
      color: "text-blue-400", 
      desc: distInMeters === null
        ? "측정 불가 (팀원 위치 텔레메트리 샘플 없음)"
        : benchmarkMinDist !== null
        ? `${benchmarkLabelFor("avgMinDist")} 평균 최근접 아군 거리: ${benchmarkMinDist}m`
        : "가장 가까운 아군까지의 평균 거리 기반의 즉각적인 교전 지원 거리 유지",
      formula: "100 - (평균 최근접 아군 거리 / 2.0)",
      detail: "아군과 200m 이상 떨어지면 0점 처리됩니다. 백업 가능한 거리를 유지하세요."
    },
    { 
      label: "고도 일치성", 
      value: normHeight, 
      icon: <ArrowUpCircle size={14} />, 
      color: "text-purple-400", 
      desc: heightInMeters === null
        ? "측정 불가 (고도 텔레메트리 샘플 없음)"
        : "팀원과 동일한 수직 높이 유지",
      formula: "100 - (평균 고도차 * 10)",
      detail: "수직 높이차가 10m를 넘으면 0점 처리됩니다. 복층/지형 고저차를 관리하세요."
    },
    { 
      label: "양각 방어력", 
      value: normPressure, 
      icon: <ShieldAlert size={14} />, 
      color: "text-orange-400", 
      desc: "여러 방향(양각)에서의 공격 방어",
      formula: "양각 피격 판정",
      detail: "5초 이내에 서로 다른 적 2명 이상에게 피격된 '다굴' 상황을 체크합니다."
    },
  ];

  return (
    <div className="@container relative p-6 sm:p-8 bg-black/40 rounded-[40px] border border-white/10 backdrop-blur-3xl shadow-2xl overflow-hidden group transition-all duration-500 hover:bg-black/50">
      <div className="absolute -top-24 -right-24 w-48 h-48 bg-emerald-500/10 blur-[80px] rounded-full group-hover:bg-emerald-500/20 transition-colors duration-700" />
      
      <div className="flex flex-col @md:flex-row @md:items-center justify-between gap-4 mb-8">
        <div className="flex flex-col gap-1">
          <div className="flex items-center gap-2 text-[10px] text-emerald-400 font-black uppercase tracking-[0.3em]">
            공간 지각 지능 분석 
            {data.userTier && (
              <span className="px-1.5 py-0.5 bg-emerald-500/20 text-emerald-300 rounded-[4px] tracking-normal border border-emerald-500/30">
                {data.userTier} TIER
              </span>
            )}
          </div>
          <div className="text-xl sm:text-2xl font-black text-white tracking-tighter">전술적 공간 데이터</div>
        </div>
        <div className={`w-fit px-4 py-1.5 rounded-xl border text-[10px] sm:text-xs font-black transition-all ${
          isolationIndex === null ? "bg-white/5 border-white/10 text-white/50" :
          isolationIndex > 2 ? "bg-red-500/20 border-red-500/30 text-red-400" :
          isolationIndex > 1.2 ? "bg-orange-500/20 border-orange-500/30 text-orange-400" :
          "bg-emerald-500/20 border-emerald-500/30 text-emerald-400"
        }`}>
          {isolationIndex === null
            ? "공간 안정성: 측정 불가"
            : isolationIndex > 2 ? "전술적 고립: 위험" : isolationIndex > 1.2 ? "거리 유지: 주의" : "공간 안정성: 우수"}
        </div>
      </div>

      <div className="grid grid-cols-1 @md:grid-cols-2 gap-4 sm:gap-6">
        {stats.map((s, i) => (
          <div key={i} className="flex flex-col gap-3 p-4 bg-white/[0.03] rounded-2xl border border-white/5 group/item hover:bg-white/[0.08] transition-all relative">
            <div className="flex items-center justify-between">
              <div className={`flex items-center gap-2 text-[10px] sm:text-[11px] font-black uppercase tracking-tight ${s.color}`}>
                {s.icon} {s.label}
                <button 
                  onMouseEnter={() => !isMobile && setActiveTooltip(s.label)}
                  onMouseLeave={() => !isMobile && setActiveTooltip(null)}
                  onClick={() => isMobile && setActiveTooltip(activeTooltip === s.label ? null : s.label)}
                  className="opacity-40 hover:opacity-100 transition-opacity cursor-help p-1"
                >
                  <HelpCircle size={14} />
                </button>
              </div>
              <div className="text-lg font-black text-white/90">
                {s.value === null ? "측정 불가" : Math.round(s.value)}
              </div>
            </div>

            {/* Tooltip Content */}
            {activeTooltip === s.label && (
              <div 
                ref={tooltipRef}
                className={`${
                  isMobile 
                  ? "fixed inset-x-4 bottom-10 animate-in slide-in-from-bottom-5" 
                  : "absolute bottom-full left-0 mb-2 animate-in fade-in zoom-in-95"
                } p-4 bg-[#111] border border-white/20 rounded-2xl shadow-[0_0_50px_rgba(0,0,0,0.8)] z-[100] ${isMobile ? "w-auto" : "w-64"} duration-200`}
              >
                <div className="flex justify-between items-start mb-2">
                  <div className={`text-[10px] font-black uppercase ${s.color}`}>{s.formula}</div>
                  {isMobile && (
                    <button onClick={() => setActiveTooltip(null)} className="text-white/40">
                      <X size={14} />
                    </button>
                  )}
                </div>
                <div className="text-[12px] text-white font-bold mb-1">{s.label} 분석</div>
                <div className="text-[11px] text-white/70 font-medium leading-relaxed">{s.detail}</div>
                {!isMobile && <div className="absolute -bottom-1 left-6 w-2 h-2 bg-[#111] border-r border-b border-white/10 rotate-45" />}
              </div>
            )}

            <div className="text-[10px] text-white/30 font-medium leading-tight mb-1">{s.desc}</div>
            <div className="w-full h-1.5 bg-black/40 rounded-full overflow-hidden">
              {s.value !== null && (
                <div
                  className={`h-full bg-current transition-all duration-1000 ease-out shadow-[0_0_8px_rgba(0,0,0,0.5)] ${s.color}`}
                  style={{ width: `${s.value}%` }}
                />
              )}
            </div>
          </div>
        ))}
      </div>

      <div className="mt-8 pt-8 border-t border-white/10 flex flex-row items-center justify-between gap-6">
        <div className="flex flex-col relative group/iso">
          <div className="flex items-center gap-1 text-[10px] text-gray-500 font-bold uppercase tracking-widest">
            공간 고립 지수
            <button
              onMouseEnter={() => !isMobile && setActiveTooltip("iso_mastery")}
              onMouseLeave={() => !isMobile && setActiveTooltip(null)}
              onClick={() => isMobile && setActiveTooltip(activeTooltip === "iso_mastery" ? null : "iso_mastery")}
              className="opacity-50 hover:opacity-100 transition-opacity cursor-help"
            >
              <HelpCircle size={12} />
            </button>
          </div>
          
          {/* Tooltip Content */}
          {activeTooltip === "iso_mastery" && (
            <div 
              ref={tooltipRef}
              className={`${
                isMobile 
                ? "fixed inset-x-4 bottom-10 animate-in slide-in-from-bottom-5" 
                : "absolute bottom-full left-0 mb-2 animate-in fade-in zoom-in-95"
              } p-4 bg-[#111] border border-white/20 rounded-2xl shadow-[0_0_50px_rgba(0,0,0,0.8)] z-[100] ${isMobile ? "w-auto" : "w-64"} duration-200`}
            >
              <div className="flex justify-between items-start mb-2">
                <div className="text-[9px] font-black uppercase text-emerald-400">계산 방식</div>
                {isMobile && (
                  <button onClick={() => setActiveTooltip(null)} className="text-white/40">
                    <X size={14} />
                  </button>
                )}
              </div>
              <div className="text-[10px] text-white/70 font-medium leading-relaxed">
                교전 시 아군과의 거리 및 고도차를 분석한 고립도입니다. <span className="text-emerald-400">0.5 미만</span>이 우수하며, 수치가 낮을수록 백업 받기 유리한 포지셔닝을 의미합니다.
              </div>
              {!isMobile && <div className="absolute -bottom-1 left-4 w-2 h-2 bg-[#111] border-r border-b border-white/10 rotate-45" />}
            </div>
          )}

          <div className="text-2xl sm:text-4xl font-black text-white flex items-baseline gap-1">
            {isolationIndex === null ? "측정 불가" : isolationIndex.toFixed(1)}
            <span className="text-[10px] sm:text-xs text-gray-500 font-medium uppercase">점</span>
          </div>
        </div>
        <div className="text-right flex flex-col items-end">
            <div className="text-[10px] text-gray-500 font-bold uppercase tracking-widest">평균 최근접 아군 거리</div>
          <div className="text-xl sm:text-2xl font-black text-white/90">
            {distInMeters === null ? "측정 불가" : <>{distInMeters.toFixed(1)}<span className="text-sm font-medium">m</span></>}
            <span className="ml-2 text-[10px] sm:text-xs text-emerald-500/60 font-medium">
              ({heightInMeters === null ? "측정 불가" : `${heightInMeters.toFixed(1)}m`} 고도차)
            </span>
          </div>
          <div className="mt-1 text-[9px] text-gray-600 font-bold uppercase tracking-tighter">
            평균 주변 아군: <span className="text-emerald-500/80">
              {teammateCount === null ? "측정 불가" : `${teammateCount}명`}
            </span>
          </div>
        </div>
      </div>
      {isCrossfire && (
        <div className="mt-6 p-4 bg-red-500/10 border border-red-500/20 rounded-2xl flex items-center gap-4 animate-in slide-in-from-bottom-2 duration-500">
          <ShieldAlert className="text-red-400 shrink-0" size={20} />
          <div className="flex flex-col">
            <span className="text-[10px] text-red-400 font-black uppercase tracking-wider">양각(다굴) 노출 위험 경고</span>
            <span className="text-[11px] text-red-200/60 font-medium leading-tight">두 방향 이상에서 동시에 공격받고 있습니다. 엄폐물 확보가 시급합니다.</span>
          </div>
        </div>
      )}
      <div className="mt-5 text-[9px] text-gray-600 font-bold tracking-tight">
        최근 유효 경기 텔레메트리에서 파생된 지표
      </div>
    </div>
  );
};
