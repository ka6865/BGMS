"use client";

import React, { useCallback, useState, useEffect, useMemo } from "react";
import {
  MapContainer,
  TileLayer,
  Marker,
  Polyline,
  Tooltip,
  useMap,
} from "react-leaflet";
import L, { CRS } from "leaflet";
import "leaflet/dist/leaflet.css";
import { Loader2, ShieldAlert, Play, Pause, RotateCcw, Eye, EyeOff, Zap } from "lucide-react";
import { getTranslatedWeaponName } from "@/lib/pubg-analysis/constants";
import { fetchTelemetryPayload } from "@/lib/pubg-analysis/fetchTelemetryPayload";
import { parseTelemetryPlatform } from "@/lib/pubg-analysis/telemetryIdentity";
import { svgIcon } from "@/lib/ui/icon-svg";

const skullMarkerSvg = svgIcon("skull", { color: "currentColor", size: 13 });
const targetMarkerSvg = svgIcon("target", { color: "currentColor", size: 12 });
const alertMarkerSvg = svgIcon("alert", { color: "currentColor", size: 12 });
const impactMarkerSvg = svgIcon("zap", { color: "currentColor", size: 12 });
const vehicleMarkerSvg = svgIcon("vehicle", { color: "currentColor", size: 10 });

// Marker Icons custom styling
const groggyIcon = L.divIcon({
  html: `
    <div class="relative flex items-center justify-center">
      <div class="absolute w-8 h-8 bg-red-500 rounded-full opacity-40 animate-ping"></div>
      <div class="relative w-7 h-7 bg-red-600 border-2 border-white rounded-full flex items-center justify-center font-bold text-white shadow-lg text-sm">${skullMarkerSvg}</div>
    </div>
  `,
  className: "custom-groggy-marker",
  iconSize: [28, 28],
  iconAnchor: [14, 14],
});


const COLORS = ["#34A853", "#a855f7", "#ff9f0a", "#3b82f6"];

// PUBG API Map name to tile directory mapping
const TILE_MAP_NAMES: Record<string, string> = {
  "에란겔": "Erangel",
  "미라마": "Miramar",
  "사녹": "Sanhok",
  "태이고": "Taego",
  "데스턴": "Deston",
  "론도": "Rondo",
  "비켄디": "Vikendi",
  "카라킨": "Karakin",
  "파라모": "Paramo",
  "헤이븐": "Haven",
  "Baltic_Main": "Erangel",
  "Desert_Main": "Miramar",
  "Savage_Main": "Sanhok",
  "Tiger_Main": "Taego",
  "Kiki_Main": "Deston",
  "Neon_Main": "Rondo",
  "DihorOtok_Main": "Vikendi",
  "Chimera_Main": "Paramo"
};

const getTileMapName = (name: string): string => {
  const mapped = TILE_MAP_NAMES[name];
  if (mapped) return mapped;
  const fallback = name.toLowerCase().replace(/_main/i, "");
  return fallback.charAt(0).toUpperCase() + fallback.slice(1);
};

const normalizeName = (name: string): string => {
  if (!name) return "";
  return name.toLowerCase().replace(/[\s\-_]/g, "");
};

import { toCalibratedCoords as toLeafletCoords } from "@/utils/coordinate";

// 시간 기반 2D 평면 선형 보간 함수
const interpolatePosition = (
  posEvs: { relativeTimeMs: number; x: number; y: number }[],
  timeMs: number,
  mapName?: string
): [number, number] | null => {
  if (!posEvs || posEvs.length === 0) return null;
  
  if (timeMs <= posEvs[0].relativeTimeMs) {
    return toLeafletCoords(posEvs[0].x, posEvs[0].y, mapName);
  }
  
  if (timeMs >= posEvs[posEvs.length - 1].relativeTimeMs) {
    return toLeafletCoords(posEvs[posEvs.length - 1].x, posEvs[posEvs.length - 1].y, mapName);
  }
  
  for (let i = 0; i < posEvs.length - 1; i++) {
    const ev1 = posEvs[i];
    const ev2 = posEvs[i + 1];
    
    if (timeMs >= ev1.relativeTimeMs && timeMs <= ev2.relativeTimeMs) {
      const duration = ev2.relativeTimeMs - ev1.relativeTimeMs;
      if (duration === 0) return toLeafletCoords(ev1.x, ev1.y, mapName);
      
      const ratio = (timeMs - ev1.relativeTimeMs) / duration;
      const x = ev1.x + (ev2.x - ev1.x) * ratio;
      const y = ev1.y + (ev2.y - ev1.y) * ratio;
      return toLeafletCoords(x, y, mapName);
    }
  }
  
  return toLeafletCoords(posEvs[posEvs.length - 1].x, posEvs[posEvs.length - 1].y, mapName);
};

// 시간 기반 raw coordinate 선형 보간 함수
const interpolateRawPosition = (
  posEvs: { relativeTimeMs: number; x: number; y: number }[],
  timeMs: number
): { x: number; y: number } | null => {
  if (!posEvs || posEvs.length === 0) return null;
  
  if (timeMs <= posEvs[0].relativeTimeMs) {
    return { x: posEvs[0].x, y: posEvs[0].y };
  }
  
  if (timeMs >= posEvs[posEvs.length - 1].relativeTimeMs) {
    return { x: posEvs[posEvs.length - 1].x, y: posEvs[posEvs.length - 1].y };
  }
  
  for (let i = 0; i < posEvs.length - 1; i++) {
    const ev1 = posEvs[i];
    const ev2 = posEvs[i + 1];
    
    if (timeMs >= ev1.relativeTimeMs && timeMs <= ev2.relativeTimeMs) {
      const duration = ev2.relativeTimeMs - ev1.relativeTimeMs;
      if (duration === 0) return { x: ev1.x, y: ev1.y };
      
      const ratio = (timeMs - ev1.relativeTimeMs) / duration;
      const x = ev1.x + (ev2.x - ev1.x) * ratio;
      const y = ev1.y + (ev2.y - ev1.y) * ratio;
      return { x, y };
    }
  }
  
  return { x: posEvs[posEvs.length - 1].x, y: posEvs[posEvs.length - 1].y };
};

// 특정 시점의 플레이어 상태를 반환하는 함수
const getPlayerStatusAtTime = (
  events: any[],
  playerName: string,
  timeMs: number
): "normal" | "groggy" | "dead" => {
  const normPlayerName = normalizeName(playerName);
  
  // 플레이어가 대상인 기절, 사망, 소생 이벤트를 필터링
  const playerEvents = events.filter(
    (ev: any) =>
      (ev.type === "groggy" || ev.type === "kill" || ev.type === "revive") &&
      normalizeName(ev.victim) === normPlayerName &&
      ev.relativeTimeMs <= timeMs
  );
  
  if (playerEvents.length === 0) return "normal";
  
  // 시간 순서대로 정렬하여 가장 최근 이벤트를 획득
  const sorted = [...playerEvents].sort((a, b) => b.relativeTimeMs - a.relativeTimeMs);
  const lastEvent = sorted[0];
  
  if (lastEvent.type === "groggy") return "groggy";
  if (lastEvent.type === "kill") return "dead";
  if (lastEvent.type === "revive") return "normal";
  
  return "normal";
};

// 특정 시간(playbackTimeMs)과 가장 가까운 위치 이벤트에서 vehicleId 조회
const getVehicleIdAtTime = (posEvs: any[], timeMs: number): string | null => {
  if (!posEvs || posEvs.length === 0) return null;
  let closestEv = posEvs[0];
  let minDiff = Math.abs(posEvs[0].relativeTimeMs - timeMs);
  
  for (const ev of posEvs) {
    const diff = Math.abs(ev.relativeTimeMs - timeMs);
    if (diff < minDiff) {
      minDiff = diff;
      closestEv = ev;
    }
  }
  
  return minDiff < 3000 ? (closestEv.vehicleId || null) : null;
};

// 공격자 이름을 정제하여 환경 요인이나 시스템 킬일 경우 적합한 한글 명칭으로 변환합니다.
const getCleanAttackerName = (attacker: string): string => {
  if (!attacker) return "환경요인";
  const normalized = attacker.trim();
  if (
    normalized === "없음" ||
    normalized === "Unknown" ||
    normalized === "알 수 없음" ||
    normalized === "자연사" ||
    normalized === "환경/자연사"
  ) {
    return "환경요인";
  }
  return attacker;
};

// 맵 중심이 변경될 때 지도의 중심을 맞춰주는 도우미 컴포넌트
function MapUpdater({ center }: { center: [number, number] }) {
  const map = useMap();
  const [lat, lng] = center;

  useEffect(() => {
    if (map) {
      // panTo는 현재 지도의 줌 크기(Zoom Level)를 100% 그대로 유지하면서
      // 지도의 화면 중심(Center)만 해당 좌표로 부드럽게 평행 이동시킵니다.
      map.panTo([lat, lng], { animate: true, duration: 0.5 });
    }
  }, [lat, lng, map]);
  return null;
}

interface Squad2DMapProps {
  matchId: string;
  nickname: string;
  platform: string;
  mapName: string;
  focusTimeMs?: number | null;
}

export default function Squad2DMap({ matchId, nickname, platform, mapName, focusTimeMs }: Squad2DMapProps) {
  const [telemetry, setTelemetry] = useState<any>(null);
  const [loading, setLoading] = useState<boolean>(true);
  const [error, setError] = useState<string | null>(null);
  const [isMobile, setIsMobile] = useState<boolean>(false);
  const [selectedKnockIdx, setSelectedKnockIdx] = useState<number>(0);

  // 리플레이 재생 관련 상태 추가
  const [isPlaying, setIsPlaying] = useState<boolean>(false);
  const [playbackTimeMs, setPlaybackTimeMs] = useState<number>(0);
  const [playbackSpeed, setPlaybackSpeed] = useState<number>(1); // 1, 2, 4
  const [showPaths, setShowPaths] = useState<boolean>(false); // 기본적으로 동선 선은 숨김
  const [showNames, setShowNames] = useState<boolean>(true); // 기본적으로 이름 툴팁 활성화
  const [hoveredChar, setHoveredChar] = useState<string | null>(null);

  const resetSquadReplayState = useCallback(() => {
    setTelemetry(null);
    setIsPlaying(false);
    setPlaybackTimeMs(0);
    setSelectedKnockIdx(0);
  }, []);

  // Check if mobile device
  useEffect(() => {
    const checkMobile = () => {
      setIsMobile(window.innerWidth < 768);
    };
    checkMobile();
    window.addEventListener("resize", checkMobile);
    return () => window.removeEventListener("resize", checkMobile);
  }, []);

  // Fetch telemetry caching data
  useEffect(() => {
    let active = true;
    const controller = new AbortController();
    async function loadTelemetry() {
      resetSquadReplayState();
      try {
        setLoading(true);
        setError(null);
        const telemetryPlatform = parseTelemetryPlatform(platform);
        const data = await fetchTelemetryPayload({
          matchId,
          nickname,
          platform: telemetryPlatform,
          mapName,
          mode: "full",
        }, { signal: controller.signal });
        if (active) {
          setTelemetry(data);
        }
      } catch (error: unknown) {
        if (controller.signal.aborted) return;
        if (active) {
          setError(error instanceof Error ? error.message : "리플레이 궤적 데이터를 불러오지 못했습니다.");
        }
      } finally {
        if (active) {
          setLoading(false);
        }
      }
    }
    loadTelemetry();
    return () => {
      active = false;
      controller.abort();
    };
  }, [matchId, nickname, platform, mapName, resetSquadReplayState]);

  // Sync selectedKnockIdx with focusTimeMs when telemetry or focusTimeMs changes
  useEffect(() => {
    if (!telemetry || !telemetry.events) return;
    
    const events = telemetry.events;
    const teammateKnocks = events.filter(
      (ev: any) => ev.type === "groggy" && ev.isTeamVictim
    );
    let knocks = teammateKnocks.sort(
      (a: any, b: any) => a.relativeTimeMs - b.relativeTimeMs
    );

    if (knocks.length === 0) {
      const teammateKills = events.filter(
        (ev: any) => ev.type === "kill" && ev.isTeamVictim
      );
      knocks = teammateKills.sort(
        (a: any, b: any) => a.relativeTimeMs - b.relativeTimeMs
      );
    }

    if (knocks.length === 0) {
      const attackerKnocks = events.filter(
        (ev: any) => ev.type === "groggy" && ev.isTeamAttacker
      );
      knocks = attackerKnocks.sort(
        (a: any, b: any) => a.relativeTimeMs - b.relativeTimeMs
      );
    }

    if (typeof focusTimeMs === "number" && focusTimeMs > 0) {
      const isClose = knocks.some(
        (k: any) => Math.abs(k.relativeTimeMs - focusTimeMs) <= 10000
      );
      
      if (!isClose) {
        const myPosEvs = events.filter(
          (ev: any) =>
            ev.type === "position" &&
            normalizeName(ev.name) === normalizeName(nickname)
        );
        const myRawPos = interpolateRawPosition(myPosEvs, focusTimeMs);
        
        const virtualKnock = {
          type: "focus_time",
          relativeTimeMs: focusTimeMs,
          victim: nickname,
          attacker: "원인 장면",
          weapon: "None",
          isTeamVictim: true,
          victimX: myRawPos?.x ?? 4096,
          victimY: myRawPos?.y ?? 4096,
          x: myRawPos?.x ?? 4096,
          y: myRawPos?.y ?? 4096,
        };
        knocks.push(virtualKnock);
        knocks.sort((a: any, b: any) => a.relativeTimeMs - b.relativeTimeMs);
      }
      
      let closestIdx = 0;
      let minDiff = Math.abs(knocks[0].relativeTimeMs - focusTimeMs);
      
      for (let i = 1; i < knocks.length; i++) {
        const diff = Math.abs(knocks[i].relativeTimeMs - focusTimeMs);
        if (diff < minDiff) {
          minDiff = diff;
          closestIdx = i;
        }
      }
      setSelectedKnockIdx(closestIdx);
    } else {
      setSelectedKnockIdx(0);
    }
  }, [telemetry, focusTimeMs, nickname]);

  // Compute 4-player paths & Groggy coordinates
  const mapData = useMemo(() => {
    if (!telemetry || !telemetry.events || telemetry.events.length === 0) return null;

    const events = telemetry.events;
    const teamNames = telemetry.teamNames || [nickname];

    // 1. Gather all teammate knocks (groggy as victim)
    const teammateKnocks = events.filter(
      (ev: any) => ev.type === "groggy" && ev.isTeamVictim
    );
    let knocks = teammateKnocks.sort(
      (a: any, b: any) => a.relativeTimeMs - b.relativeTimeMs
    );

    // Fallback 1: if no teammate knocks, check teammate kills (immediate deaths)
    if (knocks.length === 0) {
      const teammateKills = events.filter(
        (ev: any) => ev.type === "kill" && ev.isTeamVictim
      );
      knocks = teammateKills.sort(
        (a: any, b: any) => a.relativeTimeMs - b.relativeTimeMs
      );
    }

    // Fallback 2: teammate attacker groggy (kills we made)
    if (knocks.length === 0) {
      const attackerKnocks = events.filter(
        (ev: any) => ev.type === "groggy" && ev.isTeamAttacker
      );
      knocks = attackerKnocks.sort(
        (a: any, b: any) => a.relativeTimeMs - b.relativeTimeMs
      );
    }

    // Add virtual knock if focusTimeMs is not close to any existing knocks
    if (typeof focusTimeMs === "number" && focusTimeMs > 0) {
      const isClose = knocks.some(
        (k: any) => Math.abs(k.relativeTimeMs - focusTimeMs) <= 10000
      );
      
      if (!isClose) {
        const myPosEvs = events.filter(
          (ev: any) =>
            ev.type === "position" &&
            normalizeName(ev.name) === normalizeName(nickname)
        );
        const myRawPos = interpolateRawPosition(myPosEvs, focusTimeMs);
        
        const virtualKnock = {
          type: "focus_time",
          relativeTimeMs: focusTimeMs,
          victim: nickname,
          attacker: "원인 장면",
          weapon: "None",
          isTeamVictim: true,
          victimX: myRawPos?.x ?? 4096,
          victimY: myRawPos?.y ?? 4096,
          x: myRawPos?.x ?? 4096,
          y: myRawPos?.y ?? 4096,
        };
        knocks.push(virtualKnock);
        knocks.sort((a: any, b: any) => a.relativeTimeMs - b.relativeTimeMs);
      }
    }

    // Fallback 3: If absolutely nothing, create a dummy 300000ms knock event to prevent crash
    if (knocks.length === 0) {
      knocks = [{
        type: "groggy",
        relativeTimeMs: 300000,
        victim: nickname,
        attacker: "없음",
        weapon: "None",
        isTeamVictim: true,
      }];
    }

    // Identify current active knock event based on selector index
    const activeKnock = knocks[selectedKnockIdx] || knocks[0];
    const T = activeKnock.relativeTimeMs;

    // 2. Extract 4-players locations within T - 15s to T + 15s
    const startMs = Math.max(0, T - 15000);
    const endMs = T + 15000;

    // 기절 또는 포커스 이벤트 기준 상대 적의 닉네임을 식별합니다.
    const targetEnemyName = activeKnock
      ? (activeKnock.isTeamVictim ? activeKnock.attacker : activeKnock.victim)
      : null;

    // 해당 적의 teamId를 events에서 탐색하여 식별합니다.
    let targetEnemyTeamId: number | null = null;
    if (targetEnemyName) {
      const normTargetName = normalizeName(targetEnemyName);
      const enemyPosEv = events.find(
        (ev: any) =>
          ev.type === "position" &&
          normalizeName(ev.name) === normTargetName
      );
      if (enemyPosEv) {
        targetEnemyTeamId = enemyPosEv.teamId;
      }
    }

    // 30초 교전 구간 동안 아군과 직간접 교전을 주고받은 적군 명단 및 이들의 teamId 목록 수집
    const engagedEnemyNames = new Set<string>();
    const engagedEnemyTeamIds = new Set<number>();
    const teamNamesLower = new Set(teamNames.map((t: string) => normalizeName(t)));

    events.forEach((ev: any) => {
      if (ev.relativeTimeMs >= startMs && ev.relativeTimeMs <= endMs) {
        if (ev.type === "damage") {
          const attackerLower = normalizeName(ev.attackerName || "");
          const victimLower = normalizeName(ev.victimName || "");
          const isAttackerTeam = teamNamesLower.has(attackerLower);
          const isVictimTeam = teamNamesLower.has(victimLower);

          if (isAttackerTeam && !isVictimTeam && ev.victimName) {
            engagedEnemyNames.add(normalizeName(ev.victimName));
          } else if (!isAttackerTeam && isVictimTeam && ev.attackerName) {
            engagedEnemyNames.add(normalizeName(ev.attackerName));
          }
        } else if (ev.type === "groggy" || ev.type === "kill") {
          const attackerLower = normalizeName(ev.attacker || "");
          const victimLower = normalizeName(ev.victim || "");
          const isAttackerTeam = teamNamesLower.has(attackerLower);
          const isVictimTeam = teamNamesLower.has(victimLower);

          if (isAttackerTeam && !isVictimTeam && ev.victim) {
            engagedEnemyNames.add(normalizeName(ev.victim));
          } else if (!isAttackerTeam && isVictimTeam && ev.attacker) {
            engagedEnemyNames.add(normalizeName(ev.attacker));
          }
        }
      }
    });

    // 교전 참여한 적들의 teamId 탐색하여 수집 목록에 주입
    events.forEach((ev: any) => {
      if (ev.type === "position" && ev.name) {
        const normName = normalizeName(ev.name);
        if (engagedEnemyNames.has(normName) && ev.teamId !== undefined) {
          engagedEnemyTeamIds.add(ev.teamId);
        }
      }
    });

    if (targetEnemyTeamId !== null) {
      engagedEnemyTeamIds.add(targetEnemyTeamId);
    }

    const playerPaths = teamNames.map((name: string, idx: number) => {
      const posEvs = events.filter(
        (ev: any) =>
          ev.type === "position" &&
          normalizeName(ev.name) === normalizeName(name) &&
          ev.relativeTimeMs >= startMs &&
          ev.relativeTimeMs <= endMs
      );

      const coords: [number, number][] = posEvs.map((ev: any) => toLeafletCoords(ev.x, ev.y, mapName));

      return {
        name,
        color: COLORS[idx % COLORS.length],
        coords,
        posEvs,
      };
    });

    // 3. Extract nearby enemies around T-15s to T+15s (Filter out teamNames to avoid duplication or wrong mapping)
    const enemyPosEvents = events.filter(
      (ev: any) =>
        ev.type === "position" &&
        ev.isTeam === false &&
        !teamNames.some((tName: string) => normalizeName(tName) === normalizeName(ev.name)) &&
        ev.relativeTimeMs >= startMs &&
        ev.relativeTimeMs <= endMs
    );

    // Group enemy positions by name
    const enemyGroups = new Map<string, any[]>();
    enemyPosEvents.forEach((ev: any) => {
      const list = enemyGroups.get(ev.name) || [];
      list.push(ev);
      enemyGroups.set(ev.name, list);
    });

    const enemies = Array.from(enemyGroups.entries())
      .filter(([name]) => !activeKnock || name !== activeKnock.attacker)
      .map(([name, evs]) => {
        const sortedEvs = evs.sort((a, b) => a.relativeTimeMs - b.relativeTimeMs);
        const lastEv = sortedEvs[sortedEvs.length - 1];
        
        // 교전 상대 적 스쿼드의 teamId와 일치하는지 판정하여 같은 스쿼드 여부를 세팅합니다.
        const enemyTeamId = lastEv.teamId;
        const normName = normalizeName(name);
        const isSameSquad = (targetEnemyTeamId !== null && enemyTeamId === targetEnemyTeamId) ||
                            (enemyTeamId !== undefined && engagedEnemyTeamIds.has(enemyTeamId)) ||
                            engagedEnemyNames.has(normName);

        return {
          name,
          posEvs: sortedEvs,
          health: lastEv.health || 100,
          isSameSquad,
        };
      });

    // Extract attacker telemetry positions specifically
    let attackerPosEvs: any[] = [];
    if (activeKnock && activeKnock.attacker) {
      attackerPosEvs = events.filter(
        (ev: any) =>
          ev.type === "position" &&
          normalizeName(ev.name) === normalizeName(activeKnock.attacker) &&
          ev.relativeTimeMs >= startMs &&
          ev.relativeTimeMs <= endMs
      );
      attackerPosEvs.sort((a, b) => a.relativeTimeMs - b.relativeTimeMs);
    }

    // 4. Determine map bounds to fit the viewport perfectly
    const allCoords: [number, number][] = [];
    playerPaths.forEach((p: any) => {
      if (p.coords.length > 0) allCoords.push(...p.coords);
    });

    let mapBounds: [[number, number], [number, number]] = [[1000, 1000], [7192, 7192]];
    if (allCoords.length > 0) {
      const lats = allCoords.map((c) => c[0]);
      const lngs = allCoords.map((c) => c[1]);
      const minLat = Math.min(...lats);
      const maxLat = Math.max(...lats);
      const minLng = Math.min(...lngs);
      const maxLng = Math.max(...lngs);
      
      const enemyCoords = enemies.flatMap(e => e.posEvs.map(pe => toLeafletCoords(pe.x, pe.y, mapName)));
      const enemyLats = enemyCoords.map(c => c[0]);
      const enemyLngs = enemyCoords.map(c => c[1]);
      
      const minLatVal = Math.min(minLat, enemyLats.length > 0 ? Math.min(...enemyLats) : minLat);
      const maxLatVal = Math.max(maxLat, enemyLats.length > 0 ? Math.max(...enemyLats) : maxLat);
      const minLngVal = Math.min(minLng, enemyLngs.length > 0 ? Math.min(...enemyLngs) : minLng);
      const maxLngVal = Math.max(maxLng, enemyLngs.length > 0 ? Math.max(...enemyLngs) : maxLng);

      const centerLat = (minLatVal + maxLatVal) / 2;
      const centerLng = (minLngVal + maxLngVal) / 2;
      
      // 줌 크기가 제각각인 현상을 해결하기 위해 최소 뷰 포트 너비(MIN_VIEW_SIZE) 강제
      // PUBG 전장 8192x8192 스케일 대비 약 18% 넓이인 1500 유닛을 최솟값으로 잡음
      const MIN_VIEW_SIZE = 1500;
      const latDiff = Math.max(MIN_VIEW_SIZE, maxLatVal - minLatVal);
      const lngDiff = Math.max(MIN_VIEW_SIZE, maxLngVal - minLngVal);

      // 여유 마진 (35%)
      const latMargin = latDiff * 0.35;
      const lngMargin = lngDiff * 0.35;

      mapBounds = [
        [Math.max(0, centerLat - latDiff / 2 - latMargin), Math.max(0, centerLng - lngDiff / 2 - lngMargin)],
        [Math.min(8192, centerLat + latDiff / 2 + latMargin), Math.min(8192, centerLng + lngDiff / 2 + lngMargin)],
      ];
    }

    const combatEvents = events.filter(
      (ev: any) =>
        (ev.type === "groggy" || ev.type === "kill") &&
        ev.relativeTimeMs >= startMs &&
        ev.relativeTimeMs <= endMs
    );

    return {
      paths: playerPaths,
      firstKnock: activeKnock,
      bounds: mapBounds,
      enemies,
      attackerPosEvs,
      knocks,
      combatEvents,
    };
  }, [telemetry, nickname, selectedKnockIdx, focusTimeMs, mapName]);

  // Extract variables for easier access
  const T = mapData?.firstKnock?.relativeTimeMs ?? 0;
  const startMs = Math.max(0, T - 15000);
  const endMs = T + 15000;

  // 기절 발생 지점(교전지) 또는 전체 Bounds로부터 최초 center와 zoom을 구함
  const initialCenterAndZoom = useMemo(() => {
    if (mapData?.firstKnock) {
      const fk = mapData.firstKnock;
      if (fk.victimY !== undefined && fk.victimX !== undefined) {
        return { center: toLeafletCoords(fk.victimX, fk.victimY, mapName), zoom: -1 };
      }
      if (fk.y !== undefined && fk.x !== undefined) {
        return { center: toLeafletCoords(fk.x, fk.y, mapName), zoom: -1 };
      }
    }
    const b = mapData?.bounds;
    if (!b) return { center: [4096, 4096] as [number, number], zoom: -1 };
    const centerLat = (b[0][0] + b[1][0]) / 2;
    const centerLng = (b[0][1] + b[1][1]) / 2;
    return {
      center: [centerLat, centerLng] as [number, number],
      zoom: -1
    };
  }, [mapData, mapName]);

  // 실시간으로 변경되는 교전지의 실제 기절 발생 중심점 추적
  const currentCenter = useMemo(() => {
    if (mapData?.firstKnock) {
      const fk = mapData.firstKnock;
      if (fk.victimY !== undefined && fk.victimX !== undefined) {
        return toLeafletCoords(fk.victimX, fk.victimY, mapName);
      }
      if (fk.y !== undefined && fk.x !== undefined) {
        return toLeafletCoords(fk.x, fk.y, mapName);
      }
    }
    const b = mapData?.bounds;
    if (!b) return [4096, 4096] as [number, number];
    const centerLat = (b[0][0] + b[1][0]) / 2;
    const centerLng = (b[0][1] + b[1][1]) / 2;
    return [centerLat, centerLng] as [number, number];
  }, [mapData, mapName]);

  // Reset playback time when active knock event changes
  useEffect(() => {
    if (mapData && mapData.firstKnock) {
      setPlaybackTimeMs(startMs);
      setIsPlaying(false);
    }
  }, [selectedKnockIdx, startMs, mapData]);

  // Playback timer effect using requestAnimationFrame
  useEffect(() => {
    if (!isPlaying || !mapData || !mapData.firstKnock) return;

    let lastTime = performance.now();
    let animationFrameId: number;

    const tick = (now: number) => {
      const elapsed = now - lastTime;
      lastTime = now;

      setPlaybackTimeMs((prev) => {
        const next = prev + elapsed * playbackSpeed;
        if (next >= endMs) {
          setIsPlaying(false);
          return endMs;
        }
        return next;
      });

      animationFrameId = requestAnimationFrame(tick);
    };

    animationFrameId = requestAnimationFrame(tick);
    return () => {
      cancelAnimationFrame(animationFrameId);
    };
  }, [isPlaying, playbackSpeed, endMs, mapData]);

  // 실시간 0.4초 동안 유지되며 페이드아웃되는 사격선(탄도선) 계산
  const activeShotLines = useMemo(() => {
    if (!telemetry || !telemetry.events) return [];
    const events = telemetry.events;

    return events
      .filter((ev: any) => {
        if (ev.type !== "damage") return false;
        const diff = playbackTimeMs - ev.relativeTimeMs;
        return diff >= 0 && diff < 400; // 0.4초 동안 선 유지
      })
      .map((ev: any, idx: number) => {
        if (!ev.attackerX || !ev.attackerY || !ev.x || !ev.y) return null;

        const start = toLeafletCoords(ev.attackerX, ev.attackerY, mapName);
        const end = toLeafletCoords(ev.x, ev.y, mapName);
        const diff = playbackTimeMs - ev.relativeTimeMs;
        const opacity = Math.max(0.1, 1 - diff / 400);

        const attackerLower = normalizeName(ev.attackerName || "");
        const teamNamesLower = new Set(
          (telemetry.teamNames || []).map((t: string) => normalizeName(t))
        );
        const isOurTeamAttack = teamNamesLower.size > 0 
          ? teamNamesLower.has(attackerLower)
          : normalizeName(nickname) === attackerLower;

        // 아군이 공격할 때는 녹색 사격선, 적군이 공격할 때는 적색 사격선
        const color = isOurTeamAttack ? "#22c55e" : "#ef4444";

        return (
          <Polyline
            key={`shotline-${ev.relativeTimeMs}-${idx}-${playbackTimeMs}`}
            positions={[start, end]}
            color={color}
            weight={3.5}
            opacity={opacity}
            interactive={false}
            pane="tooltipPane"
          />
        );
      })
      .filter(Boolean);
  }, [telemetry, playbackTimeMs, mapName, nickname]);

  // 4. Calculate active combat markers to overlay (within 3 seconds of occurrence)
  const activeCombatMarkers = useMemo(() => {
    if (!mapData || !mapData.combatEvents) return [];
    
    return mapData.combatEvents
      .map((ev: any, idx: number) => {
        const diff = playbackTimeMs - ev.relativeTimeMs;
        if (diff < 0 || diff >= 3000) return null; // 발생 후 3초간 표시
        if (!ev.victimX || !ev.victimY) return null;
        
        const pos = toLeafletCoords(ev.victimX, ev.victimY, mapName);
        const isKill = ev.type === "kill";
        const isOurTeamAttack = ev.isTeamAttacker === true;
        const isOurTeamVictim = ev.isTeamVictim === true;
        
        let iconHtml = "";
        let tooltipClass = "";
        let text = "";
        
        if (isKill) {
          if (isOurTeamAttack) {
            // 아군이 적을 처치함 (킬)
            iconHtml = `
              <div class="relative flex items-center justify-center z-[2000]">
                <div class="absolute w-8 h-8 bg-green-500 rounded-full opacity-40 animate-ping"></div>
                <div class="relative w-6.5 h-6.5 bg-green-600 border border-white rounded-full flex items-center justify-center font-bold text-white shadow-lg text-[10px]">${targetMarkerSvg}</div>
              </div>
            `;
            tooltipClass = "!bg-green-950/95 !border-green-800 !text-green-300";
            text = `[아군 킬] ${ev.attacker} ➔ ${ev.victim} 사망 (${getTranslatedWeaponName(ev.weapon)})`;
          } else {
            // 적이 다른 적을 처치하거나, 아군이 사망함
            iconHtml = `
              <div class="relative flex items-center justify-center z-[2000]">
                <div class="absolute w-7 h-7 bg-zinc-500 rounded-full opacity-35 animate-pulse"></div>
                <div class="relative w-5.5 h-5.5 bg-zinc-700 border border-zinc-500 rounded-full flex items-center justify-center font-bold text-zinc-300 shadow-md text-[9px]">${skullMarkerSvg}</div>
              </div>
            `;
            tooltipClass = "!bg-zinc-950/95 !border-zinc-800 !text-zinc-400";
            text = `[사망] ${ev.victim} (${getCleanAttackerName(ev.attacker)})`;
          }
        } else { // groggy (기절)
          if (isOurTeamVictim) {
            // 아군이 기절함
            iconHtml = `
              <div class="relative flex items-center justify-center z-[2000]">
                <div class="absolute w-8 h-8 bg-red-500 rounded-full opacity-40 animate-ping"></div>
                <div class="relative w-6 h-6 bg-red-600 border border-white rounded-full flex items-center justify-center font-bold text-white shadow-lg text-[10px]">${alertMarkerSvg}</div>
              </div>
            `;
            tooltipClass = "!bg-red-950/95 !border-red-800 !text-red-300";
            text = `[아군 기절] ${ev.victim} 다운! (공격: ${getCleanAttackerName(ev.attacker)})`;
          } else {
            // 적이 기절함
            iconHtml = `
              <div class="relative flex items-center justify-center z-[2000]">
                <div class="absolute w-7 h-7 bg-amber-500 rounded-full opacity-30 animate-pulse"></div>
                <div class="relative w-5.5 h-5.5 bg-amber-600 border border-white rounded-full flex items-center justify-center font-bold text-white shadow-md text-[9px]">${impactMarkerSvg}</div>
              </div>
            `;
            tooltipClass = "!bg-amber-950/95 !border-amber-800 !text-amber-300";
            text = `[적 기절] ${ev.victim} 다운! (공격: ${getCleanAttackerName(ev.attacker)})`;
          }
        }
        
        const combatIcon = L.divIcon({
          html: iconHtml,
          className: "custom-combat-event-marker",
          iconSize: [24, 24],
          iconAnchor: [12, 12],
        });
        
        return (
          <Marker key={`combat-${ev.type}-${ev.victim}-${idx}`} position={pos} icon={combatIcon}>
            <Tooltip permanent direction="top" offset={[0, -10]} className={`custom-map-tooltip !text-[8.5px] !px-2 !py-0.8 !rounded shadow-xl font-bold ${tooltipClass}`}>
              {text}
            </Tooltip>
          </Marker>
        );
      })
      .filter(Boolean);
  }, [mapData, playbackTimeMs, mapName]);

  if (loading) {
    return (
      <div className="flex h-64 items-center justify-center rounded-xl border border-zinc-800 bg-zinc-950/20">
        <Loader2 className="h-6 w-6 animate-spin text-purple-500" />
        <span className="ml-2 text-xs text-zinc-400">교전 위치 및 동선을 불러오는 중...</span>
      </div>
    );
  }

  if (error || !mapData) {
    return (
      <div className="flex h-64 flex-col items-center justify-center rounded-xl border border-zinc-800 bg-zinc-950/20 p-4 text-center">
        <ShieldAlert className="h-8 w-8 text-zinc-600 mb-2" />
        <p className="text-xs text-zinc-400">동선 리플레이 데이터를 로드하지 못했습니다.</p>
        <p className="text-[10px] text-zinc-500 mt-1">
          {error || "해당 경기의 텔레메트리 파일 분석 기록이 유실되었거나 누락되었습니다."}
        </p>
      </div>
    );
  }

  const { paths, firstKnock, enemies, knocks, attackerPosEvs } = mapData;

  // 1. 재생 시점 기준 아군들의 실시간 위치 및 상태 계산
  const computedPlayers = paths.map((p: any) => {
    const pos = interpolatePosition(p.posEvs, playbackTimeMs, mapName);
    const status = getPlayerStatusAtTime(telemetry.events, p.name, playbackTimeMs);
    const vehicleId = getVehicleIdAtTime(p.posEvs, playbackTimeMs);
    return {
      ...p,
      currentPos: pos,
      status,
      vehicleId,
    };
  });

  // 2. 재생 시점 기준 공격자의 실시간 위치 계산
  const attackerCurrentPos = firstKnock && firstKnock.attacker
    ? interpolatePosition(attackerPosEvs, playbackTimeMs, mapName)
    : null;

  // 3. 재생 시점 기준 주변 적들의 실시간 위치 및 상태 계산
  const computedEnemies = enemies.map((e: any) => {
    const pos = interpolatePosition(e.posEvs, playbackTimeMs, mapName);
    const status = getPlayerStatusAtTime(telemetry.events, e.name, playbackTimeMs);
    const vehicleId = getVehicleIdAtTime(e.posEvs, playbackTimeMs);
    return {
      ...e,
      currentPos: pos,
      status,
      vehicleId,
    };
  });

  // 4. 초근접 교전 시 이름 툴팁 가려짐 방지를 위한 캐릭터 간 거리 계산 (35미터 이내 시 permanent=false로 마우스 호버 노출 전환)
  const activeCharacters: { name: string; pos: [number, number] }[] = [];

  computedPlayers.forEach((p: any) => {
    if (p.currentPos && p.status !== "dead") {
      activeCharacters.push({ name: p.name, pos: p.currentPos });
    }
  });

  computedEnemies.forEach((e: any) => {
    if (e.currentPos && e.status !== "dead" && e.isSameSquad) {
      activeCharacters.push({ name: e.name, pos: e.currentPos });
    }
  });

  if (
    firstKnock &&
    firstKnock.attacker &&
    attackerCurrentPos &&
    playbackTimeMs >= T &&
    firstKnock.type !== "focus_time"
  ) {
    if (!activeCharacters.some((c) => normalizeName(c.name) === normalizeName(firstKnock.attacker))) {
      activeCharacters.push({ name: firstKnock.attacker, pos: attackerCurrentPos });
    }
  }

  const proximityMap = new Map<string, boolean>();
  for (let i = 0; i < activeCharacters.length; i++) {
    const charA = activeCharacters[i];
    let isTooClose = false;
    for (let j = 0; j < activeCharacters.length; j++) {
      if (i === j) continue;
      const charB = activeCharacters[j];
      const dist = Math.sqrt(
        Math.pow(charA.pos[0] - charB.pos[0], 2) + Math.pow(charA.pos[1] - charB.pos[1], 2)
      );
      if (dist <= 60) {
        isTooClose = true;
        break;
      }
    }
    proximityMap.set(normalizeName(charA.name), isTooClose);
  }

  // 5. 아군 마커 목록 생성
  const playerMarkers = computedPlayers
    .map((p: any) => {
      if (!p.currentPos || p.status === "dead") return null;

      const isInVehicle = !!p.vehicleId;
      const badgeHtml = isInVehicle 
        ? `<div class="absolute -bottom-1 -right-1 w-3.5 h-3.5 bg-zinc-950 border border-zinc-800 rounded-full flex items-center justify-center text-[8px] shadow-md z-[1001]">${vehicleMarkerSvg}</div>`
        : "";

      const isGroggy = p.status === "groggy";
      const playerIcon = L.divIcon({
        html: isGroggy
          ? `
            <div class="relative flex items-center justify-center">
              <div class="absolute w-6 h-6 bg-red-600 rounded-full opacity-40 animate-ping"></div>
              <div class="w-4.5 h-4.5 rounded-full border border-red-500 shadow-md flex items-center justify-center font-bold text-[9px] bg-red-950 text-red-200">
                ${skullMarkerSvg}
              </div>
              ${badgeHtml}
            </div>
          `
          : `
            <div class="relative flex items-center justify-center">
              <div class="w-4.5 h-4.5 rounded-full border border-white shadow-md flex items-center justify-center font-bold text-[9px] text-white" style="background-color: ${p.color};">
                ${p.name.slice(0, 1).toUpperCase()}
              </div>
              ${badgeHtml}
            </div>
          `,
        className: "custom-player-marker",
        iconSize: [18, 18],
        iconAnchor: [9, 9],
      });

      const isTooClose = proximityMap.get(normalizeName(p.name)) || false;
      const isHovered = hoveredChar && normalizeName(hoveredChar) === normalizeName(p.name);
      const shouldShowTooltip = showNames && (!isTooClose || isHovered);

      return (
        <Marker 
          key={p.name} 
          position={p.currentPos} 
          icon={playerIcon}
          eventHandlers={{
            mouseover: () => setHoveredChar(p.name),
            mouseout: () => setHoveredChar(null)
          }}
        >
          {shouldShowTooltip && (
            <Tooltip permanent direction="top" offset={[0, -9]} className={`custom-map-tooltip !border-zinc-800 !text-[8px] !px-1.5 !py-0.5 !rounded shadow-lg ${
              isGroggy ? "!bg-red-950 !text-red-300 !border-red-900" : "!bg-zinc-950 !text-zinc-200"
            }`}>
              {isGroggy ? `[기절] ${p.name}` : p.name}
            </Tooltip>
          )}
        </Marker>
      );
    })
    .filter(Boolean);

  // 6. 기절 유발선 및 해당 공격자 마커 생성
  let attackLine = null;
  let enemyMarker = null;

  if (firstKnock && firstKnock.victimY && firstKnock.victimX && firstKnock.type !== "focus_time") {
    const isVictimInPlayers = computedPlayers.find(
      (p: any) => normalizeName(p.name) === normalizeName(firstKnock.victim)
    );
    const victimPos = (playbackTimeMs >= T && isVictimInPlayers?.currentPos)
      ? isVictimInPlayers.currentPos
      : toLeafletCoords(firstKnock.victimX, firstKnock.victimY, mapName);

    const attackerPos = attackerCurrentPos || toLeafletCoords(firstKnock.x, firstKnock.y, mapName);
    const attackerVehicleId = getVehicleIdAtTime(attackerPosEvs, playbackTimeMs);
    const attackerIsInVehicle = !!attackerVehicleId;
    const attackerBadgeHtml = attackerIsInVehicle 
      ? `<div class="absolute -bottom-1 -right-1 w-3.5 h-3.5 bg-zinc-950 border border-zinc-800 rounded-full flex items-center justify-center text-[8px] shadow-md z-[1001]">${vehicleMarkerSvg}</div>`
      : "";

    if (playbackTimeMs >= T) {
      attackLine = (
        <Polyline
          positions={[victimPos, attackerPos]}
          color="#ef4444"
          weight={1.5}
          dashArray="4, 4"
          interactive={false}
        />
      );

      const attackerIcon = L.divIcon({
        html: `
          <div class="relative flex items-center justify-center">
            <div class="absolute w-7 h-7 bg-red-600 rounded-full opacity-40 animate-ping"></div>
            <div class="relative w-6 h-6 bg-red-950 border-2 border-red-500 rounded-full flex items-center justify-center font-extrabold text-red-200 text-[10px] shadow-[0_0_10px_rgba(239,68,68,0.9)]">적</div>
            ${attackerBadgeHtml}
          </div>
        `,
        className: "custom-enemy-marker-alert",
        iconSize: [24, 24],
        iconAnchor: [12, 12],
      });

      const isTooClose = proximityMap.get(normalizeName(firstKnock.attacker)) || false;
      const isHovered = hoveredChar && normalizeName(hoveredChar) === normalizeName(firstKnock.attacker);
      const shouldShowTooltip = showNames && (!isTooClose || isHovered);

      enemyMarker = (
        <Marker 
          position={attackerPos} 
          icon={attackerIcon}
          eventHandlers={{
            mouseover: () => setHoveredChar(firstKnock.attacker),
            mouseout: () => setHoveredChar(null)
          }}
        >
          {shouldShowTooltip && (
            <Tooltip permanent direction="top" offset={[0, -10]} className="custom-map-tooltip !bg-zinc-950 !border-red-800 !text-red-300 !text-[8px] !px-1.5 !py-0.5 shadow-lg">
              적: {firstKnock.attacker} ({getTranslatedWeaponName(firstKnock.weapon)})
            </Tooltip>
          )}
        </Marker>
      );
    } else if (firstKnock.attacker) {
      const standardAttackerIcon = L.divIcon({
        html: `
          <div class="relative flex items-center justify-center">
            <div class="absolute w-6 h-6 bg-red-500 rounded-full opacity-40 animate-ping"></div>
            <div class="relative w-5.5 h-5.5 bg-red-950 border-2 border-red-500 rounded-full flex items-center justify-center font-extrabold text-red-200 text-[9px] shadow-[0_0_8px_rgba(239,68,68,0.8)]">적</div>
            ${attackerBadgeHtml}
          </div>
        `,
        className: "custom-enemy-marker",
        iconSize: [22, 22],
        iconAnchor: [11, 11],
      });

      const isTooClose = proximityMap.get(normalizeName(firstKnock.attacker)) || false;
      const isHovered = hoveredChar && normalizeName(hoveredChar) === normalizeName(firstKnock.attacker);
      const shouldShowTooltip = showNames && (!isTooClose || isHovered);

      enemyMarker = (
        <Marker 
          position={attackerPos} 
          icon={standardAttackerIcon}
          eventHandlers={{
            mouseover: () => setHoveredChar(firstKnock.attacker),
            mouseout: () => setHoveredChar(null)
          }}
        >
          {shouldShowTooltip && (
            <Tooltip permanent direction="top" offset={[0, -8]} className="custom-map-tooltip !bg-zinc-950 !border-zinc-800 !text-zinc-200 !text-[8px] !px-1.5 !py-0.5 shadow-md">
              적: {firstKnock.attacker}
            </Tooltip>
          )}
        </Marker>
      );
    }
  }

  // 7. 실제 기절 고정 핀 마커 생성
  let groggyMarker = null;
  if (firstKnock && firstKnock.victimY && firstKnock.victimX && playbackTimeMs >= T && firstKnock.type !== "focus_time") {
    const isVictimInPlayers = computedPlayers.find(
      (p: any) => normalizeName(p.name) === normalizeName(firstKnock.victim)
    );
    const victimPos = isVictimInPlayers?.currentPos || toLeafletCoords(firstKnock.victimX, firstKnock.victimY, mapName);

    const isTooClose = proximityMap.get(normalizeName(firstKnock.victim)) || false;
    const isHovered = hoveredChar && normalizeName(hoveredChar) === normalizeName(firstKnock.victim);
    const shouldShowTooltip = showNames && (!isTooClose || isHovered);

    groggyMarker = (
      <Marker 
        position={victimPos} 
        icon={groggyIcon}
        eventHandlers={{
          mouseover: () => setHoveredChar(firstKnock.victim),
          mouseout: () => setHoveredChar(null)
        }}
      >
        {shouldShowTooltip && (
          <Tooltip permanent direction="bottom" offset={[0, 12]} className="custom-map-tooltip !bg-red-950/90 !border-red-800 !text-red-200 !text-[8px] !px-1.5 !py-0.5 shadow-lg">
            {firstKnock.victim} 기절 (공격: {getCleanAttackerName(firstKnock.attacker)} - {getTranslatedWeaponName(firstKnock.weapon)})
          </Tooltip>
        )}
      </Marker>
    );
  }

  // 8. 교전 상대 적군 마커 목록 생성
  const enemyMarkers = computedEnemies
    .map((e: any) => {
      if (!e.currentPos || e.status === "dead") return null;

      if (!e.isSameSquad) return null;

      const isInVehicle = !!e.vehicleId;
      const badgeHtml = isInVehicle 
        ? `<div class="absolute -bottom-1 -right-1 w-3.5 h-3.5 bg-zinc-950 border border-zinc-800 rounded-full flex items-center justify-center text-[8px] shadow-md z-[1001]">${vehicleMarkerSvg}</div>`
        : "";

      const isGroggy = e.status === "groggy";
      const customIcon = L.divIcon({
        html: isGroggy
          ? `
            <div class="relative flex items-center justify-center">
              <div class="absolute w-6 h-6 bg-red-500 rounded-full opacity-40 animate-ping"></div>
              <div class="relative w-5.5 h-5.5 bg-red-950 border-2 border-red-500 rounded-full flex items-center justify-center font-extrabold text-red-200 text-[9px] shadow-[0_0_8px_rgba(239,68,68,0.8)]">${skullMarkerSvg}</div>
              ${badgeHtml}
            </div>
          `
          : `
              <div class="relative flex items-center justify-center">
                <div class="absolute w-6 h-6 bg-red-500 rounded-full opacity-40 animate-ping"></div>
                <div class="relative w-5.5 h-5.5 bg-red-950 border-2 border-red-500 rounded-full flex items-center justify-center font-extrabold text-red-200 text-[9px] shadow-[0_0_8px_rgba(239,68,68,0.8)]">적</div>
                ${badgeHtml}
              </div>
            `,
        className: "custom-enemy-marker",
        iconSize: [22, 22],
        iconAnchor: [11, 11],
      });

      const isTooClose = proximityMap.get(normalizeName(e.name)) || false;
      const isHovered = hoveredChar && normalizeName(hoveredChar) === normalizeName(e.name);
      const shouldShowTooltip = showNames && (!isTooClose || isHovered);

      return (
        <Marker 
          key={`enemy-${e.name}`} 
          position={e.currentPos} 
          icon={customIcon}
          eventHandlers={{
            mouseover: () => setHoveredChar(e.name),
            mouseout: () => setHoveredChar(null)
          }}
        >
          {shouldShowTooltip && (
            <Tooltip permanent direction="top" offset={[0, -7]} className="custom-map-tooltip !text-[8px] !px-1.5 !py-0.5 !rounded shadow-md !bg-red-950/90 !border-red-800 !text-red-200">
              적: {e.name} (HP {Math.round(e.health)})
            </Tooltip>
          )}
        </Marker>
      );
    })
    .filter(Boolean);

  // Time format helper for current playback status
  const relativeSec = ((playbackTimeMs - T) / 1000).toFixed(1);
  const formattedSec = Number(relativeSec) >= 0 ? `+${relativeSec}s` : `${relativeSec}s`;

  return (
    <div className="w-full rounded-xl overflow-hidden border border-zinc-800/80 bg-zinc-950 shadow-inner">
      <style>{`
        .custom-player-marker,
        .custom-enemy-marker,
        .custom-other-enemy-marker,
        .custom-enemy-marker-alert {
          transition: transform 0.2s cubic-bezier(0.25, 0.46, 0.45, 0.94) !important;
          will-change: transform;
        }
      `}</style>
      {/* Groggy Event Selector Tab */}
      {knocks && knocks.length > 1 && (
        <div className="px-4 pt-4 pb-2 bg-zinc-900/40 border-b border-zinc-800/80 flex flex-col gap-2">
          <span className="text-[9px] font-black text-zinc-400 uppercase tracking-widest">교전 순간 선택기</span>
          <div className="flex gap-2 overflow-x-auto pb-1 scrollbar-none whitespace-nowrap">
            {knocks.map((k: any, idx: number) => {
              const minutes = Math.floor(k.relativeTimeMs / 60000);
              const seconds = Math.floor((k.relativeTimeMs % 60000) / 1000);
              const timeStr = `${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`;
              const weaponName = getTranslatedWeaponName(k.weapon);
              const isSelected = selectedKnockIdx === idx;

              return (
                <button
                  key={idx}
                  onClick={() => setSelectedKnockIdx(idx)}
                  className={`inline-flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-[10px] font-bold transition-all border cursor-pointer ${
                    isSelected
                      ? "bg-purple-600/20 border-purple-500 text-purple-300 shadow-md shadow-purple-500/5"
                      : "bg-zinc-950/60 border-zinc-800 text-zinc-400 hover:text-zinc-200"
                  }`}
                >
                  <span className="text-[9px] font-black opacity-75">{timeStr}</span>
                  {k.type === "focus_time" ? (
                    <span className="font-extrabold text-purple-400 inline-flex items-center gap-1">
                      <Zap className="h-3 w-3" /> 원인 장면 분석 시점
                    </span>
                  ) : (
                    <>
                      <span className="font-extrabold">{k.victim} 기절</span>
                      <span className="text-[9px] opacity-75">(공격: {getCleanAttackerName(k.attacker)} - {weaponName})</span>
                    </>
                  )}
                </button>
              );
            })}
          </div>
        </div>
      )}

      <div className="h-[280px] sm:h-[360px] w-full relative">
        <div className="absolute top-3 left-3 z-[1000] bg-zinc-900/85 backdrop-blur-sm border border-zinc-800 px-2.5 py-1.5 rounded-lg pointer-events-none flex flex-col gap-0.5">
          <h6 className="text-[10px] font-bold text-zinc-200 flex items-center gap-1.5">
            <span className={`h-1.5 w-1.5 rounded-full ${isPlaying ? "bg-green-500 animate-pulse" : "bg-zinc-500"}`} />
            교전 2D 리플레이 {isPlaying ? "재생 중" : "일시정지"}
          </h6>
          <p className="text-[8px] text-zinc-400">기절 순간 전후 15초 리플레이 시뮬레이션</p>
        </div>

        <div className="absolute top-3 right-3 z-[1000] bg-purple-600/90 text-purple-100 font-mono text-[10px] font-black px-2 py-1 rounded border border-purple-500 shadow-lg pointer-events-none flex items-center gap-1">
          <span className="opacity-60">기절 기준:</span>
          <span>{formattedSec}</span>
        </div>

        <MapContainer
          center={initialCenterAndZoom.center}
          zoom={initialCenterAndZoom.zoom}
          crs={CRS.Simple}
          maxBounds={[[0, 0], [8192, 8192]]}
          style={{ height: "100%", width: "100%" }}
          zoomControl={!isMobile}
          dragging={!isMobile}
          scrollWheelZoom={!isMobile}
          doubleClickZoom={!isMobile}
          touchZoom={!isMobile}
        >
          <MapUpdater center={currentCenter} />
          <TileLayer
            url={`/tiles/${getTileMapName(mapName)}/{z}/{x}/{y}.jpg`}
            minZoom={-5}
            maxZoom={2}
            maxNativeZoom={0}
            zoomOffset={5}
            bounds={[[0, 0], [8192, 8192]]}
            noWrap={true}
          />

          {/* Render paths if showPaths is enabled */}
          {showPaths && paths.map((p: any) => (
            <Polyline
              key={`line-${p.name}`}
              positions={p.coords}
              color={p.color}
              weight={2}
              opacity={0.3}
              interactive={false}
            />
          ))}

          {/* Render active shot lines */}
          {activeShotLines}

          {/* Groggy / Attack Line */}
          {groggyMarker}
          {attackLine}
          {enemyMarker}

          {/* Render active combat event markers */}
          {activeCombatMarkers}

          {/* Render nearby enemies */}
          {enemyMarkers}

          {/* Players Markers */}
          {playerMarkers}
        </MapContainer>
      </div>

      {/* Modern Glassmorphic Replay Control Panel */}
      <div className="bg-zinc-900/90 border-t border-zinc-800/80 px-4 py-3 flex flex-col gap-3">
        {/* Timeline Slider and Status */}
        <div className="flex items-center gap-3">
          <span className="font-mono text-[9px] text-zinc-500 font-bold">-15.0s</span>
          <input
            type="range"
            min={startMs}
            max={endMs}
            value={playbackTimeMs}
            onChange={(e) => {
              setIsPlaying(false); // 드래그 시 일시정지
              setPlaybackTimeMs(Number(e.target.value));
            }}
            className="flex-1 h-1 bg-zinc-800 rounded-lg appearance-none cursor-pointer accent-purple-500 hover:accent-purple-400 transition-all outline-none"
            style={{
              background: `linear-gradient(to right, #a855f7 0%, #a855f7 ${((playbackTimeMs - startMs) / (endMs - startMs)) * 100}%, #27272a ${((playbackTimeMs - startMs) / (endMs - startMs)) * 100}%, #27272a 100%)`
            }}
          />
          <span className="font-mono text-[9px] text-zinc-500 font-bold">+15.0s</span>
        </div>

        {/* Buttons Controls */}
        <div className="flex flex-wrap items-center justify-between gap-3">
          {/* Play/Pause & Restart */}
          <div className="flex items-center gap-2">
            <button
              onClick={() => setIsPlaying(!isPlaying)}
              className="inline-flex h-7 items-center justify-center gap-1.5 rounded-lg bg-zinc-950 border border-zinc-800 px-3 py-1 text-[10px] font-bold text-zinc-300 hover:text-white hover:border-zinc-700 transition-all shadow-sm cursor-pointer"
            >
              {isPlaying ? (
                <>
                  <Pause className="h-3 w-3 text-purple-400 fill-purple-400" />
                  일시정지
                </>
              ) : (
                <>
                  <Play className="h-3 w-3 text-green-400 fill-green-400" />
                  재생하기
                </>
              )}
            </button>

            <button
              onClick={() => {
                setPlaybackTimeMs(startMs);
                setIsPlaying(true);
              }}
              title="처음부터 다시 재생"
              className="inline-flex h-7 w-7 items-center justify-center rounded-lg bg-zinc-950 border border-zinc-800 text-zinc-400 hover:text-white hover:border-zinc-700 transition-all shadow-sm cursor-pointer"
            >
              <RotateCcw className="h-3 w-3" />
            </button>
          </div>

          {/* Speed Selectors */}
          <div className="flex items-center gap-1 bg-zinc-950 rounded-lg p-0.5 border border-zinc-800/80">
            {[1, 2, 4].map((speed) => (
              <button
                key={speed}
                onClick={() => setPlaybackSpeed(speed)}
                className={`px-2 py-0.5 rounded-md text-[9px] font-black transition-all cursor-pointer ${
                  playbackSpeed === speed
                    ? "bg-purple-600 text-white font-extrabold shadow-sm"
                    : "text-zinc-500 hover:text-zinc-300"
                }`}
              >
                {speed}x
              </button>
            ))}
          </div>

          {/* Path Line Toggle & Teammates Indicator */}
          <div className="flex items-center gap-3 ml-auto">
            {/* Show Paths Switch */}
            <button
              onClick={() => setShowPaths(!showPaths)}
              className={`inline-flex h-7 items-center gap-1.5 rounded-lg px-2.5 text-[9px] font-bold border transition-all cursor-pointer ${
                showPaths
                  ? "bg-purple-950/40 border-purple-500/50 text-purple-300"
                  : "bg-zinc-950 border-zinc-800 text-zinc-500 hover:text-zinc-400"
              }`}
            >
              {showPaths ? (
                <>
                  <Eye className="h-3 w-3" />
                  동선 켬
                </>
              ) : (
                <>
                  <EyeOff className="h-3 w-3" />
                  동선 끔
                </>
              )}
            </button>

            {/* Show Names Switch */}
            <button
              onClick={() => setShowNames(!showNames)}
              className={`inline-flex h-7 items-center gap-1.5 rounded-lg px-2.5 text-[9px] font-bold border transition-all cursor-pointer ${
                showNames
                  ? "bg-purple-950/40 border-purple-500/50 text-purple-300"
                  : "bg-zinc-950 border-zinc-800 text-zinc-500 hover:text-zinc-400"
              }`}
            >
              {showNames ? (
                <>
                  <Eye className="h-3 w-3" />
                  이름 켬
                </>
              ) : (
                <>
                  <EyeOff className="h-3 w-3" />
                  이름 끔
                </>
              )}
            </button>

            {/* Players Dot Indicators */}
            <div className="hidden sm:flex items-center gap-2.5 border-l border-zinc-800 pl-3">
              {paths.map((p: any) => (
                <div key={p.name} className="flex items-center gap-1 text-[8px] text-zinc-400 font-bold">
                  <span className="w-1.5 h-1.5 rounded-full" style={{ backgroundColor: p.color }} />
                  <span>{p.name.slice(0, 4)}</span>
                </div>
              ))}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
