import React from "react";
import { Compass, RefreshCw, Users, Crosshair, Loader2, Eye, EyeOff, Radio, Skull } from "lucide-react";
import { PlayerTrajectory } from "@/types/replay3d";
import { getActiveDeathTime } from "@/lib/replay/replay3dHelpers";

interface ReplaySidebarProps {
  isOpen: boolean;
  players: PlayerTrajectory[];
  hiddenPlayers: Set<string>;
  trackingPlayer: string | null;
  currentTimeMs: number;
  altitudeScale: number;
  setAltitudeScale: (v: number) => void;
  togglePlayer: (name: string) => void;
  handlePlayerFocus: (name: string) => void;
  handlePlayerTrack: (name: string) => void;
  // 필터 토글
  showBluezone: boolean;
  setShowBluezone: (v: boolean) => void;
  showTrajectories: boolean;
  setShowTrajectories: (v: boolean) => void;
  showNames: boolean;
  setShowNames: (v: boolean) => void;
  // 새로고침
  isLoading: boolean;
  isMapLoading: boolean;
  handleFetchTelemetry: () => void;
}

export default function ReplaySidebar({
  isOpen,
  players,
  hiddenPlayers,
  trackingPlayer,
  currentTimeMs,
  altitudeScale,
  setAltitudeScale,
  togglePlayer,
  handlePlayerFocus,
  handlePlayerTrack,
  showBluezone,
  setShowBluezone,
  showTrajectories,
  setShowTrajectories,
  showNames,
  setShowNames,
  isLoading,
  isMapLoading,
  handleFetchTelemetry,
}: ReplaySidebarProps) {
  const teamPlayers = players.filter((p) => p.isTeam);
  const enemyPlayers = players.filter((p) => !p.isTeam);

  const enemyTeams: Record<number, PlayerTrajectory[]> = {};
  enemyPlayers.forEach((p) => {
    const tId = p.teamId ?? 999;
    if (!enemyTeams[tId]) enemyTeams[tId] = [];
    enemyTeams[tId].push(p);
  });

  const renderPlayerBtn = (p: PlayerTrajectory) => {
    const isHidden = hiddenPlayers.has(p.name);
    const isDead = getActiveDeathTime(p.deathTimes, p.redeployTimes, currentTimeMs) !== null;
    const isTracking = trackingPlayer === p.name;

    return (
      <div
        key={p.name}
        className="flex items-center justify-between text-[10px] font-mono px-2 py-1 rounded border transition-all"
        style={{
          backgroundColor: isHidden ? "rgba(30,30,30,0.8)" : isTracking ? `${p.color}28` : `${p.color}18`,
          borderColor: isHidden ? "#30363d" : isTracking ? "#ff9f0a" : p.color,
          color: isHidden ? "#484f58" : p.color,
        }}
      >
        <div
          onClick={() => handlePlayerFocus(p.name)}
          onDoubleClick={() => handlePlayerTrack(p.name)}
          className="flex-grow flex items-center gap-1.5 cursor-pointer select-none py-0.5"
          title="클릭: 초점 이동 | 더블클릭: 카메라 추적 고정"
        >
          <span className="w-2 h-2 rounded-full shrink-0" style={{ backgroundColor: isHidden ? "#484f58" : p.color }} />
          <span className="truncate max-w-[110px] font-bold">{p.name}</span>
          {isTracking && (
            <span className="inline-flex items-center gap-0.5 text-[8px] bg-[#ff9f0a] text-[#0d1117] font-bold px-1 rounded animate-pulse shrink-0 scale-90">
              <Radio className="w-2 h-2" />
              REC
            </span>
          )}
        </div>
        <button
          onClick={() => togglePlayer(p.name)}
          className="text-[9px] shrink-0 text-[#8b949e] hover:text-[#ff9f0a] ml-2 px-1 py-0.5 hover:bg-[#21262d] rounded transition-all cursor-pointer"
        >
          {isDead ? <Skull className="w-3 h-3" /> : isHidden ? "숨김" : "표시"}
        </button>
      </div>
    );
  };

  const FILTERS = [
    { label: "자기장", active: showBluezone, toggle: () => setShowBluezone(!showBluezone), activeColor: "#3b82f6" },
    { label: "이동경로", active: showTrajectories, toggle: () => setShowTrajectories(!showTrajectories), activeColor: "#ff9f0a" },
    { label: "닉네임", active: showNames, toggle: () => setShowNames(!showNames), activeColor: "#2ea043" },
  ];

  return (
    <div
      className={`fixed md:relative top-0 bottom-0 left-0 z-40 w-[min(18rem,86vw)] bg-[#161b22]/98 backdrop-blur border-r border-[#30363d] flex flex-col p-4 gap-4 overflow-y-auto no-scrollbar shrink-0 select-none transition-transform duration-300 md:w-72 md:transform-none ${
        isOpen ? "translate-x-0" : "-translate-x-full md:translate-x-0"
      }`}
      style={{ height: "100%" }}
    >
      {/* 헤더 */}
      <div className="flex items-center justify-between border-b border-[#30363d] pb-3 shrink-0">
        <div className="flex items-center gap-2">
          <div className="w-8 h-8 rounded-lg bg-[#ff9f0a]/10 flex items-center justify-center text-[#ff9f0a]">
            <Compass className="w-5 h-5 animate-pulse" />
          </div>
          <div className="flex flex-col">
            <h1 className="text-sm font-bold text-[#ff9f0a] leading-tight">3D 전술 리플레이</h1>
            <span className="text-[9px] text-[#8b949e]">PUBG 실시간 전술 분석기</span>
          </div>
        </div>

        {/* 새로고침 버튼 */}
        <button
          onClick={handleFetchTelemetry}
          disabled={isLoading || isMapLoading}
          title="전술 데이터 새로고침"
          className="w-8 h-8 flex items-center justify-center rounded-lg border border-[#30363d] bg-[#21262d] hover:border-[#ff9f0a] hover:text-[#ff9f0a] text-[#8b949e] disabled:opacity-40 disabled:cursor-not-allowed transition-all cursor-pointer"
        >
          {isLoading || isMapLoading ? (
            <Loader2 className="w-4 h-4 animate-spin" />
          ) : (
            <RefreshCw className="w-4 h-4" />
          )}
        </button>
      </div>

      {/* 필터 토글 3종 */}
      <div className="flex flex-col gap-2 bg-[#0d1117]/40 p-3 rounded-xl border border-[#30363d] shrink-0">
        <span className="text-[9px] font-bold text-[#8b949e] uppercase tracking-wider">레이어 필터</span>
        <div className="flex gap-2">
          {FILTERS.map(({ label, active, toggle, activeColor }) => (
            <button
              key={label}
              onClick={toggle}
              className="flex-1 flex items-center justify-center gap-1 py-1.5 rounded-lg border text-[10px] font-bold transition-all cursor-pointer"
              style={{
                backgroundColor: active ? `${activeColor}22` : "#21262d",
                borderColor: active ? activeColor : "#30363d",
                color: active ? activeColor : "#8b949e",
              }}
            >
              {active ? <Eye className="w-3 h-3 shrink-0" /> : <EyeOff className="w-3 h-3 shrink-0" />}
              <span className="truncate">{label}</span>
            </button>
          ))}
        </div>
      </div>

      {/* 고도 스케일 슬라이더 */}
      <div className="flex flex-col gap-2 bg-[#0d1117]/30 p-2.5 rounded-lg border border-[#30363d] shrink-0">
        <div className="flex flex-col gap-1.5">
          <div className="flex justify-between text-[10px] font-bold">
            <span className="text-[#8b949e]">고도 스케일</span>
            <span className="font-mono text-[#ff9f0a] font-bold">{(altitudeScale * 1000).toFixed(0)}%</span>
          </div>
          <input
            type="range"
            min="0"
            max="0.08"
            step="0.005"
            value={altitudeScale}
            onChange={(e) => setAltitudeScale(Number(e.target.value))}
            className="w-full accent-[#ff9f0a] h-1 bg-[#30363d] rounded-lg appearance-none cursor-pointer"
          />
          <div className="flex justify-between text-[9px] text-[#8b949e]">
            <span>평면</span>
            <span>입체감 최대</span>
          </div>
        </div>
      </div>

      <hr className="border-[#30363d]" />

      {/* 플레이어 목록 */}
      <div className="flex flex-col gap-3 flex-1 min-h-0">
        {teamPlayers.length > 0 && (
          <div className="flex flex-col gap-1.5">
            <label className="text-[9px] font-bold text-[#2ea043] uppercase tracking-wider flex items-center gap-1">
              <Users className="w-3.5 h-3.5" /> 아군 스쿼드 ({teamPlayers.length})
            </label>
            <div className="flex flex-col gap-1 bg-[#0d1117] p-2 rounded border border-[#238636]/40">
              {teamPlayers.map(renderPlayerBtn)}
            </div>
          </div>
        )}

        {enemyPlayers.length > 0 && (
          <div className="flex flex-col gap-1.5 min-h-0">
            <label className="text-[9px] font-bold text-[#ff4a4a] uppercase tracking-wider flex items-center gap-1">
              <Crosshair className="w-3.5 h-3.5" /> 적군 ({enemyPlayers.length})
            </label>
            <div className="flex flex-col gap-2.5 bg-[#0d1117] p-2 rounded border border-[#ef4444]/30 overflow-y-auto max-h-56 no-scrollbar">
              {Object.entries(enemyTeams)
                .sort(([aId], [bId]) => Number(aId) - Number(bId))
                .map(([teamId, members]) => {
                  const firstMemberColor = members[0]?.color || "#ff4a4a";
                  return (
                    <div key={teamId} className="flex flex-col gap-1 border-l-2 pl-2 py-0.5" style={{ borderColor: `${firstMemberColor}50` }}>
                      <div className="text-[8px] font-bold uppercase tracking-widest flex items-center gap-1" style={{ color: firstMemberColor }}>
                        <span className="w-1.5 h-1.5 rounded-full" style={{ backgroundColor: firstMemberColor }} />
                        <span>TEAM {teamId}</span>
                      </div>
                      <div className="flex flex-col gap-1">{members.map(renderPlayerBtn)}</div>
                    </div>
                  );
                })}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
