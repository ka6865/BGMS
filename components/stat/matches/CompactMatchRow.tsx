"use client";

import { ChevronDown } from "lucide-react";
import type { MatchSummaryData } from "@/lib/pubg-analysis/matchSummary";
import { classifyMatchMode } from "@/lib/stats/statsPageModel";
import { estimateUserTier } from "@/lib/pubg-analysis/benchmarkScore";

export interface CompactMatchRowProps {
  summary: MatchSummaryData;
  isExpanded: boolean;
  onToggle(): void;
}

const MAP_NAMES: Record<string, string> = {
  Baltic_Main: "에란겔",
  Desert_Main: "미라마",
  Savage_Main: "사녹",
  Summerland_Main: "카라킨",
  Chimera_Main: "파라모",
  Tiger_Main: "태이고",
  Kiki_Main: "데스턴",
  Neon_Main: "론도",
  DihorOtok_Main: "비켄디",
  PillarCompound_Main: "필라 기지 (TDM)",
  Italy_TDM_Main: "리틀 이탈리아 (TDM)",
};

const MODE_LABELS = {
  ranked: "경쟁전",
  normal: "일반전",
  tdm: "팀 데스매치",
} as const;

function getStatus(summary: MatchSummaryData): { label: string; border: string } {
  const mode = classifyMatchMode(summary);
  if (mode === "tdm") {
    return summary.stats.winPlace === 1
      ? { label: "승리", border: "border-l-rose-400" }
      : { label: "패배", border: "border-l-red-400" };
  }
  if (summary.stats.winPlace === 1) return { label: "승리", border: "border-l-amber-400" };
  if (summary.stats.winPlace <= 10) return { label: "상위권", border: "border-l-teal-400" };
  if (summary.stats.kills === 0 && summary.stats.damageDealt < 100) {
    return { label: "저성과", border: "border-l-red-400" };
  }
  return { label: "일반", border: "border-l-white/20" };
}

function formatMode(gameMode: string) {
  const mode = gameMode.toLowerCase();
  const perspective = mode.includes("fpp") ? "1인칭" : "3인칭";
  const party = mode.includes("solo") ? "솔로" : mode.includes("duo") ? "듀오" : "스쿼드";
  return `${perspective} ${party}`;
}

export function CompactMatchRow({ summary, isExpanded, onToggle }: CompactMatchRowProps) {
  const mode = classifyMatchMode(summary);
  const status = getStatus(summary);
  const tier = summary.benchmark ? estimateUserTier(summary.benchmark.score) : null;
  const total = summary.totalTeams || summary.totalPlayers || 0;

  return (
    <article
      className={`overflow-hidden rounded-2xl border border-white/10 border-l-4 bg-[#161616] ${status.border}`}
      data-compact-match-id={summary.matchId}
    >
      <button
        type="button"
        aria-expanded={isExpanded}
        aria-label={isExpanded ? "매치 상세 접기" : "매치 상세 펼치기"}
        onClick={onToggle}
        className="flex min-h-11 w-full items-center gap-3 p-3 text-left md:gap-4 md:p-4"
      >
        <div className="flex h-12 w-12 shrink-0 flex-col items-center justify-center rounded-xl bg-white/5">
          <span className="text-[9px] font-black text-white/40">{mode === "tdm" ? "결과" : "순위"}</span>
          <strong className="text-lg text-white">
            {mode === "tdm" ? status.label : `#${summary.stats.winPlace}`}
          </strong>
          {mode !== "tdm" && total > 0 && <span className="text-[9px] text-white/30">/ {total}</span>}
        </div>

        <div className="min-w-0 flex-1">
          <div className="flex min-w-0 items-center gap-2">
            <strong className="truncate text-sm text-white md:text-base">
              {MAP_NAMES[summary.mapName] ?? summary.mapName ?? "맵 정보 없음"}
            </strong>
            <span className="shrink-0 rounded-md border border-white/10 bg-white/5 px-2 py-0.5 text-[10px] font-black text-white/60">
              {MODE_LABELS[mode]}
            </span>
            <span className="hidden text-[10px] font-bold text-white/35 sm:inline">{formatMode(summary.gameMode || "")}</span>
          </div>
          <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs font-bold text-white/55">
            <span><strong className="text-white">{summary.stats.kills}</strong> 킬</span>
            <span><strong className="text-white">{Math.floor(summary.stats.damageDealt || 0)}</strong> 피해</span>
            <span><strong className="text-white">{summary.stats.DBNOs || 0}</strong> DBNO</span>
            <span><strong className="text-white">{Math.floor((summary.stats.timeSurvived || 0) / 60)}</strong>분 생존</span>
          </div>
        </div>

        <div className="flex shrink-0 flex-col items-end gap-1">
          <span className="text-[10px] font-black text-white/50">{status.label}</span>
          {tier && <span className="rounded-md bg-indigo-500/15 px-2 py-1 text-[10px] font-black text-indigo-300">AI {tier}</span>}
        </div>
        <ChevronDown
          size={20}
          aria-hidden="true"
          className={`shrink-0 text-white/40 transition-transform ${isExpanded ? "rotate-180" : ""}`}
        />
      </button>
    </article>
  );
}
