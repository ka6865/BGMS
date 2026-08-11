"use client";

import React from "react";
import {
  Zap,
  Trophy,
  Crosshair,
  ArrowRight,
  Clock,
} from "lucide-react";
import { TimelineEvent } from "../../lib/pubg-analysis/types";
import { normalizeName } from "../../lib/pubg-analysis/utils";

interface MatchTimelineProps {
  events: TimelineEvent[];
  nickname: string;
  onEventClick?: (event: any) => void;
}

const formatTime = (ms: number) => {
  const totalSeconds = Math.floor(ms / 1000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${minutes}:${seconds.toString().padStart(2, "0")}`;
};

const getEventLabel = (type: TimelineEvent['type']) => {
  switch (type) {
    case 'KILL': return { text: "킬 달성", color: "bg-red-500", textColor: "text-white" };
    case 'KNOCK': return { text: "적 기절", color: "bg-orange-500", textColor: "text-white" };
    case 'FINISH': return { text: "확킬", color: "bg-indigo-500", textColor: "text-white" };
    case 'REVIVE': return { text: "아군 부활", color: "bg-emerald-500", textColor: "text-white" };
    case 'DIED': return { text: "최종 사망", color: "bg-gray-700", textColor: "text-gray-200" };
    case 'DOWNED': return { text: "나 기절", color: "bg-amber-600", textColor: "text-white" };
    case 'TEAM_KNOCK': return { text: "팀원 기절", color: "bg-orange-500/10 border border-orange-500/30", textColor: "text-orange-400" };
    case 'TEAM_KILL': return { text: "팀원 킬", color: "bg-orange-600/10 border border-orange-600/30", textColor: "text-orange-300" };
    case 'TEAM_REVIVE': return { text: "팀원 부활", color: "bg-emerald-500/10 border border-emerald-500/30", textColor: "text-emerald-400" };
    case 'TEAM_DIED': return { text: "팀원 사망", color: "bg-rose-500/10 border border-rose-500/30", textColor: "text-rose-400" };
    case 'ITEM_USE': return { text: "아이템 사용", color: "bg-blue-600/20 border border-blue-500/30", textColor: "text-blue-300" };
    case 'RECALL': return { text: "블루칩 부활", color: "bg-indigo-600", textColor: "text-white" };
    case 'TEAM_RECALL': return { text: "팀원 부활", color: "bg-indigo-600/10 border border-indigo-500/30", textColor: "text-indigo-400" };
    case 'REDEPLOY': return { text: "복귀전 투입", color: "bg-cyan-600", textColor: "text-white" };
    case 'VICTORY': return { text: "승리", color: "bg-yellow-500", textColor: "text-black" };
    default: return { text: "기타", color: "bg-gray-500", textColor: "text-white" };
  }
};

export const MatchTimeline = ({ events, nickname, onEventClick }: MatchTimelineProps) => {
  const lowerNickname = nickname.toLowerCase().trim();

  // 회복/부스트 아이템 제외 및 빈 이름 유령 로그 필터링
  const filteredEvents = events.filter(e => {
    if (e.type === 'ITEM_USE') {
      const w = (e.weapon || "").trim().toLowerCase();
      // 이름이 없으면 필터링
      if (!w) return false;

      // 회복/부스트 키워드 제외
      const healBoostKeywords = [
        "firstaid", "medkit", "bandage", "energydrink", "painkiller", "adrenaline",
        "구급상자", "의료용 키트", "붕대", "에너지 드링크", "진통제", "아드레날린"
      ];
      return !healBoostKeywords.some(k => w.includes(k));
    }
    return true;
  });

  if (!filteredEvents || filteredEvents.length === 0) {
    return (
      <div className="py-12 flex flex-col items-center justify-center border-2 border-dashed border-white/5 rounded-[1.5rem] bg-white/[0.02]">
        <Clock size={40} className="text-white/10 mb-3 animate-pulse" />
        <span className="text-gray-500 font-black text-lg tracking-tight">기록된 주요 교전이 없습니다.</span>
      </div>
    );
  }

  const groups: { phase: number | string, events: TimelineEvent[] }[] = [];
  let currentGroup: { phase: number | string, events: TimelineEvent[] } = { phase: 0, events: [] };

  filteredEvents.forEach(event => {
    if (event.type === 'PHASE_START') {
      // 이전 그룹에 PHASE_START 외의 실제 이벤트가 있는 경우에만 추가
      if (currentGroup.events.some(e => e.type !== 'PHASE_START')) {
        groups.push(currentGroup);
      }
      currentGroup = { phase: event.phase ?? 'Unknown', events: [event] };
    } else {
      currentGroup.events.push(event);
    }
  });
  // 마지막 그룹도 실제 이벤트가 있는 경우에만 추가
  if (currentGroup.events.some(e => e.type !== 'PHASE_START')) {
    groups.push(currentGroup);
  }

  return (
    <div className="space-y-6 pb-4">
      {groups.map((group, gIdx) => (
        <div key={gIdx} className="relative">
          <div className="sticky top-0 z-20 flex items-center gap-3 py-2 bg-[#0d0e12]/60 backdrop-blur-xl rounded-xl px-3 border border-white/5 shadow-lg shadow-black/30">
            <div className="flex items-center gap-2 px-3 py-1 bg-gradient-to-r from-blue-500/20 to-indigo-500/20 border border-blue-500/30 rounded-full shadow-[0_0_15px_rgba(59,130,246,0.2)]">
              <Zap size={13} className="text-blue-400 animate-pulse" />
              <span className="text-[11px] font-black text-transparent bg-clip-text bg-gradient-to-r from-blue-400 to-indigo-300 uppercase tracking-widest">
                페이즈 {group.phase}
              </span>
            </div>
            <div className="flex-1 h-[2px] bg-gradient-to-r from-blue-500/40 via-blue-500/10 to-transparent" />
          </div>

          <div className="pl-3 border-l-2 border-white/5 ml-2 md:ml-6 mt-3 space-y-2">
            {group.events.map((event, idx) => {
              if (event.type === 'PHASE_START') return null;

              const isMe = event.isMe !== undefined ? event.isMe : (
                (event.attacker?.toLowerCase().trim() === lowerNickname) ||
                (['DIED', 'DOWNED', 'RECALL', 'REDEPLOY'].includes(event.type) && event.victim?.toLowerCase().trim() === lowerNickname) ||
                (event.type === 'VICTORY')
              );
              const labelInfo = getEventLabel(event.type);

              return (
                <div
                  key={idx}
                  onClick={() => {
                    if (event.x !== undefined && event.y !== undefined) {
                      onEventClick?.(event);
                    }
                  }}
                  className={`relative flex items-center gap-3 md:gap-3 group transition-all duration-300
                    ${isMe ? 'scale-[1.02]' : 'opacity-70 hover:opacity-100'}
                    ${event.x !== undefined && event.y !== undefined ? 'cursor-pointer' : ''}
                  `}
                >
                  <div className="absolute -left-[21px] md:-left-[37px] top-1/2 -translate-y-1/2 w-4 h-4 md:w-5 md:h-5 rounded-full bg-black border-2 border-white/10 flex items-center justify-center group-hover:border-blue-500 transition-colors">
                    <div className={`w-1.5 h-1.5 md:w-2 h-2 rounded-full ${isMe ? 'bg-blue-500 shadow-[0_0_8px_rgba(59,130,246,0.8)]' : 'bg-white/20'}`} />
                  </div>

                  <div className="w-8 md:w-16 shrink-0 text-center md:text-left">
                    <span className="text-[10px] md:text-[11px] font-bold text-gray-500 tabular-nums tracking-tighter">
                      {formatTime(event.ts)}
                    </span>
                  </div>

                  <div className={`flex-1 flex items-center gap-2 md:gap-3 p-2 md:p-2.5 rounded-xl border transition-colors overflow-hidden
                    ${isMe ? 'border-white/15 bg-white/[0.05]' : 'border-white/5 bg-white/[0.02]'}
                  `}>
                    <div className={`px-1.5 py-0.5 rounded-md text-[8px] md:text-[10px] font-black shrink-0 ${labelInfo.color} ${labelInfo.textColor} whitespace-nowrap`}>
                      {labelInfo.text}
                    </div>

                    <div className="flex-1 flex items-center justify-between min-w-0">
                      <div className="flex flex-wrap items-center gap-1 md:gap-2 text-[11px] md:text-sm font-bold tracking-tight break-keep">
                        {isMe && (
                          <span className="px-1 py-0.5 rounded-[4px] bg-blue-500/20 text-blue-400 text-[8px] md:text-[9px] font-black mr-0.5 border border-blue-500/30 shrink-0">
                            나
                          </span>
                        )}
                        <div className="truncate">
                          {renderEventText(event, lowerNickname)}
                        </div>
                        {event.isHeadshot && (
                          <span className="text-red-500 flex items-center gap-1">
                            <Crosshair size={12} strokeWidth={3} />
                          </span>
                        )}
                      </div>

                      {event.type === 'VICTORY' && <Trophy size={18} className="text-yellow-400 animate-bounce" />}
                    </div>
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      ))}
    </div>
  );
};

const Nickname = ({ name, isMe, className = "" }: { name: string, isMe?: boolean, className?: string }) => (
  <span className={`truncate max-w-[120px] xs:max-w-[170px] md:max-w-none inline-block align-bottom ${isMe ? 'text-blue-400 font-black' : className}`} title={name}>
    {isMe ? '나' : name}
  </span>
);

const renderEventText = (event: TimelineEvent, lowerNickname: string) => {
  const weaponStr = event.weapon ? `(${event.weapon})` : "";
  const isThrowable = ["수류탄", "연막", "화염병", "섬광", "C4"].some(k => event.weapon?.includes(k));
  const distStr = (!isThrowable && event.distance !== undefined) ? ` [${event.distance}m]` : "";

  const isAttackerMe = normalizeName(event.attacker || "") === lowerNickname;
  const isVictimMe = normalizeName(event.victim || "") === lowerNickname;

  switch (event.type) {
    case 'FINISH':
      return (
        <div className="flex items-center gap-1 min-w-0">
          <Nickname name={event.victim || ""} isMe={isVictimMe} className="text-white" />
          <span className="text-[9px] md:text-[10px] text-gray-500 truncate ml-1 shrink-0">
            (킬 주인: {isAttackerMe ? '나' : event.attacker}{weaponStr})
          </span>
        </div>
      );
    case 'KILL':
      return (
        <div className="flex flex-wrap items-center gap-0.5 md:gap-1 min-w-0">
          <Nickname name="나" isMe={true} />
          <span className="text-[8px] md:text-[10px] text-gray-500 truncate shrink min-w-0 max-w-[20px] xs:max-w-[40px] md:max-w-none opacity-60">{weaponStr}</span>
          <ArrowRight size={10} className="text-gray-600 shrink-0 mx-0.5" />
          <Nickname name={event.victim || ""} isMe={isVictimMe} className="text-white font-black" />
          {distStr && <span className="text-[9px] md:text-[10px] text-blue-400/80 ml-1 shrink-0 font-bold whitespace-nowrap tracking-tighter">{distStr}</span>}
        </div>
      );
    case 'KNOCK':
      return (
        <div className="flex flex-wrap items-center gap-0.5 md:gap-1 min-w-0">
          <Nickname name="나" isMe={true} />
          <span className="text-[8px] md:text-[10px] text-gray-500 truncate shrink min-w-0 max-w-[20px] xs:max-w-[40px] md:max-w-none opacity-60">{weaponStr}</span>
          <ArrowRight size={10} className="text-gray-600 shrink-0 mx-0.5" />
          <Nickname name={event.victim || ""} isMe={isVictimMe} className="text-white" />
          {distStr && <span className="text-[9px] md:text-[10px] text-orange-400/80 ml-1 shrink-0 font-bold whitespace-nowrap tracking-tighter">{distStr}</span>}
        </div>
      );
    case 'TEAM_KILL':
      return (
        <div className="flex flex-wrap items-center gap-0.5 md:gap-1 min-w-0">
          <Nickname name={event.attacker || ""} isMe={isAttackerMe} className="text-orange-300 font-bold" />
          <span className="text-[8px] md:text-[10px] text-gray-500 truncate shrink min-w-0 max-w-[20px] xs:max-w-[40px] md:max-w-none opacity-60">{weaponStr}</span>
          <ArrowRight size={10} className="text-gray-600 shrink-0 mx-0.5" />
          <Nickname name={event.victim || ""} isMe={isVictimMe} className="text-white/90" />
        </div>
      );
    case 'TEAM_KNOCK':
      return (
        <div className="flex flex-wrap items-center gap-0.5 md:gap-1 min-w-0">
          <Nickname name={event.attacker || ""} isMe={isAttackerMe} className="text-orange-400 font-bold" />
          <span className="text-[8px] md:text-[10px] text-gray-500 truncate shrink min-w-0 max-w-[20px] xs:max-w-[40px] md:max-w-none opacity-60">{weaponStr}</span>
          <ArrowRight size={10} className="text-gray-600 shrink-0 mx-0.5" />
          <Nickname name={event.victim || ""} isMe={isVictimMe} className="text-white/80" />
        </div>
      );
    case 'REVIVE':
      if (event.isSelfRevive) {
        return (
          <div className="flex items-center gap-1 min-w-0">
            <Nickname name="나" isMe={true} />
            <ArrowRight size={10} className="text-emerald-400 shrink-0" />
            <Nickname name="나" isMe={true} />
            <span className="text-emerald-400 font-black ml-1 shrink-0">자가 부활</span>
          </div>
        );
      }
      return (
        <div className="flex items-center gap-1 min-w-0">
          <Nickname
            name={event.attacker || "나"}
            isMe={isAttackerMe || !event.attacker}
            className={isAttackerMe || !event.attacker ? "" : "text-emerald-500/80 font-medium"}
          />
          <ArrowRight size={10} className="text-emerald-400 shrink-0" />
          <Nickname name={event.victim || ""} isMe={isVictimMe} className="text-white" />
          <span className="text-emerald-400 font-black ml-1 shrink-0">부활</span>
        </div>
      );
    case 'TEAM_REVIVE':
      return (
        <div className="flex items-center gap-1 min-w-0">
          <Nickname name={event.attacker || ""} isMe={isAttackerMe} className="text-emerald-500/80 font-medium" />
          <ArrowRight size={10} className="text-emerald-500 shrink-0" />
          <Nickname name={event.victim || ""} isMe={isVictimMe} className="text-white" />
          <span className="text-emerald-500/80 ml-1 shrink-0">부활</span>
        </div>
      );
    case 'RECALL':
      return (
        <div className="flex items-center gap-1 min-w-0">
          {event.attacker && (
            <>
              <Nickname name={event.attacker} isMe={isAttackerMe} className="text-white/60 font-medium" />
              <ArrowRight size={10} className="text-indigo-400 shrink-0" />
            </>
          )}
          <Nickname name="나" isMe={true} />
          <span className="text-indigo-400 font-bold ml-1 shrink-0">블루칩 부활</span>
        </div>
      );
    case 'TEAM_RECALL':
      return (
        <div className="flex items-center gap-1 min-w-0">
          {event.attacker && (
            <>
              <Nickname name={event.attacker} isMe={isAttackerMe} className="text-white/60 font-medium" />
              <ArrowRight size={10} className="text-indigo-500 shrink-0" />
            </>
          )}
          <Nickname name={event.victim || ""} isMe={isVictimMe} className="text-white" />
          <span className="text-indigo-500/80 ml-1 shrink-0">블루칩 부활</span>
        </div>
      );
    case 'REDEPLOY':
      return (
        <div className="flex items-center gap-1 min-w-0">
          <Nickname name={event.victim || ""} isMe={isVictimMe} className="text-cyan-400 font-bold" />
          <span className="text-cyan-400 font-bold ml-1 shrink-0">복귀전 투입</span>
        </div>
      );
    case 'TEAM_DIED':
      return (
        <div className="flex items-center gap-1 min-w-0">
          <Nickname name={event.attacker || ""} isMe={isAttackerMe} className="text-rose-400 font-medium" />
          <span className="text-[9px] md:text-[10px] text-gray-500 truncate shrink min-w-0 max-w-[50px] md:max-w-none">{weaponStr}</span>
          <ArrowRight size={10} className="text-gray-600 shrink-0" />
          <Nickname name={event.victim || ""} isMe={isVictimMe} className="text-rose-500 font-bold" />
          <span className="text-rose-500 font-bold ml-1 shrink-0">사망</span>
        </div>
      );
    case 'DOWNED':
      return (
        <div className="flex flex-wrap items-center gap-0.5 md:gap-1 min-w-0">
          <Nickname name={event.attacker || ""} isMe={isAttackerMe} className="text-red-400 font-medium" />
          <span className="text-[8px] md:text-[10px] text-gray-500 truncate shrink min-w-0 max-w-[20px] xs:max-w-[40px] md:max-w-none opacity-60">{weaponStr}</span>
          <ArrowRight size={10} className="text-gray-600 shrink-0 mx-0.5" />
          <Nickname name="나" isMe={true} />
          <span className="text-blue-400 font-black ml-1 shrink-0">기절</span>
          {distStr && <span className="text-[9px] md:text-[10px] text-red-400/80 ml-1 shrink-0 font-bold whitespace-nowrap tracking-tighter">{distStr}</span>}
        </div>
      );
    case 'DIED':
      return (
        <div className="flex items-center gap-1 min-w-0">
          <Nickname name={event.attacker || ""} isMe={isAttackerMe} className="text-red-600 font-black" />
          <span className="text-[9px] md:text-[10px] text-gray-500 truncate shrink min-w-0 max-w-[50px] md:max-w-none">{weaponStr}</span>
          <ArrowRight size={10} className="text-gray-600 shrink-0" />
          <Nickname name="나" isMe={true} />
          <span className="text-blue-600 font-black ml-1 shrink-0">사망</span>
        </div>
      );
    case 'ITEM_USE':
      return (
        <div className="flex items-center gap-1 min-w-0">
          {event.attacker && (
            <Nickname name={event.attacker} isMe={isAttackerMe} className="text-blue-300 font-bold" />
          )}
          <span className="text-blue-300 font-bold truncate">{event.weapon}</span>
        </div>
      );
    case 'VICTORY':
      return (
        <span className="inline-flex items-center gap-1 text-yellow-400 font-black tracking-tighter shrink-0">
          <Trophy className="h-3.5 w-3.5" /> 치킨 달성!
        </span>
      );
    case 'PHASE_START':
      return <span className="text-blue-400/80 shrink-0">페이즈 {event.phase ?? '?'} 시작</span>;
    default:
      return (
        <div className="flex items-center gap-1 min-w-0">
          <span className="text-gray-500 shrink-0">{event.type}:</span>
          <span className="text-gray-500 truncate">{event.victim || event.weapon}</span>
        </div>
      );
  }
};
