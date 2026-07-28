import React, { memo, useState, useEffect } from "react";
import { useSearchParams, useRouter } from "next/navigation";
import L from "leaflet";
import Sidebar from "../Sidebar";
import MobileBottomSheet from "./MobileBottomSheet";
import MapView from "./MapView";
import AdfitBanner from "../ads/AdfitBanner";
import { X, Hammer, Map as MapIcon, Crosshair, AlertCircle, SlidersHorizontal, Menu, Flame, MapPin, Target } from 'lucide-react';
import type { MapTab, MapMarker, AuthUser, PendingVehicle } from "../../types/map";
import { useTelemetry } from "../../hooks/useTelemetry";
import TelemetryPlayer from "./TelemetryPlayer";
import KillFeed from "./KillFeed";
import HomeNotice from "./HomeNotice";
import { TelemetrySidebar } from "./telemetry/TelemetrySidebar";
import { BgmsIcon } from "@/components/common/BgmsIcon";
import { InlineIconLabel } from "@/components/common/InlineIconLabel";
import { SimulatorPanel } from "./SimulatorPanel";
import { HeatmapLegend } from "./HeatmapLegend";
import type { TelemetryMode, TelemetryPlatform } from "../../lib/pubg-analysis/telemetryIdentity";

interface MapShellProps {
  activeMapId: string;
  currentMap: MapTab | undefined;
  bounds: [[number, number], [number, number]];
  visibleVehicles: MapMarker[];
  icons: Record<string, L.DivIcon>;
  imageHeight: number;
  imageWidth: number;
  isMobile: boolean;
  isSidebarOpen: boolean;
  filters: Record<string, boolean>;
  onSetSidebarOpen: (isOpen: boolean) => void;
  onToggleFilter: (id: string) => void;
  onGetCount: (id: string) => number;
  currentUser: AuthUser | null;
  isAdmin?: boolean;
  pendingVehicles: PendingVehicle[];
}

const getDistanceToLineSegment = (px: number, py: number, x1: number, y1: number, x2: number, y2: number) => {
  const A = px - x1; const B = py - y1; const C = x2 - x1; const D = y2 - y1;
  const dot = A * C + B * D; const lenSq = C * C + D * D;
  const param = lenSq !== 0 ? dot / lenSq : -1;
  let xx, yy;
  if (param < 0) { xx = x1; yy = y1; }
  else if (param > 1) { xx = x2; yy = y2; }
  else { xx = x1 + param * C; yy = y1 + param * D; }
  const dx = px - xx; const dy = py - yy;
  return Math.sqrt(dx * dx + dy * dy);
};

const formatTime = (ms: number) => {
  const s = Math.floor(ms / 1000);
  const m = Math.floor(s / 60);
  return `${m}:${(s % 60).toString().padStart(2, "0")}`;
};

const MapShell = memo(({
    activeMapId, currentMap, bounds, visibleVehicles, icons, imageHeight, imageWidth,
    isMobile, isSidebarOpen, filters, onSetSidebarOpen, onToggleFilter, onGetCount,
    currentUser, isAdmin, pendingVehicles,
  }: MapShellProps) => {
    const router = useRouter();
    const searchParams = useSearchParams();
    const playbackId = searchParams?.get("playback") || null;
    const playbackNickname = searchParams?.get("nickname") || null;
    const playbackPlatformParam = searchParams?.get("platform") || null;
    const playbackModeParam = searchParams?.get("mode") ?? null;
    const playbackPlatform: TelemetryPlatform | null =
      playbackPlatformParam === "steam" || playbackPlatformParam === "kakao"
        ? playbackPlatformParam
        : null;
    const playbackMode: TelemetryMode | null = playbackModeParam === null
      ? "lite"
      : playbackModeParam === "lite" || playbackModeParam === "full"
        ? playbackModeParam
        : null;
    const playbackIdentityError = playbackId && !playbackNickname
      ? "리플레이 nickname이 누락되었습니다."
      : playbackId && !playbackPlatform
        ? "리플레이 platform이 누락되었거나 지원되지 않습니다."
        : playbackId && !playbackMode
          ? "리플레이 mode가 지원되지 않습니다."
          : null;
    
    const {
      events: telemetryEvents, loading: telemetryLoading, error: telemetryError,
      isPlaying, setIsPlaying, playbackSpeed, setPlaybackSpeed,
      currentTimeMs, setCurrentTimeMs, maxTimeMs, currentStates, teamNames, zoneEvents,
      isFullMode
    } = useTelemetry(playbackId, playbackNickname, playbackPlatform, playbackMode, activeMapId);
    const safeTelemetryEvents = playbackIdentityError ? [] : telemetryEvents;
    const safeCurrentStates = playbackIdentityError ? {} : currentStates;
    const safeTeamNames = playbackIdentityError ? [] : teamNames;
    const safeZoneEvents = playbackIdentityError ? [] : zoneEvents;

    const [activeMode, setActiveMode] = useState<"none" | "mortar" | "flight" | "report" | "simulate">("none");
    const [isMortarDisclaimerOpen, setIsMortarDisclaimerOpen] = useState(false);
    const [mortarPoints, setMortarPoints] = useState<L.LatLng[]>([]);
    const [flightPoints, setFlightPoints] = useState<L.LatLng[]>([]);
    const [reportLocation, setReportLocation] = useState<L.LatLng | null>(null);

    // 시뮬레이터 전용 상태 추가
    const [simulatorStep, setSimulatorStep] = useState(0);
    const [simulatorPhases, setSimulatorPhases] = useState<L.LatLng[]>([]);
    const [isVehicleFilterOn, setIsVehicleFilterOn] = useState(false);
    const [isGridOn, setIsGridOn] = useState(true);
    const [isHotDropOn, setIsHotDropOn] = useState(false);
    const [isMenuOpen, setIsMenuOpen] = useState(false);
    const [showZone, setShowZone] = useState(true);
    const [showCombatDots, setShowCombatDots] = useState(false);
    const [showShotDots, setShowShotDots] = useState(true);
    const [hiddenPlayers, setHiddenPlayers] = useState<string[]>([]);
    const [showPlayerNames, setShowPlayerNames] = useState(true);
    const [showFlightPath, setShowFlightPath] = useState(true);
    const [showSmokeNotice, setShowSmokeNotice] = useState(false); // 🎯 연막탄 공지 상태
    const [isInstructionDismissed, setIsInstructionDismissed] = useState(false);

    // Reset instruction dismissal when activeMode changes
    useEffect(() => {
      setIsInstructionDismissed(false);
    }, [activeMode]);

    // 🎯 "오늘 하루 보지 않기" 체크 로직
    useEffect(() => {
      let isMounted = true;
      if (playbackId && isFullMode) {
        const dismissed = localStorage.getItem("smoke_notice_dismissed");
        const today = new Date().toDateString();
        if (dismissed !== today && isMounted) {
          setTimeout(() => setShowSmokeNotice(true), 0);
        }
      } else {
        if (isMounted) setTimeout(() => setShowSmokeNotice(false), 0);
      }
      return () => { isMounted = false; };
    }, [playbackId, isFullMode]);

    const handleDismissNotice = (dontShowToday: boolean) => {
      if (dontShowToday) {
        localStorage.setItem("smoke_notice_dismissed", new Date().toDateString());
      }
      setShowSmokeNotice(false);
    };

    const mapScale = 8192 / imageWidth;
    const pxPerMeter = imageWidth / 8192;

    const handleModeToggle = (mode: "mortar" | "flight" | "report" | "simulate") => {
      if (mode === "mortar" && activeMode !== "mortar") {
        const accepted = localStorage.getItem("bgms_mortar_disclaimer_accepted") === "true";
        if (!accepted) {
          setIsMortarDisclaimerOpen(true);
          return;
        }
      }
      setActiveMode(activeMode === mode ? "none" : mode);
      setMortarPoints([]); 
      setFlightPoints([]); 
      setIsVehicleFilterOn(false); 
      setReportLocation(null);
      if (mode !== "simulate") {
        setSimulatorStep(0);
        setSimulatorPhases([]);
      }
    };

    const handleAcceptMortarDisclaimer = () => {
      localStorage.setItem("bgms_mortar_disclaimer_accepted", "true");
      setIsMortarDisclaimerOpen(false);
      setActiveMode("mortar");
      setMortarPoints([]); 
      setFlightPoints([]); 
      setIsVehicleFilterOn(false); 
      setReportLocation(null);
    };

    let flightPolygonCoords: [number, number][] = [];
    if (flightPoints.length === 2) {
      const p1 = flightPoints[0]; const p2 = flightPoints[1];
      const radiusPx = 1000 * pxPerMeter; const dx = p2.lng - p1.lng; const dy = p2.lat - p1.lat;
      const len = Math.sqrt(dx * dx + dy * dy);
      if (len > 0) {
        const nx = -dy / len; const ny = dx / len;
        flightPolygonCoords = [
          [p1.lat + ny * radiusPx, p1.lng + nx * radiusPx],
          [p2.lat + ny * radiusPx, p2.lng + nx * radiusPx],
          [p2.lat - ny * radiusPx, p2.lng - nx * radiusPx],
          [p1.lat - ny * radiusPx, p1.lng - nx * radiusPx],
        ];
      }
    }

    let displayedVehicles = visibleVehicles;
    if ((activeMode === "flight" || activeMode === "simulate") && flightPoints.length === 2 && isVehicleFilterOn) {
      displayedVehicles = visibleVehicles.filter((v) => {
        const distPx = getDistanceToLineSegment(v.x, v.y, flightPoints[0].lng, flightPoints[0].lat, flightPoints[1].lng, flightPoints[1].lat);
        return distPx <= 1000 && !(v.type === "Key" || v.type === "SecretRoom" || v.type === "SecurityCard");
      });
    }

    return (
      <div className="flex w-full h-full overflow-hidden">
        {!isMobile ? (
          <Sidebar isOpen={isSidebarOpen} setIsOpen={onSetSidebarOpen} mapLabel={currentMap?.label || "지도"} activeMapId={activeMapId} filters={filters} toggleFilter={onToggleFilter} getCount={onGetCount} />
        ) : (
          <MobileBottomSheet isOpen={isSidebarOpen} setIsOpen={onSetSidebarOpen} mapLabel={currentMap?.label || "지도"} activeMapId={activeMapId} filters={filters} toggleFilter={onToggleFilter} getCount={onGetCount} />
        )}

        <div className="flex-1 flex overflow-hidden relative bg-[#0a0a0a]">
          {/* Left: Map Area */}
          <div className="flex-1 flex flex-col relative min-w-0">
            {/* 데스크톱 전용 우측 하단 플로팅 카카오 애드핏 광고 — 사이드바 침범 방지 및 광고 설치 검증 보장 */}
            {!isMobile && (
              <div className="absolute right-4 bottom-4 z-[1000] shadow-[0_4px_12px_rgba(0,0,0,0.5)] border border-white/10 rounded-lg overflow-hidden bg-black/80 p-1">
                <AdfitBanner
                  adUnit="DAN-tQGcqmddMC8tPpXA"
                  adWidth={320}
                  adHeight={100}
                />
              </div>
            )}
            <HomeNotice />

            {/* 구형 상태바 제거됨 */}

            {/* UI Overlay Buttons */}
            {/* UI Overlay Buttons */}
            {!playbackId && (
              <>
                {isMobile ? (
                  // Mobile compact layout
                  <div className="absolute z-[1000] bottom-[72px] left-6 right-6 pointer-events-none flex flex-col gap-3 safe-bottom">
                    {isMenuOpen && (
                      <div className="pointer-events-auto w-full bg-black/90 backdrop-blur-xl border border-white/10 rounded-2xl px-2 py-3 shadow-[0_12px_40px_rgba(0,0,0,0.6)] flex justify-around items-center gap-1 animate-in slide-in-from-bottom-4 duration-300">
                        {/* 핫드랍 */}
                        <button 
                          onClick={() => setIsHotDropOn(!isHotDropOn)} 
                          className={`flex flex-col items-center gap-1.5 flex-1 py-1 rounded-xl transition-all active:scale-90 ${isHotDropOn ? "text-orange-500 font-bold" : "text-gray-400"}`}
                        >
                          <Flame size={18} strokeWidth={2.5} className={isHotDropOn ? "animate-pulse text-orange-500" : ""} />
                          <span className="text-[10px] tracking-tight">핫드랍</span>
                        </button>
                        
                        {/* 그리드 */}
                        <button 
                          onClick={() => setIsGridOn(!isGridOn)} 
                          className={`flex flex-col items-center gap-1.5 flex-1 py-1 rounded-xl transition-all active:scale-90 ${isGridOn ? "text-[#F2A900] font-bold" : "text-gray-400"}`}
                        >
                          <MapIcon size={18} strokeWidth={2.5} className={isGridOn ? "text-[#F2A900]" : ""} />
                          <span className="text-[10px] tracking-tight">그리드</span>
                        </button>
                        
                        {/* 시뮬레이터 */}
                        <button 
                          onClick={() => handleModeToggle("simulate")} 
                          className={`flex flex-col items-center gap-1.5 flex-1 py-1 rounded-xl transition-all active:scale-90 ${activeMode === "simulate" ? "text-blue-400 font-bold" : "text-gray-400"}`}
                        >
                          <Target size={18} strokeWidth={2.5} className={activeMode === "simulate" ? "text-blue-400" : ""} />
                          <span className="text-[10px] tracking-tight">시뮬</span>
                        </button>
                        
                        {/* 박격포 */}
                        <button 
                          onClick={() => handleModeToggle("mortar")} 
                          className={`flex flex-col items-center gap-1.5 flex-1 py-1 rounded-xl transition-all active:scale-90 ${activeMode === "mortar" ? "text-red-500 font-bold" : "text-gray-400"}`}
                        >
                          <Crosshair size={18} strokeWidth={2.5} className={activeMode === "mortar" ? "text-red-500" : ""} />
                          <span className="text-[10px] tracking-tight">박격포</span>
                        </button>
                        
                        {/* 차량 제보 */}
                        <button 
                          onClick={() => handleModeToggle("report")} 
                          className={`flex flex-col items-center gap-1.5 flex-1 py-1 rounded-xl transition-all active:scale-90 ${activeMode === "report" ? "text-emerald-400 font-bold" : "text-gray-400"}`}
                        >
                          <MapPin size={18} strokeWidth={2.5} className={activeMode === "report" ? "text-emerald-400" : ""} />
                          <span className="text-[10px] tracking-tight">차량제보</span>
                        </button>
                      </div>
                    )}
                    <div className="flex justify-between items-center w-full">
                      <button 
                        onClick={() => onSetSidebarOpen(!isSidebarOpen)} 
                        className="pointer-events-auto flex items-center justify-center w-[52px] h-[52px] bg-black/80 backdrop-blur-md border border-white/10 rounded-2xl shadow-2xl active:scale-90 transition-all text-[#F2A900]"
                      >
                        <SlidersHorizontal size={22} strokeWidth={2.5} />
                      </button>
                      <button 
                        onClick={() => setIsMenuOpen(!isMenuOpen)} 
                        className={`pointer-events-auto flex items-center gap-2 px-5 shadow-[0_12px_40px_rgba(0,0,0,0.4)] active:scale-90 transition-all duration-300 border border-white/5 bg-black/80 backdrop-blur-xl h-[52px] rounded-2xl ${isMenuOpen ? "text-red-500 border-red-500/20" : "text-[#F2A900]"}`}
                      >
                        {isMenuOpen ? (
                          <><X size={18} strokeWidth={3} /><span className="font-black uppercase tracking-tight text-xs">닫기</span></>
                        ) : (
                          <><Hammer size={18} strokeWidth={3} /><span className="font-black uppercase tracking-tight text-xs">도구</span></>
                        )}
                      </button>
                    </div>
                  </div>
                ) : (
                  // Desktop layout
                  <div className="absolute z-[1000] flex w-full pointer-events-none transition-all top-4 right-4 justify-end">
                    <div className="flex w-full items-start justify-end">
                      {!isSidebarOpen && (
                        <button 
                          onClick={() => onSetSidebarOpen(true)} 
                          className="pointer-events-auto absolute left-4 top-0 flex items-center justify-center w-[44px] h-[44px] bg-black/80 backdrop-blur-md border border-white/10 rounded-xl shadow-2xl active:scale-90 transition-all text-white hover:text-[#F2A900] z-[5000]"
                        >
                          <Menu size={22} strokeWidth={2.5} />
                        </button>
                      )}
                      <div className="flex flex-col gap-3 items-end pointer-events-auto">
                        <button 
                          onClick={() => setIsMenuOpen(!isMenuOpen)} 
                          className={`pointer-events-auto flex items-center gap-2 px-6 shadow-[0_12px_40px_rgba(0,0,0,0.4)] active:scale-90 transition-all duration-300 border border-white/5 ${isMenuOpen ? "bg-red-600 text-white h-[52px] rounded-2xl text-sm" : "bg-black/80 backdrop-blur-xl text-[#F2A900] h-[52px] rounded-2xl text-base"}`}
                        >
                          {isMenuOpen ? (
                            <><X size={18} strokeWidth={3} /><span className="font-black uppercase tracking-tight text-xs">닫기</span></>
                          ) : (
                            <><Hammer size={18} strokeWidth={3} /><span className="font-black uppercase tracking-tight text-xs">지도 도구</span></>
                          )}
                        </button>
                        {isMenuOpen && (
                          <div className="flex flex-col gap-2.5 items-end animate-in fade-in slide-in-from-bottom-4 duration-300">
                            <button 
                              onClick={() => setIsHotDropOn(!isHotDropOn)} 
                              className={`pointer-events-auto flex items-center gap-2.5 px-5 py-3.5 border border-white/10 rounded-xl font-black text-xs shadow-2xl transition-all active:scale-95 ${isHotDropOn ? "bg-gradient-to-r from-orange-500 to-red-600 text-white border-orange-400" : "bg-[#1a1a1a] text-orange-500 hover:text-orange-400"}`}
                            >
                              <Flame size={16} strokeWidth={3} />
                              <span className="uppercase tracking-tighter">핫드랍 {isHotDropOn ? "ON" : "OFF"}</span>
                            </button>
                            <button 
                              onClick={() => setIsGridOn(!isGridOn)} 
                              className={`pointer-events-auto flex items-center gap-2.5 px-5 py-3.5 border border-white/10 rounded-xl font-black text-xs shadow-2xl transition-all active:scale-95 ${isGridOn ? "bg-[#F2A900] text-black" : "bg-[#1a1a1a] text-[#777]"}`}
                            >
                              <MapIcon size={16} strokeWidth={3} />
                              <span className="uppercase tracking-tighter">그리드 {isGridOn ? "ON" : "OFF"}</span>
                            </button>
                            <button 
                              onClick={() => handleModeToggle("simulate")} 
                              className={`pointer-events-auto flex items-center gap-2.5 px-5 py-3.5 border border-blue-500/30 rounded-xl font-black text-xs shadow-2xl transition-all active:scale-95 ${activeMode === "simulate" ? "bg-blue-600 text-white" : "bg-[#1a1a1a] text-blue-400 hover:text-blue-300"}`}
                            >
                              <Target size={16} strokeWidth={3} />
                              <span className="uppercase tracking-tighter">시뮬레이터</span>
                            </button>
                            <button 
                              onClick={() => handleModeToggle("mortar")} 
                              className={`pointer-events-auto flex items-center gap-2.5 px-5 py-3.5 border border-white/10 rounded-xl font-black text-xs shadow-2xl transition-all active:scale-95 ${activeMode === "mortar" ? "bg-[#ea4335] text-white" : "bg-[#1a1a1a] text-[#777]"}`}
                            >
                              <Crosshair size={16} strokeWidth={3} />
                              <span className="uppercase tracking-tighter">박격포</span>
                            </button>
                            <button 
                              onClick={() => handleModeToggle("report")} 
                              className={`pointer-events-auto flex items-center gap-2.5 px-5 py-3.5 border border-emerald-500/30 rounded-xl font-black text-xs shadow-2xl transition-all active:scale-95 ${activeMode === "report" ? "bg-emerald-600 text-white border-emerald-500" : "bg-[#1a1a1a] text-emerald-400 hover:text-emerald-300"}`}
                            >
                              <MapPin size={16} strokeWidth={3} />
                              <span className="uppercase tracking-tighter">차량 제보</span>
                            </button>
                          </div>
                        )}
                      </div>
                    </div>
                  </div>
                )}
              </>
            )}
            
            <SimulatorPanel 
              activeMode={activeMode}
              currentStep={simulatorStep}
              flightPointsReady={flightPoints.length === 2}
              onNextStep={() => setSimulatorStep(s => s + 1)}
              onPrevStep={() => {
                setSimulatorStep(s => {
                  const nextStep = Math.max(0, s - 1);
                  setSimulatorPhases(prev => prev.slice(0, Math.max(0, nextStep - 1)));
                  return nextStep;
                });
              }}
              onClose={() => handleModeToggle("simulate")}
              onReset={() => {
                setFlightPoints([]);
                setSimulatorStep(0);
                setSimulatorPhases([]);
                setIsVehicleFilterOn(false);
              }}
              isVehicleFilterOn={isVehicleFilterOn}
              setIsVehicleFilterOn={setIsVehicleFilterOn}
              simulatorPhases={simulatorPhases}
            />

            {activeMode !== "none" && !isInstructionDismissed && (
              <div className={`absolute left-1/2 -translate-x-1/2 z-[1000] bg-black/80 backdrop-blur-md text-white px-4 py-2.5 rounded-2xl border border-white/10 shadow-2xl flex flex-col items-center justify-center gap-1.5 pointer-events-auto transition-all w-[calc(100%-2rem)] max-w-md ${isMobile ? 'top-[60px]' : 'top-4'}`}>
                <div className="flex items-start justify-between gap-3 w-full">
                  <span className="text-xs sm:text-sm font-medium leading-tight">
                    {activeMode === "mortar" && (
                      <InlineIconLabel icon="crosshair">[박격포] 지도 위에 내 위치와 타겟 지점을 순서대로 클릭하세요.</InlineIconLabel>
                    )}
                    {activeMode === "simulate" && (
                      <InlineIconLabel icon="activity">[시뮬레이터] 지도를 클릭해 서클 및 가상 경로 지점을 추가하세요.</InlineIconLabel>
                    )}
                    {activeMode === "report" && (
                      <InlineIconLabel icon="alert">[차량 제보] 지도 위에 차량을 제보할 위치를 클릭하세요!</InlineIconLabel>
                    )}
                    {!isMobile && <span className="text-[#F2A900] ml-1.5">(우클릭: 취소)</span>}
                  </span>
                  <button 
                    onClick={() => setIsInstructionDismissed(true)}
                    className="p-1 hover:bg-white/10 rounded-full transition-all active:scale-75 shrink-0"
                    title="닫기"
                  >
                    <X size={14} className="text-gray-400 hover:text-white" />
                  </button>
                </div>
                {activeMode === "mortar" && (
                  <span className="text-[10px] text-gray-400 font-semibold leading-normal w-full text-left sm:text-center">
                    (※ 지형 기반 고도차 참고 데이터로 실제 인게임 수치와 오차가 존재할 수 있습니다)
                  </span>
                )}
              </div>
            )}

            <MapView
              activeMapId={activeMapId} currentMap={currentMap} bounds={bounds} icons={icons} imageHeight={imageHeight} imageWidth={imageWidth}
              activeMode={activeMode} mortarPoints={mortarPoints} flightPoints={flightPoints} flightPolygonCoords={flightPolygonCoords}
              displayedVehicles={displayedVehicles} isGridOn={isGridOn} mapScale={mapScale} setMortarPoints={setMortarPoints}
              setFlightPoints={setFlightPoints} setIsVehicleFilterOn={setIsVehicleFilterOn} setActiveMode={setActiveMode}
              setReportLocation={setReportLocation} reportLocation={reportLocation} currentUser={currentUser} isAdmin={isAdmin}
              pendingVehicles={playbackId ? [] : pendingVehicles} filters={filters} isHotDropOn={isHotDropOn}
              isHighPrecision={isFullMode}
              telemetryData={{
                isActive: !!playbackId && !playbackIdentityError, mapName: activeMapId || "Erangel", events: safeTelemetryEvents, currentTimeMs, currentStates: safeCurrentStates,
                teamNames: safeTeamNames, zoneEvents: safeZoneEvents, showZone, showCombatDots, showShotDots, hiddenPlayers, showPlayerNames, showFlightPath,
              }}
              simulatorStep={simulatorStep}
              simulatorPhases={simulatorPhases}
              setSimulatorStep={setSimulatorStep}
              setSimulatorPhases={setSimulatorPhases}
            />

            {/* 🏆 히트맵 범례 (핫드랍 또는 시뮬레이터 활성화 시) */}
            <HeatmapLegend 
              visible={isHotDropOn} 
              type="hotdrop" 
            />

            {playbackId && (
              <>
                {/* 🏆 고도화된 통합 상단 상태바 (모바일 최적화) */}
                <div className={`absolute ${isMobile ? 'top-2' : 'top-6'} left-1/2 -translate-x-1/2 z-[1000] flex flex-col items-center gap-2 w-full max-w-xl pointer-events-none`}>
                  {/* ℹ️ 연막탄 위치 추론 안내 공지 (모바일에서는 더 작게) */}
                  {showSmokeNotice && (
                    <div className={`pointer-events-auto bg-black/90 backdrop-blur-xl ${isMobile ? 'px-3 py-1.5 mx-4' : 'px-4 py-2'} rounded-xl border border-orange-500/30 shadow-[0_10px_30px_rgba(0,0,0,0.5)] flex items-center gap-3 mb-2 animate-in fade-in slide-in-from-top-2 duration-500`}>
                      <AlertCircle size={isMobile ? 12 : 14} className="text-orange-500 shrink-0" />
                      <div className="flex flex-col">
                        <span className={`${isMobile ? 'text-[9px]' : 'text-[11px]'} text-white font-bold tracking-tight`}>
                          고정밀 분석: 연막탄 위치는 투척 궤적 기반의 추론 데이터입니다.
                        </span>
                        <div className="flex gap-3 mt-1">
                          <button onClick={() => handleDismissNotice(false)} className="text-[10px] text-gray-400">닫기</button>
                          <button onClick={() => handleDismissNotice(true)} className="text-[10px] text-orange-500/80 font-bold">오늘 안보기</button>
                        </div>
                      </div>
                    </div>
                  )}

                  {safeZoneEvents.length > 0 && (
                    <div className={`bg-black/80 backdrop-blur-md ${isMobile ? 'px-3 py-0.5' : 'px-4 py-1'} rounded-full border border-white/10 shadow-2xl flex items-center gap-3 animate-fade-in`}>
                       <ZoneStatus currentTimeMs={currentTimeMs} zoneEvents={safeZoneEvents} />
                    </div>
                  )}
                  
                  <div className={`bg-[#111]/90 backdrop-blur-xl ${isMobile ? 'px-5 py-2' : 'px-8 py-3'} rounded-[2rem] border border-white/10 shadow-[0_20px_50px_rgba(0,0,0,0.5)] flex items-center ${isMobile ? 'gap-4' : 'gap-8'}`}>
                    <div className="flex flex-col items-center">
                      <span className="text-[9px] text-gray-500 font-bold uppercase tracking-widest">Time</span>
                      <span className={`${isMobile ? 'text-lg' : 'text-2xl'} font-mono font-bold text-white leading-none`}>{formatTime(currentTimeMs)}</span>
                    </div>
                    <div className="w-px h-6 bg-white/10" />
                    <div className="flex flex-col items-center">
                      <span className="text-[9px] text-[#F2A900] font-bold uppercase tracking-widest">Alive</span>
                      <span className={`${isMobile ? 'text-lg' : 'text-2xl'} font-mono font-bold text-[#F2A900] leading-none`}>
                        {Object.values(safeCurrentStates).filter((p: any) => !p.isDead).length}
                      </span>
                    </div>
                  </div>
                </div>

                {/* 🚀 데이터 로딩 오버레이 */}
                {telemetryLoading && (
                  <div className="absolute inset-0 z-[5000] bg-black/80 backdrop-blur-md flex flex-col items-center justify-center">
                    <div className="relative">
                      <div className={`w-20 h-20 border-4 ${isFullMode ? 'border-yellow-500/20 border-t-yellow-500' : 'border-indigo-500/20 border-t-indigo-500'} rounded-full animate-spin`} />
                      <div className="absolute inset-0 flex items-center justify-center text-2xl animate-pulse">
                        <BgmsIcon name={isFullMode ? "award" : "activity"} size={28} className={isFullMode ? "text-yellow-400" : "text-indigo-300"} />
                      </div>
                    </div>
                    <h3 className="mt-6 text-white font-black text-xl tracking-tighter uppercase px-4 text-center">
                      {isFullMode ? "초정밀 데이터 분석 중..." : "전투 데이터 복기 중..."}
                    </h3>
                  </div>
                )}

                {/* 모바일용 팀 리스트 토글 버튼 */}
                {isMobile && (
                  <button 
                    onClick={() => setIsMenuOpen(!isMenuOpen)}
                    className="absolute top-4 right-4 z-[2000] pointer-events-auto flex items-center justify-center w-[44px] h-[44px] bg-black/80 backdrop-blur-md border border-white/10 rounded-xl text-[#F2A900]"
                  >
                    <Menu size={20} />
                  </button>
                )}

                {/* 하단 플레이어 컨트롤러 */}
                <div className={`absolute ${isMobile ? 'bottom-20' : 'bottom-6'} left-1/2 -translate-x-1/2 z-[1000] w-full max-w-2xl px-4`}>
                  <TelemetryPlayer
                    events={safeTelemetryEvents} teamNames={safeTeamNames} isPlaying={isPlaying} setIsPlaying={setIsPlaying} playbackSpeed={playbackSpeed}
                    setPlaybackSpeed={setPlaybackSpeed} currentTimeMs={currentTimeMs} setCurrentTimeMs={setCurrentTimeMs}
                    maxTimeMs={maxTimeMs} loading={telemetryLoading} error={playbackIdentityError || telemetryError} showZone={showZone}
                    onToggleZone={() => setShowZone(!showZone)} showCombatDots={showCombatDots}
                    onToggleCombatDots={() => setShowCombatDots(!showCombatDots)} showShotDots={showShotDots}
                    onToggleShotDots={() => setShowShotDots(!showShotDots)} hiddenPlayers={hiddenPlayers}
                    onTogglePlayer={(n) => setHiddenPlayers(prev => prev.includes(n) ? prev.filter(x => x !== n) : [...prev, n])}
                    showPlayerNames={showPlayerNames} onTogglePlayerNames={() => setShowPlayerNames(!showPlayerNames)}
                    showFlightPath={showFlightPath} onToggleFlightPath={() => setShowFlightPath(!showFlightPath)}
                    onClose={() => {
                      const p = new URLSearchParams(searchParams?.toString() || "");
                      p.delete("playback");
                      p.delete("nickname");
                      p.delete("platform");
                      p.delete("mode");
                      router.push(`/?${p.toString()}`);
                    }}
                  />
                </div>
                {safeTelemetryEvents.length > 0 && (
                  <div className={isMobile ? "translate-y-[-60px]" : ""}>
                    <KillFeed events={safeTelemetryEvents} currentTimeMs={currentTimeMs} teamNames={safeTeamNames} playbackSpeed={playbackSpeed} />
                  </div>
                )}
              </>
            )}
          </div>

          {/* Right Sidebar (모바일에서는 오버레이 형태로 전환) */}
          {playbackId && (
            <div className={`
              ${isMobile 
                ? `absolute inset-y-0 right-0 z-[3000] transition-transform duration-300 ${isMenuOpen ? 'translate-x-0' : 'translate-x-full'}` 
                : 'relative'
              }
            `}>
              {isMobile && isMenuOpen && (
                <div 
                  className="absolute inset-0 -left-full bg-black/40 backdrop-blur-sm z-[-1]"
                  onClick={() => setIsMenuOpen(false)}
                />
              )}
              <TelemetrySidebar currentStates={safeCurrentStates} />
            </div>
          )}
        </div>

        {/* 🏆 박격포 고저차 면책 고지 안내 모달 (pubg.plus 스타일 방어책) */}
        {isMortarDisclaimerOpen && (
          <div className="absolute inset-0 bg-black/60 backdrop-blur-md z-[5000] flex items-center justify-center p-4 pointer-events-auto">
            <div className="bg-[#0b0f19]/95 border border-white/10 rounded-3xl p-6 sm:p-8 max-w-lg w-full shadow-2xl relative overflow-hidden animate-fade-in">
              {/* 뒷배경 오렌지 빛 네온 효과 */}
              <div className="absolute inset-0 bg-gradient-to-r from-amber-500/5 to-transparent pointer-events-none" />
              
              <div className="space-y-6">
                <div className="flex items-center gap-3 border-b border-white/5 pb-4">
                  <Crosshair className="w-6 h-6 text-[#F2A900] animate-pulse" />
                  <h3 className="text-lg font-black text-white tracking-wide uppercase">
                    박격포 고저차 기능 안내
                  </h3>
                </div>
                
                <div className="space-y-4 text-xs sm:text-sm text-gray-300 leading-relaxed font-medium">
                  <p className="text-gray-400 font-bold">
                    이 기능은 지형 고도 데이터를 활용하여 박격포 사격 파라미터 계산을 보조합니다.
                  </p>
                  
                  <div className="space-y-3 bg-white/5 border border-white/5 rounded-2xl p-4">
                    <p className="font-extrabold text-[#F2A900] text-[11px] uppercase tracking-wider">
                      <InlineIconLabel icon="alert" iconSize={13}>다음 제한 사항을 확인하세요</InlineIconLabel>
                    </p>
                    <ul className="list-disc list-inside space-y-2 text-gray-300 text-xs font-semibold">
                      <li>
                        데이터 정밀도의 한계로 인해 론도 고지대 등 극단적인 지형에서는 오차가 클 수 있습니다. 고도는 자연 지형만 계산하며, 건물·교량 등 구조물은 포함되지 않습니다.
                      </li>
                      <li>
                        이 기능은 참고용으로만 제공되며, 계산 결과의 정확성을 보장하지 않습니다.
                      </li>
                      <li>
                        이 기능 사용으로 인한 게임 내 손실에 대해 본 사이트는 어떠한 책임도 지지 않습니다.
                      </li>
                    </ul>
                  </div>
                  
                  <p className="text-[11px] text-gray-400 font-semibold">
                    계속 사용하면 위 제한 사항을 이해하고 동의한 것으로 간주합니다.
                  </p>
                </div>
                
                <div className="flex gap-3 pt-2">
                  <button
                    onClick={() => setIsMortarDisclaimerOpen(false)}
                    className="flex-1 py-3 bg-white/5 hover:bg-white/10 text-gray-450 hover:text-white font-bold rounded-xl active:scale-95 transition-all text-xs cursor-pointer border border-white/5 text-center"
                  >
                    취소
                  </button>
                  <button
                    onClick={handleAcceptMortarDisclaimer}
                    className="flex-1 py-3 bg-gradient-to-r from-amber-500 to-orange-600 hover:from-amber-600 hover:to-orange-700 text-slate-950 font-black rounded-xl active:scale-95 transition-all text-xs cursor-pointer text-center"
                  >
                    확인했습니다, 계속 사용
                  </button>
                </div>
              </div>
            </div>
          </div>
        )}
      </div>
    );
});

MapShell.displayName = "MapShell";

const ZoneStatus = ({ currentTimeMs, zoneEvents }: { currentTimeMs: number, zoneEvents: any[] }) => {
  if (!zoneEvents || zoneEvents.length === 0) return null;

  let currentZone = zoneEvents[0];
  let isMoving = false;

  for (let i = 0; i < zoneEvents.length; i++) {
    if (zoneEvents[i].relativeTimeMs <= currentTimeMs) {
      currentZone = zoneEvents[i];
      if (i > 0) {
        const prev = zoneEvents[i - 1];
        if (currentZone.blueRadius < prev.blueRadius - 1) {
          isMoving = true;
        } else {
          isMoving = false;
        }
      }
    } else {
      break;
    }
  }

  let phaseEndTime = currentZone.relativeTimeMs;
  // [V58.0] 현재 시간까지의 데이터 중 가장 높은 페이즈를 선택 (명시적 필드 + 폴백)
  let phase = zoneEvents.length > 0 ? 1 : 0;
  let lastWhite = zoneEvents[0]?.whiteRadius || 0;

  for (const z of zoneEvents) {
    if (z.relativeTimeMs <= currentTimeMs) {
      // 1. 명시적 페이즈 필드(V58.0) 우선 활용
      if (z.phase && z.phase > phase) {
        phase = z.phase;
      } 
      // 2. 명시적 데이터가 없거나 0인 경우 화이트존 반경 축소를 통해 페이즈 전환 감지 (폴백)
      else if (!z.phase || z.phase === 0) {
        if (z.whiteRadius != null && lastWhite > 0 && z.whiteRadius < lastWhite - 100) {
          phase++;
          lastWhite = z.whiteRadius;
        }
      }
      
      if (z.whiteRadius != null) lastWhite = z.whiteRadius;
    } else {
      break;
    }
  }
  
  for (let i = 0; i < zoneEvents.length; i++) {
    const z = zoneEvents[i];
    if (z.relativeTimeMs > currentTimeMs) {
      if (!isMoving) {
        if (z.blueRadius < currentZone.blueRadius - 1) {
          phaseEndTime = z.relativeTimeMs;
          break;
        }
      } else {
        if (z.blueRadius - z.whiteRadius < 1 || (i > 0 && z.blueRadius >= zoneEvents[i - 1].blueRadius)) {
          phaseEndTime = z.relativeTimeMs;
          break;
        }
      }
    }
  }

  // 페이즈 종료 시간을 찾지 못한 경우 (마지막 자기장 등) 처리
  if (phaseEndTime <= currentTimeMs) {
    phaseEndTime = currentTimeMs; 
  }

  const remainingSec = Math.max(0, Math.floor((phaseEndTime - currentTimeMs) / 1000));
  const m = Math.floor(remainingSec / 60);
  const s = remainingSec % 60;
  const timeStr = remainingSec > 0 ? `${m}:${s.toString().padStart(2, "0")}` : "--:--";

  return (
    <div className="flex items-center gap-2">
      <div className={`w-2 h-2 rounded-full ${isMoving ? "bg-blue-500 animate-pulse" : "bg-white/40"}`} />
      <span className="text-[11px] font-bold text-gray-300">
        {phase}단계 {isMoving ? "축소 중" : "대기"}
      </span>
      <span className="text-[11px] font-mono font-bold text-[#F2A900] ml-1">
        {timeStr}
      </span>
    </div>
  );
};

export default MapShell;
