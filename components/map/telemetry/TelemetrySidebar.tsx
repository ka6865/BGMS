import React from "react";
import { PlayerState } from "../../../hooks/useTelemetry";

interface TelemetrySidebarProps {
  currentStates: Record<string, PlayerState>;
}

export const TelemetrySidebar: React.FC<TelemetrySidebarProps> = ({ currentStates }) => {
  const players = Object.values(currentStates);
  
  // 팀별 그룹화
  const teams: Record<number, PlayerState[]> = {};
  players.forEach((p) => {
    const tid = p.teamId ?? 999;
    if (!teams[tid]) teams[tid] = [];
    teams[tid].push(p);
  });

  // 팀 정렬 (우리 팀 먼저)
  const sortedTeamIds = Object.keys(teams)
    .map(Number)
    .sort((a, b) => {
      const aIsTeam = teams[a].some((p) => !p.isEnemy);
      const bIsTeam = teams[b].some((p) => !p.isEnemy);
      if (aIsTeam && !bIsTeam) return -1;
      if (!aIsTeam && bIsTeam) return 1;
      return a - b;
    });

  return (
    <div className="w-72 h-full bg-[#1a1a1a]/95 border-l border-white/10 flex flex-col overflow-hidden text-sm text-gray-300">
      <div className="p-4 border-b border-white/10 bg-black/20">
        <div className="flex justify-between items-center text-xs font-bold text-gray-500 tracking-wider">
          <span>PLAYER / TEAM</span>
          <span>K / D / A</span>
        </div>
      </div>
      
      <div className="flex-1 overflow-y-auto custom-scrollbar p-2 space-y-3">
        {sortedTeamIds.map((tid) => {
          const teamPlayers = teams[tid];
          const isUserTeam = teamPlayers.some((p) => !p.isEnemy);
          
          return (
            <div 
              key={tid} 
              className={`rounded-lg border ${
                isUserTeam ? "border-[#F2A900]/50 bg-[#F2A900]/5" : "border-white/5 bg-white/5"
              } overflow-hidden`}
            >
              <div className="px-3 py-1.5 bg-black/20 flex justify-between items-center border-b border-white/5">
                <span className={`text-[10px] font-black ${isUserTeam ? "text-[#F2A900]" : "text-gray-500"}`}>
                  {tid === 0 ? "TEAM ?" : `TEAM ${tid}`}
                </span>
                {isUserTeam && <span className="text-[10px] bg-[#F2A900] text-black px-1 rounded font-bold">YOUR SQUAD</span>}
              </div>
              
              <div className="divide-y divide-white/5">
                {teamPlayers.sort((a, b) => Number(a.isDead) - Number(b.isDead)).map((p) => (
                  <div 
                    key={p.name} 
                    className={`px-3 py-2 flex justify-between items-center group hover:bg-white/5 transition-colors ${
                      p.isDead ? "opacity-40 grayscale" : ""
                    }`}
                  >
                    <div className="flex items-center gap-2 min-w-0">
                      <div 
                        className="w-2 h-2 rounded-full shrink-0" 
                        style={{ backgroundColor: p.color || "#fff" }}
                      />
                      <span className={`truncate font-medium ${p.isDead ? "line-through" : "text-white"}`}>
                        {p.name}
                      </span>
                    </div>
                    
                    <div className="flex gap-2 text-[11px] font-mono shrink-0">
                      <span className={p.kills > 0 ? "text-orange-400 font-bold" : "text-gray-500"}>
                        {p.kills}
                      </span>
                      <span className="text-gray-700">/</span>
                      <span className={(p.isDead ? 1 : 0) > 0 ? "text-red-400 font-bold" : "text-gray-500"}>
                        {p.isDead ? 1 : 0}
                      </span>
                      <span className="text-gray-700">/</span>
                      <span className={(p.assists || 0) > 0 ? "text-blue-400 font-bold" : "text-gray-500"}>
                        {p.assists || 0}
                      </span>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
};
