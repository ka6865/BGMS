import React from "react";
import { PlayerState } from "../../../hooks/useTelemetry";

interface TelemetrySidebarProps {
  currentStates: Record<string, PlayerState>;
  /** 최근 아군과 교전한 상대 이름(소문자). */
  engagedOpponents?: ReadonlySet<string>;
  followPlayer?: string | null;
}

const normalize = (name: string) => name.trim().toLowerCase();

// 정렬 순서: 아군 → 아군과 교전 중인 팀 → 생존 팀 → 전멸 팀
function teamRank(players: PlayerState[], engaged: ReadonlySet<string>): number {
  if (players.some((p) => !p.isEnemy)) return 0;
  if (players.some((p) => !p.isDead && engaged.has(normalize(p.name)))) return 1;
  if (players.some((p) => !p.isDead)) return 2;
  return 3;
}

function HealthBar({ player }: { player: PlayerState }) {
  if (player.isDead) return null;
  const pct = Math.max(0, Math.min(100, player.health ?? 0));
  const color = player.isGroggy ? "#ef4444" : pct > 50 ? "#22c55e" : pct > 20 ? "#f59e0b" : "#ef4444";
  return (
    <div className="mt-1 h-1 w-full rounded-full bg-white/10 overflow-hidden" aria-hidden="true">
      <div className="h-full rounded-full" style={{ width: `${pct}%`, backgroundColor: color }} />
    </div>
  );
}

export const TelemetrySidebar: React.FC<TelemetrySidebarProps> = ({ currentStates, engagedOpponents, followPlayer }) => {
  const engaged = engagedOpponents ?? new Set<string>();
  const followed = followPlayer ? normalize(followPlayer) : "";
  const players = Object.values(currentStates);

  // 팀별 그룹화
  const teams: Record<number, PlayerState[]> = {};
  players.forEach((p) => {
    const tid = p.teamId ?? 999;
    if (!teams[tid]) teams[tid] = [];
    teams[tid].push(p);
  });

  const sortedTeamIds = Object.keys(teams)
    .map(Number)
    .sort((a, b) => teamRank(teams[a], engaged) - teamRank(teams[b], engaged) || a - b);

  return (
    <div className="w-72 h-full bg-[#1a1a1a]/95 border-l border-white/10 flex flex-col overflow-hidden text-sm text-gray-300">
      <div className="p-4 border-b border-white/10 bg-black/20">
        <div className="flex justify-between items-center text-xs font-bold text-gray-500 tracking-wider">
          <span>선수 / 팀</span>
          <span>K / D / A</span>
        </div>
      </div>

      <div className="flex-1 overflow-y-auto custom-scrollbar p-2 space-y-3">
        {sortedTeamIds.map((tid) => {
          const teamPlayers = teams[tid];
          const rank = teamRank(teamPlayers, engaged);
          const isUserTeam = rank === 0;

          return (
            <div
              key={tid}
              className={`rounded-lg border ${
                isUserTeam ? "border-[#F2A900]/50 bg-[#F2A900]/5"
                  : rank === 1 ? "border-red-500/50 bg-red-500/5"
                    : "border-white/5 bg-white/5"
              } overflow-hidden ${rank === 3 ? "opacity-60" : ""}`}
            >
              <div className="px-3 py-1.5 bg-black/20 flex justify-between items-center border-b border-white/5">
                <span className={`text-[10px] font-black ${isUserTeam ? "text-[#F2A900]" : "text-gray-500"}`}>
                  {tid === 0 ? "팀 ?" : `팀 ${tid}`}
                </span>
                {isUserTeam && <span className="text-[10px] bg-[#F2A900] text-black px-1 rounded font-bold">내 스쿼드</span>}
                {rank === 1 && <span className="text-[10px] bg-red-500 text-white px-1 rounded font-bold">교전 중</span>}
                {rank === 3 && <span className="text-[10px] text-gray-500 font-bold">전멸</span>}
              </div>

              <div className="divide-y divide-white/5">
                {teamPlayers.sort((a, b) => Number(a.isDead) - Number(b.isDead)).map((p) => {
                  const isFollowed = followed !== "" && normalize(p.name) === followed;
                  return (
                    <div
                      key={p.name}
                      className={`px-3 py-2 group hover:bg-white/5 transition-colors ${
                        p.isDead ? "opacity-40 grayscale" : ""
                      } ${isFollowed ? "bg-sky-400/10" : ""}`}
                    >
                      <div className="flex justify-between items-center">
                        <div className="flex items-center gap-2 min-w-0">
                          <div
                            className={`w-2 h-2 rounded-full shrink-0 ${isFollowed ? "ring-2 ring-sky-400" : ""}`}
                            style={{ backgroundColor: p.color || "#fff" }}
                          />
                          <span className={`truncate font-medium ${p.isDead ? "line-through" : "text-white"}`}>
                            {p.name}
                          </span>
                          {p.isGroggy && !p.isDead && <span className="text-[10px] text-red-400 font-bold shrink-0">기절</span>}
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
                      <HealthBar player={p} />
                    </div>
                  );
                })}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
};
