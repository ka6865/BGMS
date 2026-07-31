"use client";

import React, { useCallback, useEffect, useRef, useState, Suspense } from "react";
import { useSearchParams, useRouter } from "next/navigation";
import * as THREE from "three";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";
import { AlertTriangle, ChevronLeft, ChevronRight, Loader2, PanelLeftOpen, RefreshCw } from "lucide-react";

import { PlayerTrajectory, ZoneState } from "@/types/replay3d";
import ReplayHUD from "@/components/replay/ReplayHUD";
import ReplaySidebar from "@/components/replay/ReplaySidebar";
import ReplayTimeline from "@/components/replay/ReplayTimeline";
import ReplayKillFeed from "@/components/replay/ReplayKillFeed";
import {
  useLatestTelemetryRequest,
  type TelemetryRequestToken,
} from "@/hooks/useLatestTelemetryRequest";
import { fetchTelemetryPayload } from "@/lib/pubg-analysis/fetchTelemetryPayload";
import {
  resolveReplay3DRequest,
  parseReplayStartMs,
  resolveReplaySeekMs,
  type Replay3DRequest,
} from "@/lib/pubg-analysis/replay3dRequest";
import { shouldUseSingleTileFallback } from "@/lib/replay/tile-load";
import {
  get3DReplayUnsupportedMessage,
  resolve3DMapCapability,
  type Supported3DMapId,
} from "@/lib/replay/mapCapabilities";

// PUBG 맵 크기 상수 (cm)
const THREE_MAP_SIZE = 100; // Three.js 공간 상의 가로세로 크기
const MOBILE_QUERY = "(max-width: 767px)";
const MOBILE_TERRAIN_SEGMENTS = 128;
const DESKTOP_TERRAIN_SEGMENTS = 256;
const MOBILE_RENDER_FPS = 30;
const DESKTOP_RENDER_FPS = 60;
const UI_TIME_UPDATE_INTERVAL_MS = 120;

type RenderProfile = {
  terrainSegments: number;
  maxPixelRatio: number;
  antialias: boolean;
  shadows: boolean;
  textureAnisotropy: number;
  targetFps: number;
};

const getRenderProfile = (): RenderProfile => {
  if (typeof window === "undefined") {
    return {
      terrainSegments: DESKTOP_TERRAIN_SEGMENTS,
      maxPixelRatio: 2,
      antialias: true,
      shadows: true,
      textureAnisotropy: 8,
      targetFps: DESKTOP_RENDER_FPS
    };
  }

  const isMobile = window.matchMedia(MOBILE_QUERY).matches;
  return {
    terrainSegments: isMobile ? MOBILE_TERRAIN_SEGMENTS : DESKTOP_TERRAIN_SEGMENTS,
    maxPixelRatio: isMobile ? 1.25 : 2,
    antialias: !isMobile,
    shadows: !isMobile,
    textureAnisotropy: isMobile ? 2 : 8,
    targetFps: isMobile ? MOBILE_RENDER_FPS : DESKTOP_RENDER_FPS
  };
};




const convertTo3D = (x: number, y: number, z: number = 0, altitudeScale: number = 0.02) => {
  const threeX = (x / 8192) * THREE_MAP_SIZE - THREE_MAP_SIZE / 2;
  const threeZ = (y / 8192) * THREE_MAP_SIZE - THREE_MAP_SIZE / 2;
  // 고도(z) 미터 단위를 altitudeScale 비율로 축소 적용하여 붕 떠 있는 괴리감 해결
  const threeY = z * altitudeScale; 
  return new THREE.Vector3(threeX, threeY, threeZ);
};

// 닉네임 3D 빌보드 스프라이트 라벨 생성 함수
const createNicknameSprite = (text: string, color: string): THREE.Sprite => {
  const canvas = document.createElement("canvas");
  canvas.width = 256;
  canvas.height = 64;
  const ctx = canvas.getContext("2d");
  if (ctx) {
    // 둥근 사각형 네온 테두리 반투명 어두운 배경 박스
    ctx.fillStyle = "rgba(10, 15, 25, 0.75)";
    ctx.strokeStyle = color;
    ctx.lineWidth = 3;
    ctx.beginPath();
    // roundRect 폴백 또는 기본 메소드 활용
    if (typeof (ctx as any).roundRect === "function") {
      (ctx as any).roundRect(4, 4, 248, 56, 12);
    } else {
      ctx.rect(4, 4, 248, 56);
    }
    ctx.fill();
    ctx.stroke();

    // 텍스트 스타일링
    ctx.font = "bold 22px sans-serif";
    ctx.fillStyle = "#ffffff";
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    
    // 닉네임 글자수 제한
    const maxLen = 14;
    const displayText = text.length > maxLen ? text.slice(0, maxLen - 2) + ".." : text;
    ctx.fillText(displayText, 128, 32);
  }

  const texture = new THREE.CanvasTexture(canvas);
  const material = new THREE.SpriteMaterial({
    map: texture,
    transparent: true,
    depthTest: true,
    depthWrite: false
  });
  
  const sprite = new THREE.Sprite(material);
  sprite.scale.set(1.4, 0.35, 1.0); // 콤팩트한 텍스트 비율 조정
  return sprite;
};

/**
 * 지정 맵의 타일을 Canvas에 합성해 고화질 텍스처 ImageBitmap을 반환한다.
 * zoom 2 (4x4 = 16장, 각 256px) → 1024x1024 합성 이미지
 *
 * 타일 좌표 규칙 (RGB 픽셀 통계 역산으로 확정):
 *  - 파일 경로: /{zoom}/{x}/{y}.jpg  (y는 음수)
 *  - x: 화면 좌→우 방향 열 인덱스 (x=0이 왼쪽, x=3이 오른쪽)
 *  - y: 화면 위→아래 역방향 (y=-4가 최상단, y=-1이 최하단)
 *  - 따라서: fileX = col, fileY = -(GRID - row)
 */
async function buildHighResTileTexture(mapName: string): Promise<HTMLCanvasElement> {
  const ZOOM = 2;
  const GRID = 4; // 2^ZOOM
  const TILE_PX = 256;
  const CANVAS_SIZE = GRID * TILE_PX; // 1024

  const canvas = document.createElement("canvas");
  canvas.width = CANVAS_SIZE;
  canvas.height = CANVAS_SIZE;
  const ctx = canvas.getContext("2d")!;

  const promises: Promise<boolean>[] = [];
  for (let row = 0; row < GRID; row++) {
    for (let col = 0; col < GRID; col++) {
      const fileX = col;              // x는 열과 동일 방향 (좌→우)
      const fileY = -(GRID - row);    // row=0 -> y=-4(상단), row=3 -> y=-1(하단)
      const url = `/tiles/${mapName}/${ZOOM}/${fileX}/${fileY}.jpg`;
      const destX = col * TILE_PX;
      const destY = row * TILE_PX;

      promises.push(
        new Promise<boolean>((resolve) => {
          const img = new Image();
          img.onload = () => {
            ctx.drawImage(img, destX, destY, TILE_PX, TILE_PX);
            resolve(true);
          };
          img.onerror = () => resolve(false);
          img.src = url;
        })
      );
    }
  }

  const tileResults = await Promise.all(promises);
  const loadedTiles = tileResults.filter(Boolean).length;
  if (shouldUseSingleTileFallback(loadedTiles, GRID * GRID)) {
    throw new Error(`3D 지도 타일 로딩 실패: ${loadedTiles}/${GRID * GRID}`);
  }

  return canvas;
}

// 비상호출 수송 비행기 판정 헬퍼 함수
const isAirplane = (vehicleId: string | null | undefined): boolean => {
  if (!vehicleId) return false;
  const lower = vehicleId.toLowerCase();
  return lower.includes("emergency") || lower.includes("plane") || lower.includes("flight") || lower.includes("air");
};

// 차량/비행기 내의 동승 좌석 오프셋 반환 헬퍼 함수 (로컬 좌표계 기준)
const getSeatOffset = (index: number, isPlane: boolean): THREE.Vector3 => {
  if (isPlane) {
    // 비행기의 경우 동체 중앙선을 따라 앞뒤 일렬로 나열 배치
    return new THREE.Vector3(0, 0.12, 0.4 - index * 0.25);
  }
  // 일반 차량의 경우 (0: 운전석 앞좌, 1: 조수석 앞우, 2: 뒷좌석 좌, 3: 뒷좌석 우)
  switch (index) {
    case 0: return new THREE.Vector3(-0.16, 0.22, 0.12);
    case 1: return new THREE.Vector3(0.16, 0.22, 0.12);
    case 2: return new THREE.Vector3(-0.16, 0.22, -0.18);
    case 3: return new THREE.Vector3(0.16, 0.22, -0.18);
    default:
      // 4인 초과 정원일 경우 점차 뒷열로 밀려 배치
      return new THREE.Vector3(0, 0.22, -0.2 - (index - 4) * 0.15);
  }
};



const COLORS = ["#34A853", "#a855f7", "#ff9f0a", "#3b82f6", "#ef4444", "#06b6d4", "#eab308", "#ec4899"];
const ENEMY_TEAM_COLORS = [
  "#ff4a4a", // 네온 레드
  "#00f0ff", // 네온 시안
  "#ff2a85", // 네온 핫핑크
  "#39ff14", // 네온 라임그린
  "#ffff33", // 네온 옐로우
  "#bf00ff", // 딥 네온퍼플
  "#ff8c00", // 네온 다크오렌지
  "#00ff87", // 네온 민트그린
  "#ff5e00", // 일렉트릭 오렌지
  "#9d4edd", // 네온 바이올렛
  "#0077b6", // 딥 오션블루
  "#e0aaff"  // 라이트 라벤더
];

function Replay3DContent() {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  
  const router = useRouter();
  const searchParams = useSearchParams();
  const qNickname = searchParams.get("nickname");
  const qMatchId = searchParams.get("matchId");
  const qPlatform = searchParams.get("platform");
  // Overwolf Companion 세션 타임라인에서 특정 교전 시점으로 진입할 때 넘어오는 초 단위 값.
  const qStartSeconds = searchParams.get("t");
  const demoRequest = qNickname === null && qMatchId === null && qPlatform === null
    ? resolveReplay3DRequest({ matchId: null, nickname: null, platform: null })
    : null;

  // 상태 관리 (기본 검색값: KangHeeSung_의 스쿼드 미라마 8등 매치)
  const [nickname, setNickname] = useState(qNickname ?? demoRequest?.nickname ?? "");
  const [matchId, setMatchId] = useState(qMatchId ?? demoRequest?.matchId ?? "");
  const [platform, setPlatform] = useState(qPlatform ?? demoRequest?.platform ?? "");
  
  const [isLoading, setIsLoading] = useState(false);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  
  // 텔레메트리 파싱된 결과 상태
  const [players, setPlayers] = useState<PlayerTrajectory[]>([]);
  const [zones, setZones] = useState<ZoneState[]>([]);
  const [maxTimeMs, setMaxTimeMs] = useState(300000); // 5분 기본값
  const [selectedMap, setSelectedMap] = useState<Supported3DMapId | null>(null);
  
  // 프리미엄 기능 관련 상태
  const [damageEvents, setDamageEvents] = useState<any[]>([]);
  const [carePackages, setCarePackages] = useState<any[]>([]);

  // 플레이백 상태
  const [isPlaying, setIsPlaying] = useState(false);
  const [currentTimeMs, setCurrentTimeMs] = useState(0);
  const [playbackSpeed, setPlaybackSpeed] = useState(2);
  const [showBluezone, setShowBluezone] = useState(true);
  const [showTrajectories, setShowTrajectories] = useState(true);
  const [isMapLoading, setIsMapLoading] = useState(false);
  const [altitudeScale, setAltitudeScale] = useState(0.015);
  const [showEnemies] = useState(true);
  // 플레이어별 개별 표시 토글 (이름 Set)
  const [hiddenPlayers, setHiddenPlayers] = useState<Set<string>>(new Set());
  // 현재 카메라가 고정 추적 중인 플레이어 닉네임
  const [trackingPlayer, setTrackingPlayer] = useState<string | null>(null);
  // 사이드바 접기/펼치기 (모바일 대응)
  const [isSidebarOpen, setIsSidebarOpen] = useState(false);
  const [showNames, setShowNames] = useState(true);

  // Three.js 인스턴스 레퍼런스
  const rendererRef = useRef<THREE.WebGLRenderer | null>(null);
  const sceneRef = useRef<THREE.Scene | null>(null);
  const mapMeshRef = useRef<THREE.Mesh | null>(null);
  const mapTextureRef = useRef<THREE.Texture | null>(null);
  const animationFrameIdRef = useRef<number | null>(null);
  const controlsRef = useRef<OrbitControls | null>(null);
  const heightmapDataRef = useRef<{
    pixels: Uint8ClampedArray;
    width: number;
    height: number;
  } | null>(null);
  const terrainGridRef = useRef<{ grid: number[][]; size: number } | null>(null);
  const currentTimeRef = useRef(0);
  const renderStateVersionRef = useRef(0);
  const lastUiTimeSyncRef = useRef(0);
  const isPlayingRef = useRef(false);
  const playbackSpeedRef = useRef(playbackSpeed);
  const maxTimeRef = useRef(maxTimeMs);
  const updateReplaySceneRef = useRef<(frameTimeMs: number) => void>(() => {});

  // 마커 및 라인 씬 객체 캐시
  const playerMeshesRef = useRef<Record<string, THREE.Mesh>>({});
  const playerLinesRef = useRef<Record<string, THREE.Line>>({});
  const playerDropLinesRef = useRef<Record<string, THREE.LineSegments>>({});
  const bluezoneMeshRef = useRef<THREE.Mesh | null>(null);
  const whitezoneMeshRef = useRef<THREE.Mesh | null>(null);
  const borderLineRef = useRef<THREE.LineSegments | null>(null);
  const tracerPoolRef = useRef<THREE.Mesh[]>([]);
  const impactPoolRef = useRef<THREE.Mesh[]>([]); // 탄착 지점 임팩트 구체 풀
  const carePackageMeshesRef = useRef<Record<number, THREE.Group>>({});
  const {
    begin: beginRequest,
    cancel: cancelRequest,
    complete: completeRequest,
    isCurrent,
  } = useLatestTelemetryRequest();

  const resetReplayState = useCallback(() => {
    setSelectedMap(null);
    setPlayers([]);
    setZones([]);
    setDamageEvents([]);
    setCarePackages([]);
    setMaxTimeMs(0);
    setIsPlaying(false);
    setCurrentTimeMs(0);
    setHiddenPlayers(new Set());
    setTrackingPlayer(null);
    currentTimeRef.current = 0;
    maxTimeRef.current = 0;
    isPlayingRef.current = false;
  }, []);


  useEffect(() => {
    const applyViewportMode = () => {
      const isMobile = window.matchMedia(MOBILE_QUERY).matches;
      setIsSidebarOpen((prev) => (isMobile ? false : prev));
    };

    applyViewportMode();
    window.addEventListener("resize", applyViewportMode);
    return () => window.removeEventListener("resize", applyViewportMode);
  }, []);

  useEffect(() => {
    isPlayingRef.current = isPlaying;
  }, [isPlaying]);

  useEffect(() => {
    playbackSpeedRef.current = playbackSpeed;
  }, [playbackSpeed]);

  useEffect(() => {
    maxTimeRef.current = maxTimeMs;
  }, [maxTimeMs]);

  /*
   * Overwolf Companion 세션 타임라인에서 `t`(초)를 붙여 들어온 경우,
   * 텔레메트리 로드가 끝나 재생 구간이 정해진 뒤 그 시점으로 한 번 이동한다.
   *
   * `t` 는 매치 시작 기준 경과 초이고 텔레메트리 타임라인 기준과 완전히 같지 않다.
   * 정확한 프레임이 아니라 "그 무렵" 으로 데려가는 용도이며, 매치 길이를 넘으면 끝으로 맞춘다.
   * players 가 채워진 뒤에만 적용해 로딩 중 값이 덮이지 않게 한다.
   */
  useEffect(() => {
    const startMs = parseReplayStartMs(qStartSeconds);
    const target = resolveReplaySeekMs({
      requestedStartMs: startMs,
      maxTimeMs,
      playerCount: players.length,
    });

    if (target === null) return;

    setCurrentTimeMs(target);
    currentTimeRef.current = target;
  }, [qStartSeconds, maxTimeMs, players.length]);

  useEffect(() => {
    currentTimeRef.current = currentTimeMs;
    renderStateVersionRef.current += 1;
  }, [currentTimeMs, players, zones, showBluezone, showTrajectories, altitudeScale, showEnemies, damageEvents, carePackages, trackingPlayer, hiddenPlayers, showNames]);

  // 1. 실시간 텔레메트리 API 호출 및 파싱
  const fetchTelemetryData = useCallback(async (
    target: Replay3DRequest,
    request: TelemetryRequestToken,
  ) => {
    const {
      matchId: targetMatchId,
      nickname: targetNickname,
      platform: targetPlatform,
    } = target;
    try {
      const data = await fetchTelemetryPayload({
        matchId: targetMatchId,
        nickname: targetNickname,
        platform: targetPlatform,
        mode: "full",
      }, { signal: request.controller.signal });
      if (!isCurrent(request)) return;
      if (!data.events || data.events.length === 0) {
        throw new Error("데이터에 유효한 동선 이벤트가 존재하지 않습니다.");
      }
      
      // 맵 정보 정규화
      const rawMapName = data.mapName;
      const mapCapability = resolve3DMapCapability(rawMapName);
      if (!mapCapability) {
        throw new Error(get3DReplayUnsupportedMessage(rawMapName));
      }

      const events = data.events as any[];
      const teamNames = data.teamNames || [targetNickname];

      // 1) 전체 플레이어 이름 추출 및 적군/아군 동선 구분
      const parsedPlayers: PlayerTrajectory[] = [];
      const lowerTeamNames = new Set((teamNames || []).map((n: string) => n.trim().toLowerCase()));

      // 사망 및 블루칩 부활 이벤트를 분석하여 플레이어별 시간대 목록 매핑
      const playerDeathTimes: Record<string, number[]> = {};
      const playerRedeployTimes: Record<string, number[]> = {};
      events.forEach((ev: any) => {
        const type = ev._T || ev.type || "";
        const lowerType = type.toLowerCase();
        
        if (lowerType === "logplayerkill" || lowerType === "kill") {
          const victim = (ev.victim?.name || ev.victim || "").trim().toLowerCase();
          if (victim) {
            if (!playerDeathTimes[victim]) playerDeathTimes[victim] = [];
            playerDeathTimes[victim].push(ev.relativeTimeMs || 0);
          }
        }
        
        if (lowerType === "logplayercreate" || lowerType === "create") {
          const name = (ev.name || ev.character?.name || "").trim().toLowerCase();
          if (name) {
            if (!playerRedeployTimes[name]) playerRedeployTimes[name] = [];
            playerRedeployTimes[name].push(ev.relativeTimeMs || 0);
          }
        }
      });

      const allPlayerNames = new Set<string>();
      events.forEach((ev: any) => {
        const type = ev._T || ev.type || "";
        const pName = ev.name || ev.character?.name;
        if ((type === "position" || type === "LogPlayerPosition") && pName) {
          allPlayerNames.add(pName.trim());
        }
      });

      allPlayerNames.forEach((name) => {
        const lowerName = name.toLowerCase();
        const isTeam = lowerTeamNames.has(lowerName);

        const posEvs = events.filter((ev: any) => {
          const type = ev._T || ev.type || "";
          const pName = (ev.name || ev.character?.name || "").trim().toLowerCase();
          return (type === "position" || type === "LogPlayerPosition") && pName === lowerName;
        });

        if (posEvs.length > 0) {
          const waypoints = posEvs.map((ev: any) => {
            const loc = ev.location || ev;
            return {
              t: ev.relativeTimeMs || 0,
              x: loc.x ?? 0,
              y: loc.y ?? 0,
              z: loc.z ?? 0,
              vehicleId: ev.vehicleId || null,
              health: ev.health ?? ev.character?.health ?? 100
            };
          })
          .filter((wp: any) => wp.x !== 0 || wp.y !== 0)
          .sort((a: any, b: any) => a.t - b.t);

          if (waypoints.length > 0) {
            const teamId = posEvs[0]?.teamId ?? posEvs[0]?.character?.teamId ?? 999;
            let color = "#ff4a4a"; // 기본값
            if (isTeam) {
              const teamIdx = Array.from(teamNames).findIndex((n: any) => n.trim().toLowerCase() === lowerName);
              color = COLORS[teamIdx >= 0 ? teamIdx % COLORS.length : 0];
            } else {
              // 적군은 스쿼드 teamId별로 고유 색상 매핑
              color = ENEMY_TEAM_COLORS[teamId % ENEMY_TEAM_COLORS.length];
            }

            const dTimes = playerDeathTimes[lowerName] || [];
            const rTimes = playerRedeployTimes[lowerName] || [];

            parsedPlayers.push({
              name,
              color,
              waypoints,
              isTeam,
              teamId,
              deathTimeMs: dTimes.length > 0 ? dTimes[dTimes.length - 1] : null,
              deathTimes: dTimes,
              redeployTimes: rTimes
            });
          }
        }
      });

      // 2) 자기장 이벤트 필터링
      const zoneEvents = data.zoneEvents as any[];
      const parsedZones: ZoneState[] = zoneEvents.map((z: any) => ({
        t: z.relativeTimeMs,
        whiteX: z.whiteX ?? 408000,
        whiteY: z.whiteY ?? 408000,
        whiteRadius: z.whiteRadius ?? 0,
        blueX: z.blueX ?? 408000,
        blueY: z.blueY ?? 408000,
        blueRadius: z.blueRadius ?? 0
      })).sort((a: any, b: any) => a.t - b.t);

      // 3) 전체 재생 시간 산출
      // 3) 총탄 트레이서용 데미지 공격/피해 및 전투 이벤트 필터링
      const parsedDamageEvs = events.filter((ev: any) => 
        (ev.type === "damage" && ev.attackerX != null) ||
        ev.type === "kill" ||
        ev.type === "groggy" ||
        ev.type === "revive"
      );

      // 4) 보급 상자 이벤트 매칭 (Spawn -> Land 연결)
      const cpSpawns = events.filter((ev: any) => ev.type === "carepackage_spawn");
      const cpLands = events.filter((ev: any) => ev.type === "carepackage_land");
      
      const parsedCarePackages: any[] = [];
      cpSpawns.forEach((spawn: any, idx: number) => {
        // 동일 혹은 가장 가까운 랜드 이벤트를 검색 (약 120초 이내 범위)
        const land = cpLands.find((l: any) => Math.abs(l.relativeTimeMs - spawn.relativeTimeMs) < 120000);
        parsedCarePackages.push({
          id: idx,
          spawnTimeMs: spawn.relativeTimeMs,
          landTimeMs: land ? land.relativeTimeMs : (spawn.relativeTimeMs + 45000), // 매칭 안 될 시 45초 낙하 가정
          spawnX: spawn.x,
          spawnY: spawn.y,
          spawnZ: spawn.z ?? 120, // 공중 드롭 위치 기본값 120m
          landX: land ? land.x : spawn.x,
          landY: land ? land.y : spawn.y,
          landZ: land ? (land.z ?? 0) : 0
        });
      });

      // 5) 전체 재생 시간 산출
      let finalMaxTime = 300000;
      if (events.length > 0) {
        const lastEv = events[events.length - 1];
        finalMaxTime = lastEv.relativeTimeMs || 300000;
      }

      if (!isCurrent(request)) return;
      setSelectedMap(mapCapability.id);
      setPlayers(parsedPlayers);
      setZones(parsedZones);
      setDamageEvents(parsedDamageEvs);
      setCarePackages(parsedCarePackages);
      setMaxTimeMs(finalMaxTime);
      
    } catch (error: unknown) {
      if (!isCurrent(request)) return;
      setErrorMsg(error instanceof Error ? error.message : "텔레메트리 요청에 실패했습니다.");
    } finally {
      if (isCurrent(request)) {
        setIsLoading(false);
        completeRequest(request);
      }
    }
  }, [completeRequest, isCurrent]);

  const startTelemetryRequest = useCallback((target: Replay3DRequest) => {
    const request = beginRequest();
    resetReplayState();
    setErrorMsg(null);
    setIsLoading(true);
    void fetchTelemetryData(target, request);
    return request;
  }, [beginRequest, fetchTelemetryData, resetReplayState]);

  // 마운트 및 쿼리 파라미터 변경 시 실전 데이터 땡기기
  useEffect(() => {
    let target: Replay3DRequest;
    try {
      target = resolveReplay3DRequest({
        matchId: qMatchId,
        nickname: qNickname,
        platform: qPlatform,
      });
    } catch {
      cancelRequest();
      resetReplayState();
      setErrorMsg("3D 리플레이 query가 누락되었거나 지원되지 않습니다.");
      setIsLoading(false);
      return;
    }

    setMatchId(target.matchId);
    setNickname(target.nickname);
    setPlatform(target.platform);
    const request = startTelemetryRequest(target);
    return () => cancelRequest(request);
  }, [cancelRequest, qMatchId, qNickname, qPlatform, resetReplayState, startTelemetryRequest]);

  // 특정 X, Z 월드 좌표에서 하이트맵 고도 데이터를 기반으로 실제 지형 높이 Y를 계산하는 헬퍼 함수
  const getTerrainHeight = (threeX: number, threeZ: number): number => {
    // 1) 3D 지형 메쉬와 동일한 격자 기준의 이중 선형 보간 캐시가 있는 경우 우선 사용
    if (terrainGridRef.current) {
      const { grid, size } = terrainGridRef.current;
      const maxIndex = size - 1;
      
      // threeX: -50 ~ 50, threeZ: -50 ~ 50 범위 매핑
      // PlaneGeometry의 Local X는 -50 ~ 50 이며, ix = 0 일 때 x = -50, ix = 255 일 때 x = 50
      const percentX = (threeX + THREE_MAP_SIZE / 2) / THREE_MAP_SIZE;
      const ixFloat = percentX * maxIndex;
      
      // 3D 지형의 X축 -90도 회전(Local Y -> World -Z)에 맞춘 세로축 Z축 반전 보정 해결
      const percentZ = (threeZ + THREE_MAP_SIZE / 2) / THREE_MAP_SIZE;
      const iyFloat = percentZ * maxIndex;

      const ix = Math.floor(ixFloat);
      const iy = Math.floor(iyFloat);

      const ix1 = Math.max(0, Math.min(maxIndex, ix));
      const ix2 = Math.max(0, Math.min(maxIndex, ix + 1));
      const iy1 = Math.max(0, Math.min(maxIndex, iy));
      const iy2 = Math.max(0, Math.min(maxIndex, iy + 1));

      const fx = ixFloat - ix;
      const fy = iyFloat - iy;

      const h11 = grid[iy1][ix1];
      const h21 = grid[iy1][ix2];
      const h12 = grid[iy2][ix1];
      const h22 = grid[iy2][ix2];

      const h1 = h11 * (1 - fx) + h21 * fx;
      const h2 = h12 * (1 - fx) + h22 * fx;
      return h1 * (1 - fy) + h2 * fy;
    }

    // 2) 폴백: 캐시가 아직 로드되지 않은 경우 하이트맵 픽셀을 직접 쿼리
    const data = heightmapDataRef.current;
    if (!data) return 0.05;

    // Three.js 월드 좌표 (-50 ~ 50)를 Leaflet 좌표 (0 ~ 8192)로 변환
    const leafletX = (threeX + THREE_MAP_SIZE / 2) * (8192 / THREE_MAP_SIZE);
    // 3D 지형의 X축 -90도 회전(Local Y -> World -Z)에 맞춘 세로축 Z축 반전 보정
    const leafletY = (THREE_MAP_SIZE / 2 - threeZ) * (8192 / THREE_MAP_SIZE);

    // Leaflet 좌표를 이미지 픽셀 인덱스 좌표로 변환 (Y축 반전 없이 동일 방향 매핑)
    const px_x = Math.round((leafletX / 8192) * data.width);
    const px_y = Math.round((leafletY / 8192) * data.height);

    const clampedX = Math.max(0, Math.min(data.width - 1, px_x));
    const clampedY = Math.max(0, Math.min(data.height - 1, px_y));

    const pixelIdx = (clampedY * data.width + clampedX) * 4;
    const R = data.pixels[pixelIdx];
    // PUBG 인게임 표준 8비트 고도 변환 공식: R=128 기준 ±262m 범위
    const elevation = (R - 128) * 2.048;
    return elevation * altitudeScale;
  };

  // 2. 플레이어 위치 및 차량 탑승 상태 보간 계산 함수
  const getInterpolatedState = (player: PlayerTrajectory, time: number, altitudeScale: number): { position: THREE.Vector3; vehicleId: string | null; health: number } => {
    const pts = player.waypoints;
    if (!pts || pts.length === 0) return { position: new THREE.Vector3(0, 0, 0), vehicleId: null, health: 100 };
    if (time <= pts[0].t) {
      return { 
        position: convertTo3D(pts[0].x, pts[0].y, pts[0].z, altitudeScale),
        vehicleId: pts[0].vehicleId || null,
        health: pts[0].health ?? 100
      };
    }
    if (time >= pts[pts.length - 1].t) {
      const last = pts[pts.length - 1];
      return {
        position: convertTo3D(last.x, last.y, last.z, altitudeScale),
        vehicleId: last.vehicleId || null,
        health: last.health ?? 100
      };
    }

    for (let i = 0; i < pts.length - 1; i++) {
      const p1 = pts[i];
      const p2 = pts[i + 1];
      if (time >= p1.t && time <= p2.t) {
        const ratio = (time - p1.t) / (p2.t - p1.t);
        const x = p1.x + (p2.x - p1.x) * ratio;
        const y = p1.y + (p2.y - p1.y) * ratio;
        const z = p1.z + (p2.z - p1.z) * ratio;
        const health = (p1.health ?? 100) + ((p2.health ?? 100) - (p1.health ?? 100)) * ratio;
        return {
          position: convertTo3D(x, y, z, altitudeScale),
          vehicleId: (ratio >= 0.5 ? p2.vehicleId : p1.vehicleId) || null,
          health: Math.max(0, Math.round(health))
        };
      }
    }
    return {
      position: convertTo3D(pts[0].x, pts[0].y, pts[0].z, altitudeScale),
      vehicleId: pts[0].vehicleId || null,
      health: pts[0].health ?? 100
    };
  };

  // 3. 자기장 속성 선형 보간 계산 함수
  const getInterpolatedZone = (time: number) => {
    if (zones.length === 0) {
      return { t: time, whiteX: 408000, whiteY: 408000, whiteRadius: 0, blueX: 408000, blueY: 408000, blueRadius: 0 };
    }
    if (time <= zones[0].t) return zones[0];
    if (time >= zones[zones.length - 1].t) return zones[zones.length - 1];

    for (let i = 0; i < zones.length - 1; i++) {
      const z1 = zones[i];
      const z2 = zones[i + 1];
      if (time >= z1.t && time <= z2.t) {
        const ratio = (time - z1.t) / (z2.t - z1.t);
        return {
          t: time,
          whiteX: z1.whiteX + (z2.whiteX - z1.whiteX) * ratio,
          whiteY: z1.whiteY + (z2.whiteY - z1.whiteY) * ratio,
          whiteRadius: z1.whiteRadius + (z2.whiteRadius - z1.whiteRadius) * ratio,
          blueX: z1.blueX + (z2.blueX - z1.blueX) * ratio,
          blueY: z1.blueY + (z2.blueY - z1.blueY) * ratio,
          blueRadius: z1.blueRadius + (z2.blueRadius - z1.blueRadius) * ratio
        };
      }
    }
    return zones[0];
  };

  // 4. Three.js Engine 마운트 및 렌더 룹 설정
  useEffect(() => {
    if (!selectedMap || !canvasRef.current || !containerRef.current) return;

    const renderProfile = getRenderProfile();
    const width = containerRef.current.clientWidth;
    const height = containerRef.current.clientHeight;

    // [A] Scene 설정
    const scene = new THREE.Scene();
    scene.background = new THREE.Color("#05070c");
    // 우주/전술 작전실 분위기의 안개(Fog) 추가
    scene.fog = new THREE.FogExp2("#05070c", 0.009);
    sceneRef.current = scene;

    // [B] Camera 설정
    const camera = new THREE.PerspectiveCamera(45, width / height, 0.1, 1000);
    camera.position.set(0, 65, 85);

    // [C] WebGLRenderer 설정
    const renderer = new THREE.WebGLRenderer({
      canvas: canvasRef.current,
      antialias: renderProfile.antialias,
      alpha: false
    });
    renderer.setSize(width, height);
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, renderProfile.maxPixelRatio));
    renderer.shadowMap.enabled = renderProfile.shadows;
    renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    rendererRef.current = renderer;

    // [D] OrbitControls 연동
    const controls = new OrbitControls(camera, renderer.domElement);
    controls.enableDamping = true;
    controls.dampingFactor = 0.05;
    controls.maxPolarAngle = Math.PI / 2 - 0.05;
    controls.minDistance = 5;
    controls.maxDistance = 220;
    controlsRef.current = controls;

    // [E] 조명 배치
    const ambientLight = new THREE.AmbientLight(0xffffff, 0.45);
    scene.add(ambientLight);

    const dirLight = new THREE.DirectionalLight(0xffffff, 1.0);
    dirLight.position.set(30, 80, 40);
    dirLight.castShadow = renderProfile.shadows;
    dirLight.shadow.mapSize.width = 1024;
    dirLight.shadow.mapSize.height = 1024;
    scene.add(dirLight);

    // [F] Grid 가이드 데코레이션 배치
    // 지형 메쉬가 불투명하게 렌더링되므로, 산 등의 지형 아래에 깔린 격자는 깊이 테스트에 의해 올바르게 가려집니다.
    const gridHelper = new THREE.GridHelper(THREE_MAP_SIZE, 40, 0x1f2937, 0x111827);
    gridHelper.position.y = 0.01;
    if (Array.isArray(gridHelper.material)) {
      gridHelper.material.forEach((mat) => {
        mat.transparent = false;
        mat.depthWrite = true;
        mat.depthTest = true;
      });
    } else {
      gridHelper.material.transparent = false;
      gridHelper.material.depthWrite = true;
      gridHelper.material.depthTest = true;
    }
    scene.add(gridHelper);

    // [G] 지형 고도(Heightmap)를 반영한 입체 지형 메쉬 생성
    const segments = renderProfile.terrainSegments;
    const planeGeo = new THREE.PlaneGeometry(THREE_MAP_SIZE, THREE_MAP_SIZE, segments - 1, segments - 1);

    setIsMapLoading(true);

    // zoom 2 타일 16장을 canvas에 합성해 1024x1024 고화질 텍스처 생성
    const texture = new THREE.Texture();
    texture.colorSpace = THREE.SRGBColorSpace;
    mapTextureRef.current = texture;

    buildHighResTileTexture(selectedMap)
      .then((canvas) => {
        texture.image = canvas;
        // GPU가 지원하는 최대 이방성 필터링 적용 (경사 뷰에서 텍스처 선명도 유지)
        if (rendererRef.current) {
          texture.anisotropy = Math.min(rendererRef.current.capabilities.getMaxAnisotropy(), renderProfile.textureAnisotropy);
        }
        texture.needsUpdate = true;
        setIsMapLoading(false);
      })
      .catch(() => {
        // 합성 실패 시 zoom 0 단일 이미지로 폴백
        const fallbackLoader = new THREE.TextureLoader();
        fallbackLoader.load(
          `/tiles/${selectedMap}/0/0/-1.jpg`,
          (txt) => {
            txt.colorSpace = THREE.SRGBColorSpace;
            if (mapMeshRef.current) {
              (mapMeshRef.current.material as THREE.MeshStandardMaterial).map = txt;
              (mapMeshRef.current.material as THREE.MeshStandardMaterial).needsUpdate = true;
            }
            setIsMapLoading(false);
          },
          undefined,
          () => setIsMapLoading(false)
        );
      });

    // 지형 메쉬의 재질을 불투명하게 변경하여 하위 바닥에 있는 GridHelper가
    // 깊이 판정을 뚫고 지상 위로 오버레이 렌더링(붕 뜨는 착시 현상)되는 현상을 해결합니다.
    const planeMat = new THREE.MeshStandardMaterial({
      map: texture,
      side: THREE.DoubleSide,
      roughness: 0.45,
      metalness: 0.4,
      transparent: false
    });

    const mapMesh = new THREE.Mesh(planeGeo, planeMat);
    mapMesh.rotation.x = -Math.PI / 2;
    mapMesh.position.y = 0;
    mapMesh.receiveShadow = true;
    scene.add(mapMesh);
    mapMeshRef.current = mapMesh;

    // Load map elevation details asynchronously for supported maps
    const supportedMaps = ["Erangel", "Miramar", "Vikendi", "Taego", "Deston", "Rondo"];
    if (supportedMaps.includes(selectedMap)) {
      const heightmapImg = new Image();
      heightmapImg.crossOrigin = "anonymous";
      // 손상된 PNG를 우회하여 정상 JPG 하이트맵을 모든 맵에서 일관되게 사용
      heightmapImg.src = `/assets/map/${selectedMap}_HeightMap.jpg`;
      heightmapImg.onload = () => {
        const tempCanvas = document.createElement("canvas");
        tempCanvas.width = heightmapImg.width;
        tempCanvas.height = heightmapImg.height;
        const tempCtx = tempCanvas.getContext("2d");
        if (tempCtx) {
          tempCtx.drawImage(heightmapImg, 0, 0);
          try {
            const imgData = tempCtx.getImageData(0, 0, heightmapImg.width, heightmapImg.height);
            const pixels = imgData.data;
            
            // 3D 지형 실시간 역산용 레퍼런스 업데이트
            heightmapDataRef.current = {
              pixels,
              width: heightmapImg.width,
              height: heightmapImg.height
            };

            const posAttr = planeGeo.attributes.position;
            const count = posAttr.count;
            const grid: number[][] = Array.from({ length: segments }, () => new Array(segments).fill(0));

            // 전체 지형 중 최저 고도를 수집하기 위한 변수
            let minElevation = 0;

            for (let i = 0; i < count; i++) {
              const x = posAttr.getX(i); // Local X coordinate (-50 to 50)
              const y = posAttr.getY(i); // Local Y coordinate (-50 to 50)

              // Restore back to Leaflet coordinate system (0 to 8192)
              const leafletX = (x + THREE_MAP_SIZE / 2) * (8192 / THREE_MAP_SIZE);
              const leafletY = (y + THREE_MAP_SIZE / 2) * (8192 / THREE_MAP_SIZE);

              // 하이트맵 Y축은 반전 없이 Leaflet Y와 동일 방향으로 매핑
              const px_x = Math.round((leafletX / 8192) * heightmapImg.width);
              const px_y = Math.round((leafletY / 8192) * heightmapImg.height);

              const clampedX = Math.max(0, Math.min(heightmapImg.width - 1, px_x));
              const clampedY = Math.max(0, Math.min(heightmapImg.height - 1, px_y));

              const pixelIdx = (clampedY * heightmapImg.width + clampedX) * 4;
              let finalElevation = 0;
              if (pixels[pixelIdx + 3] !== 0) { // Skip transparent pixels if any
                const R = pixels[pixelIdx];
                // PUBG 인게임 표준 8비트 고도 변환 공식: R=128 기준 ±262m 범위
                const elevation = (R - 128) * 2.048;
                finalElevation = elevation * altitudeScale;
                posAttr.setZ(i, finalElevation);
              }
              
              const ix = i % segments;
              const iy = Math.floor(i / segments);
              grid[iy][ix] = finalElevation;

              // 최저 고도 최신화
              if (finalElevation < minElevation) {
                minElevation = finalElevation;
              }
            }
            terrainGridRef.current = { grid, size: segments };
            posAttr.needsUpdate = true;
            planeGeo.computeVertexNormals();

            // 격자의 Y 위치를 지형의 최저 고도보다 아주 조금 더 아래(예: -0.05m)로 내려줍니다.
            // 이를 통해 격자가 지상의 특정 저지대(음수 고도 지역) 위로 뚫고 나오는 공중 붕뜸 현상을 종식합니다.
            gridHelper.position.y = minElevation - 0.05;
          } catch {
            setIsMapLoading(false);
          }
        }
      };
      heightmapImg.onerror = () => {
        setIsMapLoading(false);
      };
    }

    // 홀로그램 전술 보드판 테두리 네온 라인 추가
    const borderGeo = new THREE.BoxGeometry(THREE_MAP_SIZE, THREE_MAP_SIZE, 0.05);
    const edges = new THREE.EdgesGeometry(borderGeo);
    const borderMat = new THREE.LineBasicMaterial({
      color: 0x00d2ff, // 청록색(Cyan)의 네온 빛
      transparent: true,
      opacity: 0.8
    });
    const borderLine = new THREE.LineSegments(edges, borderMat);
    borderLine.rotation.x = -Math.PI / 2;
    borderLine.position.y = 0.02; // 지도 바로 위에 살짝 얹음
    scene.add(borderLine);
    borderLineRef.current = borderLine;

    // [H] 3D 자기장 실린더 메쉬 배치
    const cylinderGeo = new THREE.CylinderGeometry(1, 1, 40, 64, 1, true);
    const bluezoneMat = new THREE.MeshBasicMaterial({
      color: 0x0066ff,
      transparent: true,
      opacity: 0.22,
      side: THREE.DoubleSide,
      depthWrite: false
    });
    const bluezoneMesh = new THREE.Mesh(cylinderGeo, bluezoneMat);
    bluezoneMesh.position.y = 20;
    scene.add(bluezoneMesh);
    bluezoneMeshRef.current = bluezoneMesh;

    const whitezoneMat = new THREE.MeshBasicMaterial({
      color: 0xffffff,
      transparent: true,
      opacity: 0.13,
      side: THREE.DoubleSide,
      depthWrite: false
    });
    const whitezoneMesh = new THREE.Mesh(cylinderGeo, whitezoneMat);
    whitezoneMesh.position.y = 20;
    scene.add(whitezoneMesh);
    whitezoneMeshRef.current = whitezoneMesh;

    // [I-Tracer] 총탄 트레이서 빔 풀 사전 생성 (최대 15개 동시 표현)
    // 빔의 두께를 대폭 두껍게 하고(0.02 ~ 0.08) 꼬리가 가늘어지는 원뿔대 형태로 입체감 구현
    const tracerGeo = new THREE.CylinderGeometry(0.02, 0.08, 1, 6);
    const tracerPool: THREE.Mesh[] = [];
    for (let i = 0; i < 15; i++) {
      const tracerMat = new THREE.MeshBasicMaterial({
        color: 0xffaa00,
        transparent: true,
        opacity: 0,
        depthWrite: false,
        blending: THREE.AdditiveBlending
      });
      const tracer = new THREE.Mesh(tracerGeo, tracerMat);
      tracer.visible = false;
      scene.add(tracer);
      tracerPool.push(tracer);
    }
    tracerPoolRef.current = tracerPool;

    // [I-Impact] 탄착 지점 타격 네온 스파크 구체 풀 사전 생성 (최대 15개 동시 표현)
    const impactGeo = new THREE.SphereGeometry(0.35, 12, 12);
    const impactPool: THREE.Mesh[] = [];
    for (let i = 0; i < 15; i++) {
      const impactMat = new THREE.MeshBasicMaterial({
        color: 0xff3300,
        transparent: true,
        opacity: 0,
        depthWrite: false,
        blending: THREE.AdditiveBlending
      });
      const impact = new THREE.Mesh(impactGeo, impactMat);
      impact.visible = false;
      scene.add(impact);
      impactPool.push(impact);
    }
    impactPoolRef.current = impactPool;

    // [I] 동적 플레이어 그룹 마커 및 궤적 라인 렌더
    playerMeshesRef.current = {};
    playerLinesRef.current = {};
    playerDropLinesRef.current = {};

    players.forEach((player) => {
      // 플레이어 마커를 감싸는 상위 Group 생성
      const group = new THREE.Group();
      group.name = player.name;
      group.visible = player.isTeam ? true : showEnemies; // 적군은 showEnemies 상태에 따라 초기 가시성 설정

      // 1-1) 도보 모드용 3D 홀로그램 마네킹 피규어 조각 (Sphere 대체, 방법 B)
      const mannequin = new THREE.Group();
      mannequin.name = "walkSphere"; // 기존 바인딩 호환용 name 유지

      const mScale = player.isTeam ? 0.58 : 0.42;
      const mannequinMat = new THREE.MeshStandardMaterial({
        color: new THREE.Color(player.color),
        emissive: new THREE.Color(player.color),
        emissiveIntensity: player.isTeam ? 0.55 : 0.35,
        roughness: 0.15,
        metalness: 0.85
      });

      // 머리 (Sphere)
      const headGeo = new THREE.SphereGeometry(0.11 * mScale, 12, 12);
      const head = new THREE.Mesh(headGeo, mannequinMat);
      head.position.y = 0.46 * mScale;
      head.castShadow = true;
      mannequin.add(head);

      // 시선 바이저/포인터 (Cone) - 머리 전면에 뾰족하게 부착해 방향성을 연출
      const visorGeo = new THREE.ConeGeometry(0.04 * mScale, 0.08 * mScale, 4);
      const visorMat = new THREE.MeshBasicMaterial({ color: 0xffffff });
      const visor = new THREE.Mesh(visorGeo, visorMat);
      visor.rotation.x = Math.PI / 2;
      visor.position.set(0, 0.46 * mScale, 0.12 * mScale);
      mannequin.add(visor);

      // 몸통 (Cylinder)
      const bodyGeo = new THREE.CylinderGeometry(0.05 * mScale, 0.08 * mScale, 0.28 * mScale, 12);
      const body = new THREE.Mesh(bodyGeo, mannequinMat);
      body.position.y = 0.26 * mScale;
      body.castShadow = true;
      mannequin.add(body);

      // 스탠드 베이스 받침 (Cylinder)
      const baseGeo = new THREE.CylinderGeometry(0.12 * mScale, 0.14 * mScale, 0.05 * mScale, 12);
      const base = new THREE.Mesh(baseGeo, mannequinMat);
      base.position.y = 0.03 * mScale;
      base.castShadow = true;
      mannequin.add(base);

      // 오른팔 + 총기 그룹 (사격 시 앞으로 들어올리는 연출용)
      const gunArmGroup = new THREE.Group();
      gunArmGroup.name = "gunArm";
      // 팔뚝 (얇은 Cylinder)
      const armGeo = new THREE.CylinderGeometry(0.025 * mScale, 0.025 * mScale, 0.22 * mScale, 6);
      const armMat = new THREE.MeshStandardMaterial({
        color: new THREE.Color(player.color),
        emissive: new THREE.Color(player.color),
        emissiveIntensity: player.isTeam ? 0.45 : 0.3,
        roughness: 0.2,
        metalness: 0.8
      });
      const armMesh = new THREE.Mesh(armGeo, armMat);
      // 그립(손잡이): CylinderGeometry 기본 축이 Y이므로 배소 0 = 수직 아래 구현 OK
      armMesh.position.set(0, -0.11 * mScale, 0); // 그립 중심이 어깨 아래로 0.11
      gunArmGroup.add(armMesh);
      // 배럴(총신): BoxGeometry가 기본적으로 Z축 방향으로 론간이 없으면 X·Y 단면이 도드라지 안되므로
      // 어걸리하지 않고 배럴은 단면 사각형 + 걸이 Z충 방향
      const gunGeo = new THREE.BoxGeometry(0.04 * mScale, 0.04 * mScale, 0.34 * mScale);
      const gunMat = new THREE.MeshStandardMaterial({
        color: 0x1a1a2e,
        emissive: new THREE.Color(player.color),
        emissiveIntensity: 0.6,
        roughness: 0.1,
        metalness: 0.95
      });
      const gunMesh = new THREE.Mesh(gunGeo, gunMat);
      // 배럴은 그립 상단(어깨 높이)에서 앞으로 반바른 수평으로 뜨 있음
      gunMesh.position.set(0, 0, 0.17 * mScale); // y=0 = 어깨와 같은 높이, z= 앞으로
      gunArmGroup.add(gunMesh);
      // 총구 플래시 — 배럴 끝단 (크기 조정 및 depthWrite 방지)
      const muzzleGeo = new THREE.SphereGeometry(0.08 * mScale, 8, 8);
      const muzzleMat = new THREE.MeshBasicMaterial({
        color: 0xffd700,
        transparent: true,
        opacity: 0,
        depthWrite: false, // 렌더링 depth 꼬임 방지
        blending: THREE.AdditiveBlending
      });
      const muzzleFlash = new THREE.Mesh(muzzleGeo, muzzleMat);
      muzzleFlash.name = "muzzleFlash";
      muzzleFlash.position.set(0, 0, 0.34 * mScale); // 배럴 끝단
      muzzleFlash.visible = false; // 기본 상태 비활성화
      gunArmGroup.add(muzzleFlash);

      // 기본 자세: rotation.x=0 → 그립 수직 아래, 배럴 어깨 높이에서 앞으로 뜨음
      gunArmGroup.position.set(0.12 * mScale, 0.32 * mScale, 0.0);
      gunArmGroup.rotation.x = 0;
      mannequin.add(gunArmGroup);

      group.add(mannequin);

      // 1-1-c) 닉네임 빌보드 스프라이트 라벨 추가
      const nameSprite = createNicknameSprite(player.name, player.color);
      nameSprite.name = "nicknameSprite";
      nameSprite.position.set(0, 0.62 * mScale + 0.15, 0); // 머리 바로 위로 오프셋 조정
      group.add(nameSprite);

      // 1-1-b) 3D 묘비 메쉬 조각 (완전 사망 시 그 자리에 소환)
      const tombstoneGroup = new THREE.Group();
      tombstoneGroup.name = "tombstone";

      const tombScale = player.isTeam ? 1.0 : 0.7;
      const stoneMat = new THREE.MeshStandardMaterial({
        color: 0x5a606b,
        roughness: 0.9,
        metalness: 0.1
      });

      // 기둥
      const postGeo = new THREE.BoxGeometry(0.11 * tombScale, 0.44 * tombScale, 0.1 * tombScale);
      const post = new THREE.Mesh(postGeo, stoneMat);
      post.position.y = 0.22 * tombScale;
      post.castShadow = true;
      tombstoneGroup.add(post);

      // 가로장 (십자가)
      const barGeo = new THREE.BoxGeometry(0.3 * tombScale, 0.1 * tombScale, 0.1 * tombScale);
      const bar = new THREE.Mesh(barGeo, stoneMat);
      bar.position.set(0, 0.28 * tombScale, 0);
      bar.castShadow = true;
      tombstoneGroup.add(bar);

      tombstoneGroup.visible = false;
      group.add(tombstoneGroup);

      // 1-2) 차량 탑승용 3D 미니 전술 차량 메쉬 그룹 생성 (귀여운 전술 자동차 형상 조각)
      const carGroup = new THREE.Group();
      carGroup.name = "vehicleBox"; // 기존 바인딩 유지용 name

      const chassisScale = player.isTeam ? 0.52 : 0.38;
      
      // 차체 (Chassis)
      const chassisGeo = new THREE.BoxGeometry(0.85 * chassisScale, 0.26 * chassisScale, 0.48 * chassisScale);
      const chassisMat = new THREE.MeshStandardMaterial({
        color: new THREE.Color(player.color),
        emissive: new THREE.Color(player.color),
        emissiveIntensity: player.isTeam ? 0.65 : 0.4,
        roughness: 0.15,
        metalness: 0.85
      });
      const chassis = new THREE.Mesh(chassisGeo, chassisMat);
      chassis.position.y = 0.08 * chassisScale;
      chassis.castShadow = true;
      carGroup.add(chassis);

      // 캐빈 (Cabin)
      const cabinGeo = new THREE.BoxGeometry(0.45 * chassisScale, 0.24 * chassisScale, 0.38 * chassisScale);
      const cabinMat = new THREE.MeshStandardMaterial({
        color: 0x1a2130, // 어두운 유리창 유광 플라스틱
        emissive: new THREE.Color(player.color),
        emissiveIntensity: 0.18,
        roughness: 0.05,
        metalness: 0.95
      });
      const cabin = new THREE.Mesh(cabinGeo, cabinMat);
      cabin.position.set(0.02 * chassisScale, 0.3 * chassisScale, 0);
      cabin.castShadow = true;
      carGroup.add(cabin);

      // 바퀴 4개 (Cylinder)
      const wheelGeo = new THREE.CylinderGeometry(0.14 * chassisScale, 0.14 * chassisScale, 0.08 * chassisScale, 8);
      const wheelMat = new THREE.MeshStandardMaterial({
        color: 0x1f232b,
        roughness: 0.8,
        metalness: 0.2
      });

      const wheelOffsets = [
        [-0.26 * chassisScale, -0.02 * chassisScale, 0.24 * chassisScale],
        [0.26 * chassisScale, -0.02 * chassisScale, 0.24 * chassisScale],
        [-0.26 * chassisScale, -0.02 * chassisScale, -0.24 * chassisScale],
        [0.26 * chassisScale, -0.02 * chassisScale, -0.24 * chassisScale]
      ];

      wheelOffsets.forEach((offset) => {
        const wheel = new THREE.Mesh(wheelGeo, wheelMat);
        wheel.rotation.x = Math.PI / 2; // 바퀴가 축 방향을 보게 회전
        wheel.position.set(offset[0], offset[1], offset[2]);
        wheel.castShadow = true;
        carGroup.add(wheel);
      });

      carGroup.visible = false; // 기본값 숨김
      group.add(carGroup);

      // 1-3) 비상호출/수송 비행기 3D 메쉬 그룹 생성 (수송기 모양 조각)
      const planeGroup = new THREE.Group();
      planeGroup.name = "airplaneBox";

      const planeScale = player.isTeam ? 0.7 : 0.5;
      // 동체 (Fuselage)
      const fuseGeo = new THREE.CylinderGeometry(0.12 * planeScale, 0.08 * planeScale, 1.5 * planeScale, 8);
      const fuseMat = new THREE.MeshStandardMaterial({
        color: 0x8b949e,
        emissive: new THREE.Color(player.color),
        emissiveIntensity: 0.25,
        metalness: 0.9,
        roughness: 0.1
      });
      const fuse = new THREE.Mesh(fuseGeo, fuseMat);
      fuse.rotation.x = Math.PI / 2; // 앞뒤 수평 방향 눕힘
      fuse.castShadow = true;
      planeGroup.add(fuse);

      // 주날개 (Wings)
      const wingGeo = new THREE.BoxGeometry(1.8 * planeScale, 0.03 * planeScale, 0.28 * planeScale);
      const wingMat = new THREE.MeshStandardMaterial({
        color: new THREE.Color(player.color),
        emissive: new THREE.Color(player.color),
        emissiveIntensity: player.isTeam ? 0.55 : 0.35,
        metalness: 0.8,
        roughness: 0.2
      });
      const wing = new THREE.Mesh(wingGeo, wingMat);
      wing.position.set(0, 0.02 * planeScale, 0.1 * planeScale); // 동체 중간 얹음
      wing.castShadow = true;
      planeGroup.add(wing);

      // 꼬리날개 (Tail fin)
      const tailGeo = new THREE.BoxGeometry(0.02 * planeScale, 0.32 * planeScale, 0.22 * planeScale);
      const tail = new THREE.Mesh(tailGeo, wingMat);
      tail.position.set(0, 0.16 * planeScale, -0.55 * planeScale);
      tail.castShadow = true;
      planeGroup.add(tail);

      planeGroup.visible = false; // 기본값 숨김
      group.add(planeGroup);

      // 1-4) 성능 과부하 및 Three.js 조명 제한 방지를 위해 포인트 라이트는 아군 스쿼드(isTeam)에만 부착
      if (player.isTeam) {
        const pointLight = new THREE.PointLight(new THREE.Color(player.color), 4.5, 12, 0.45);
        pointLight.position.set(0, 0.8, 0);
        group.add(pointLight);
      }

      scene.add(group);
      playerMeshesRef.current[player.name] = group as any;

      // 2) 수직 드롭 가이드 라인 (지도 지면 Y=0과 공중 마커를 연결해 주는 수직 점선)
      const dropPoints = [new THREE.Vector3(0, 0, 0), new THREE.Vector3(0, 1, 0)];
      const dropLineGeo = new THREE.BufferGeometry().setFromPoints(dropPoints);
      const dropLineMat = new THREE.LineDashedMaterial({
        color: new THREE.Color(player.color),
        dashSize: player.isTeam ? 0.4 : 0.2,
        gapSize: player.isTeam ? 0.25 : 0.15,
        transparent: true,
        opacity: player.isTeam ? 0.6 : 0.25
      });
      const dropLine = new THREE.LineSegments(dropLineGeo, dropLineMat);
      dropLine.computeLineDistances();
      dropLine.visible = player.isTeam ? showTrajectories : (showTrajectories && showEnemies);
      scene.add(dropLine);
      playerDropLinesRef.current[player.name] = dropLine;

      // 3) 궤적 전체 라인 (시각적 과부하 방지를 위해 아군 스쿼드만 드로잉!)
      if (player.isTeam && player.waypoints && player.waypoints.length > 0) {
        const points = player.waypoints.map(wp => convertTo3D(wp.x, wp.y, wp.z, altitudeScale));
        const lineGeo = new THREE.BufferGeometry().setFromPoints(points);
        const lineMat = new THREE.LineBasicMaterial({
          color: new THREE.Color(player.color),
          linewidth: 2.5,
          transparent: true,
          opacity: 0.75
        });
        const line = new THREE.Line(lineGeo, lineMat);
        scene.add(line);
        playerLinesRef.current[player.name] = line;
      }
    });

    // [I-CarePackage] 보급 상자 및 연기 메쉬 사전 배치
    carePackageMeshesRef.current = {};
    carePackages.forEach((cp) => {
      const cpGroup = new THREE.Group();
      cpGroup.name = "carepackage_" + cp.id;

      // 1) 보급 박스 몸체 (빨간색 상자)
      const boxGeo = new THREE.BoxGeometry(0.8, 0.8, 0.8);
      const boxMat = new THREE.MeshStandardMaterial({
        color: 0xd92b2b,
        roughness: 0.4,
        metalness: 0.6
      });
      const box = new THREE.Mesh(boxGeo, boxMat);
      box.position.y = 0.4;
      box.castShadow = true;
      cpGroup.add(box);

      // 2) 보급 상자 지붕 천막 (파란색 지붕)
      const tarpGeo = new THREE.BoxGeometry(0.85, 0.12, 0.85);
      const tarpMat = new THREE.MeshStandardMaterial({
        color: 0x1d4ed8,
        roughness: 0.6,
        metalness: 0.1
      });
      const tarp = new THREE.Mesh(tarpGeo, tarpMat);
      tarp.position.y = 0.84;
      tarp.castShadow = true;
      cpGroup.add(tarp);

      // 3) 낙하산 메쉬 (반구체)
      const chuteGeo = new THREE.SphereGeometry(0.65, 8, 8, 0, Math.PI * 2, 0, Math.PI / 2);
      const chuteMat = new THREE.MeshStandardMaterial({
        color: 0xe5e7eb,
        transparent: true,
        opacity: 0.9,
        side: THREE.DoubleSide
      });
      const chute = new THREE.Mesh(chuteGeo, chuteMat);
      chute.name = "chute";
      chute.position.y = 1.6;
      chute.castShadow = true;
      cpGroup.add(chute);

      // 4) 네온 연기 기둥 (반투명 빨간 실린더)
      const smokeGeo = new THREE.CylinderGeometry(0.12, 0.6, 50, 16, 1, true);
      const smokeMat = new THREE.MeshBasicMaterial({
        color: 0xef4444,
        transparent: true,
        opacity: 0, // 기본값 투명
        side: THREE.DoubleSide,
        depthWrite: false
      });
      const smoke = new THREE.Mesh(smokeGeo, smokeMat);
      smoke.name = "smoke";
      smoke.position.y = 25; // 높이 50의 절반
      smoke.visible = false;
      cpGroup.add(smoke);

      cpGroup.visible = false; // 기본적으론 숨겨둠
      scene.add(cpGroup);
      carePackageMeshesRef.current[cp.id] = cpGroup;
    });

    // 카메라 원점 초점 조정
    if (players.length > 0 && players[0].waypoints.length > 0) {
      const firstWp = players[0].waypoints[0];
      const startPos3D = convertTo3D(firstWp.x, firstWp.y, firstWp.z, altitudeScale);
      controls.target.set(startPos3D.x, 0, startPos3D.z);
      controls.update();
    }

    // [J] 창 크기 조절 콜백
    const handleResize = () => {
      if (!containerRef.current || !renderer || !camera) return;
      const w = containerRef.current.clientWidth;
      const h = containerRef.current.clientHeight;
      camera.aspect = w / h;
      camera.updateProjectionMatrix();
      renderer.setSize(w, h);
    };
    window.addEventListener("resize", handleResize);

    // [K] 렌더 프레임 루프 기동
    let lastRenderTime = 0;
    const frameInterval = 1000 / renderProfile.targetFps;

    const animate = (now: number) => {
      animationFrameIdRef.current = requestAnimationFrame(animate);
      if (now - lastRenderTime < frameInterval) {
        return;
      }
      lastRenderTime = now;

      if (isPlayingRef.current || renderStateVersionRef.current > 0) {
        updateReplaySceneRef.current(currentTimeRef.current);
        renderStateVersionRef.current = 0;
      }

      controls.update();

      // 차량에 탄 캐릭터의 마커의 바퀴 회전 및 상하 바운싱 모션 부여 (SF 홀로그램 서스펜션 느낌)
      players.forEach((player) => {
        const group = playerMeshesRef.current[player.name];
        if (group) {
          const car = group.getObjectByName("vehicleBox");
          if (car && car.visible) {
            // 미세한 부유식 위아래 흔들림 (자전 대신 서스펜션 흔들림)
            car.position.y = Math.sin(performance.now() * 0.012) * 0.04;
            
            // 바퀴 메쉬 회전
            car.children.forEach((child) => {
              if (child instanceof THREE.Mesh && child.geometry instanceof THREE.CylinderGeometry) {
                child.rotation.y += 0.2; // 실시간 휠 스핀
              }
            });
          }

          const plane = group.getObjectByName("airplaneBox");
          if (plane && plane.visible) {
            // 비행기 공중 부양식 미세 고도 흔들림 및 좌우 기우뚱 롤링 모션 추가
            plane.position.y = Math.sin(performance.now() * 0.006) * 0.08;
            plane.rotation.z = Math.sin(performance.now() * 0.003) * 0.12;
          }
        }
      });

      // 보급 상자 안착 후 연기 기둥 자전 회전 애니메이션
      Object.keys(carePackageMeshesRef.current).forEach((key) => {
        const cp = carePackageMeshesRef.current[Number(key)];
        if (cp && cp.visible) {
          const smoke = cp.getObjectByName("smoke");
          if (smoke && smoke.visible) {
            smoke.rotation.y += 0.005; // 부드럽게 기둥 자전 회전
          }
        }
      });

      renderer.render(scene, camera);
    };
    animationFrameIdRef.current = requestAnimationFrame(animate);

    // [L] 메모리 누수 방지 리소스 수소 폐기
    return () => {
      window.removeEventListener("resize", handleResize);
      if (animationFrameIdRef.current) {
        cancelAnimationFrame(animationFrameIdRef.current);
      }
      
      controls.dispose();
      renderer.dispose();
      
      planeGeo.dispose();
      planeMat.dispose();
      if (texture) texture.dispose();

      borderGeo.dispose();
      edges.dispose();
      borderMat.dispose();

      // 격자 가이드 자원 수거 (메모리 누수 및 옛날 격자가 씬에 중첩 잔존하여 붕 뜨는 결함 해결)
      if (gridHelper) {
        gridHelper.geometry.dispose();
        if (Array.isArray(gridHelper.material)) {
          gridHelper.material.forEach((m) => m.dispose());
        } else {
          gridHelper.material.dispose();
        }
        scene.remove(gridHelper);
      }

      cylinderGeo.dispose();
      bluezoneMat.dispose();
      whitezoneMat.dispose();

      // 사격 트레이서 풀 자원 수거
      tracerGeo.dispose();
      tracerPoolRef.current.forEach((t) => {
        if (Array.isArray(t.material)) {
          t.material.forEach(m => m.dispose());
        } else {
          t.material.dispose();
        }
        scene.remove(t);
      });
      tracerPoolRef.current = [];

      // 탄착 임팩트 풀 자원 수거
      impactGeo.dispose();
      impactPoolRef.current.forEach((im) => {
        if (Array.isArray(im.material)) {
          im.material.forEach(m => m.dispose());
        } else {
          im.material.dispose();
        }
        scene.remove(im);
      });
      impactPoolRef.current = [];

      // 보급 상자 메쉬들 자원 수거
      Object.keys(carePackageMeshesRef.current).forEach((key) => {
        const cpGroup = carePackageMeshesRef.current[Number(key)];
        if (cpGroup) {
          cpGroup.traverse((child) => {
            if (child instanceof THREE.Mesh) {
              child.geometry.dispose();
              if (Array.isArray(child.material)) {
                child.material.forEach(m => m.dispose());
              } else {
                child.material.dispose();
              }
            }
          });
          scene.remove(cpGroup);
        }
      });
      carePackageMeshesRef.current = {};

      players.forEach((player) => {
        const group = playerMeshesRef.current[player.name];
        if (group) {
          // 자식 자원들 완벽 수거
          group.traverse((child) => {
            if (child instanceof THREE.Light) {
              child.dispose();
            }
            if (child instanceof THREE.Mesh) {
              child.geometry.dispose();
              if (Array.isArray(child.material)) {
                child.material.forEach(m => m.dispose());
              } else {
                child.material.dispose();
              }
            }
          });
          scene.remove(group);
        }
        const dropLine = playerDropLinesRef.current[player.name];
        if (dropLine) {
          dropLine.geometry.dispose();
          if (Array.isArray(dropLine.material)) {
            dropLine.material.forEach(m => m.dispose());
          } else {
            dropLine.material.dispose();
          }
          scene.remove(dropLine);
        }
        const line = playerLinesRef.current[player.name];
        if (line) {
          line.geometry.dispose();
          if (Array.isArray(line.material)) {
            line.material.forEach(m => m.dispose());
          } else {
            line.material.dispose();
          }
          scene.remove(line);
        }
      });
    };
  }, [players, selectedMap, altitudeScale, showEnemies, showTrajectories, carePackages]);

  // 5. 재생 시간 경과 틱 관리
  useEffect(() => {
    if (!isPlaying) return;

    let lastTime = performance.now();
    let animationId: number;

    const tick = (now: number) => {
      const delta = now - lastTime;
      lastTime = now;

      const next = Math.min(currentTimeRef.current + delta * playbackSpeedRef.current, maxTimeRef.current);
      currentTimeRef.current = next;

      if (next >= maxTimeRef.current) {
        setCurrentTimeMs(maxTimeRef.current);
        setIsPlaying(false);
        return;
      }

      if (now - lastUiTimeSyncRef.current >= UI_TIME_UPDATE_INTERVAL_MS) {
        lastUiTimeSyncRef.current = now;
        setCurrentTimeMs(next);
      }

      animationId = requestAnimationFrame(tick);
    };

    animationId = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(animationId);
  }, [isPlaying]);

  // 6. 시간에 따른 실시간 마커 및 자기장 위치 갱신 동기화
  const updateReplayScene = useCallback((frameTimeMs: number) => {
    const currentTimeMs = frameTimeMs;
    // 1) 모든 플레이어의 현재 프레임 보간 상태 계산 및 vehicleId별 그룹핑
    const playerStates: Record<string, {
      position: THREE.Vector3;
      vehicleId: string | null;
      health: number;
      isDead: boolean;
      isInVehicle: boolean;
      isPlane: boolean;
    }> = {};

    const vehicleGroups: Record<string, string[]> = {};

    players.forEach((player) => {
      const state = getInterpolatedState(player, currentTimeMs, altitudeScale);
      
      // 다중 사망 및 블루칩 부활 기록을 종합한 실시간 사망 판정
      let isDead = false;
      const dTimes = player.deathTimes || [];
      const rTimes = player.redeployTimes || [];
      const pastDeaths = dTimes.filter(t => t <= currentTimeMs);
      const pastRedeploys = rTimes.filter(t => t <= currentTimeMs);
      
      if (pastDeaths.length > 0) {
        const lastDeath = Math.max(...pastDeaths);
        if (pastRedeploys.length > 0) {
          const lastRedeploy = Math.max(...pastRedeploys);
          isDead = lastDeath > lastRedeploy;
        } else {
          isDead = true;
        }
      }
      if (state.health <= 0) {
        isDead = true;
      }

      const isInVehicle = !isDead && state.vehicleId !== null && state.vehicleId !== undefined && state.vehicleId !== "";
      const isPlane = isInVehicle ? isAirplane(state.vehicleId) : false;

      playerStates[player.name] = {
        position: state.position,
        vehicleId: state.vehicleId,
        health: state.health,
        isDead,
        isInVehicle,
        isPlane
      };

      if (isInVehicle && !isDead) {
        const vId = state.vehicleId!;
        if (!vehicleGroups[vId]) {
          vehicleGroups[vId] = [];
        }
        vehicleGroups[vId].push(player.name);
      }
    });

    // 2) 플레이어 마커, 기절(DBNO), 사망(Tombstone) 및 수직 드롭 라인 업데이트
    players.forEach((player) => {
      const state = playerStates[player.name];
      if (!state) return;

      const currentPos = state.position;
      const isInVehicle = state.isInVehicle;
      const isDead = state.isDead;
      
      const group = playerMeshesRef.current[player.name];
      const finalWpOffset = new THREE.Vector3(0, 0, 0);

      // 플레이어 이동 방향 자전 각도 계산
      let moveAngle = 0;
      const pts = player.waypoints;
      if (pts.length > 1) {
        let idx = 0;
        for (let i = 0; i < pts.length - 1; i++) {
          if (currentTimeMs >= pts[i].t && currentTimeMs <= pts[i + 1].t) {
            idx = i;
            break;
          }
        }
        if (currentTimeMs > pts[pts.length - 1].t) idx = pts.length - 2;
        const p1 = pts[idx];
        const p2 = pts[idx + 1];
        if (p2) {
          const dx = p2.x - p1.x;
          const dy = p2.y - p1.y;
          if (dx !== 0 || dy !== 0) {
            moveAngle = Math.atan2(dx, dy); // XZ 평면에서의 자전 각도
          }
        }
      }

      // 기절(DBNO) 여부 판정
      let isGroggy = false;
      const myGroggyEvs = damageEvents.filter(ev => ev.type === "groggy" && ev.victim === player.name);
      const myReviveEvs = damageEvents.filter(ev => ev.type === "revive" && ev.victim === player.name);
      const myRedeploys = player.redeployTimes || [];
      const myDeaths = player.deathTimes || [];
      
      myGroggyEvs.forEach((g) => {
        const gTime = g.relativeTimeMs;
        if (currentTimeMs >= gTime) {
          // 기절 이후에 현재 프레임 전까지 부활이 완료되었는지 확인
          const nextRevive = myReviveEvs.find(r => r.relativeTimeMs >= gTime && r.relativeTimeMs <= currentTimeMs);
          // 기절 이후에 현재 프레임 전까지 사망이 완료되었는지 확인
          const nextDeath = myDeaths.find(d => d >= gTime && d <= currentTimeMs);
          // 기절 이후에 현재 프레임 전까지 블루칩 부활이 일어났는지 확인
          const nextRedeploy = myRedeploys.find(r => r >= gTime && r <= currentTimeMs);
          
          if (!nextRevive && !nextDeath && !nextRedeploy) {
            isGroggy = true;
          }
        }
      });

      const finalPos = currentPos.clone();

      if (group) {
        // 지상 캐릭터 지형 높이 스냅 보정 (묻힘 및 산정상 붕뜸 현상 해결)
        if (heightmapDataRef.current && !isDead) {
          const isPlaneState = state.isPlane;
          const vehicleId = state.vehicleId;
          const isEmergency = vehicleId ? isAirplane(vehicleId) : false;
          const terrainHeight = getTerrainHeight(finalPos.x, finalPos.z);
          
          // 실측 고도와 지형 높이의 차이 (미터 단위)
          const diffM = (finalPos.y - terrainHeight) / altitudeScale;
          const isFlying = isPlaneState || isEmergency;

          if (!isFlying) {
            // 1) 캐릭터가 지형 아래로 파묻히는 비주얼 버그 전면 차단 (지하 매몰 방지)
            if (diffM < 0.0) {
              finalPos.y = terrainHeight;
            } else {
              // 2) 일반 차량은 비행할 수 없으므로 25m 완화 스냅 적용, 도보는 옥상 분리를 위해 8m 스냅 적용
              const snapLimit = isInVehicle ? 25.0 : 8.0;
              if (diffM <= snapLimit) {
                finalPos.y = terrainHeight;
              }
            }
          }
        }

        // 사망 여부에 따라 그룹 위치를 사망 시점 좌표에 고정하거나 보간 위치로 갱신
        if (isDead && player.deathTimeMs != null) {
          // 사망 시점의 좌표를 계산하여 묘비를 해당 위치에 고정 (매 프레임 갱신 금지)
          const deathState = getInterpolatedState(player, player.deathTimeMs, altitudeScale);
          const finalDeathPos = deathState.position.clone();
          if (heightmapDataRef.current) {
            const terrainHeight = getTerrainHeight(finalDeathPos.x, finalDeathPos.z);
            finalDeathPos.y = Math.max(terrainHeight, finalDeathPos.y);
          }
          finalPos.copy(finalDeathPos);
          group.position.copy(finalPos);
        } else {
          group.position.copy(finalPos);
        }

        // 묘비 노출 분기: 사망했고, 적군인 경우 showEnemies 스위치 준수
        const tombstone = group.getObjectByName("tombstone");
        const sphere = group.getObjectByName("walkSphere");
        const vehicleBox = group.getObjectByName("vehicleBox");
        const airplaneBox = group.getObjectByName("airplaneBox");

        // 닉네임 스프라이트 가시성 제어
        const nameSprite = group.getObjectByName("nicknameSprite");
        if (nameSprite) {
          const isHidden = hiddenPlayers.has(player.name);
          nameSprite.visible = showNames && !isHidden && !isDead;
        }

        if (isDead) {
          group.visible = player.isTeam ? true : showEnemies;
          if (tombstone) tombstone.visible = true;
          if (sphere) sphere.visible = false;
          if (vehicleBox) vehicleBox.visible = false;
          if (airplaneBox) airplaneBox.visible = false;
        } else {
          group.visible = player.isTeam ? true : showEnemies;
          if (tombstone) tombstone.visible = false;
          if (sphere) sphere.visible = true;

          // 도보 이동 중 방향(자전) 정합
          if (sphere && !isInVehicle) {
            sphere.rotation.y = moveAngle;
          }

          if (isGroggy) {
            // 기절 상태 연출: 마네킹을 90도 눕히고 네온 주황색으로 고동 점멸
            if (sphere) {
              sphere.rotation.x = Math.PI / 2;
              sphere.position.y = 0.05;
              const pulse = Math.sin(performance.now() * 0.015) * 0.4 + 0.6;
              sphere.traverse((child) => {
                if (child instanceof THREE.Mesh && child.material && 'emissiveIntensity' in child.material) {
                  (child.material as any).emissiveIntensity = pulse;
                  (child.material as any).color.setHex(0xff6600); // 네온 주황색 강제화
                }
              });
            }
            if (vehicleBox) vehicleBox.visible = false;
            if (airplaneBox) airplaneBox.visible = false;
          } else {
            // 정상 상태 복원
            if (sphere) {
              sphere.rotation.x = 0;
              sphere.position.y = 0;
              sphere.traverse((child) => {
                if (child instanceof THREE.Mesh && child.material && 'emissiveIntensity' in child.material) {
                  (child.material as any).emissiveIntensity = player.isTeam ? 0.55 : 0.35;
                  (child.material as any).color.copy(new THREE.Color(player.color));
                }
              });
            }

            // 사격 연출: 이 플레이어가 400ms 이내에 공격자인 damage 이벤트 존재 시 총기 팔 들어올리기
            const gunArm = sphere ? sphere.getObjectByName("gunArm") : null;
            const recentShot = damageEvents.find(
              ev => ev.attackerName === player.name &&
                    currentTimeMs >= ev.relativeTimeMs &&
                    currentTimeMs <= ev.relativeTimeMs + 400
            );
            if (gunArm) {
              if (recentShot && !isInVehicle) {
                // 사격 리코일: 배럴이 위로 살짝 들려 올라가는 반동 (최대 30도)
                const shotProgress = (currentTimeMs - recentShot.relativeTimeMs) / 400;
                // 빠르게 들리고(0~20%) 천천히 복귀(20~100%)
                const raiseAngle = shotProgress < 0.2
                  ? -(Math.PI / 6) * (shotProgress / 0.2)            // 빠르게 반동
                  : -(Math.PI / 6) * (1 - (shotProgress - 0.2) / 0.8); // 천천히 복귀
                gunArm.rotation.x = raiseAngle;

                // 총구 플래시 — 지속시간과 크기를 확대
                const muzzle = gunArm.getObjectByName("muzzleFlash") as THREE.Mesh | undefined;
                if (muzzle && muzzle.material) {
                  const isActive = shotProgress < 0.3;
                  muzzle.visible = isActive;
                  if (isActive) {
                    (muzzle.material as any).opacity = (1 - shotProgress / 0.3) * 0.95;
                    const mS = 1.0 + (1 - shotProgress) * 0.6; // 번쩍일 때 펑 커지도록 스케일링
                    muzzle.scale.set(mS, mS, mS);
                  } else {
                    (muzzle.material as any).opacity = 0;
                  }
                }
              } else {
                // 비사격 시 팔 수직으로 복귀
                gunArm.rotation.x = 0;
                const muzzle = gunArm.getObjectByName("muzzleFlash") as THREE.Mesh | undefined;
                if (muzzle) {
                  muzzle.visible = false;
                  if (muzzle.material) {
                    (muzzle.material as any).opacity = 0;
                  }
                }
              }
            }

            // 차량 탑승 상태 처리
            if (isInVehicle) {
              const vId = state.vehicleId!;
              const groupMembers = vehicleGroups[vId] || [];
              const myIndex = groupMembers.indexOf(player.name);

              const isPlane = state.isPlane;
              const isDriver = myIndex === 0;

              const seatOffset = getSeatOffset(myIndex >= 0 ? myIndex : 0, isPlane);
              finalWpOffset.copy(seatOffset);

              if (sphere) {
                const sphereScale = player.isTeam ? 0.82 : 0.78;
                sphere.scale.set(sphereScale, sphereScale, sphereScale);
                sphere.position.copy(seatOffset);
              }

              if (isDriver) {
                if (vehicleBox) vehicleBox.visible = !isPlane;
                if (airplaneBox) airplaneBox.visible = isPlane;
                if (vehicleBox) vehicleBox.position.set(0, 0, 0);
                if (airplaneBox) airplaneBox.position.set(0, 0, 0);
              } else {
                if (vehicleBox) vehicleBox.visible = false;
                if (airplaneBox) airplaneBox.visible = false;
              }
            } else {
              // 도보 상태
              if (sphere) {
                sphere.scale.set(1.0, 1.0, 1.0);
                sphere.position.set(0, 0, 0);
              }
              if (vehicleBox) vehicleBox.visible = false;
              if (airplaneBox) airplaneBox.visible = false;
            }
          }
        }
      }

      // 최종 월드 좌표 연산 및 드롭라인 적용
      // 스냅 보정이 반영된 finalPos를 참조하도록 수정하여 캐릭터 마커와 수직선 위치를 1:1 동기화
      const finalWorldPos = finalPos.clone().add(finalWpOffset);

      const dropLineMesh = playerDropLinesRef.current[player.name];
      if (dropLineMesh) {
        // 사망 시 수직 드롭라인은 제거하여 시각 깔끔화
        if (isDead) {
          dropLineMesh.visible = false;
        } else {
          dropLineMesh.visible = player.isTeam ? showTrajectories : (showTrajectories && showEnemies);
        }
        // 해당 캐릭터 X, Z 좌표의 실제 지면 고도 쿼리
        const terrainHeight = getTerrainHeight(finalWorldPos.x, finalWorldPos.z);
        // 드롭라인의 시작점을 실제 지면 높이로 밀착
        dropLineMesh.position.set(finalWorldPos.x, terrainHeight, finalWorldPos.z);
        
        const posAttr = dropLineMesh.geometry.attributes.position;
        // 캐릭터 마커 고도와 지면 고도의 실질적 차이만큼 가이드라인 크기(갭) 설정
        const heightGap = Math.max(0, finalWorldPos.y - terrainHeight);
        posAttr.setY(1, heightGap);
        posAttr.needsUpdate = true;
        dropLineMesh.computeLineDistances();
      }
      
      const lineMesh = playerLinesRef.current[player.name];
      if (lineMesh) {
        lineMesh.visible = showTrajectories;
      }
    });

    // 3) 총탄 트레이서 빔 및 탄착 임팩트 실시간 매칭 드로잉
    const activeDamageEvs = damageEvents.filter(ev => 
      currentTimeMs >= ev.relativeTimeMs && 
      currentTimeMs <= ev.relativeTimeMs + 400
    );

    const tracerPool = tracerPoolRef.current;
    const impactPool = impactPoolRef.current;

    tracerPool.forEach((t) => { t.visible = false; }); 
    impactPool.forEach((im) => { im.visible = false; });

    activeDamageEvs.slice(0, 15).forEach((ev, idx) => {
      const tracer = tracerPool[idx];
      const impact = impactPool[idx];
      if (!tracer || !impact) return;

      const attPos = convertTo3D(ev.attackerX, ev.attackerY, ev.attackerZ || 0, altitudeScale);
      const vicPos = convertTo3D(ev.x, ev.y, ev.z || 0, altitudeScale);

      const direction = new THREE.Vector3().subVectors(vicPos, attPos);
      const length = direction.length();

      if (length > 0.05) {
        const elapsed = currentTimeMs - ev.relativeTimeMs;
        const progress = elapsed / 400;
        const opacity = Math.max(0, 1.0 - progress);

        // 1. 트레이서 빔 업데이트
        tracer.position.copy(attPos).addScaledVector(direction, 0.5);
        tracer.scale.set(1, length, 1);
        tracer.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), direction.clone().normalize());

        const tMat = tracer.material as any;
        tMat.opacity = opacity * 0.95;

        const isTeamAttacker = players.find(p => p.name === ev.attackerName)?.isTeam;
        tMat.color.setHex(isTeamAttacker ? 0x00ffcc : 0xffaa00); 
        tracer.visible = true;

        // 2. 탄착 지점 네온 스파크 구체 업데이트 (진동 팽창 타격감 연출)
        impact.position.copy(vicPos);
        const imScale = 0.6 + progress * 1.6;
        impact.scale.set(imScale, imScale, imScale);

        const imMat = impact.material as any;
        imMat.opacity = opacity * 0.95;
        
        const isVictimTeam = players.find(p => p.name === ev.victimName)?.isTeam;
        imMat.color.setHex(isVictimTeam ? 0xff3300 : 0xffaa00);
        impact.visible = true;
      }
    });

    // 4) 보급 상자 낙하 및 연기 기둥 기동 제어
    carePackages.forEach((cp) => {
      const cpGroup = carePackageMeshesRef.current[cp.id];
      if (!cpGroup) return;

      const spawnPos = convertTo3D(cp.spawnX, cp.spawnY, cp.spawnZ, altitudeScale);
      const landPos = convertTo3D(cp.landX, cp.landY, cp.landZ, altitudeScale);

      if (currentTimeMs < cp.spawnTimeMs) {
        cpGroup.visible = false;
      } else if (currentTimeMs >= cp.spawnTimeMs && currentTimeMs < cp.landTimeMs) {
        // 낙하 연출
        const ratio = (currentTimeMs - cp.spawnTimeMs) / (cp.landTimeMs - cp.spawnTimeMs);
        const currentPos = new THREE.Vector3().lerpVectors(spawnPos, landPos, ratio);

        cpGroup.position.copy(currentPos);
        cpGroup.visible = true;

        const chute = cpGroup.getObjectByName("chute");
        if (chute) chute.visible = true;
        const smoke = cpGroup.getObjectByName("smoke");
        if (smoke) smoke.visible = false;
      } else {
        // 안착 완료 연출
        cpGroup.position.copy(landPos);
        cpGroup.visible = true;

        const chute = cpGroup.getObjectByName("chute");
        if (chute) chute.visible = false;

        const smoke = cpGroup.getObjectByName("smoke");
        if (smoke) {
          smoke.visible = true;
          // 안착 연기 서서히 솟아나면서 출렁거리는 네온 연기 오파시티 고동
          const smokePulse = Math.sin(performance.now() * 0.003) * 0.12 + 0.38;
          const sMat = (smoke as THREE.Mesh).material as any;
          sMat.opacity = smokePulse;
        }
      }
    });

    // 5) 자기장 수축 감지 경고 점멸 효과 적용
    const zone = getInterpolatedZone(currentTimeMs);
    const futureZone = getInterpolatedZone(currentTimeMs + 2000); // 2초 뒤 상황 예측
    const isShrinking = zone.blueRadius > futureZone.blueRadius;

    // 파란 자기장 (Bluezone)
    if (bluezoneMeshRef.current) {
      if (showBluezone && zone.blueRadius > 0) {
        bluezoneMeshRef.current.visible = true;
        const scaleRadiusX = (zone.blueRadius / 8192) * THREE_MAP_SIZE;
        const scaleRadiusZ = (zone.blueRadius / 8192) * THREE_MAP_SIZE;
        bluezoneMeshRef.current.scale.set(scaleRadiusX, 1, scaleRadiusZ);

        const centerPos = convertTo3D(zone.blueX, zone.blueY, 0, altitudeScale);
        bluezoneMeshRef.current.position.set(centerPos.x, 17.5, centerPos.z);

        // 자기장 수축 중일 때 투명도 깜빡임 경고 모션
        const bMat = bluezoneMeshRef.current.material as any;
        if (isShrinking) {
          bMat.opacity = Math.sin(performance.now() * 0.01) * 0.12 + 0.28;
        } else {
          bMat.opacity = 0.22;
        }
      } else {
        bluezoneMeshRef.current.visible = false;
      }
    }

    // 안전구역 (Whitezone)
    if (whitezoneMeshRef.current) {
      if (showBluezone && zone.whiteRadius > 0) {
        whitezoneMeshRef.current.visible = true;
        const scaleRadiusX = (zone.whiteRadius / 8192) * THREE_MAP_SIZE;
        const scaleRadiusZ = (zone.whiteRadius / 8192) * THREE_MAP_SIZE;
        whitezoneMeshRef.current.scale.set(scaleRadiusX, 1, scaleRadiusZ);

        const centerPos = convertTo3D(zone.whiteX, zone.whiteY, 0, altitudeScale);
        whitezoneMeshRef.current.position.set(centerPos.x, 17.5, centerPos.z);
      } else {
        whitezoneMeshRef.current.visible = false;
      }
    }

    // 작전판 외곽선 네온 경고 컬러 동적 변환
    if (borderLineRef.current) {
      const borderMat = borderLineRef.current.material as any;
      if (isShrinking) {
        // 수축 시 긴박감을 주기 위해 노란색/빨간색 고동 변환
        const flashColor = Math.sin(performance.now() * 0.01) > 0 ? 0xff3300 : 0xffaa00;
        borderMat.color.setHex(flashColor);
      } else {
        borderMat.color.setHex(0x00d2ff); // 평상시 하이테크 청록
      }
    }

    // 6) 카메라 실시간 트래킹 추적 고정 (카메라 시점 거리/각도를 유지하며 평행 이동 추적)
    if (trackingPlayer && controlsRef.current) {
      const trackedState = playerStates[trackingPlayer];
      if (trackedState) {
        const currentTarget = controlsRef.current.target.clone();
        const newTarget = trackedState.position.clone();
        
        // 이전 좌표와 현재 플레이어 좌표 간의 이동 3D 변위(차이 벡터)
        const delta = new THREE.Vector3().subVectors(newTarget, currentTarget);
        
        // 카메라의 물리 위치와 타겟 초점을 동시에 변위만큼 평행 이동
        controlsRef.current.object.position.add(delta);
        controlsRef.current.target.copy(newTarget);
        controlsRef.current.update();
      }
    }
  }, [players, showBluezone, showTrajectories, altitudeScale, showEnemies, damageEvents, carePackages, trackingPlayer, hiddenPlayers, showNames, getInterpolatedZone, getTerrainHeight]);

  useEffect(() => {
    updateReplaySceneRef.current = updateReplayScene;
  }, [updateReplayScene]);

  useEffect(() => {
    updateReplayScene(currentTimeMs);
  }, [currentTimeMs, updateReplayScene]);

  // 재생 시간 포맷터 (분:초)
  const formatTime = (ms: number) => {
    const totalSeconds = Math.floor(ms / 1000);
    const mins = Math.floor(totalSeconds / 60);
    const secs = totalSeconds % 60;
    return `${mins.toString().padStart(2, "0")}:${secs.toString().padStart(2, "0")}`;
  };

  const handleFetchTelemetry = () => {
    try {
      const target = resolveReplay3DRequest({
        matchId: matchId.trim(),
        nickname: nickname.trim(),
        platform: platform.trim(),
      });
      startTelemetryRequest(target);
    } catch {
      cancelRequest();
      resetReplayState();
      setIsLoading(false);
      setErrorMsg("3D 리플레이 query가 누락되었거나 지원되지 않습니다.");
    }
  };

  // 플레이어 개별 토글 핸들러
  const togglePlayer = (name: string) => {
    setHiddenPlayers(prev => {
      const next = new Set(prev);
      if (next.has(name)) next.delete(name);
      else next.add(name);
      return next;
    });
  };

  // 플레이어 단일 클릭 시 해당 플레이어 위치로 초점 이동
  const handlePlayerFocus = (name: string) => {
    const player = players.find(p => p.name === name);
    if (!player) return;
    
    // 만약 숨겨진 플레이어라면 자동으로 표시 처리
    if (hiddenPlayers.has(name)) {
      setHiddenPlayers(prev => {
        const next = new Set(prev);
        next.delete(name);
        return next;
      });
    }

    const state = getInterpolatedState(player, currentTimeMs, altitudeScale);
    if (controlsRef.current) {
      controlsRef.current.target.set(state.position.x, 0, state.position.z);
      controlsRef.current.update();
    }
    setTrackingPlayer(null); // 단일 클릭 시 트래킹은 해제
  };

  // 플레이어 더블 클릭 시 트래킹 고정 활성화/비활성화
  const handlePlayerTrack = (name: string) => {
    const player = players.find(p => p.name === name);
    if (!player) return;
    
    // 만약 숨겨진 플레이어라면 자동으로 표시 처리
    if (hiddenPlayers.has(name)) {
      setHiddenPlayers(prev => {
        const next = new Set(prev);
        next.delete(name);
        return next;
      });
    }

    setTrackingPlayer(prev => (prev === name ? null : name));
  };

  // 생존자 수 계산 (사망 시간 기준)
  const aliveCount = players.filter(p =>
    p.deathTimeMs == null || currentTimeMs < p.deathTimeMs
  ).length;

  // 타임라인 이벤트 마커 (킬/기절) 중 아군 관련 이벤트만 필터링
  const timelineMarkers = damageEvents.filter(ev => {
    if (ev.type !== "kill" && ev.type !== "groggy") return false;
    const attackerName = ev.attackerName || ev.attacker;
    const victimName = ev.victim;
    const isAttackerTeam = players.find(p => p.name === attackerName)?.isTeam;
    const isVictimTeam = players.find(p => p.name === victimName)?.isTeam;
    return isAttackerTeam || isVictimTeam;
  });

  // 실시간 킬로그 피드용 최근 이벤트 필터링 (최근 7초 이내)
  const activeKillLogs = damageEvents
    .filter(ev => {
      if (ev.type !== "kill" && ev.type !== "groggy") return false;
      const age = currentTimeMs - ev.relativeTimeMs;
      return age >= 0 && age <= 7000;
    })
    .sort((a, b) => b.relativeTimeMs - a.relativeTimeMs)
    .slice(0, 5);

  return (
    <div className="fixed inset-0 z-50 flex bg-[#0d1117] text-[#e6edf3] font-sans overflow-hidden">

      {/* 모바일 화면용 반투명 배경 가림막 (Overlay) */}
      {isSidebarOpen && (
        <div 
          onClick={() => setIsSidebarOpen(false)}
          className="fixed inset-0 bg-black/60 backdrop-blur-sm z-30 md:hidden animate-in fade-in duration-200"
        />
      )}

      {/* 1. 사이드바 (플레이어 목록 & 텔레메트리 검색 폼) */}
      <ReplaySidebar
        isOpen={isSidebarOpen}
        players={players}
        hiddenPlayers={hiddenPlayers}
        trackingPlayer={trackingPlayer}
        currentTimeMs={currentTimeMs}
        altitudeScale={altitudeScale}
        setAltitudeScale={setAltitudeScale}
        togglePlayer={togglePlayer}
        handlePlayerFocus={handlePlayerFocus}
        handlePlayerTrack={handlePlayerTrack}
        showBluezone={showBluezone}
        setShowBluezone={setShowBluezone}
        showTrajectories={showTrajectories}
        setShowTrajectories={setShowTrajectories}
        showNames={showNames}
        setShowNames={setShowNames}
        isLoading={isLoading}
        isMapLoading={isMapLoading}
        handleFetchTelemetry={handleFetchTelemetry}
      />

      {/* 사이드바 토글 탭 (PC 전용) */}
      <button
        onClick={() => setIsSidebarOpen(o => !o)}
        className="hidden md:flex fixed md:absolute top-1/2 -translate-y-1/2 z-50 w-5 h-14 items-center justify-center bg-[#21262d] border border-[#30363d] rounded-r-lg text-[#8b949e] hover:text-[#ff9f0a] hover:bg-[#30363d] transition-all cursor-pointer"
        style={{ left: isSidebarOpen ? "288px" : "0px", transition: "left 0.3s" }}
      >
        {isSidebarOpen ? <ChevronLeft className="w-3.5 h-3.5" /> : <ChevronRight className="w-3.5 h-3.5" />}
      </button>

      {/* ── 뷰포트 ── */}
      <div ref={containerRef} className="flex-1 relative bg-[#0d1117] min-w-0">
        <canvas ref={canvasRef} className="w-full h-full block cursor-grab active:cursor-grabbing" />

        {/* 2. 좌상단 HUD 오버레이 */}
        {!isLoading && players.length > 0 && (
          <ReplayHUD
            currentTimeMs={currentTimeMs}
            maxTimeMs={maxTimeMs}
            aliveCount={aliveCount}
            zones={zones}
            onBack={() => {
              if (window.history.length > 1) {
                router.back();
              } else {
                router.push("/stats");
              }
            }}
            formatTime={formatTime}
            isSidebarOpen={isSidebarOpen}
            onToggleSidebar={() => setIsSidebarOpen(o => !o)}
          />
        )}

        {!isLoading && players.length === 0 && (
          <button
            type="button"
            onClick={() => setIsSidebarOpen(true)}
            title="패널 열기"
            className="absolute left-3 top-3 z-10 flex h-9 w-9 items-center justify-center rounded-lg border border-[#30363d] bg-[#161b22]/95 text-[#8b949e] shadow-lg backdrop-blur transition-all hover:border-[#ff9f0a] hover:text-[#ff9f0a] md:hidden"
          >
            <PanelLeftOpen className="h-4 w-4" />
          </button>
        )}

        {/* 3. 실시간 킬로그 피드 */}
        {!isLoading && players.length > 0 && (
          <ReplayKillFeed
            activeKillLogs={activeKillLogs}
            players={players}
          />
        )}

        {/* 로딩 오버레이 */}
        {(isLoading || isMapLoading) && (
          <div className="absolute inset-0 flex items-center justify-center bg-[#0d1117]/90 backdrop-blur-sm z-20">
            <div className="flex flex-col items-center gap-4">
              <div className="relative">
                <Loader2 className="w-12 h-12 text-[#ff9f0a] animate-spin" />
                <div className="absolute inset-0 w-12 h-12 rounded-full border-2 border-[#ff9f0a]/20" />
              </div>
              <div className="text-center">
                <p className="text-sm font-bold text-[#ff9f0a]">
                  {isLoading ? "텔레메트리 분석 중..." : "지형 텍스처 로딩 중..."}
                </p>
                <p className="text-[10px] text-[#8b949e] mt-1">PUBG API 데이터 처리</p>
              </div>
            </div>
          </div>
        )}

        {errorMsg && !isLoading && (
          <div className="absolute inset-x-3 top-14 z-20 mx-auto max-w-sm rounded-lg border border-[#ff9f0a]/35 bg-[#161b22]/95 p-3 text-[#e6edf3] shadow-xl backdrop-blur sm:top-16">
            <div className="flex items-start gap-2.5">
              <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-[#ff9f0a]" />
              <div className="min-w-0 flex-1">
                <p className="text-xs font-bold text-[#ff9f0a]">리플레이 데이터를 불러오지 못했습니다.</p>
                <p className="mt-1 text-[11px] leading-relaxed text-[#8b949e]">{errorMsg}</p>
              </div>
            </div>
            <div className="mt-3 flex gap-2">
              <button
                type="button"
                onClick={handleFetchTelemetry}
                className="inline-flex min-h-9 flex-1 items-center justify-center gap-1.5 rounded-md border border-[#ff9f0a]/45 bg-[#ff9f0a]/10 px-3 text-[11px] font-bold text-[#ff9f0a] transition-colors hover:bg-[#ff9f0a] hover:text-[#0d1117]"
              >
                <RefreshCw className="h-3.5 w-3.5" />
                다시 시도
              </button>
              <button
                type="button"
                onClick={() => setIsSidebarOpen(true)}
                className="inline-flex min-h-9 items-center justify-center gap-1.5 rounded-md border border-[#30363d] bg-[#21262d] px-3 text-[11px] font-bold text-[#8b949e] transition-colors hover:border-[#ff9f0a] hover:text-[#ff9f0a]"
              >
                <PanelLeftOpen className="h-3.5 w-3.5" />
                패널
              </button>
            </div>
          </div>
        )}

        {/* 4. 하단 타임라인 조작 바 */}
        {!errorMsg && players.length > 0 && (
          <ReplayTimeline
            currentTimeMs={currentTimeMs}
            setCurrentTimeMs={setCurrentTimeMs}
            maxTimeMs={maxTimeMs}
            isPlaying={isPlaying}
            setIsPlaying={setIsPlaying}
            playbackSpeed={playbackSpeed}
            setPlaybackSpeed={setPlaybackSpeed}
            timelineMarkers={timelineMarkers}
            players={players}
            formatTime={formatTime}
          />
        )}
      </div>
    </div>
  );
}

export default function Replay3DPage() {
  return (
    <Suspense fallback={
      <div className="flex h-screen w-screen flex-col items-center justify-center bg-[#0d1117] text-[#ff9f0a] gap-3">
        <Loader2 className="w-10 h-10 animate-spin text-[#ff9f0a]" />
        <span className="text-sm font-bold tracking-widest uppercase">전술 작전판 초기화 중...</span>
      </div>
    }>
      <Replay3DContent />
    </Suspense>
  );
}
