"use client";

import React, { useCallback, useEffect, useMemo, useRef, useState, Suspense } from "react";
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
import {
  getActiveDeathTime,
  createBuildingIndex,
  findWaypointSegment,
  getHeadingAt,
  getReplayMaxTime,
  interpolateSmooth,
  isGroggyAt,
  joinVehicleCluster,
  lowerBoundByTime,
  matchCarePackageLandings,
  normalizeReplayZoneEvents,
  sampleTerrainHeight,
  shouldMarkPlayerDeadFromHealth,
  type ReplayZoneEvent,
  type TerrainGrid,
  type VehicleCluster,
} from "@/lib/replay/replay3dHelpers";
import { heightmapElevationMeters, heightmapUrl, threeToHeightmapPixel } from "@/lib/heightmapCoords";
import { MAX_POSITION_INTERPOLATION_GAP_MS } from "@/lib/pubg-analysis/telemetryContract";
import { isCombatDamageCause } from "@/lib/pubg-analysis/replayEventKinds";
import { SQUAD_COLORS, enemyTeamColor } from "@/lib/replay/squadColors";
import { metersPerUnit } from "@/lib/replay/replayCamera";

// PUBG 맵 크기 상수 (cm)
const THREE_MAP_SIZE = 100; // Three.js 공간 상의 가로세로 크기
const MOBILE_QUERY = "(max-width: 767px)";
const MOBILE_TERRAIN_SEGMENTS = 128;
const DESKTOP_TERRAIN_SEGMENTS = 256;
const MOBILE_RENDER_FPS = 30;
const DESKTOP_RENDER_FPS = 60;
const UI_TIME_UPDATE_INTERVAL_MS = 120;
// 마커·라벨은 화면 크기 고정(sizeAttenuation false) 스프라이트라 값은 화면 높이 비율에 가깝다.
const TEAM_MARKER_SIZE = 0.024;
const ENEMY_MARKER_SIZE = 0.015;
const LABEL_HEIGHT = 0.024;
const CARE_PACKAGE_MARKER_SIZE = 0.02;
// 따라가는 선수 주변의 적만 이름을 띄워 화면이 이름표로 덮이지 않게 한다.
const ENEMY_LABEL_RANGE_M = 300;
const TRACER_POOL_SIZE = 48;
const TRACER_DURATION_MS = 400;
// 배속이 높아도 명중선이 화면에 이만큼(실제 시간)은 남도록 경기 시간 기준 유지 시간을 늘린다.
const TRACER_SCREEN_MS = 500;
// 이보다 빠른 위치 변화(약 200m/s, 8km 맵 기준)는 순간이동으로 보고 곡선 보간에 쓰지 않는다.
const SMOOTHING_MAX_UNITS_PER_MS = 0.2;
// 카메라가 따라가는 대상과 이 거리(Three 단위) 넘게 떨어지면 부드럽게 옮기지 않고 바로 맞춘다.
const FOLLOW_SNAP_DISTANCE = 15;
const FOLLOW_SMOOTHING_MS = 160;
// 따라갈 선수를 바꾸면 이 시간 동안 부드럽게 시점을 옮긴다.
const FOLLOW_ENTRY_MS = 1800;
// 건물 안에서 지면보다 이만큼(m) 높으면 옥상·위층으로 보고 지면에 붙이지 않는다. 선수 위치는 지면보다 약 1m 위다.
const STRUCTURE_MIN_HEIGHT_M = 2;
// 끌어서 이동한 거리가 이만큼(Three 단위, 약 40m) 쌓여야 따라가기를 끈다. 모바일 두 손가락 확대의 미세 이동은 무시한다.
const FOLLOW_RELEASE_DISTANCE = 0.5;
// 자기장은 경계만 알 수 있게 낮은 벽으로 둔다. 높으면 시야를 가린다.
const BLUE_WALL = { bottom: -1, top: 3 };
const WHITE_WALL = { bottom: -1, top: 1.5 };

type RenderProfile = {
  terrainSegments: number;
  maxPixelRatio: number;
  antialias: boolean;
  textureAnisotropy: number;
  targetFps: number;
};

const getRenderProfile = (): RenderProfile => {
  if (typeof window === "undefined") {
    return {
      terrainSegments: DESKTOP_TERRAIN_SEGMENTS,
      maxPixelRatio: 2,
      antialias: true,
      textureAnisotropy: 8,
      targetFps: DESKTOP_RENDER_FPS
    };
  }

  const isMobile = window.matchMedia(MOBILE_QUERY).matches;
  return {
    terrainSegments: isMobile ? MOBILE_TERRAIN_SEGMENTS : DESKTOP_TERRAIN_SEGMENTS,
    maxPixelRatio: isMobile ? 1.25 : 2,
    antialias: !isMobile,
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

type MarkerShape = "foot" | "vehicle" | "plane" | "groggy" | "dead" | "carePackage";

// 상태별 마커 아이콘. 도보는 원, 차량은 둥근 사각형, 비행기는 삼각형, 기절은 주황 원, 사망은 회색 X, 보급 상자는 마름모.
const drawMarkerTexture = (shape: MarkerShape, color: string): THREE.CanvasTexture => {
  const canvas = document.createElement("canvas");
  canvas.width = 64;
  canvas.height = 64;
  const ctx = canvas.getContext("2d");
  if (ctx) {
    ctx.lineJoin = "round";
    ctx.lineWidth = 6;
    ctx.strokeStyle = "#ffffff";
    ctx.fillStyle = color;
    ctx.beginPath();
    if (shape === "vehicle") {
      ctx.roundRect(10, 10, 44, 44, 10);
    } else if (shape === "carePackage") {
      ctx.moveTo(32, 4);
      ctx.lineTo(60, 32);
      ctx.lineTo(32, 60);
      ctx.lineTo(4, 32);
      ctx.closePath();
    } else if (shape === "plane") {
      ctx.moveTo(32, 6);
      ctx.lineTo(58, 56);
      ctx.lineTo(6, 56);
      ctx.closePath();
    } else if (shape === "dead") {
      ctx.lineCap = "round";
      ctx.lineWidth = 14;
      ctx.strokeStyle = "rgba(10, 14, 20, 0.85)";
      ctx.moveTo(16, 16); ctx.lineTo(48, 48);
      ctx.moveTo(48, 16); ctx.lineTo(16, 48);
      ctx.stroke();
      ctx.lineWidth = 7;
      ctx.strokeStyle = "#9ca3af";
      ctx.stroke();
    } else {
      ctx.arc(32, 32, 22, 0, Math.PI * 2);
    }
    if (shape !== "dead") {
      if (shape === "groggy") {
        ctx.fillStyle = "#ff7a1a";
        ctx.strokeStyle = color;
      }
      ctx.fill();
      ctx.stroke();
    }
  }
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  return texture;
};

const getMarkerTexture = (cache: Map<string, THREE.Texture>, shape: MarkerShape, color: string): THREE.Texture => {
  const key = `${shape}|${color}`;
  let texture = cache.get(key);
  if (!texture) {
    texture = drawMarkerTexture(shape, color);
    cache.set(key, texture);
  }
  return texture;
};

const createScreenSprite =(texture: THREE.Texture, size: number, aspect = 1): THREE.Sprite => {
  const sprite = new THREE.Sprite(new THREE.SpriteMaterial({
    map: texture,
    sizeAttenuation: false,
    // 산 뒤에 있어도 위치를 놓치지 않도록 지형에 가리지 않는다.
    depthTest: false,
    depthWrite: false
  }));
  sprite.scale.set(size * aspect, size, 1);
  return sprite;
};

// 닉네임 라벨. 마커 위에 뜨도록 스프라이트 기준점을 아래로 내린다.
const createNicknameSprite = (text: string, color: string): THREE.Sprite => {
  const canvas = document.createElement("canvas");
  canvas.width = 256;
  canvas.height = 48;
  const ctx = canvas.getContext("2d");
  if (ctx) {
    ctx.font = "bold 26px sans-serif";
    const maxLen = 14;
    const displayText = text.length > maxLen ? text.slice(0, maxLen - 2) + ".." : text;
    const boxWidth = Math.min(252, ctx.measureText(displayText).width + 24);
    const left = (256 - boxWidth) / 2;
    ctx.fillStyle = "rgba(10, 14, 20, 0.78)";
    ctx.beginPath();
    ctx.roundRect(left, 4, boxWidth, 40, 8);
    ctx.fill();
    ctx.fillStyle = color;
    ctx.fillRect(left, 4, 5, 40);
    ctx.fillStyle = "#ffffff";
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillText(displayText, 128 + 2, 25);
  }
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  const sprite = createScreenSprite(texture, LABEL_HEIGHT, 256 / 48);
  sprite.center.set(0.5, -0.45);
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

// 차량 모형. 실제(약 4m)보다 크게 잡아 기본 시점에서 차종 대신 "차량"으로 읽히게 한다. 앞쪽이 +Z다.
const createVehicleModel = (color: string): THREE.Group => {
  const model = new THREE.Group();
  const body = new THREE.MeshStandardMaterial({ color, roughness: 0.6, metalness: 0.1 });
  const dark = new THREE.MeshStandardMaterial({ color: 0x1f242c, roughness: 0.8 });
  const chassis = new THREE.Mesh(new THREE.BoxGeometry(0.28, 0.1, 0.55), body);
  chassis.position.y = 0.1;
  const cabin = new THREE.Mesh(new THREE.BoxGeometry(0.24, 0.1, 0.26), dark);
  cabin.position.set(0, 0.2, -0.04);
  model.add(chassis, cabin);
  [[-0.15, 0.17], [0.15, 0.17], [-0.15, -0.17], [0.15, -0.17]].forEach(([x, z]) => {
    const wheel = new THREE.Mesh(new THREE.CylinderGeometry(0.06, 0.06, 0.05, 10), dark);
    wheel.rotation.z = Math.PI / 2;
    wheel.position.set(x, 0.06, z);
    model.add(wheel);
  });
  model.scale.setScalar(1.5);
  return model;
};

// 수송기 모형. 앞쪽이 +Z다.
const createPlaneModel = (): THREE.Group => {
  const model = new THREE.Group();
  const material = new THREE.MeshStandardMaterial({ color: 0xaab2bc, roughness: 0.5, metalness: 0.2 });
  const fuselage = new THREE.Mesh(new THREE.CylinderGeometry(0.09, 0.07, 1.6, 10), material);
  fuselage.rotation.x = Math.PI / 2;
  const wing = new THREE.Mesh(new THREE.BoxGeometry(1.8, 0.03, 0.3), material);
  wing.position.set(0, 0.04, 0.1);
  const tailplane = new THREE.Mesh(new THREE.BoxGeometry(0.6, 0.03, 0.18), material);
  tailplane.position.set(0, 0.04, -0.7);
  const fin = new THREE.Mesh(new THREE.BoxGeometry(0.03, 0.28, 0.22), material);
  fin.position.set(0, 0.16, -0.7);
  model.add(fuselage, wing, tailplane, fin);
  return model;
};

// 비상호출 수송 비행기 판정 헬퍼 함수
const isAirplane = (vehicleId: string | null | undefined): boolean => {
  if (!vehicleId) return false;
  const lower = vehicleId.toLowerCase();
  return lower.includes("emergency") || lower.includes("plane") || lower.includes("flight") || lower.includes("air");
};

const disposeObject = (object: THREE.Object3D) => {
  object.traverse((child) => {
    if (child instanceof THREE.Sprite) {
      // Sprite 지오메트리는 three.js 전역 공유라 재질과 텍스처만 정리한다.
      child.material.map?.dispose();
      child.material.dispose();
    } else if (child instanceof THREE.Mesh || child instanceof THREE.Line) {
      // InstancedMesh는 인스턴스 행렬 버퍼를 따로 해제해야 한다.
      if (child instanceof THREE.InstancedMesh) child.dispose();
      child.geometry.dispose();
      const materials = Array.isArray(child.material) ? child.material : [child.material];
      materials.forEach((material) => material.dispose());
    }
  });
};

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
  // 쿼리 없이 진입한 데모 매치인지 여부.
  // 데모 매치 텔레메트리는 PUBG 보존 기간이 지나면 조회할 수 없어 안내 문구를 구분한다.
  const [isDemoTarget, setIsDemoTarget] = useState(demoRequest !== null);
  
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
  const terrainGridRef = useRef<TerrainGrid | null>(null);
  // 맵 좌표가 건물 안인지 묻는 함수. 옥상 선수를 지면에 붙이지 않는 데 쓴다.
  const buildingIndexRef = useRef<((x: number, y: number) => boolean) | null>(null);
  const sceneGenerationRef = useRef(0);
  const currentTimeRef = useRef(0);
  const renderStateVersionRef = useRef(0);
  const lastUiTimeSyncRef = useRef(0);
  const isPlayingRef = useRef(false);
  const playbackSpeedRef = useRef(playbackSpeed);
  const maxTimeRef = useRef(maxTimeMs);
  const updateReplaySceneRef = useRef<(frameTimeMs: number) => void>(() => {});

  // 마커 및 라인 씬 객체 캐시
  const playerMeshesRef = useRef<Record<string, THREE.Group>>({});
  const playerLinesRef = useRef<Record<string, THREE.Line>>({});
  const playerDropLinesRef = useRef<Record<string, THREE.Line>>({});
  const bluezoneMeshRef = useRef<THREE.Mesh | null>(null);
  const whitezoneMeshRef = useRef<THREE.Mesh | null>(null);
  const tracerPoolRef = useRef<THREE.Line[]>([]);
  const carePackageMeshesRef = useRef<Record<number, THREE.Sprite>>({});
  const markerTexturesRef = useRef<Map<string, THREE.Texture> | null>(null);
  // 카메라가 따라갈 현재 위치. 렌더 루프가 이 값으로 부드럽게 옮긴다.
  const followTargetRef = useRef<THREE.Vector3 | null>(null);
  const followEntryRef = useRef<{ from: THREE.Vector3; startedAt: number } | null>(null);
  // 직전 프레임에 각 탑승자가 묶였던 차량 기준 선수. 같은 차량이 한 대·두 대로 번갈아 보이지 않게 한다.
  const vehicleAnchorsRef = useRef<Map<string, string>>(new Map());
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
    setIsMapLoading(false);
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
  }, [currentTimeMs, players, zones, showBluezone, showTrajectories, altitudeScale, damageEvents, carePackages, trackingPlayer, hiddenPlayers, showNames]);

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
              vehicleUniqueId: ev.vehicleUniqueId || null,
              health: ev.health ?? ev.character?.health ?? 100
            };
          })
          .filter((wp: any) => wp.x !== 0 || wp.y !== 0)
          .sort((a: any, b: any) => a.t - b.t);

          // 대기실에서 나간 선수는 경기 시작 뒤 위치가 없으므로 선수로 세지 않는다(2D와 같은 기준).
          if (waypoints.some((wp: any) => wp.t >= 0)) {
            const teamId = posEvs[0]?.teamId ?? posEvs[0]?.character?.teamId ?? 999;
            let color = "#ff4a4a"; // 기본값
            if (isTeam) {
              const teamIdx = Array.from(teamNames).findIndex((n: any) => n.trim().toLowerCase() === lowerName);
              color = SQUAD_COLORS[teamIdx >= 0 ? teamIdx % SQUAD_COLORS.length : 0];
            } else {
              // 적군은 스쿼드 teamId별로 고유 색상 매핑
              color = enemyTeamColor(teamId);
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
      const zoneEvents = Array.isArray(data.zoneEvents) ? data.zoneEvents : [];
      const parsedZones: ZoneState[] = normalizeReplayZoneEvents(zoneEvents as ReplayZoneEvent[]);

      // 3) 전체 재생 시간 산출
      // 3) 총탄 트레이서용 데미지 공격/피해 및 전투 이벤트 필터링
      const parsedDamageEvs = events.filter((ev: any) => 
        // 트레이서는 실제 총격 등 교전 피해만 그린다. 자기 피해·출혈·자기장, 폭발·화염(탄도가 아님)은 제외한다.
        (ev.type === "damage" && ev.attackerX != null && ev.attackerName !== ev.victimName
          && isCombatDamageCause(ev.cause) && !["grenade", "explosion", "fire"].includes(ev.cause)) ||
        ev.type === "kill" ||
        ev.type === "groggy" ||
        ev.type === "revive"
      );

      // 4) 보급 상자 이벤트 매칭 (Spawn -> Land 연결)
      const cpSpawns = events.filter((ev: any) => ev.type === "carepackage_spawn");
      const cpLands = events.filter((ev: any) => ev.type === "carepackage_land");
      
      const parsedCarePackages: any[] = [];
      const cpLandMatches = matchCarePackageLandings(cpSpawns, cpLands);
      cpSpawns.forEach((spawn: any, idx: number) => {
        const land: any = cpLandMatches[idx];
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

      // 5) 전체 재생 시간 산출 (입력 이벤트 순서에 의존하지 않음)
      const finalMaxTime = getReplayMaxTime(events);

      if (!isCurrent(request)) return;
      setSelectedMap(mapCapability.id);
      setPlayers(parsedPlayers);
      setZones(parsedZones);
      setDamageEvents(parsedDamageEvs);
      setCarePackages(parsedCarePackages);
      setMaxTimeMs(finalMaxTime);
      // 검색한 선수를 기본으로 따라간다.
      const lowerNickname = targetNickname.trim().toLowerCase();
      setTrackingPlayer(
        parsedPlayers.find((p) => p.name.toLowerCase() === lowerNickname)?.name
          ?? parsedPlayers.find((p) => p.isTeam)?.name
          ?? null,
      );

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
    setIsDemoTarget(target.isDemo);
    const request = startTelemetryRequest(target);
    return () => cancelRequest(request);
  }, [cancelRequest, qMatchId, qNickname, qPlatform, resetReplayState, startTelemetryRequest]);

  // 특정 X, Z 월드 좌표에서 하이트맵 고도 데이터를 기반으로 실제 지형 높이 Y를 계산하는 헬퍼 함수
  // 고해상도 하이트맵의 해발 높이(m). 하이트맵이 없으면 null이다.
  const getGroundMeters = useCallback((threeX: number, threeZ: number): number | null => {
    const data = heightmapDataRef.current;
    if (!data) return null;
    const pixel = threeToHeightmapPixel(threeX, threeZ, THREE_MAP_SIZE, data.width, data.height);
    return heightmapElevationMeters(data.pixels[(pixel.y * data.width + pixel.x) * 4]);
  }, []);

  const getTerrainHeight = useCallback((threeX: number, threeZ: number): number => {
    // 1) 3D 지형 메쉬와 동일한 격자 기준의 이중 선형 보간 캐시가 있는 경우 우선 사용
    if (terrainGridRef.current) {
      return sampleTerrainHeight(terrainGridRef.current, threeX, threeZ, THREE_MAP_SIZE);
    }
    // 2) 폴백: 캐시가 아직 로드되지 않은 경우 하이트맵 픽셀을 직접 쿼리
    const ground = getGroundMeters(threeX, threeZ);
    return ground === null ? 0.05 : ground * altitudeScale;
  }, [altitudeScale, getGroundMeters]);

  // 2. 플레이어 위치 및 차량 탑승 상태 보간 계산 함수
  type InterpolatedPlayerState = {
    position: THREE.Vector3;
    vehicleId: string | null;
    // 탑승자 묶기에 쓰는 키. 차량 인스턴스 ID가 없으면 차종 이름을 쓴다.
    vehicleKey: string | null;
    vehicleUniqueId: string | null;
    health: number;
    healthSampleTimeMs: number | null;
  };

  const getInterpolatedState = useCallback((player: PlayerTrajectory, time: number, altitudeScale: number): InterpolatedPlayerState => {
    const pts = player.waypoints;
    if (!pts || pts.length === 0) {
      return {
        position: new THREE.Vector3(0, 0, 0),
        vehicleId: null,
        vehicleKey: null,
        vehicleUniqueId: null,
        health: 100,
        healthSampleTimeMs: null,
      };
    }
    if (time <= pts[0].t) {
      return { 
        position: convertTo3D(pts[0].x, pts[0].y, pts[0].z, altitudeScale),
        vehicleId: pts[0].vehicleId || null,
        vehicleKey: pts[0].vehicleUniqueId || pts[0].vehicleId || null,
        vehicleUniqueId: pts[0].vehicleUniqueId || null,
        health: pts[0].health ?? 100,
        healthSampleTimeMs: pts[0].t,
      };
    }
    if (time >= pts[pts.length - 1].t) {
      const last = pts[pts.length - 1];
      return {
        position: convertTo3D(last.x, last.y, last.z, altitudeScale),
        vehicleId: last.vehicleId || null,
        vehicleKey: last.vehicleUniqueId || last.vehicleId || null,
        vehicleUniqueId: last.vehicleUniqueId || null,
        health: last.health ?? 100,
        healthSampleTimeMs: last.t,
      };
    }

    const i = findWaypointSegment(pts, time);
    const p1 = pts[i];
    const p2 = pts[i + 1];
    if (p2) {
      // 재배치 같은 긴 공백은 2D 리플레이와 같은 기준으로 잇지 않고 이전 위치에 머문다.
      // 수송기 탑승도 순간이동이라 대기 장소에서 수송기까지 잇지 않는다.
      const isBoarding = !isAirplane(p1.vehicleId) && isAirplane(p2.vehicleId);
      const ratio = (p2.t - p1.t > MAX_POSITION_INTERPOLATION_GAP_MS || isBoarding) && time < p2.t ? 0 : (time - p1.t) / (p2.t - p1.t);
      const { x, y, z } = ratio === 0
        ? p1
        : interpolateSmooth(pts, i, time, MAX_POSITION_INTERPOLATION_GAP_MS, SMOOTHING_MAX_UNITS_PER_MS);
      // Health is an observation, not a continuously interpolated value.
      // Use the most recent sample at or before the current frame so a
      // pre-redeploy zero cannot bleed into the next life.
      const healthSample = time >= p2.t ? p2 : p1;
      return {
        position: convertTo3D(x, y, z, altitudeScale),
        vehicleId: (ratio >= 0.5 ? p2.vehicleId : p1.vehicleId) || null,
        vehicleKey: (ratio >= 0.5 ? (p2.vehicleUniqueId || p2.vehicleId) : (p1.vehicleUniqueId || p1.vehicleId)) || null,
        vehicleUniqueId: (ratio >= 0.5 ? p2.vehicleUniqueId : p1.vehicleUniqueId) || null,
        health: healthSample.health ?? 100,
        healthSampleTimeMs: healthSample.t,
      };
    }
    return {
      position: convertTo3D(pts[0].x, pts[0].y, pts[0].z, altitudeScale),
      vehicleId: pts[0].vehicleId || null,
      vehicleKey: pts[0].vehicleUniqueId || pts[0].vehicleId || null,
      vehicleUniqueId: pts[0].vehicleUniqueId || null,
      health: pts[0].health ?? 100,
      healthSampleTimeMs: pts[0].t,
    };
  }, []);

  // 3. 자기장 속성 선형 보간 계산 함수
  const getInterpolatedZone = useCallback((time: number) => {
    if (zones.length === 0) {
      return { t: time, whiteX: 4096, whiteY: 4096, whiteRadius: 0, blueX: 4096, blueY: 4096, blueRadius: 0 };
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
  }, [zones]);

  // 4. Three.js Engine 마운트 및 렌더 룹 설정
  useEffect(() => {
    if (!selectedMap || !canvasRef.current || !containerRef.current) return;

    const sceneGeneration = sceneGenerationRef.current + 1;
    sceneGenerationRef.current = sceneGeneration;
    let isSceneActive = true;
    const isSceneCurrent = () =>
      isSceneActive && sceneGenerationRef.current === sceneGeneration;
    // Do not let a previous map's height data snap the new scene while assets load.
    heightmapDataRef.current = null;
    terrainGridRef.current = null;
    buildingIndexRef.current = null;

    const renderProfile = getRenderProfile();
    const width = containerRef.current.clientWidth;
    const height = containerRef.current.clientHeight;

    // [A] Scene 설정
    const scene = new THREE.Scene();
    scene.background = new THREE.Color("#0b1018");
    sceneRef.current = scene;

    // [B] Camera 설정. 첫 프레임에 따라가는 선수 위치로 옮겨지므로 기준점에서의 거리·각도만 정한다.
    const camera = new THREE.PerspectiveCamera(45, width / height, 0.1, 1000);
    camera.position.set(0, 12, 16);

    // [C] WebGLRenderer 설정
    const renderer = new THREE.WebGLRenderer({
      canvas: canvasRef.current,
      antialias: renderProfile.antialias,
      alpha: false
    });
    renderer.setSize(width, height);
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, renderProfile.maxPixelRatio));
    rendererRef.current = renderer;

    // [D] OrbitControls 연동
    const controls = new OrbitControls(camera, renderer.domElement);
    controls.enableDamping = true;
    controls.dampingFactor = 0.08;
    controls.maxPolarAngle = Math.PI * 0.45;
    controls.minDistance = 2;
    controls.maxDistance = 160;
    controls.screenSpacePanning = false;
    controlsRef.current = controls;

    // [E] 조명 배치. 위성 지도 색이 그대로 보이도록 밝은 환경광 위주로 둔다.
    scene.add(new THREE.HemisphereLight(0xffffff, 0x404040, 1.6));
    const dirLight = new THREE.DirectionalLight(0xffffff, 1.1);
    dirLight.position.set(-30, 60, 20);
    scene.add(dirLight);

    // [G] 지형 고도(Heightmap)를 반영한 입체 지형 메쉬 생성
    const segments = renderProfile.terrainSegments;
    const planeGeo = new THREE.PlaneGeometry(THREE_MAP_SIZE, THREE_MAP_SIZE, segments - 1, segments - 1);

    setIsMapLoading(true);

    // zoom 2 타일 16장을 canvas에 합성해 1024x1024 고화질 텍스처 생성
    const texture = new THREE.Texture();
    texture.colorSpace = THREE.SRGBColorSpace;
    mapTextureRef.current = texture;
    let fallbackTexture: THREE.Texture | null = null;
    let mapMesh: THREE.Mesh | null = null;

    buildHighResTileTexture(selectedMap)
      .then((canvas) => {
        if (!isSceneCurrent()) return;
        texture.image = canvas;
        // GPU가 지원하는 최대 이방성 필터링 적용 (경사 뷰에서 텍스처 선명도 유지)
        texture.anisotropy = Math.min(renderer.capabilities.getMaxAnisotropy(), renderProfile.textureAnisotropy);
        texture.needsUpdate = true;
        renderStateVersionRef.current += 1;
        setIsMapLoading(false);
      })
      .catch(() => {
        if (!isSceneCurrent()) return;
        // 합성 실패 시 zoom 0 단일 이미지로 폴백
        const fallbackLoader = new THREE.TextureLoader();
        fallbackLoader.load(
          `/tiles/${selectedMap}/0/0/-1.jpg`,
          (txt) => {
            if (!isSceneCurrent()) {
              txt.dispose();
              return;
            }
            txt.colorSpace = THREE.SRGBColorSpace;
            fallbackTexture = txt;
            if (!mapMesh) {
              txt.dispose();
              return;
            }
            (mapMesh.material as THREE.MeshStandardMaterial).map = txt;
            (mapMesh.material as THREE.MeshStandardMaterial).needsUpdate = true;
            renderStateVersionRef.current += 1;
            setIsMapLoading(false);
          },
          undefined,
          () => {
            if (isSceneCurrent()) setIsMapLoading(false);
          }
        );
      });

    // 금속성을 빼고 무광으로 두어 지도가 어둡게 반사되지 않게 한다.
    const planeMat = new THREE.MeshStandardMaterial({
      map: texture,
      side: THREE.DoubleSide,
      roughness: 1,
      metalness: 0
    });

    const terrainMesh = new THREE.Mesh(planeGeo, planeMat);
    mapMesh = terrainMesh;
    terrainMesh.rotation.x = -Math.PI / 2;
    terrainMesh.position.y = 0;
    scene.add(terrainMesh);
    mapMeshRef.current = terrainMesh;

    // Load map elevation details asynchronously for supported maps
    const supportedMaps = ["Erangel", "Miramar", "Vikendi", "Taego", "Deston", "Rondo"];
    let heightmapImage: HTMLImageElement | null = null;
    if (supportedMaps.includes(selectedMap)) {
      const heightmapImg = new Image();
      heightmapImage = heightmapImg;
      heightmapImg.crossOrigin = "anonymous";
      heightmapImg.src = heightmapUrl(selectedMap);
      heightmapImg.onload = () => {
        if (!isSceneCurrent()) return;
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

            for (let i = 0; i < count; i++) {
              const x = posAttr.getX(i); // Local X coordinate (-50 to 50)
              const y = posAttr.getY(i); // Local Y coordinate (-50 to 50)

              // rotation.x = -PI/2 이후 로컬 +Y는 월드 -Z(북쪽)가 된다.
              const pixel = threeToHeightmapPixel(x, -y, THREE_MAP_SIZE, heightmapImg.width, heightmapImg.height);
              const pixelIdx = (pixel.y * heightmapImg.width + pixel.x) * 4;
              let finalElevation = 0;
              if (pixels[pixelIdx + 3] !== 0) { // Skip transparent pixels if any
                finalElevation = heightmapElevationMeters(pixels[pixelIdx]) * altitudeScale;
                posAttr.setZ(i, finalElevation);
              }

              const ix = i % segments;
              const iy = Math.floor(i / segments);
              grid[iy][ix] = finalElevation;
            }
            terrainGridRef.current = { grid, size: segments };
            posAttr.needsUpdate = true;
            planeGeo.computeVertexNormals();
            placeBuildings();
            renderStateVersionRef.current += 1;
          } catch {
            if (isSceneCurrent()) setIsMapLoading(false);
          }
        }
      };
      heightmapImg.onerror = () => {
        if (isSceneCurrent()) setIsMapLoading(false);
      };
    }

    // [G-2] 건물. 하이트맵에서 뽑은 건물 사각형(맵 좌표 중심·폭·길이·회전·높이)을 상자 하나로 일괄 그린다.
    // 바닥 높이는 지형 격자에서 구하므로 지형이 준비된 뒤에 배치한다.
    const buildingGeo = new THREE.BoxGeometry(1, 1, 1);
    const buildingMat = new THREE.MeshStandardMaterial({ color: 0xd5d9df, roughness: 0.9, metalness: 0 });
    let buildingData: number[][] | null = null;
    let buildingsPlaced = false;
    function placeBuildings() {
      const terrain = terrainGridRef.current;
      if (!buildingData || !terrain || buildingsPlaced || !isSceneCurrent()) return;
      buildingsPlaced = true;
      const unit = THREE_MAP_SIZE / 8192;
      // 경사면에서 바닥이 뜨지 않도록 지면 아래로 조금 묻는다.
      const sink = 3 * altitudeScale;
      const mesh = new THREE.InstancedMesh(buildingGeo, buildingMat, buildingData.length);
      const matrix = new THREE.Matrix4();
      const rotation = new THREE.Quaternion();
      const position = new THREE.Vector3();
      const size = new THREE.Vector3();
      const up = new THREE.Vector3(0, 1, 0);
      buildingData.forEach(([x, y, width, length, angleDeg, heightM], index) => {
        const centerX = x * unit - THREE_MAP_SIZE / 2;
        const centerZ = y * unit - THREE_MAP_SIZE / 2;
        const base = sampleTerrainHeight(terrain, centerX, centerZ, THREE_MAP_SIZE);
        const height = heightM * altitudeScale;
        position.set(centerX, base + (height - sink) / 2, centerZ);
        // 이미지 좌표(y 아래)의 시계 방향 각도라 Three.js Y축 회전은 부호가 반대다.
        rotation.setFromAxisAngle(up, (-angleDeg * Math.PI) / 180);
        size.set(width * unit, height + sink, length * unit);
        mesh.setMatrixAt(index, matrix.compose(position, rotation, size));
      });
      scene.add(mesh);
      renderStateVersionRef.current += 1;
    }
    fetch(`/assets/map/${selectedMap}_Buildings.json`)
      .then((response) => (response.ok ? response.json() : null))
      .then((json: { buildings?: number[][] } | null) => {
        if (!isSceneCurrent() || !Array.isArray(json?.buildings)) return;
        buildingData = json.buildings;
        buildingIndexRef.current = createBuildingIndex(json.buildings);
        placeBuildings();
        renderStateVersionRef.current += 1;
      })
      // 건물은 보조 레이어라 받지 못하면 지형만 보여 준다.
      .catch(() => {});

    // [H] 자기장 벽. 높이 1짜리 원통을 반지름·벽 높이로 늘려 쓴다.
    const cylinderGeo = new THREE.CylinderGeometry(1, 1, 1, 96, 1, true);
    const createZoneWall = (color: number, opacity: number, wall: { bottom: number; top: number }) => {
      const mesh = new THREE.Mesh(cylinderGeo, new THREE.MeshBasicMaterial({
        color,
        transparent: true,
        opacity,
        side: THREE.DoubleSide,
        depthWrite: false
      }));
      mesh.position.y = (wall.bottom + wall.top) / 2;
      mesh.visible = false;
      scene.add(mesh);
      return mesh;
    };
    bluezoneMeshRef.current = createZoneWall(0x2f6bff, 0.25, BLUE_WALL);
    whitezoneMeshRef.current = createZoneWall(0xffffff, 0.35, WHITE_WALL);

    // [I-Tracer] 명중선 풀. 공격자 위치에서 피해자 위치까지 짧게 그렸다가 사라진다.
    const tracerPool: THREE.Line[] = [];
    for (let i = 0; i < TRACER_POOL_SIZE; i++) {
      const tracerGeo = new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(), new THREE.Vector3()]);
      const tracer = new THREE.Line(tracerGeo, new THREE.LineBasicMaterial({
        transparent: true,
        opacity: 0,
        depthTest: false,
        depthWrite: false
      }));
      tracer.renderOrder = 5;
      tracer.visible = false;
      tracer.frustumCulled = false;
      scene.add(tracer);
      tracerPool.push(tracer);
    }
    tracerPoolRef.current = tracerPool;

    // [I] 선수 마커와 이동 경로
    const markerTextures = new Map<string, THREE.Texture>();
    markerTexturesRef.current = markerTextures;
    playerMeshesRef.current = {};
    playerLinesRef.current = {};
    playerDropLinesRef.current = {};

    players.forEach((player) => {
      const group = new THREE.Group();
      group.name = player.name;

      const marker = createScreenSprite(
        getMarkerTexture(markerTextures, "foot", player.color),
        player.isTeam ? TEAM_MARKER_SIZE : ENEMY_MARKER_SIZE,
      );
      marker.name = "marker";
      marker.userData.shape = "foot";
      group.add(marker);

      const vehicleModel = createVehicleModel(player.color);
      vehicleModel.name = "vehicleModel";
      vehicleModel.visible = false;
      const planeModel = createPlaneModel();
      planeModel.name = "planeModel";
      planeModel.visible = false;
      group.add(vehicleModel, planeModel);

      const nameSprite = createNicknameSprite(player.name, player.color);
      nameSprite.name = "nicknameSprite";
      nameSprite.renderOrder = 13;
      group.add(nameSprite);

      scene.add(group);
      playerMeshesRef.current[player.name] = group;

      // 공중(낙하산·비행기)일 때 지면 위치를 알려 주는 수직선과 지나온 경로는 아군만 그린다.
      if (!player.isTeam || player.waypoints.length === 0) return;

      const dropLine = new THREE.Line(
        new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(0, 0, 0), new THREE.Vector3(0, 1, 0)]),
        new THREE.LineBasicMaterial({ color: new THREE.Color(player.color), transparent: true, opacity: 0.6 })
      );
      dropLine.frustumCulled = false;
      dropLine.visible = false;
      scene.add(dropLine);
      playerDropLinesRef.current[player.name] = dropLine;

      // 마지막 꼭짓점 하나를 현재 위치로 덮어 경로 끝이 마커에 붙도록 원본 좌표를 따로 둔다.
      const points = player.waypoints.map(wp => convertTo3D(wp.x, wp.y, wp.z, altitudeScale));
      const lineGeo = new THREE.BufferGeometry().setFromPoints(points);
      lineGeo.setDrawRange(0, 0);
      const line = new THREE.Line(lineGeo, new THREE.LineBasicMaterial({
        color: new THREE.Color(player.color),
        transparent: true,
        opacity: 0.85
      }));
      line.userData.original = Float32Array.from(lineGeo.attributes.position.array);
      line.userData.headIndex = -1;
      line.frustumCulled = false;
      scene.add(line);
      playerLinesRef.current[player.name] = line;
    });

    // [I-CarePackage] 보급 상자 마커
    carePackageMeshesRef.current = {};
    carePackages.forEach((cp) => {
      const sprite = createScreenSprite(getMarkerTexture(markerTextures, "carePackage", "#e5484d"), CARE_PACKAGE_MARKER_SIZE);
      sprite.renderOrder = 9;
      sprite.visible = false;
      scene.add(sprite);
      carePackageMeshesRef.current[cp.id] = sprite;
    });

    // 정지 중에는 바뀐 것이 있을 때만 다시 그린다.
    let needsRender = true;

    // [J] 창 크기 조절 콜백
    const handleResize = () => {
      needsRender = true;
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
    const followStep = new THREE.Vector3();
    const targetBeforeUpdate = new THREE.Vector3();
    let userPanDistance = 0;
    const projected = new THREE.Vector3();
    const labels = Object.values(playerMeshesRef.current)
      .map((group) => group.getObjectByName("nicknameSprite"))
      .filter((label): label is THREE.Object3D => !!label);
    const placedLabels: { x: number; y: number }[] = [];

    // 이름표가 화면에서 겹치면 우선순위(따라가는 선수, 아군, 적) 낮은 쪽을 숨긴다.
    const declutterLabels = () => {
      const { clientWidth: w, clientHeight: h } = renderer.domElement;
      const labelHeightPx = LABEL_HEIGHT * camera.projectionMatrix.elements[5] * h / 2;
      const labelWidthPx = labelHeightPx * 3.5;
      placedLabels.length = 0;
      labels.sort((a, b) => (a.userData.priority ?? 3) - (b.userData.priority ?? 3));
      labels.forEach((label) => {
        label.visible = false;
        if (!label.userData.wanted || !label.parent) return;
        projected.copy(label.parent.position).project(camera);
        if (projected.z > 1) return;
        const x = projected.x * w / 2;
        const y = projected.y * h / 2 + (label.userData.seat ?? 0) * 1.1 * labelHeightPx;
        if (placedLabels.some((p) => Math.abs(p.x - x) < labelWidthPx && Math.abs(p.y - y) < labelHeightPx)) return;
        placedLabels.push({ x, y });
        label.visible = true;
      });
    };

    const animate = (now: number) => {
      animationFrameIdRef.current = requestAnimationFrame(animate);
      const elapsed = now - lastRenderTime;
      if (elapsed < frameInterval) {
        return;
      }
      lastRenderTime = now;

      if (isPlayingRef.current || renderStateVersionRef.current > 0) {
        updateReplaySceneRef.current(currentTimeRef.current);
        renderStateVersionRef.current = 0;
        needsRender = true;
      }

      // 따라가기: 시점 거리·각도는 그대로 두고 초점과 카메라를 함께 옮긴다.
      const followTarget = followTargetRef.current;
      if (followTarget) {
        const entry = followEntryRef.current;
        if (entry) {
          // 대상을 바꾼 직후에는 출발점에서 움직이는 선수까지 ease-in-out으로 옮긴다.
          const progress = Math.min(1, (now - entry.startedAt) / FOLLOW_ENTRY_MS);
          const eased = progress < 0.5 ? 4 * progress ** 3 : 1 - (-2 * progress + 2) ** 3 / 2;
          followStep.lerpVectors(entry.from, followTarget, eased).sub(controls.target);
          if (progress >= 1) followEntryRef.current = null;
        } else {
          followStep.subVectors(followTarget, controls.target);
          if (followStep.length() < FOLLOW_SNAP_DISTANCE) {
            followStep.multiplyScalar(1 - Math.exp(-Math.min(elapsed, 100) / FOLLOW_SMOOTHING_MS));
          }
        }
        if (followStep.lengthSq() > 1e-10) {
          controls.target.add(followStep);
          camera.position.add(followStep);
          needsRender = true;
        }
      }

      // 사용자가 지도를 끌어 초점이 움직이면 따라가기를 끈다(회전·확대는 초점을 바꾸지 않는다).
      targetBeforeUpdate.copy(controls.target);
      if (controls.update()) needsRender = true;
      if (!followTarget) {
        userPanDistance = 0;
      } else {
        const panStep = targetBeforeUpdate.distanceTo(controls.target);
        // 끌기가 멈추면(관성까지 끝나면) 누적을 비워 여러 번의 작은 조작이 쌓이지 않게 한다.
        userPanDistance = panStep < 1e-6 ? 0 : userPanDistance + panStep;
        if (userPanDistance > FOLLOW_RELEASE_DISTANCE) {
          userPanDistance = 0;
          followEntryRef.current = null;
          setTrackingPlayer(null);
        }
      }

      if (!needsRender) return;
      needsRender = false;
      declutterLabels();
      renderer.render(scene, camera);
    };
    animationFrameIdRef.current = requestAnimationFrame(animate);

    // [L] 메모리 누수 방지 리소스 수소 폐기
    return () => {
      isSceneActive = false;
      window.removeEventListener("resize", handleResize);
      if (animationFrameIdRef.current) {
        cancelAnimationFrame(animationFrameIdRef.current);
      }
      animationFrameIdRef.current = null;
      if (heightmapImage) {
        heightmapImage.onload = null;
        heightmapImage.onerror = null;
        heightmapImage.src = "";
      }
      if (sceneGenerationRef.current === sceneGeneration) {
        heightmapDataRef.current = null;
        terrainGridRef.current = null;
        buildingIndexRef.current = null;
      }

      controls.dispose();
      renderer.dispose();

      texture.dispose();
      if (fallbackTexture) fallbackTexture.dispose();
      cylinderGeo.dispose();
      buildingGeo.dispose();
      buildingMat.dispose();
      // 마커 텍스처는 여러 스프라이트가 공유하므로 씬을 정리한 뒤 한 번에 해제한다.
      disposeObject(scene);
      markerTextures.forEach((markerTexture) => markerTexture.dispose());
      scene.clear();

      tracerPoolRef.current = [];
      carePackageMeshesRef.current = {};
      playerMeshesRef.current = {};
      playerDropLinesRef.current = {};
      playerLinesRef.current = {};
      bluezoneMeshRef.current = null;
      whitezoneMeshRef.current = null;
      if (markerTexturesRef.current === markerTextures) markerTexturesRef.current = null;
      if (mapTextureRef.current === texture) mapTextureRef.current = null;
      if (mapMeshRef.current === mapMesh) mapMeshRef.current = null;
      if (rendererRef.current === renderer) rendererRef.current = null;
      if (sceneRef.current === scene) sceneRef.current = null;
      if (controlsRef.current === controls) controlsRef.current = null;
    };
  }, [players, selectedMap, altitudeScale, carePackages]);

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

  // 선수별 기절 시각과 기절을 끝내는 시각(부활·사망·재배치)을 한 번만 모아 둔다.
  const knockTimeline = useMemo(() => {
    const timeline: Record<string, { groggy: number[]; ends: number[] }> = {};
    players.forEach((player) => {
      timeline[player.name] = {
        groggy: [],
        ends: [...(player.deathTimes ?? []), ...(player.redeployTimes ?? [])],
      };
    });
    damageEvents.forEach((ev) => {
      const entry = timeline[ev.victim];
      if (!entry) return;
      if (ev.type === "groggy") entry.groggy.push(ev.relativeTimeMs);
      else if (ev.type === "revive") entry.ends.push(ev.relativeTimeMs);
    });
    return timeline;
  }, [players, damageEvents]);

  // 6. 시간에 따른 실시간 마커 및 자기장 위치 갱신 동기화
  const updateReplayScene = useCallback((frameTimeMs: number) => {
    const currentTimeMs = frameTimeMs;
    const markerTextures = markerTexturesRef.current;
    const followedPlayer = trackingPlayer ? players.find((p) => p.name === trackingPlayer) : undefined;
    let followedPos: THREE.Vector3 | null = null;
    const enemyLabelRange = (ENEMY_LABEL_RANGE_M / (metersPerUnit(selectedMap) * 8192)) * THREE_MAP_SIZE;

    // 1) 선수마다 현재 위치·상태를 구한다. 따라가는 선수를 먼저 처리해 적 이름표 거리 계산에 쓴다.
    // 같은 차량 탑승자 묶음. 모형을 한 대만 그리고 이름표를 위로 쌓는 데 쓴다.
    const vehicleClusters: VehicleCluster[] = [];
    const nextVehicleAnchors = new Map<string, string>();
    const orderedPlayers = followedPlayer
      ? [followedPlayer, ...players.filter((p) => p !== followedPlayer)]
      : players;

    orderedPlayers.forEach((player) => {
      const group = playerMeshesRef.current[player.name];
      if (!group) return;
      const state = getInterpolatedState(player, currentTimeMs, altitudeScale);

      // 다중 사망 및 블루칩 부활 기록을 종합한 실시간 사망 판정
      const deathTimeMs = getActiveDeathTime(player.deathTimes, player.redeployTimes, currentTimeMs);
      const isDead = deathTimeMs !== null || shouldMarkPlayerDeadFromHealth(
        player.deathTimes,
        player.redeployTimes,
        currentTimeMs,
        state.health,
        state.healthSampleTimeMs,
      );
      const isInVehicle = !isDead && !!state.vehicleId;
      const isFlying = isInVehicle && isAirplane(state.vehicleId);
      const knock = knockTimeline[player.name];
      const isGroggy = !isDead && !!knock && isGroggyAt(knock.groggy, knock.ends, currentTimeMs);

      // 사망한 선수는 사망 시점 위치에 고정한다.
      const position = isDead && deathTimeMs !== null
        ? getInterpolatedState(player, deathTimeMs, altitudeScale).position
        : state.position.clone();

      // 지상 선수 높이: 고해상도 하이트맵 기준 지면 위 높이를 구해 화면의 지형 메쉬 위에 그만큼 올린다.
      // 건물 안에서 지면보다 높으면 옥상·위층이므로 그대로 두고, 그 밖의 작은 차이(도보 8m, 차량 25m)는 지면에 붙인다.
      const groundM = isFlying ? null : getGroundMeters(position.x, position.z);
      if (groundM !== null) {
        const aboveGroundM = position.y / altitudeScale - groundM;
        const mapX = ((position.x + THREE_MAP_SIZE / 2) / THREE_MAP_SIZE) * 8192;
        const mapY = ((position.z + THREE_MAP_SIZE / 2) / THREE_MAP_SIZE) * 8192;
        const isOnStructure = aboveGroundM > STRUCTURE_MIN_HEIGHT_M && !!buildingIndexRef.current?.(mapX, mapY);
        const shownAboveM = isOnStructure || aboveGroundM > (isInVehicle ? 25 : 8) ? aboveGroundM : 0;
        position.y = getTerrainHeight(position.x, position.z) + shownAboveM * altitudeScale;
      }
      const isHidden = hiddenPlayers.has(player.name);
      group.visible = !isHidden;

      // 위치 표본이 드물어 뛰어내린 뒤에도 다음 표본까지 수송기 상태가 남으므로,
      // 구간 양 끝이 모두 수송기일 때만 탑승 중으로 본다.
      const segmentIndex = findWaypointSegment(player.waypoints, currentTimeMs);
      const nextWaypoint = player.waypoints[segmentIndex + 1];
      const isAboard = isFlying && isAirplane(player.waypoints[segmentIndex]?.vehicleId)
        && (!nextWaypoint || isAirplane(nextWaypoint.vehicleId));
      const isRiding = isAboard || (isInVehicle && !isFlying);
      let seat = 0;
      // 숨긴 선수는 그룹째 안 보이므로 묶음에서 빼서, 보이는 동승자가 차량 모형을 갖게 한다.
      if (isRiding && !isHidden) {
        const joined = joinVehicleCluster(vehicleClusters, {
          name: player.name,
          vehicleId: state.vehicleId ?? "",
          uniqueId: state.vehicleUniqueId,
          x: position.x,
          z: position.z,
          previousAnchor: vehicleAnchorsRef.current.get(player.name),
        });
        seat = joined.seat;
        nextVehicleAnchors.set(player.name, joined.cluster.anchor);
        // 동승자는 기준 탑승자 위치에 붙여 한 대로 움직이게 한다.
        if (seat > 0) {
          position.x = joined.cluster.x;
          position.z = joined.cluster.z;
          position.y = playerMeshesRef.current[joined.cluster.anchor]?.position.y ?? position.y;
        }
      }
      group.position.copy(position);
      if (player.name === trackingPlayer) followedPos = position;

      // 같은 차량에는 첫 탑승자(따라가는 선수 우선)의 모형 하나만 그린다.
      const showsModel = isRiding && seat === 0;
      const vehicleModel = group.getObjectByName("vehicleModel");
      const planeModel = group.getObjectByName("planeModel");
      if (vehicleModel) vehicleModel.visible = showsModel && !isFlying;
      if (planeModel) planeModel.visible = showsModel && isAboard;
      if (showsModel) {
        const heading = getHeadingAt(player.waypoints, currentTimeMs);
        if (heading !== null) {
          if (vehicleModel) vehicleModel.rotation.y = heading;
          if (planeModel) planeModel.rotation.y = heading;
        }
      }

      const shape: MarkerShape = isDead ? "dead" : isGroggy ? "groggy" : isAboard ? "plane" : isRiding ? "vehicle" : "foot";
      const marker = group.getObjectByName("marker") as THREE.Sprite | undefined;
      if (marker) {
        marker.renderOrder = player.name === trackingPlayer ? 14 : player.isTeam ? 12 : 10;
        // 탑승 중에는 아이콘을 모형 위로 띄운다.
        marker.center.y = isRiding ? -0.6 : 0.5;
      }
      if (marker && markerTextures && marker.userData.shape !== shape) {
        marker.material.map = getMarkerTexture(markerTextures, shape, player.color);
        marker.material.needsUpdate = true;
        marker.userData.shape = shape;
      }

      const nameSprite = group.getObjectByName("nicknameSprite") as THREE.Sprite | undefined;
      if (nameSprite) {
        // 탑승자 순서만큼 이름표를 쌓고, 탑승 중이면 띄운 아이콘 높이만큼 더 올린다.
        const labelLift = seat + (isRiding ? 1 : 0);
        nameSprite.center.y = -0.45 - labelLift * 1.1;
        const isNearFollowed = followedPos !== null && followedPos !== position
          && Math.hypot(position.x - followedPos.x, position.z - followedPos.z) <= enemyLabelRange;
        // 실제 표시는 렌더 루프가 화면에서 겹치는지 보고 정한다.
        nameSprite.userData.wanted = !isHidden && showNames && !isDead
          && (player.isTeam || player.name === trackingPlayer || isNearFollowed);
        nameSprite.userData.seat = labelLift;
        nameSprite.userData.priority = player.name === trackingPlayer ? 0 : player.isTeam ? 1 : 2;
      }

      // 공중에 있을 때만 지면까지 수직선을 내린다.
      const dropLine = playerDropLinesRef.current[player.name];
      if (dropLine) {
        const terrainHeight = getTerrainHeight(position.x, position.z);
        const heightGap = position.y - terrainHeight;
        dropLine.visible = showTrajectories && !isHidden && !isDead && heightGap > 0.3;
        dropLine.position.set(position.x, terrainHeight, position.z);
        const dropAttr = dropLine.geometry.attributes.position;
        dropAttr.setY(1, Math.max(0, heightGap));
        dropAttr.needsUpdate = true;
      }

      // 지나온 경로만 그리고, 마지막 꼭짓점을 현재 위치로 옮겨 경로 끝을 마커에 붙인다.
      const line = playerLinesRef.current[player.name];
      if (line) {
        line.visible = showTrajectories && !isHidden;
        const original = line.userData.original as Float32Array;
        const lineAttr = line.geometry.attributes.position;
        const array = lineAttr.array as Float32Array;
        const previousHead = line.userData.headIndex as number;
        if (previousHead >= 0) array.set(original.subarray(previousHead * 3, previousHead * 3 + 3), previousHead * 3);
        const segment = findWaypointSegment(player.waypoints, isDead && deathTimeMs !== null ? deathTimeMs : currentTimeMs);
        const headIndex = Math.min(segment + 1, player.waypoints.length - 1);
        if (currentTimeMs < player.waypoints[0].t) {
          line.geometry.setDrawRange(0, 0);
          line.userData.headIndex = -1;
        } else {
          array[headIndex * 3] = position.x;
          array[headIndex * 3 + 1] = position.y;
          array[headIndex * 3 + 2] = position.z;
          line.userData.headIndex = headIndex;
          line.geometry.setDrawRange(0, headIndex + 1);
        }
        lineAttr.needsUpdate = true;
      }
    });

    followTargetRef.current = followedPos;
    vehicleAnchorsRef.current = nextVehicleAnchors;

    // 2) 명중선: 최근 피해 이벤트를 공격자에서 피해자까지 잠깐 그린다.
    const tracerPool = tracerPoolRef.current;
    const tracerDurationMs = Math.max(TRACER_DURATION_MS, TRACER_SCREEN_MS * playbackSpeedRef.current);
    let tracerIndex = 0;
    for (
      let index = lowerBoundByTime(damageEvents, currentTimeMs - tracerDurationMs, (ev) => ev.relativeTimeMs);
      index < damageEvents.length && tracerIndex < tracerPool.length;
      index++
    ) {
      const ev = damageEvents[index];
      const elapsed = currentTimeMs - ev.relativeTimeMs;
      if (elapsed < 0) break;
      if (ev.type !== "damage") continue;
      if (hiddenPlayers.has(ev.attackerName) && hiddenPlayers.has(ev.victimName)) continue;
      const tracer = tracerPool[tracerIndex++];
      const tracerAttr = tracer.geometry.attributes.position;
      const from = convertTo3D(ev.attackerX, ev.attackerY, ev.attackerZ || 0, altitudeScale);
      const to = convertTo3D(ev.x, ev.y, ev.z || 0, altitudeScale);
      tracerAttr.setXYZ(0, from.x, from.y + 0.15, from.z);
      tracerAttr.setXYZ(1, to.x, to.y + 0.15, to.z);
      tracerAttr.needsUpdate = true;
      const material = tracer.material as THREE.LineBasicMaterial;
      material.color.setHex(players.find((p) => p.name === ev.attackerName)?.isTeam ? 0x3ee6c8 : 0xffb020);
      material.opacity = 1 - elapsed / tracerDurationMs;
      tracer.visible = true;
    }
    for (let i = tracerIndex; i < tracerPool.length; i++) tracerPool[i].visible = false;

    // 3) 보급 상자: 투하부터 착지까지 위치를 잇고, 착지 후에는 그 자리에 둔다.
    carePackages.forEach((cp) => {
      const sprite = carePackageMeshesRef.current[cp.id];
      if (!sprite) return;
      sprite.visible = currentTimeMs >= cp.spawnTimeMs;
      if (!sprite.visible) return;
      const ratio = Math.min(1, (currentTimeMs - cp.spawnTimeMs) / Math.max(1, cp.landTimeMs - cp.spawnTimeMs));
      const spawnPos = convertTo3D(cp.spawnX, cp.spawnY, cp.spawnZ, altitudeScale);
      const landPos = convertTo3D(cp.landX, cp.landY, cp.landZ, altitudeScale);
      sprite.position.lerpVectors(spawnPos, landPos, ratio);
      if (ratio >= 1) sprite.position.y = Math.max(sprite.position.y, getTerrainHeight(landPos.x, landPos.z));
    });

    // 4) 자기장: 수축 중에는 파란 벽을 조금 진하게 표시한다.
    const zone = getInterpolatedZone(currentTimeMs);
    const isShrinking = zone.blueRadius > getInterpolatedZone(currentTimeMs + 2000).blueRadius;
    const applyZone = (
      mesh: THREE.Mesh | null,
      radius: number,
      x: number,
      y: number,
      wall: { bottom: number; top: number },
    ) => {
      if (!mesh) return;
      mesh.visible = showBluezone && radius > 0;
      if (!mesh.visible) return;
      const scaledRadius = (radius / 8192) * THREE_MAP_SIZE;
      const center = convertTo3D(x, y, 0, altitudeScale);
      mesh.scale.set(scaledRadius, wall.top - wall.bottom, scaledRadius);
      mesh.position.set(center.x, (wall.top + wall.bottom) / 2, center.z);
    };
    applyZone(bluezoneMeshRef.current, zone.blueRadius, zone.blueX, zone.blueY, BLUE_WALL);
    applyZone(whitezoneMeshRef.current, zone.whiteRadius, zone.whiteX, zone.whiteY, WHITE_WALL);
    if (bluezoneMeshRef.current) {
      (bluezoneMeshRef.current.material as THREE.MeshBasicMaterial).opacity = isShrinking ? 0.38 : 0.25;
    }
  }, [players, selectedMap, showBluezone, showTrajectories, altitudeScale, damageEvents, carePackages, trackingPlayer, hiddenPlayers, showNames, knockTimeline, getInterpolatedZone, getTerrainHeight, getGroundMeters, getInterpolatedState]);

  useEffect(() => {
    updateReplaySceneRef.current = updateReplayScene;
  }, [updateReplayScene]);

  // 따라갈 선수가 바뀌면 현재 초점에서 새 선수까지 진입 애니메이션을 시작한다.
  useEffect(() => {
    const controls = controlsRef.current;
    if (!trackingPlayer) {
      followTargetRef.current = null;
      followEntryRef.current = null;
      return;
    }
    if (controls) followEntryRef.current = { from: controls.target.clone(), startedAt: performance.now() };
    renderStateVersionRef.current += 1;
  }, [trackingPlayer, selectedMap]);

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
    const controls = controlsRef.current;
    if (controls) {
      // 시점 거리·각도를 유지한 채 초점만 옮긴다.
      const delta = state.position.clone().sub(controls.target);
      controls.target.add(delta);
      controls.object.position.add(delta);
      controls.update();
      // 정지 중에는 바뀐 것이 있어야 다시 그리므로 직접 알린다.
      renderStateVersionRef.current += 1;
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

  const lowerNickname = nickname.trim().toLowerCase();
  const defaultFollowName = players.find((p) => p.name.toLowerCase() === lowerNickname)?.name
    ?? players.find((p) => p.isTeam)?.name
    ?? null;

  // 생존자 수 계산 (사망 시간 기준)
  const aliveCount = players.filter(p =>
    getActiveDeathTime(p.deathTimes, p.redeployTimes, currentTimeMs) === null
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
            followName={trackingPlayer}
            onToggleFollow={() => setTrackingPlayer(trackingPlayer ? null : defaultFollowName)}
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
                <p className="mt-1 text-[11px] leading-relaxed text-[#8b949e]">
                  {isDemoTarget
                    ? "예시 매치의 텔레메트리 보관 기간이 지났습니다. AI 전적 검색에서 최근 매치를 선택해 3D 리플레이를 실행해 주세요."
                    : errorMsg}
                </p>
              </div>
            </div>
            <div className="mt-3 flex gap-2">
              {isDemoTarget ? (
                <button
                  type="button"
                  onClick={() => router.push("/stats")}
                  className="inline-flex min-h-9 flex-1 items-center justify-center gap-1.5 rounded-md border border-[#ff9f0a]/45 bg-[#ff9f0a]/10 px-3 text-[11px] font-bold text-[#ff9f0a] transition-colors hover:bg-[#ff9f0a] hover:text-[#0d1117]"
                >
                  AI 전적 검색으로 이동
                </button>
              ) : (
                <button
                  type="button"
                  onClick={handleFetchTelemetry}
                  className="inline-flex min-h-9 flex-1 items-center justify-center gap-1.5 rounded-md border border-[#ff9f0a]/45 bg-[#ff9f0a]/10 px-3 text-[11px] font-bold text-[#ff9f0a] transition-colors hover:bg-[#ff9f0a] hover:text-[#0d1117]"
                >
                  <RefreshCw className="h-3.5 w-3.5" />
                  다시 시도
                </button>
              )}
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
