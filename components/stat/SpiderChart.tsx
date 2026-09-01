"use client";

import React from "react";

interface SpiderChartProps {
  data: {
    combat: number;    // 0-100
    tactical: number;  // 0-100
    survival: number;  // 0-100
  };
  nickname: string;
  bestMatchCount?: number;
}

function normalizeScore(value: unknown): number {
  try {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? Math.max(0, Math.min(100, parsed)) : 0;
  } catch {
    return 0;
  }
}

export const SpiderChart = ({ data, nickname, bestMatchCount }: SpiderChartProps) => {
  const size = 340; // 300 -> 340으로 확장
  const center = size / 2;
  const radius = size * 0.3; // 0.35 -> 0.3으로 비중 조절하여 여백 확보
  const levels = 5;
  
  const categories = [
    { key: "combat", label: "전투" },
    { key: "tactical", label: "전술" },
    { key: "survival", label: "생존" },
  ] as const;
  const normalizedScores = {
    combat: normalizeScore(data?.combat),
    tactical: normalizeScore(data?.tactical),
    survival: normalizeScore(data?.survival),
  };
  const selectionLabel = typeof bestMatchCount === "number"
    && Number.isFinite(bestMatchCount)
    && bestMatchCount > 0
    ? `점수 상위 ${Math.floor(bestMatchCount)}판`
    : "선정 경기";

  const getPoint = (index: number, value: number) => {
    const angle = (Math.PI * 2 * index) / categories.length - Math.PI / 2;
    const r = (radius * value) / 100;
    return {
      x: center + r * Math.cos(angle),
      y: center + r * Math.sin(angle),
    };
  };

  const points = categories.map((cat, i) => getPoint(i, normalizedScores[cat.key]));
  const pathData = points.map((p, i) => `${i === 0 ? "M" : "L"} ${p.x} ${p.y}`).join(" ") + " Z";

  return (
    <div className="relative flex flex-col items-center bg-black/40 p-8 rounded-[40px] border border-white/10 backdrop-blur-xl shadow-2xl overflow-hidden group">
      {/* Background Decor */}
      <div className="absolute -top-20 -left-20 w-40 h-40 bg-indigo-500/10 blur-[60px] rounded-full animate-pulse" />
      <div className="absolute -bottom-20 -right-20 w-40 h-40 bg-purple-500/10 blur-[60px] rounded-full animate-pulse" />

      <div className="flex gap-6 mb-8 self-start">
        <div className="flex items-center gap-2">
          <div className="w-3 h-3 bg-indigo-500 rounded-sm" />
          <span className="text-[11px] text-white/80 font-black tracking-tight">{nickname}</span>
        </div>
      </div>

      <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`} className="drop-shadow-[0_0_20px_rgba(99,102,241,0.2)]">
        {/* Background Grids */}
        {[...Array(levels)].map((_, i) => {
          const r = (radius * (i + 1)) / levels;
          const gridPoints = categories.map((_, j) => {
            const angle = (Math.PI * 2 * j) / categories.length - Math.PI / 2;
            return `${center + r * Math.cos(angle)},${center + r * Math.sin(angle)}`;
          }).join(" ");
          return (
            <polygon
              key={i}
              points={gridPoints}
              fill="none"
              stroke="white"
              strokeOpacity={0.05}
              strokeWidth="1"
            />
          );
        })}

        {/* Axes */}
        {categories.map((_, i) => {
          const p = getPoint(i, 100);
          return (
            <line
              key={i}
              x1={center}
              y1={center}
              x2={p.x}
              y2={p.y}
              stroke="white"
              strokeOpacity={0.05}
              strokeWidth="1"
            />
          );
        })}

        {/* User Area */}
        <path
          d={pathData}
          fill="url(#radarGradient)"
          fillOpacity={0.4}
          stroke="#6366f1"
          strokeWidth="3"
          strokeLinecap="round"
          strokeLinejoin="round"
          className="transition-all duration-1000 ease-out"
        />

        {/* Categories Labels */}
        {categories.map((cat, i) => {
          const p = getPoint(i, 135); // 여백 확보된 상태에서 135% 위치에 레이블 배치
          return (
            <g key={i}>
              <text
                x={p.x}
                y={p.y - 10}
                textAnchor="middle"
                className="fill-white font-black text-[14px] tracking-tighter"
              >
                {cat.label}
              </text>
              <text
                x={p.x}
                y={p.y + 10}
                textAnchor="middle"
                className="fill-indigo-400 font-black text-[11px]"
              >
                {Math.round(normalizedScores[cat.key])}
              </text>
            </g>
          );
        })}

        <defs>
          <linearGradient id="radarGradient" x1="0%" y1="0%" x2="100%" y2="100%">
            <stop offset="0%" stopColor="#6366f1" />
            <stop offset="100%" stopColor="#a855f7" />
          </linearGradient>
        </defs>
      </svg>

      <div className="mt-8 text-center">
        <div className="text-[10px] text-indigo-400/60 font-black uppercase tracking-[0.3em] mb-2">{selectionLabel} 전술 플레이스타일</div>
        <div className="text-2xl font-black text-white tracking-tight">
          {normalizedScores.combat > 80 ? "공격적 돌격병" : normalizedScores.survival > 80 ? "지능형 생존가" : "균형잡힌 전술가"}
        </div>
        <div className="mt-2 text-[9px] text-white/35 font-bold tracking-tight">
          {selectionLabel} · BGMS 자체 산정 · PUBG 공식 평점 아님
        </div>
      </div>
    </div>
  );
};
