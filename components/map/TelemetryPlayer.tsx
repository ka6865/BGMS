import React, { useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import { InlineIconLabel } from "@/components/common/InlineIconLabel";
import { TelemetryEvent } from "../../hooks/useTelemetry";
import { SQUAD_COLORS } from "../../lib/replay/squadColors";
import { buildReplayShareUrl, isActivationTarget, isTypingTarget, replayKeyAction } from "../../lib/replay/replayShortcuts";

interface TelemetryPlayerProps {
  events: TelemetryEvent[];
  teamNames: string[];
  isPlaying: boolean;
  setIsPlaying: (val: boolean) => void;
  playbackSpeed: number;
  setPlaybackSpeed: (val: number) => void;
  currentTimeMs: number;
  setCurrentTimeMs: (val: number) => void;
  maxTimeMs: number;
  loading: boolean;
  error: string | null;
  showZone: boolean;
  onToggleZone: () => void;
  showCombatDots: boolean;
  onToggleCombatDots: () => void;
  showShotDots: boolean;
  onToggleShotDots: () => void;
  hiddenPlayers: string[];
  onTogglePlayer: (name: string) => void;
  showPlayerNames: boolean;
  onTogglePlayerNames: () => void;
  showFlightPath: boolean;
  onToggleFlightPath: () => void;
  showVision: boolean;
  onToggleVision: () => void;
  autoZoom: boolean;
  onToggleAutoZoom: () => void;
  followPlayer: string | null;
  onFollowPlayerChange: (name: string | null) => void;
  nextFightMs: number | null;
  onNextFight: () => void;
  onClose: () => void;
}

export default function TelemetryPlayer({
  events,
  teamNames,
  isPlaying,
  setIsPlaying,
  playbackSpeed,
  setPlaybackSpeed,
  currentTimeMs,
  setCurrentTimeMs,
  maxTimeMs,
  loading,
  error,
  showZone,
  onToggleZone,
  showCombatDots,
  onToggleCombatDots,
  showShotDots,
  onToggleShotDots,
  hiddenPlayers,
  onTogglePlayer,
  showPlayerNames,
  onTogglePlayerNames,
  showFlightPath,
  onToggleFlightPath,
  showVision,
  onToggleVision,
  autoZoom,
  onToggleAutoZoom,
  followPlayer,
  onFollowPlayerChange,
  nextFightMs,
  onNextFight,
  onClose,
}: TelemetryPlayerProps) {
  // 타임라인 마커 필터 상태 (기본값: 킬만 활성화)
  const [showKills, setShowKills] = useState(true);
  const [showGroggy, setShowGroggy] = useState(true);
  const [showTeamDown, setShowTeamDown] = useState(true);
  const [showOnlyTeam, setShowOnlyTeam] = useState(true); // 아군 이벤트만 보기 추가 (Timeline 전용)
  const [isMinimized, setIsMinimized] = useState(false); // 패널 숨기기 상태
  // 선수·필터·레이어 설정은 접어 두고 재생 줄만 보여 지도를 가리지 않는다.
  const [isExpanded, setIsExpanded] = useState(false);

  // 경과 시간 포맷팅 (mm:ss)
  const formatTime = (ms: number) => {
    const totalSec = Math.floor(ms / 1000);
    const m = Math.floor(totalSec / 60);
    const s = totalSec % 60;
    return `${m.toString().padStart(2, "0")}:${s.toString().padStart(2, "0")}`;
  };

  const progressPercent = maxTimeMs > 0 ? (currentTimeMs / maxTimeMs) * 100 : 0;

  // 키보드 조작은 최신 재생 상태를 ref로 읽어 리스너를 한 번만 등록한다.
  const keyStateRef = useRef({ isPlaying, currentTimeMs, maxTimeMs, setIsPlaying, setCurrentTimeMs });
  useEffect(() => {
    keyStateRef.current = { isPlaying, currentTimeMs, maxTimeMs, setIsPlaying, setCurrentTimeMs };
  });
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.metaKey || event.ctrlKey || event.altKey || isTypingTarget(event.target)) return;
      const action = replayKeyAction(event.key, event.shiftKey);
      if (!action || (action.kind === "toggle" && isActivationTarget(event.target))) return;
      event.preventDefault();
      const state = keyStateRef.current;
      if (action.kind === "toggle") {
        if (!state.isPlaying && state.currentTimeMs >= state.maxTimeMs && state.maxTimeMs > 0) state.setCurrentTimeMs(0);
        state.setIsPlaying(!state.isPlaying);
        return;
      }
      state.setCurrentTimeMs(Math.min(state.maxTimeMs, Math.max(0, state.currentTimeMs + action.deltaMs)));
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, []);

  const copyMomentLink = async () => {
    const url = buildReplayShareUrl(window.location.href, currentTimeMs);
    try {
      await navigator.clipboard.writeText(url);
      toast.success(`${formatTime(currentTimeMs)} 장면 링크를 복사했습니다`);
    } catch {
      toast.error("링크를 복사하지 못했습니다");
    }
  };

  if (error) {
    return (
      <div className="absolute bottom-16 left-1/2 transform -translate-x-1/2 bg-[#1a1a1a]/90 backdrop-blur-md text-[#ef4444] px-6 py-4 rounded-xl border border-[#ef4444]/50 shadow-2xl z-[5000] font-bold">
        <div className="flex items-center gap-3">
          <InlineIconLabel icon="error">{error}</InlineIconLabel>
          <button onClick={onClose} className="ml-4 text-xs bg-[#ef4444] text-white px-2 py-1 rounded">닫기</button>
        </div>
      </div>
    );
  }

  if (loading) {
    return (
      <div className="absolute bottom-16 left-1/2 transform -translate-x-1/2 bg-[#1a1a1a]/90 backdrop-blur-md text-[#F2A900] px-6 py-4 rounded-xl border border-[#F2A900]/50 shadow-2xl z-[5000] font-bold">
        <div className="flex items-center gap-3">
          <svg className="animate-spin h-5 w-5 text-[#F2A900]" xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24">
            <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4"></circle>
            <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"></path>
          </svg>
          텔레메트리 파싱 및 압축 중... (약 10초 소요)
        </div>
      </div>
    );
  }

  if (isMinimized) {
    return (
      <div className="absolute bottom-4 sm:bottom-8 left-1/2 transform -translate-x-1/2 w-max bg-[#1a1a1a]/95 backdrop-blur shadow-2xl rounded-full border border-[#444] z-[5000] flex items-center justify-between text-white font-sans px-4 py-2 gap-6">
        <div className="flex items-center gap-3">
          <button 
            onClick={() => {
              if (!isPlaying && currentTimeMs >= maxTimeMs && maxTimeMs > 0) {
                setCurrentTimeMs(0);
              }
              setIsPlaying(!isPlaying);
            }}
            className="w-8 h-8 flex items-center justify-center bg-[#F2A900] rounded-full text-black hover:bg-yellow-400 active:scale-95 transition-all"
          >
            {isPlaying ? (
              <svg viewBox="0 0 24 24" width="16" height="16" fill="currentColor"><path d="M6 19h4V5H6v14zm8-14v14h4V5h-4z"/></svg>
            ) : (
              <svg viewBox="0 0 24 24" width="16" height="16" fill="currentColor" style={{ marginLeft: "2px" }}><path d="M8 5v14l11-7z"/></svg>
            )}
          </button>
          <div className="font-mono text-sm tracking-widest font-bold">
            <span className="text-[#F2A900]">{formatTime(currentTimeMs)}</span>
            <span className="text-[#666] mx-1">/</span>
            <span className="text-[#aaa]">{formatTime(maxTimeMs)}</span>
          </div>
        </div>
        <div className="flex items-center gap-2">
          <button 
            onClick={() => setIsMinimized(false)}
            className="text-[11px] bg-[#333] hover:bg-[#444] px-3 py-1.5 rounded-full font-bold text-gray-300 transition-colors"
          >
            <InlineIconLabel icon="chevronUp" iconSize={11}>펼치기</InlineIconLabel>
          </button>
          <button 
            onClick={onClose}
            className="text-[11px] bg-[#ef4444]/20 text-red-500 hover:bg-[#ef4444] hover:text-white px-3 py-1.5 rounded-full font-bold transition-colors"
          >
            닫기
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="absolute bottom-4 sm:bottom-8 left-1/2 transform -translate-x-1/2 w-[95%] sm:w-[560px] bg-[#1a1a1a]/95 backdrop-blur shadow-2xl rounded-2xl border border-[#333] z-[5000] flex flex-col overflow-hidden text-white font-sans">
      
      {/* 타임라인 슬라이더 영역 */}
      <div className="relative w-full h-6 sm:h-8 bg-[#111] cursor-pointer group" onClick={(e) => {
        const rect = e.currentTarget.getBoundingClientRect();
        const clickX = e.clientX - rect.left;
        const newTime = (clickX / rect.width) * maxTimeMs;
        setCurrentTimeMs(newTime);
      }}>
        <div 
          className="absolute top-0 left-0 h-full bg-[#F2A900] opacity-80" 
          style={{ width: `${progressPercent}%` }}
        />
        
        {/* 교전 마커 (킬, 기절 이벤트) - 타임라인 배경 위에 작은 점으로 그림 */}
        {events.length > 0 && events.filter((e: any) => {
          // 1차 필터: 아군 전용 보기일 때
          if (showOnlyTeam && !(e.isTeamAttacker || e.isTeamVictim)) return false;

          // 2차 필터: 이벤트 종류별
          if (showKills && e.type === "kill") return true;
          if (showGroggy && e.type === "groggy") return true;
          // 아군 기절 (took_damage 중 기절 로그)
          if (showTeamDown && e.type === "took_damage" && e.detail === "LogPlayerMakeGroggy") return true;
          return false;
        }).map((ev: any, i) => {
          // relativeTimeMs 기반으로 비율 계산
          const relMs = (ev as any).relativeTimeMs ?? 0;
          const ratio = maxTimeMs > 0 ? relMs / maxTimeMs : 0;
          if (ratio < 0 || ratio > 1) return null;
          
          let markerColor = "#ef4444"; 
          const isTeamDown = ev.type === "took_damage";

          if (isTeamDown) {
            markerColor = "#a855f7"; //  아군 기절 전용 보라색 (사용자 요청)
          } else if (ev.attacker) {
            const idx = teamNames.indexOf(ev.attacker);
            if (idx !== -1) {
              markerColor = SQUAD_COLORS[idx % SQUAD_COLORS.length];
            }
          }

          return (
            <div 
              key={`event-${i}-${relMs}`}
              className="absolute top-1/2 -translate-y-1/2 w-[3px] h-3 rounded-sm pointer-events-none transition-all duration-300 pointer-events-auto hover:w-2 hover:h-4 hover:z-[6000] cursor-help"
              style={{ 
                left: `${ratio * 100}%`, 
                backgroundColor: markerColor,
                boxShadow: isTeamDown ? "0 0 4px #a855f7" : "none",
                zIndex: isTeamDown ? 100 : 1
              }}
              onClick={(e) => {
                e.stopPropagation();
                setCurrentTimeMs(relMs);
              }}
              title={`${ev.attacker || "환경"} -> ${ev.victim || "대상"} (${ev.type === 'kill' ? '킬' : '다운'})`}
            />
          );
        })}
      </div>

      {/* 재생 줄: 항상 보이는 핵심 컨트롤 */}
      <div className="px-3 py-2 flex flex-wrap items-center gap-x-3 gap-y-2">
        <div className="flex items-center gap-3">
          <button
            onClick={() => setIsPlaying(!isPlaying)}
            aria-label={isPlaying ? "일시정지" : "재생"}
            className="w-9 h-9 flex items-center justify-center bg-[#F2A900] rounded-full text-black hover:bg-yellow-400 hover:scale-105 active:scale-95 transition-all"
          >
            {isPlaying ? (
              <svg viewBox="0 0 24 24" width="18" height="18" fill="currentColor"><path d="M6 19h4V5H6v14zm8-14v14h4V5h-4z"/></svg>
            ) : (
              <svg viewBox="0 0 24 24" width="18" height="18" fill="currentColor" style={{ marginLeft: "3px" }}><path d="M8 5v14l11-7z"/></svg>
            )}
          </button>
          <div className="font-mono text-sm tracking-widest font-bold whitespace-nowrap">
            <span className="text-[#F2A900]">{formatTime(currentTimeMs)}</span>
            <span className="text-[#666] mx-1">/</span>
            <span className="text-[#aaa]">{formatTime(maxTimeMs)}</span>
          </div>
        </div>

        <div className="ml-auto flex items-center gap-1.5">
          <button
            onClick={onNextFight}
            disabled={nextFightMs === null}
            title={nextFightMs === null ? "이후 아군 교전이 없습니다" : `${formatTime(nextFightMs)}부터 다음 아군 교전 재생`}
            className="flex items-center gap-1 h-8 px-2 rounded border text-[11px] font-bold whitespace-nowrap transition-colors border-[#F2A900]/60 text-[#F2A900] hover:bg-[#F2A900]/15 disabled:border-[#444] disabled:text-[#555] disabled:hover:bg-transparent"
          >
            <InlineIconLabel icon="battle" iconSize={11}>다음 교전</InlineIconLabel>
          </button>

          <button
            type="button"
            onClick={copyMomentLink}
            aria-label="이 장면 링크 복사"
            title="지금 시각부터 재생되는 링크를 복사합니다"
            className="hidden sm:flex items-center h-8 px-2 rounded border border-[#444] text-[11px] font-bold text-gray-300 hover:text-white whitespace-nowrap"
          >
            링크
          </button>

          {teamNames.length > 0 && (
            <select
              aria-label="따라갈 선수"
              value={followPlayer ?? ""}
              onChange={(e) => onFollowPlayerChange(e.target.value || null)}
              className="h-8 max-w-[7.5rem] bg-[#222] text-xs font-bold border border-[#444] rounded px-1.5 outline-none text-white"
            >
              <option value="">따라가기 끔</option>
              {teamNames.map((name) => (
                <option key={name} value={name}>{name}</option>
              ))}
            </select>
          )}

          <select
            id="replay-speed-select"
            name="playback_speed"
            aria-label="재생 배속"
            value={playbackSpeed}
            onChange={(e) => setPlaybackSpeed(Number(e.target.value))}
            className="h-8 bg-[#222] text-[#F2A900] text-xs font-bold border border-[#444] rounded px-1.5 outline-none"
          >
            <option value={1}>1x</option>
            <option value={5}>5x</option>
            <option value={10}>10x</option>
            <option value={30}>30x</option>
            <option value={60}>60x</option>
          </select>

          <button
            onClick={() => setIsExpanded(!isExpanded)}
            aria-expanded={isExpanded}
            aria-label="리플레이 설정"
            title="선수·필터·레이어 설정"
            className={`w-8 h-8 flex items-center justify-center rounded border transition-colors ${isExpanded ? "border-[#ddd] text-white bg-white/10" : "border-[#444] text-gray-400 hover:text-white"}`}
          >
            <svg viewBox="0 0 24 24" width="15" height="15" fill="currentColor"><path d="M3 17v2h6v-2H3zM3 5v2h10V5H3zm10 16v-2h8v-2h-8v-2h-2v6h2zM7 9v2H3v2h4v2h2V9H7zm14 4v-2H11v2h10zm-6-4h2V7h4V5h-4V3h-2v6z"/></svg>
          </button>

          <button
            onClick={onClose}
            aria-label="재생 종료"
            title="재생 종료"
            className="w-8 h-8 flex items-center justify-center rounded bg-red-500/20 text-red-400 hover:bg-red-500 hover:text-white transition-colors"
          >
            <svg viewBox="0 0 24 24" width="14" height="14" fill="currentColor"><path d="M19 6.41L17.59 5 12 10.59 6.41 5 5 6.41 10.59 12 5 17.59 6.41 19 12 13.41 17.59 19 19 17.59 13.41 12 19 6.41z"/></svg>
          </button>
        </div>
      </div>

      {isExpanded && (
        <div className="border-t border-[#333]">
          {/* 좁은 화면은 재생 줄 대신 설정 안에서 장면 링크를 복사한다. */}
          <div className="sm:hidden px-4 py-2 bg-[#161616] border-b border-[#333]">
            <button
              type="button"
              onClick={copyMomentLink}
              aria-label="이 장면 링크 복사"
              className="h-8 px-3 rounded border border-[#444] text-[11px] font-bold text-gray-300"
            >
              {formatTime(currentTimeMs)} 장면 링크 복사
            </button>
          </div>
          {/* 지도 표시 범례 */}
          <ul aria-label="지도 표시 범례" className="px-4 py-1.5 flex flex-wrap items-center gap-x-3 gap-y-1 bg-[#161616] border-b border-[#333] text-[10px] text-gray-400">
            <li className="flex items-center gap-1">
              {SQUAD_COLORS.map((color) => <span key={color} className="w-2 h-2 rounded-full" style={{ backgroundColor: color }} />)}
              <span className="ml-0.5">아군(선수 칩 색)</span>
            </li>
            <li className="flex items-center gap-1">
              <span className="w-3.5 h-3.5 rounded-full bg-[#06b6d4] text-[8px] leading-[14px] text-center font-bold text-white">7</span>
              적 · 숫자는 팀 번호
            </li>
            <li className="flex items-center gap-1"><span className="w-2.5 h-2.5 rounded-full bg-[#ff0000] ring-2 ring-[#ff0000]/40" />기절</li>
            <li className="flex items-center gap-1"><span className="w-2.5 h-2.5 rounded-full border-2 border-[#38bdf8]" />따라가는 선수</li>
            <li className="flex items-center gap-1"><span className="w-3 h-2 rounded-sm bg-[#282828] border border-white" />차량</li>
            <li className="flex items-center gap-1" title="착탄 지점은 텔레메트리에 없어 던진 사람 위치에 표시합니다">
              <span className="w-2.5 h-2.5 rounded-full bg-[#cbd5e1] ring-2 ring-[#cbd5e1]/40" />투척(던진 위치)
            </li>
            <li className="flex items-center gap-1" title="폭발 지점이 아니라 피해를 받은 사람 위치입니다">
              <span className="w-2.5 h-2.5 rounded-full bg-[#f97316]/50 border border-[#f97316]" />폭발 피해 위치
            </li>
            <li className="flex items-center gap-1"><span className="w-3 h-0.5 bg-[#ff5050]" />명중</li>
            <li className="flex items-center gap-1"><span className="w-2.5 h-2.5 bg-[#ef4444] border border-white" />보급 상자</li>
            {showVision && followPlayer && (
              <li className="flex items-center gap-1"><span className="w-2.5 h-2.5 rounded-full bg-[#06b6d4] opacity-25" />흐린 적 · 인지 범위 밖(추정)</li>
            )}
            <li className="text-gray-500">단축키 · 스페이스 재생/정지 · ←→ 5초 · Shift+←→ 30초</li>
          </ul>
      {/* 플레이어 컴러 레전드 + 개별 토글 바 */}
      {teamNames.length > 0 && (
        <div className="px-4 py-1.5 flex items-center gap-2 bg-[#1e1e1e] border-b border-[#333] flex-wrap">
          <span className="text-[10px] font-bold text-gray-500 shrink-0">선수</span>
          {teamNames.map((name, ni) => {
            const color = SQUAD_COLORS[ni % SQUAD_COLORS.length];
            const isHidden = hiddenPlayers.includes(name);
            return (
              <button
                key={name}
                onClick={() => onTogglePlayer(name)}
                title={isHidden ? `${name} 표시` : `${name} 숨기기`}
                className="flex items-center gap-1 text-[10px] font-bold px-2 py-0.5 rounded-full border transition-all whitespace-nowrap"
                style={{
                  backgroundColor: isHidden ? "rgba(40,40,40,0.8)" : `${color}28`,
                  borderColor: isHidden ? "#444" : color,
                  color: isHidden ? "#555" : color,
                  textDecoration: isHidden ? "line-through" : "none",
                }}
              >
                <span style={{
                  display: "inline-block",
                  width: 7,
                  height: 7,
                  borderRadius: "50%",
                  background: isHidden ? "#555" : color,
                  flexShrink: 0,
                }} />
                {name}
              </button>
            );
          })}
        </div>
      )}

      {/* 타임라인 필터 컨트롤 바 */}
      <div className="px-4 py-1 flex flex-wrap items-center gap-x-4 gap-y-1 bg-[#252525] border-b border-[#333]">
        <span className="text-[10px] font-bold text-gray-500">타임라인</span>
        <div className="flex gap-2">
          <button 
            onClick={() => setShowKills(!showKills)}
            className={`text-[9px] font-bold px-1.5 py-0.5 rounded transition-all ${showKills ? 'bg-red-500 text-white' : 'bg-[#333] text-gray-500'}`}
          >
            <InlineIconLabel icon="skull" iconSize={10}>처치</InlineIconLabel>
          </button>
          <button 
            onClick={() => setShowGroggy(!showGroggy)}
            className={`text-[9px] font-bold px-1.5 py-0.5 rounded transition-all ${showGroggy ? 'bg-orange-500 text-white' : 'bg-[#333] text-gray-500'}`}
          >
            <InlineIconLabel icon="battle" iconSize={10}>기절</InlineIconLabel>
          </button>
          <button 
            onClick={() => setShowTeamDown(!showTeamDown)}
            className={`text-[9px] font-bold px-1.5 py-0.5 rounded transition-all ${showTeamDown ? 'bg-[#a855f7] text-white' : 'bg-[#333] text-gray-500'}`}
          >
            <InlineIconLabel icon="alert" iconSize={10}>아군 기절</InlineIconLabel>
          </button>
        </div>
        <div className="h-3 w-px bg-white/10 mx-1" />
        <button 
          onClick={() => setShowOnlyTeam(!showOnlyTeam)}
          className={`text-[9px] font-bold px-1.5 py-0.5 rounded transition-all border ${showOnlyTeam ? 'bg-blue-600 text-white border-blue-400' : 'bg-[#333] text-gray-500 border-transparent hover:border-gray-500'}`}
        >
          <InlineIconLabel icon={showOnlyTeam ? "team" : "activity"} iconSize={10}>
            {showOnlyTeam ? "아군 사건만" : "전체 사건"}
          </InlineIconLabel>
        </button>
      </div>

      <div className="px-3 py-2">
        <div className="flex items-center gap-2 flex-wrap">
          {/* 자기장 토글 */}
          <button
            onClick={onToggleZone}
            title={showZone ? "자기장 숨기기" : "자기장 표시"}
            className="flex items-center gap-1 text-[10px] font-bold px-2 py-1 rounded border transition-all whitespace-nowrap"
            style={{
              backgroundColor: showZone ? "rgba(59,130,246,0.2)" : "rgba(40,40,40,0.8)",
              borderColor: showZone ? "#3b82f6" : "#444",
              color: showZone ? "#60a5fa" : "#666",
            }}
          >
            <InlineIconLabel icon="shield" iconSize={11}>자기장</InlineIconLabel>
          </button>

          {/* 교전 흔적 토글 */}
          <button
            onClick={onToggleCombatDots}
            title="교전 흔적 점 표시/숨기기"
            className="flex items-center gap-1 text-[10px] font-bold px-2 py-1 rounded border transition-all whitespace-nowrap"
            style={{
              backgroundColor: showCombatDots ? "rgba(120,120,120,0.3)" : "rgba(40,40,40,0.8)",
              borderColor: showCombatDots ? "#999" : "#444",
              color: showCombatDots ? "#ddd" : "#666",
            }}
          >
            <InlineIconLabel icon="battle" iconSize={11}>교전점</InlineIconLabel>
          </button>

          {/* 발사 이펙트 토글 */}
          <button
            onClick={onToggleShotDots}
            title="아군 발사 이펙트 표시/숨기기"
            className="flex items-center gap-1 text-[10px] font-bold px-2 py-1 rounded border transition-all whitespace-nowrap"
            style={{
              backgroundColor: showShotDots ? "rgba(242,169,0,0.2)" : "rgba(40,40,40,0.8)",
              borderColor: showShotDots ? "#F2A900" : "#444",
              color: showShotDots ? "#F2A900" : "#666",
            }}
          >
            <InlineIconLabel icon="weapon" iconSize={11}>발사점</InlineIconLabel>
          </button>

          {/* 이름 표시 토글 */}
          <button
            onClick={onTogglePlayerNames}
            title={showPlayerNames ? "아군·따라가는 선수·최근 교전 상대만 이름 표시" : "모든 선수 이름 표시"}
            className="flex items-center gap-1 text-[10px] font-bold px-2 py-1 rounded border transition-all whitespace-nowrap"
            style={{
              backgroundColor: showPlayerNames ? "rgba(255,255,255,0.1)" : "rgba(40,40,40,0.8)",
              borderColor: showPlayerNames ? "#ddd" : "#444",
              color: showPlayerNames ? "#fff" : "#666",
            }}
          >
            <InlineIconLabel icon="eye" iconSize={11}>이름 {showPlayerNames ? "전체" : "자동"}</InlineIconLabel>
          </button>

          {/* 비행기 경로 토글 */}
          <button
            onClick={onToggleFlightPath}
            title={showFlightPath ? "비행기 경로 숨기기" : "비행기 경로 표시"}
            className="flex items-center gap-1 text-[10px] font-bold px-2 py-1 rounded border transition-all whitespace-nowrap"
            style={{
              backgroundColor: showFlightPath ? "rgba(255,255,255,0.1)" : "rgba(40,40,40,0.8)",
              borderColor: showFlightPath ? "#ddd" : "#444",
              color: showFlightPath ? "#fff" : "#666",
            }}
          >
            <InlineIconLabel icon="plane" iconSize={11}>비행경로 {showFlightPath ? "ON" : "OFF"}</InlineIconLabel>
          </button>

          {/* 따라가기 전용: 인지 범위(추정)와 이동 속도 자동 줌 */}
          {[
            { key: "vision", on: showVision, onClick: onToggleVision, label: `인지 범위 ${showVision ? "ON" : "OFF"}`,
              title: "따라가는 선수에게서 150m 밖이고 최근 교전도 없는 적을 흐리게 표시합니다. 시야 정보가 없어 거리로 추정합니다." },
            { key: "zoom", on: autoZoom, onClick: onToggleAutoZoom, label: `자동 줌 ${autoZoom ? "ON" : "OFF"}`,
              title: "따라가는 선수가 멈추면 가깝게, 차량으로 달리면 멀리 보도록 줌을 맞춥니다. 직접 확대·축소하면 꺼집니다." },
          ].map((item) => (
            <button
              key={item.key}
              type="button"
              onClick={item.onClick}
              disabled={!followPlayer}
              aria-pressed={item.on}
              title={followPlayer ? item.title : "따라갈 선수를 고르면 쓸 수 있습니다"}
              className="flex items-center gap-1 text-[10px] font-bold px-2 py-1 rounded border transition-all whitespace-nowrap disabled:opacity-40"
              style={{
                backgroundColor: item.on && followPlayer ? "rgba(56,189,248,0.15)" : "rgba(40,40,40,0.8)",
                borderColor: item.on && followPlayer ? "#38bdf8" : "#444",
                color: item.on && followPlayer ? "#e0f2fe" : "#666",
              }}
            >
              {item.label}
            </button>
          ))}


          <button 
            onClick={() => setIsMinimized(true)}
            title="타임라인 리모컨 숨기기"
            className="flex items-center gap-1.5 px-2.5 h-8 rounded bg-[#333] hover:bg-[#444] transition-colors text-xs font-bold text-gray-300"
          >
            <InlineIconLabel icon="chevronDown" iconSize={12}>패널 숨기기</InlineIconLabel>
          </button>

        </div>
      </div>
        </div>
      )}
    </div>
  );
}
