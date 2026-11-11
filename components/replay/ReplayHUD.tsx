import React from "react";
import { ArrowLeft, Users, PanelLeftOpen, Zap, LocateFixed, X } from "lucide-react";
import { ZoneState } from "@/types/replay3d";

interface ReplayHUDProps {
  currentTimeMs: number;
  maxTimeMs: number;
  aliveCount: number;
  zones: ZoneState[];
  onBack: () => void;
  formatTime: (ms: number) => string;
  // 모바일 사이드바 토글
  isSidebarOpen: boolean;
  onToggleSidebar: () => void;
  // 카메라가 따라가는 선수. 없으면 기본 선수를 다시 따라가는 버튼을 보인다.
  followName: string | null;
  onToggleFollow: () => void;
}

export default function ReplayHUD({
  currentTimeMs,
  aliveCount,
  zones,
  onBack,
  formatTime,
  isSidebarOpen,
  onToggleSidebar,
  followName,
  onToggleFollow,
}: ReplayHUDProps) {
  return (
    <div className="absolute left-3 top-3 flex flex-col gap-2 z-10 pointer-events-none sm:left-4 sm:top-4">
      {/* 뒤로가기 + 모바일 사이드바 토글 (같은 행) */}
      <div className="flex items-center gap-2">
        <button
          onClick={onBack}
          className="pointer-events-auto flex items-center gap-1.5 px-3 py-1.5 bg-[#161b22]/95 backdrop-blur border border-[#ff9f0a]/30 hover:border-[#ff9f0a] text-[#ff9f0a] hover:bg-[#ff9f0a] hover:text-[#0d1117] rounded-lg font-bold text-xs transition-all cursor-pointer shadow-lg w-fit"
        >
          <ArrowLeft className="w-3.5 h-3.5" />
          <span className="hidden sm:inline">이전으로</span>
        </button>

        {/* 모바일 전용 사이드바 토글 버튼 */}
        <button
          onClick={onToggleSidebar}
          title={isSidebarOpen ? "패널 닫기" : "패널 열기"}
          className="pointer-events-auto md:hidden flex items-center justify-center w-8 h-8 bg-[#161b22]/95 backdrop-blur border border-[#30363d] hover:border-[#ff9f0a] text-[#8b949e] hover:text-[#ff9f0a] rounded-lg transition-all cursor-pointer shadow-lg"
        >
          <PanelLeftOpen className="w-4 h-4" />
        </button>
      </div>

      {/* 현재 재생 시간 + 생존자 수 */}
      <div className="bg-[#161b22]/90 backdrop-blur border border-[#30363d] rounded-lg px-2.5 py-2 flex items-center gap-2.5 sm:px-3 sm:gap-3">
        <div className="flex flex-col">
          <span className="text-[8px] font-bold text-[#8b949e] uppercase tracking-widest">ELAPSED</span>
          <span className="text-base sm:text-lg font-mono font-bold text-[#ff9f0a] leading-none">{formatTime(currentTimeMs)}</span>
        </div>
        <div className="w-px h-8 bg-[#30363d]" />
        <div className="flex flex-col">
          <span className="text-[8px] font-bold text-[#8b949e] uppercase tracking-widest">ALIVE</span>
          <div className="flex items-center gap-1">
            <Users className="w-3.5 h-3.5 text-[#2ea043]" />
            <span className="text-base sm:text-lg font-mono font-bold text-[#2ea043] leading-none">{aliveCount}</span>
          </div>
        </div>
      </div>

      <button
        type="button"
        onClick={onToggleFollow}
        title={followName ? "따라가기 해제" : "선수 따라가기"}
        className="pointer-events-auto inline-flex min-h-8 w-fit max-w-[180px] items-center gap-1.5 rounded-lg border border-[#30363d] bg-[#161b22]/90 px-2.5 py-1.5 text-[11px] font-bold text-[#e6edf3] shadow-lg backdrop-blur transition-colors hover:border-[#ff9f0a]"
      >
        <LocateFixed className={`h-3.5 w-3.5 shrink-0 ${followName ? "text-[#ff9f0a]" : "text-[#8b949e]"}`} />
        <span className="truncate">{followName ?? "선수 따라가기"}</span>
        {followName && <X className="h-3 w-3 shrink-0 text-[#8b949e]" />}
      </button>

      {/* 자기장 수축 경고 배지 */}
      {zones.length > 0 &&
        (() => {
          const z1 = zones.findLast((z) => z.t <= currentTimeMs) ?? zones[0];
          const z2 = zones.find((z) => z.t > currentTimeMs);
          const shrinking = z2 && z2.blueRadius < z1.blueRadius;
          return shrinking ? (
            <div className="inline-flex items-center gap-1 bg-[#ff3300]/20 border border-[#ff3300]/60 text-[#ff6633] px-3 py-1.5 rounded-lg text-[10px] font-bold animate-pulse">
              <Zap className="w-3 h-3" />
              자기장 수축 중
            </div>
          ) : null;
        })()}
    </div>
  );
}
