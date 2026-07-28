import React, { useState } from "react";
import { InlineIconLabel } from "@/components/common/InlineIconLabel";
import { TelemetryEvent } from "../../hooks/useTelemetry";

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
  onClose,
}: TelemetryPlayerProps) {
  // 타임라인 마커 필터 상태 (기본값: 킬만 활성화)
  const [showKills, setShowKills] = useState(true);
  const [showGroggy, setShowGroggy] = useState(true);
  const [showTeamDown, setShowTeamDown] = useState(true);
  const [showOnlyTeam, setShowOnlyTeam] = useState(true); // 아군 이벤트만 보기 추가 (Timeline 전용)
  const [isMinimized, setIsMinimized] = useState(false); // 패널 숨기기 상태

  // 경과 시간 포맷팅 (mm:ss)
  const formatTime = (ms: number) => {
    const totalSec = Math.floor(ms / 1000);
    const m = Math.floor(totalSec / 60);
    const s = totalSec % 60;
    return `${m.toString().padStart(2, "0")}:${s.toString().padStart(2, "0")}`;
  };

  const progressPercent = maxTimeMs > 0 ? (currentTimeMs / maxTimeMs) * 100 : 0;

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
    <div className="absolute bottom-4 sm:bottom-8 left-1/2 transform -translate-x-1/2 w-[95%] sm:w-[500px] bg-[#1a1a1a]/95 backdrop-blur shadow-2xl rounded-2xl border border-[#333] z-[5000] flex flex-col overflow-hidden text-white font-sans">
      
      {/* 타임라인 슬라이더 영역 */}
      <div className="relative w-full h-8 bg-[#111] cursor-pointer group" onClick={(e) => {
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
            markerColor = "#a855f7"; // 🟣 아군 기절 전용 보라색 (사용자 요청)
          } else if (ev.attacker) {
            const idx = teamNames.indexOf(ev.attacker);
            if (idx !== -1) {
              const teamColors = ["#F2A900", "#34A853", "#3b82f6", "#ef4444"];
              markerColor = teamColors[idx % teamColors.length];
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

      {/* 플레이어 컴러 레전드 + 개별 토글 바 */}
      {teamNames.length > 0 && (
        <div className="px-4 py-1.5 flex items-center gap-2 bg-[#1e1e1e] border-b border-[#333] flex-wrap">
          <span className="text-[9px] font-bold text-gray-600 uppercase tracking-tighter shrink-0">Players:</span>
          {teamNames.map((name, ni) => {
            const COLORS = ["#F2A900", "#34A853", "#3b82f6", "#ef4444"];
            const color = COLORS[ni % COLORS.length];
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
      <div className="px-4 py-1 flex items-center gap-4 bg-[#252525] border-b border-[#333]">
        <span className="text-[10px] font-bold text-gray-500 uppercase tracking-tighter">Timeline Filters:</span>
        <div className="flex gap-2">
          <button 
            onClick={() => setShowKills(!showKills)}
            className={`text-[9px] font-bold px-1.5 py-0.5 rounded transition-all ${showKills ? 'bg-red-500 text-white' : 'bg-[#333] text-gray-500'}`}
          >
            <InlineIconLabel icon="skull" iconSize={10}>Kills</InlineIconLabel>
          </button>
          <button 
            onClick={() => setShowGroggy(!showGroggy)}
            className={`text-[9px] font-bold px-1.5 py-0.5 rounded transition-all ${showGroggy ? 'bg-orange-500 text-white' : 'bg-[#333] text-gray-500'}`}
          >
            <InlineIconLabel icon="battle" iconSize={10}>Knock</InlineIconLabel>
          </button>
          <button 
            onClick={() => setShowTeamDown(!showTeamDown)}
            className={`text-[9px] font-bold px-1.5 py-0.5 rounded transition-all ${showTeamDown ? 'bg-[#a855f7] text-white' : 'bg-[#333] text-gray-500'}`}
          >
            <InlineIconLabel icon="alert" iconSize={10}>Team Down</InlineIconLabel>
          </button>
        </div>
        <div className="h-3 w-px bg-white/10 mx-1" />
        <button 
          onClick={() => setShowOnlyTeam(!showOnlyTeam)}
          className={`text-[9px] font-bold px-1.5 py-0.5 rounded transition-all border ${showOnlyTeam ? 'bg-blue-600 text-white border-blue-400' : 'bg-[#333] text-gray-500 border-transparent hover:border-gray-500'}`}
        >
          <InlineIconLabel icon={showOnlyTeam ? "team" : "activity"} iconSize={10}>
            {showOnlyTeam ? "TEAM ONLY" : "ALL EVENTS"}
          </InlineIconLabel>
        </button>
      </div>

      <div className="px-4 py-3 flex items-center justify-between">
        <div className="flex items-center gap-4">
          <button 
            onClick={() => setIsPlaying(!isPlaying)}
            className="w-10 h-10 flex items-center justify-center bg-[#F2A900] rounded-full text-black hover:bg-yellow-400 hover:scale-105 active:scale-95 transition-all"
          >
            {isPlaying ? (
              <svg viewBox="0 0 24 24" width="20" height="20" fill="currentColor"><path d="M6 19h4V5H6v14zm8-14v14h4V5h-4z"/></svg>
            ) : (
              <svg viewBox="0 0 24 24" width="20" height="20" fill="currentColor" style={{ marginLeft: "4px" }}><path d="M8 5v14l11-7z"/></svg>
            )}
          </button>
          
          <div className="font-mono text-sm tracking-widest font-bold">
            <span className="text-[#F2A900]">{formatTime(currentTimeMs)}</span>
            <span className="text-[#666] mx-1">/</span>
            <span className="text-[#aaa]">{formatTime(maxTimeMs)}</span>
          </div>
        </div>

        <div className="flex items-center gap-2 flex-wrap justify-end">
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
            title={showPlayerNames ? "이름 숨기기" : "이름 표시"}
            className="flex items-center gap-1 text-[10px] font-bold px-2 py-1 rounded border transition-all whitespace-nowrap"
            style={{
              backgroundColor: showPlayerNames ? "rgba(255,255,255,0.1)" : "rgba(40,40,40,0.8)",
              borderColor: showPlayerNames ? "#ddd" : "#444",
              color: showPlayerNames ? "#fff" : "#666",
            }}
          >
            <InlineIconLabel icon="eye" iconSize={11}>이름 {showPlayerNames ? "ON" : "OFF"}</InlineIconLabel>
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

          {/* 이동 경로 토글 기능 제거됨 */}

          <select
            id="replay-speed-select"
            name="playback_speed"
            value={playbackSpeed}
            onChange={(e) => setPlaybackSpeed(Number(e.target.value))}
            className="bg-[#222] text-[#F2A900] text-xs font-bold border border-[#444] rounded px-2 py-1 outline-none"
          >
            <option value={1}>1x 재생</option>
            <option value={5}>5x 배속</option>
            <option value={10}>10x 배속</option>
            <option value={30}>30x 배속</option>
            <option value={60}>60x 배속</option>
          </select>
          
          <button 
            onClick={() => setIsMinimized(true)}
            title="타임라인 리모컨 숨기기"
            className="flex items-center gap-1.5 px-2.5 h-8 rounded bg-[#333] hover:bg-[#444] transition-colors text-xs font-bold text-gray-300"
          >
            <InlineIconLabel icon="chevronDown" iconSize={12}>숨기기</InlineIconLabel>
          </button>

          <button 
            onClick={onClose}
            title="재생 종료"
            className="flex items-center gap-1 px-2.5 h-8 rounded bg-red-500/20 text-red-400 hover:bg-red-500 hover:text-white transition-colors text-[11px] font-bold"
          >
            <svg viewBox="0 0 24 24" width="14" height="14" fill="currentColor"><path d="M19 6.41L17.59 5 12 10.59 6.41 5 5 6.41 10.59 12 5 17.59 6.41 19 12 13.41 17.59 19 19 17.59 13.41 12 19 6.41z"/></svg>
            닫기
          </button>
        </div>
      </div>
    </div>
  );
}
