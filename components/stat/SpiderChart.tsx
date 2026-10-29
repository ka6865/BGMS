"use client";

import React from "react";

interface SpiderChartProps {
  data: {
    combat?: number | null;
    tactical?: number | null;
    survival?: number | null;
  };
  nickname: string;
  tierScope?: "solo" | "team";
  bestMatchCount?: number;
}

function readScore(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function formatScore(value: number): string {
  return String(Number(value.toFixed(1)));
}

export const SpiderChart = ({ data, nickname, tierScope, bestMatchCount }: SpiderChartProps) => {
  const size = 340;
  const center = size / 2;
  const radius = size * 0.3; // 0.35 -> 0.3으로 비중 조절하여 여백 확보
  const levels = 5;
  
  const categories = [
    { key: "combat", label: "전투" },
    { key: "tactical", label: "전술" },
    { key: "survival", label: "생존" },
  ] as const;
  const caps = tierScope === "team"
    ? { combat: 40, tactical: 35, survival: 25 }
    : tierScope === "solo"
      ? { combat: 50, tactical: 15, survival: 35 }
      : null;
  const scores = {
    combat: readScore(data?.combat),
    tactical: readScore(data?.tactical),
    survival: readScore(data?.survival),
  };
  const hasCompleteScores = caps !== null && Object.values(scores).every((score) => score !== null);
  const selectionLabel = typeof bestMatchCount === "number"
    && Number.isFinite(bestMatchCount)
    && bestMatchCount > 0
    ? `${Math.floor(bestMatchCount)}경기 기준 · 3영역 점수 분포`
    : "3영역 점수 분포";

  const getPoint = (index: number, value: number) => {
    const angle = (Math.PI * 2 * index) / categories.length - Math.PI / 2;
    const r = (radius * value) / 100;
    return {
      x: center + r * Math.cos(angle),
      y: center + r * Math.sin(angle),
    };
  };

  const points = hasCompleteScores
    ? categories.map((cat, i) => getPoint(i, Math.max(0, Math.min(100, (scores[cat.key]! / caps![cat.key]) * 100))))
    : [];
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

      <svg width="100%" viewBox={`0 0 ${size} ${size}`} role="img" aria-label={`${nickname} 3영역 점수 분포`} className="h-auto w-full max-w-[340px] drop-shadow-[0_0_20px_rgba(99,102,241,0.2)]">
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
        {hasCompleteScores && <path
          d={pathData}
          fill="url(#radarGradient)"
          fillOpacity={0.4}
          stroke="#6366f1"
          strokeWidth="3"
          strokeLinecap="round"
          strokeLinejoin="round"
          className="transition-all duration-1000 ease-out"
        />}

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
                {scores[cat.key] === null
                  ? "측정 불가"
                  : caps
                    ? `${formatScore(scores[cat.key]!)}/${caps[cat.key]}`
                    : `${formatScore(scores[cat.key]!)}점`}
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

      {!caps && <p className="mt-3 text-xs text-white/60">배점 정보가 없어 원점수만 표시합니다.</p>}

      <div className="mt-8 text-center">
        <div className="text-sm text-indigo-300 font-bold mb-2">{selectionLabel}</div>
        <p className="text-xs text-white/60">각 영역 배점 대비 달성률이며 백분위가 아닙니다.</p>
      </div>
    </div>
  );
};
