"use client";

import React, { useEffect, useRef } from "react";
import { useMap } from "react-leaflet";
import L from "leaflet";
import { toCalibratedCoords } from "../../../utils/coordinate";
import { buildPositionTracks, samplePosition, type PositionSample } from "../../../lib/replay/replayInterpolation";
import { classifyThrowable, isCombatDamageCause, type ReplayThrowableKind } from "../../../lib/pubg-analysis/replayEventKinds";
import { collectTeamEngagements, recentOpponents, type ReplayEngagement } from "../../../lib/replay/replayEngagements";
import { AUTO_ZOOM_HOLD_MS, SPEED_WINDOW_MS, autoZoomFor, isKnownEnemy, metersPerUnit, nextAutoZoom, speedMetersPerSecond } from "../../../lib/replay/replayCamera";

// 따라가기를 시작할 때 맞추는 최소 줌(CRS.Simple, 0이 원본 해상도). 기본 화면(-3)보다 8배 확대다.
const FOLLOW_MIN_ZOOM = 0;
/** 인지 범위 밖 적의 투명도. */
const DIM_ALPHA = 0.25;

interface TelemetryCanvasLayerProps {
  telemetryData: any;
  showZones?: boolean;
  showPlayerNames?: boolean;
  showFlightPath?: boolean;
}

function drawPlaneGlyph(ctx: CanvasRenderingContext2D, scale: number) {
  const s = Math.max(0.8, scale);
  ctx.beginPath();
  ctx.moveTo(0, -16 * s);
  ctx.lineTo(7 * s, 10 * s);
  ctx.lineTo(0, 5 * s);
  ctx.lineTo(-7 * s, 10 * s);
  ctx.closePath();
  ctx.fill();
}

// 위성 지도 위에서도 읽히도록 이름 뒤에 어두운 칩을 깐다. (x, y)는 글자 가운데다.
function drawNameLabel(ctx: CanvasRenderingContext2D, text: string, x: number, y: number, color: string, font: string) {
  ctx.font = font;
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  const width = ctx.measureText(text)?.width ?? text.length * 6;
  ctx.fillStyle = "rgba(0,0,0,0.72)";
  ctx.beginPath();
  if ((ctx as any).roundRect) (ctx as any).roundRect(x - width / 2 - 4, y - 7, width + 8, 14, 4);
  else ctx.rect(x - width / 2 - 4, y - 7, width + 8, 14);
  ctx.fill();
  ctx.fillStyle = color;
  ctx.fillText(text, x, y);
}

const THROW_MARKER_MS = 3_000;
const BLAST_MARKER_MS = 1_500;
/** 보급 상자는 착지 뒤 계속 표시하고, 착지 직후 이 시간 동안만 이름표를 붙인다. */
const CARE_PACKAGE_LABEL_MS = 20_000;
const HIT_LINE_MS = 600;

const THROWABLE_STYLES: Record<ReplayThrowableKind, { color: string; label: string }> = {
  smoke: { color: "#cbd5e1", label: "연막" },
  grenade: { color: "#f97316", label: "수류탄" },
  molotov: { color: "#ef4444", label: "화염병" },
  flash: { color: "#fde047", label: "섬광" },
  bluezone: { color: "#3b82f6", label: "블루존 수류탄" },
  sticky: { color: "#f97316", label: "점착 폭탄" },
  c4: { color: "#f97316", label: "C4" },
  cover: { color: "#a3e635", label: "엄폐 신호탄" },
  flare: { color: "#f43f5e", label: "신호탄" },
};

// 효과 라벨은 선수 이름표에 가려지지 않도록 모아 두었다가 선수를 그린 뒤 맨 위에 그린다.
type OverlayLabel = { text: string; x: number; y: number; color: string; alpha: number };

// 선수 이름표. 중요도가 높은 것(나 → 따라가는 선수 → 아군 → 적)부터 놓고, 겹치면 위로 비켜 놓는다.
type NameLabel = { text: string; x: number; y: number; color: string; font: string; priority: number };
const LABEL_HEIGHT = 14;
const LABEL_STEP = 15;
const MAX_LABEL_SHIFTS = 4;

function drawNameLabels(ctx: CanvasRenderingContext2D, labels: NameLabel[]) {
  const placed: { left: number; right: number; top: number; bottom: number }[] = [];
  [...labels].sort((a, b) => a.priority - b.priority).forEach((label) => {
    ctx.font = label.font;
    const width = (ctx.measureText(label.text)?.width ?? label.text.length * 6) + 8;
    let y = label.y;
    for (let shift = 0; shift < MAX_LABEL_SHIFTS; shift++) {
      const top = y - LABEL_HEIGHT / 2, bottom = y + LABEL_HEIGHT / 2;
      const left = label.x - width / 2, right = label.x + width / 2;
      if (!placed.some((r) => left < r.right && right > r.left && top < r.bottom && bottom > r.top)) break;
      y -= LABEL_STEP;
    }
    placed.push({ left: label.x - width / 2, right: label.x + width / 2, top: y - LABEL_HEIGHT / 2, bottom: y + LABEL_HEIGHT / 2 });
    drawNameLabel(ctx, label.text, label.x, y, label.color, label.font);
  });
}

// 던진 사람 위치에 투척물 종류를 짧게 표시한다. 착탄 지점은 텔레메트리에 없어 그리지 않는다.
// 라벨은 선수 이름표(마커 위)와 겹치지 않게 마커 아래에 둔다.
function drawThrowMarker(ctx: CanvasRenderingContext2D, x: number, y: number, kind: ReplayThrowableKind, progress: number, labels: OverlayLabel[]) {
  const style = THROWABLE_STYLES[kind];
  ctx.save();
  ctx.globalAlpha = 1 - progress;
  ctx.beginPath(); ctx.arc(x, y, 8 + progress * 16, 0, Math.PI * 2);
  ctx.strokeStyle = style.color; ctx.lineWidth = 2; ctx.stroke();
  ctx.beginPath(); ctx.arc(x, y, 5, 0, Math.PI * 2);
  ctx.fillStyle = style.color; ctx.fill();
  ctx.strokeStyle = "#000000"; ctx.lineWidth = 1; ctx.stroke();
  ctx.restore();
  labels.push({ text: style.label, x, y: y + 26, color: style.color, alpha: Math.min(1, 2 * (1 - progress)) });
}

// 보급 상자 착지 위치. 내용물은 리플레이 데이터에 없어 위치와 착지 시각만 그린다.
function drawCarePackage(ctx: CanvasRenderingContext2D, x: number, y: number, fresh: boolean, labels: OverlayLabel[]) {
  ctx.save();
  ctx.fillStyle = "#ef4444";
  ctx.strokeStyle = "#ffffff";
  ctx.lineWidth = 1.5;
  ctx.fillRect(x - 6, y - 6, 12, 12);
  ctx.strokeRect(x - 6, y - 6, 12, 12);
  ctx.beginPath(); ctx.moveTo(x - 6, y); ctx.lineTo(x + 6, y); ctx.stroke();
  ctx.restore();
  if (fresh) labels.push({ text: "보급", x, y: y + 22, color: "#fca5a5", alpha: 1 });
}

// 폭발·화염 피해를 받은 사람 위치에 표시한다(폭발 지점이 아니라 피해 위치 기준).
function drawBlastMarker(ctx: CanvasRenderingContext2D, x: number, y: number, cause: string, progress: number, labels: OverlayLabel[]) {
  const color = cause === "fire" ? "239, 68, 68" : "249, 115, 22";
  ctx.save();
  ctx.beginPath(); ctx.arc(x, y, 10 + progress * 14, 0, Math.PI * 2);
  ctx.fillStyle = `rgba(${color}, ${0.45 * (1 - progress)})`; ctx.fill();
  ctx.strokeStyle = `rgba(${color}, ${1 - progress})`; ctx.lineWidth = 2; ctx.stroke();
  ctx.restore();
  if (cause !== "fire") {
    labels.push({ text: cause === "grenade" ? "수류탄 피해" : "폭발 피해", x, y: y + 28, color: "#fdba74", alpha: 1 - progress });
  }
}

function drawVehicleGlyph(ctx: CanvasRenderingContext2D) {
  ctx.fillRect(-9, -4, 18, 8);
  ctx.fillRect(-6, -8, 12, 5);
  ctx.beginPath();
  ctx.arc(-6, 6, 2.4, 0, Math.PI * 2);
  ctx.arc(6, 6, 2.4, 0, Math.PI * 2);
  ctx.fill();
}

export const TelemetryCanvasLayer = ({ 
  telemetryData, 
  showZones = true, 
  showFlightPath = true
}: TelemetryCanvasLayerProps): React.ReactElement | null => {
  const map = useMap();
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const animationRef = useRef<number | null>(null);
  const dataRef = useRef(telemetryData);
  const optionsRef = useRef({ showZones, showFlightPath });
  const effectEventsRef = useRef<any[]>([]);
  const carePackagesRef = useRef<any[]>([]);
  const lastAutoZoomAtRef = useRef(0);
  const tracksRef = useRef<Map<string, PositionSample[]>>(new Map());
  const flightPathRef = useRef<{ start: {x: number, y: number}, end: {x: number, y: number} } | null>(null);
  const requestDrawRef = useRef<() => void>(() => {});
  const engagementsRef = useRef<ReplayEngagement[]>([]);
  const followStartRef = useRef<(name: string) => void>(() => {});

  useEffect(() => {
    dataRef.current = telemetryData;
    optionsRef.current = { showZones, showFlightPath };
    requestDrawRef.current();
  }, [telemetryData, showZones, showFlightPath]);

  useEffect(() => {
    const evs = telemetryData.events;
    effectEventsRef.current = (evs || []).filter((ev: any) =>
      ["groggy", "kill", "throw", "damage", "shot"].includes(String(ev.type || "")));
    carePackagesRef.current = (evs || []).filter((ev: any) =>
      ev.type === "carepackage_land" && Number.isFinite(ev.x) && Number.isFinite(ev.y) && Number.isFinite(ev.relativeTimeMs));
    if (!evs) { tracksRef.current = new Map(); flightPathRef.current = null; return; }
    tracksRef.current = buildPositionTracks(evs);

    let startPt: {x: number, y: number} | null = null;
    let endPt: {x: number, y: number} | null = null;
    for (const ev of evs) {
      // 대기섬 ride 이벤트를 배제하고 실제 낙하(leave) 궤적만 추출 (초반 3분 이내 본 비행기만)
      if (ev.type === "leave" && ev.vehicle && ev.vehicle.toLowerCase().includes("aircraft") && (ev.relativeTimeMs || 0) < 180000) {
        if (!startPt) startPt = { x: ev.x, y: ev.y };
        endPt = { x: ev.x, y: ev.y };
      }
    }
    if (startPt && endPt && (startPt.x !== endPt.x || startPt.y !== endPt.y)) {
      const dx = endPt.x - startPt.x;
      const dy = endPt.y - startPt.y;
      const dist = Math.sqrt(dx*dx + dy*dy);
      flightPathRef.current = {
        start: { x: startPt.x - (dx/dist)*8000, y: startPt.y - (dy/dist)*8000 },
        end: { x: endPt.x + (dx/dist)*8000, y: endPt.y + (dy/dist)*8000 }
      };
    } else {
      flightPathRef.current = null;
    }
    requestDrawRef.current();
  }, [telemetryData.events]);

  useEffect(() => {
    engagementsRef.current = collectTeamEngagements(telemetryData.events || [], telemetryData.teamNames || []);
    requestDrawRef.current();
  }, [telemetryData.events, telemetryData.teamNames]);

  useEffect(() => {
    if (!map) return;
    let pane = map.getPane("telemetry-pane");
    if (!pane) {
      pane = map.createPane("telemetry-pane");
      pane.style.zIndex = "450";
      pane.style.pointerEvents = "none";
    }
    const canvas = L.DomUtil.create("canvas", "leaflet-zoom-animated") as HTMLCanvasElement;
    canvas.style.pointerEvents = "none";
    pane.appendChild(canvas);
    canvasRef.current = canvas;

    const getInterpolatedPos = (rawName: string, time: number) =>
      samplePosition(tracksRef.current.get((rawName || "").trim().toLowerCase()), time);

    const findLivePlayer = (name: string) => {
      const playhead = dataRef.current?.playheadRef?.current;
      const states = playhead?.states ?? dataRef.current?.currentStates ?? {};
      const timeMs = playhead?.timeMs ?? dataRef.current?.currentTimeMs ?? 0;
      const target = name.trim().toLowerCase();
      const state = Object.values(states).find((p: any) => typeof p?.name === "string" && p.name.trim().toLowerCase() === target) as any;
      if (!state || state.isDead) return null;
      const pos = getInterpolatedPos(state.name, timeMs) || { x: state.x, y: state.y };
      if (!Number.isFinite(pos.x) || !Number.isFinite(pos.y) || pos.x < 0 || pos.y < 0) return null;
      return toCalibratedCoords(pos.x, pos.y, dataRef.current.mapName);
    };

    // 따라가는 선수의 최근 이동 속도로 화면에 담을 거리를 정한다. 멈추면 가깝게, 차량은 멀리 본다.
    const applyAutoZoom = (name: string, target: L.LatLngExpression) => {
      const playhead = dataRef.current?.playheadRef?.current;
      const timeMs = playhead?.timeMs ?? dataRef.current?.currentTimeMs ?? 0;
      const now = performance.now();
      if (now - lastAutoZoomAtRef.current < AUTO_ZOOM_HOLD_MS) return;
      const unitMeters = metersPerUnit(dataRef.current?.mapName);
      const speed = speedMetersPerSecond(
        getInterpolatedPos(name, timeMs),
        getInterpolatedPos(name, Math.max(0, timeMs - SPEED_WINDOW_MS)),
        Math.min(SPEED_WINDOW_MS, timeMs),
        unitMeters,
      );
      const next = nextAutoZoom(map.getZoom(), autoZoomFor(speed, map.getSize().x, unitMeters));
      if (next === null) return;
      lastAutoZoomAtRef.current = now;
      map.setView(target, next, { animate: true });
    };

    // 따라가는 선수를 화면 가운데에 둔다. 1px 미만 차이는 무시해 멈춘 상태에서 다시 그리기가 반복되지 않게 한다.
    const keepFollowedPlayerCentered = () => {
      const name = dataRef.current?.followPlayer;
      if (!name || dataRef.current?.isActive === false) return;
      const target = findLivePlayer(name);
      if (!target) return;
      if (dataRef.current?.autoZoom) applyAutoZoom(name, target);
      const point = map.latLngToContainerPoint(target);
      const center = map.getSize().divideBy(2);
      if (Math.abs(point.x - center.x) >= 1 || Math.abs(point.y - center.y) >= 1) {
        map.panTo(target, { animate: false });
      }
    };

    followStartRef.current = (name: string) => {
      const target = findLivePlayer(name);
      if (!target) return;
      map.setView(target, Math.max(map.getZoom(), FOLLOW_MIN_ZOOM), { animate: true });
    };
    const cancelFollowOnDrag = () => dataRef.current?.onFollowCancel?.();
    // 사용자가 직접 확대·축소하면 자동 줌을 끈다. Leaflet 줌 이벤트로는 코드가 바꾼 줌과 구분되지 않아 입력 자체를 본다.
    const cancelAutoZoomOnUserZoom = () => {
      if (dataRef.current?.autoZoom && dataRef.current?.followPlayer) dataRef.current?.onAutoZoomCancel?.();
    };
    const onPinch = (event: TouchEvent) => { if (event.touches.length >= 2) cancelAutoZoomOnUserZoom(); };
    const onZoomControl = (event: MouseEvent) => {
      if ((event.target as HTMLElement | null)?.closest?.(".leaflet-control-zoom")) cancelAutoZoomOnUserZoom();
    };

    const getPoint = (lat: number, lng: number) => {
      if (typeof lat !== "number" || typeof lng !== "number" || !Number.isFinite(lat) || !Number.isFinite(lng)) {
        return { x: -9999, y: -9999 }; // 화면 밖으로 밀어냄
      }
      try {
        const calibrated = toCalibratedCoords(lng, lat, dataRef.current.mapName);
        const p = map.latLngToContainerPoint(calibrated);
        return { x: p.x, y: p.y };
      } catch (e) {
        return { x: -9999, y: -9999 };
      }
    };

    // 재생 중에만 매 프레임 그리고, 멈춘 상태에서는 지도 이동이나 데이터 변경 때만 다시 그린다.
    const requestDraw = () => {
      if (animationRef.current === null) animationRef.current = requestAnimationFrame(draw);
    };

    const draw = () => {
      animationRef.current = null;
      if (!canvas || !map) return;
      const ctx = canvas.getContext("2d");
      if (!ctx) return;

      // 재생 시각과 선수 상태는 React 렌더를 거치지 않는 playheadRef에서 매 프레임 읽는다.
      const playhead = dataRef.current?.playheadRef?.current;
      const states = playhead?.states ?? dataRef.current?.currentStates;
      const currentTimeMs = playhead?.timeMs ?? dataRef.current?.currentTimeMs;
      const { zoneEvents, showZone } = dataRef.current || {};
      ctx.clearRect(0, 0, canvas.width, canvas.height);
      if (!states || dataRef.current?.isActive === false) return;

      keepFollowedPlayerCentered();
      const size = map.getSize(), dpr = window.devicePixelRatio || 1;
      // 크기를 다시 대입하면 매 프레임 백버퍼가 재할당되므로 실제로 바뀐 경우에만 설정한다.
      const backingWidth = Math.round(size.x * dpr), backingHeight = Math.round(size.y * dpr);
      if (canvas.width !== backingWidth || canvas.height !== backingHeight) {
        canvas.width = backingWidth; canvas.height = backingHeight;
        canvas.style.width = `${size.x}px`; canvas.style.height = `${size.y}px`;
      }
      L.DomUtil.setPosition(canvas, map.containerPointToLayerPoint([0, 0]));

      ctx.clearRect(0, 0, canvas.width, canvas.height);
      ctx.save(); ctx.scale(dpr, dpr);

      //  줌 레벨에 따른 스케일 계산
      const currentZoom = map.getZoom();
      const zoomScale = Math.pow(1.5, currentZoom - 1); 

      // [A] 인게임 스타일 자기장 (반전 채우기 & 보간 적용)
      const isZoneVisible = optionsRef.current.showZones && showZone !== false;
      if (isZoneVisible && zoneEvents && Array.isArray(zoneEvents) && zoneEvents.length > 0) {
        // 현재 시간 기준 이전(prev)과 다음(next) 상태 찾기
        let prevZone = zoneEvents[0];
        let nextZone = zoneEvents[zoneEvents.length - 1];
        
        for (let i = 0; i < zoneEvents.length; i++) {
          if (zoneEvents[i].relativeTimeMs <= currentTimeMs) {
            prevZone = zoneEvents[i];
          } else {
            nextZone = zoneEvents[i];
            break;
          }
        }

        if (prevZone && nextZone) {
          // 보간 비율 계산
          const timeDiff = nextZone.relativeTimeMs - prevZone.relativeTimeMs;
          const rawRatio = timeDiff > 0 ? (currentTimeMs - prevZone.relativeTimeMs) / timeDiff : 1;
          const ratio = Math.max(0, Math.min(1, rawRatio));
          
          // 위치 및 반지름 보간 (null 값은 상대 구간의 유효값으로 보정)
          const startX = prevZone.blueX ?? nextZone.blueX;
          const endX = nextZone.blueX ?? prevZone.blueX;
          const startY = prevZone.blueY ?? nextZone.blueY;
          const endY = nextZone.blueY ?? prevZone.blueY;
          const startRadius = prevZone.blueRadius ?? nextZone.blueRadius;
          const endRadius = nextZone.blueRadius ?? prevZone.blueRadius;

          // Missing zone evidence must not hide players and combat layers.
          if ([startX,endX,startY,endY,startRadius,endRadius].every(value => typeof value === "number" && Number.isFinite(value))) {
          const interpX = startX + (endX - startX) * ratio;
          const interpY = startY + (endY - startY) * ratio;
          const interpRadius = startRadius + (endRadius - startRadius) * ratio;

          // 자기장(파란색) 원 영역 그리기
          if (typeof interpRadius === "number" && interpRadius > 0) {
            const center = getPoint(interpY, interpX);
            if (center.x !== -9999) {
              const edgePoint = getPoint(interpY, interpX + interpRadius);
              const radiusPx = Math.abs(edgePoint.x - center.x);

              ctx.save();
              ctx.beginPath();
              // 전체 화면 영역 사각형 (시계 방향)
              ctx.moveTo(0, 0);
              ctx.lineTo(size.x, 0);
              ctx.lineTo(size.x, size.y);
              ctx.lineTo(0, size.y);
              ctx.closePath();
              
              // 자기장 원 (반시계 방향으로 그려서 내부를 비움)
              ctx.arc(center.x, center.y, radiusPx, 0, Math.PI * 2, true);
              ctx.closePath();
              
              ctx.fillStyle = "rgba(0, 50, 255, 0.22)"; // 투명도 조정
              ctx.fill("nonzero"); // nonzero 규칙 사용 시 외부만 칠해짐

              // 자기장 경계선
              ctx.beginPath();
              ctx.arc(center.x, center.y, radiusPx, 0, Math.PI * 2);
              ctx.strokeStyle = "rgba(59, 130, 246, 0.7)";
              ctx.lineWidth = 2.5;
              ctx.stroke();
              ctx.restore();
            }
          }
        }
      }

      }

      // [A-2] 비행기 경로 (Flight Path)
      if (optionsRef.current.showFlightPath && dataRef.current.showFlightPath && flightPathRef.current) {
        const p1 = getPoint(flightPathRef.current.start.y, flightPathRef.current.start.x);
        const p2 = getPoint(flightPathRef.current.end.y, flightPathRef.current.end.x);
        if (p1.x !== -9999 && p2.x !== -9999) {
          ctx.save();
          ctx.beginPath();
          ctx.moveTo(p1.x, p1.y);
          ctx.lineTo(p2.x, p2.y);
          ctx.setLineDash([15, 10]);
          ctx.strokeStyle = "rgba(255, 255, 255, 0.8)";
          ctx.lineWidth = Math.max(2, 4 * zoomScale);
          ctx.stroke();
          
          // 경로 양끝 화살표 (방향 표시)
          const angle = Math.atan2(p2.y - p1.y, p2.x - p1.x);
          ctx.setLineDash([]);
          const drawArrow = (x: number, y: number, dir: number) => {
            ctx.beginPath();
            ctx.moveTo(x, y);
            ctx.lineTo(x - Math.cos(dir - Math.PI/6) * 15, y - Math.sin(dir - Math.PI/6) * 15);
            ctx.lineTo(x - Math.cos(dir + Math.PI/6) * 15, y - Math.sin(dir + Math.PI/6) * 15);
            ctx.closePath();
            ctx.fillStyle = "rgba(255, 255, 255, 0.8)";
            ctx.fill();
          };
          drawArrow(p1.x + Math.cos(angle)*100, p1.y + Math.sin(angle)*100, angle);
          drawArrow(p2.x - Math.cos(angle)*100, p2.y - Math.sin(angle)*100, angle);
          ctx.restore();
        }
      }

      // [B] 전투 이펙트. 텔레메트리에 투척물 착탄·폭발 좌표와 방향이 없으므로
      // 던진 사람 위치·피해자 위치·피해 이벤트의 공격자 좌표처럼 실제 기록된 좌표만 그린다.
      const overlayLabels: OverlayLabel[] = [];
      carePackagesRef.current.forEach((ev: any) => {
        const ageMs = currentTimeMs - ev.relativeTimeMs;
        if (ageMs < 0) return;
        const pt = getPoint(ev.y, ev.x);
        if (pt.x === -9999) return;
        drawCarePackage(ctx, pt.x, pt.y, ageMs < CARE_PACKAGE_LABEL_MS, overlayLabels);
      });
      if (effectEventsRef.current.length) {
        effectEventsRef.current.forEach((ev: any) => {
          const type = String(ev.type || "");
          const ageMs = currentTimeMs - (ev.relativeTimeMs || 0);
          if (ageMs < 0 || ageMs > THROW_MARKER_MS) return;
          if ((type === "groggy" || type === "kill") && dataRef.current.showCombatDots === false) return;
          if ((type === "shot" || type === "damage") && dataRef.current.showShotDots === false) return;
          if (!Number.isFinite(ev.x) || !Number.isFinite(ev.y)) return;
          const pt = getPoint(ev.y, ev.x);
          if (pt.x === -9999) return;

          if (type === "groggy" || type === "kill") {
            if (ageMs >= 2500) return;
            const t = ageMs / 2500;
            ctx.beginPath();
            ctx.arc(pt.x, pt.y, Math.max(0, 100 * t * zoomScale), 0, Math.PI * 2);
            ctx.strokeStyle = `rgba(251, 191, 36, ${1 - t})`;
            ctx.lineWidth = 6 * (1 - t);
            ctx.stroke();
            return;
          }

          if (type === "throw") {
            const kind = (ev.throwable as ReplayThrowableKind | undefined) ?? classifyThrowable(ev.weapon);
            if (kind && THROWABLE_STYLES[kind]) drawThrowMarker(ctx, pt.x, pt.y, kind, ageMs / THROW_MARKER_MS, overlayLabels);
            return;
          }

          if (type === "damage") {
            // 폭발·화염은 자기 투척물에 맞은 경우도 실제 피해 위치이므로 그린다.
            if (ev.cause === "grenade" || ev.cause === "explosion" || ev.cause === "fire") {
              if (ageMs < BLAST_MARKER_MS) drawBlastMarker(ctx, pt.x, pt.y, ev.cause, ageMs / BLAST_MARKER_MS, overlayLabels);
              return;
            }
            // 자기장·낙하처럼 공격자와 피해자가 같은 피해는 명중선을 그리지 않는다.
            if (!ev.attackerName || ev.attackerName === ev.victimName) return;
            if (!isCombatDamageCause(ev.cause) || ageMs >= HIT_LINE_MS) return;
            if (!Number.isFinite(ev.attackerX) || !Number.isFinite(ev.attackerY)) return;
            const from = getPoint(ev.attackerY, ev.attackerX);
            const op = 1 - ageMs / HIT_LINE_MS;
            ctx.beginPath();
            ctx.moveTo(from.x, from.y);
            ctx.lineTo(pt.x, pt.y);
            ctx.strokeStyle = `rgba(255, 80, 80, ${op * 0.9})`;
            ctx.lineWidth = 2;
            ctx.stroke();
            ctx.beginPath();
            ctx.arc(pt.x, pt.y, 3.5, 0, Math.PI * 2);
            ctx.fillStyle = `rgba(255, 120, 120, ${op})`;
            ctx.fill();
            return;
          }

          // 총구 화염: 사격 방향 값이 없으므로 방향 없는 원으로만 표시한다.
          if (type === "shot" && ageMs < 400) {
            const op = 1 - ageMs / 400;
            ctx.beginPath();
            ctx.arc(pt.x, pt.y, 24 * op * zoomScale, 0, Math.PI * 2);
            ctx.fillStyle = `rgba(255, 230, 100, ${op})`;
            ctx.fill();
            ctx.beginPath();
            ctx.arc(pt.x, pt.y, 12 * op * zoomScale, 0, Math.PI * 2);
            ctx.fillStyle = "white";
            ctx.fill();
          }
        });
      }

      // [C] 플레이어 & 차량 (기존 로직 유지)
      const hidden = (name:string) => (dataRef.current.hiddenPlayers || []).some((value:string) => value.trim().toLowerCase() === name.trim().toLowerCase());
      // 이름 자동 표시: 아군, 따라가는 선수, 최근 아군과 교전한 상대. "전체"면 모두 표시한다.
      const opponents = recentOpponents(engagementsRef.current, currentTimeMs);
      const followed = (dataRef.current.followPlayer || "").trim().toLowerCase();
      const showName = (player: any) => {
        if (dataRef.current.showPlayerNames || player.name === dataRef.current.nickname || !player.isEnemy) return true;
        const name = String(player.name || "").trim().toLowerCase();
        return name === followed || opponents.has(name);
      };
      const handledVehicles = new Set();
      const nameLabels: NameLabel[] = [];
      // 인지 범위: 따라가는 선수에게서 멀고 최근 교전도 없는 적은 흐리게 그리고 이름을 숨긴다(거리 기준 추정).
      const unitMeters = metersPerUnit(dataRef.current.mapName);
      const followedState = followed
        ? Object.values(states).find((p: any) => String(p?.name || "").trim().toLowerCase() === followed) as any
        : null;
      const followedPos = dataRef.current.showVision && followedState && !followedState.isDead
        ? getInterpolatedPos(followed, currentTimeMs) || { x: followedState.x, y: followedState.y }
        : null;
      const isUnknown = (player: any) => {
        if (!followedPos || !player.isEnemy) return false;
        const pos = getInterpolatedPos(player.name, currentTimeMs) || { x: player.x, y: player.y };
        return !isKnownEnemy({ followed: followedPos, enemy: pos, enemyName: String(player.name || ""), recentContacts: opponents, unitMeters });
      };
      const labelPriority = (player: any) => {
        const name = String(player.name || "").trim().toLowerCase();
        if (player.name === dataRef.current.nickname) return 0;
        if (followed && name === followed) return 1;
        return player.isEnemy ? 3 : 2;
      };
      Object.values(states).forEach((p: any) => {
        if (p.isDead || hidden(p.name)) return;
        const pos = getInterpolatedPos(p.name, currentTimeMs) || { x: p.x, y: p.y };
        const pt = getPoint(pos.y, pos.x);
        const isMe = p.name === dataRef.current.nickname;
        const isGroggy = p.isGroggy;
        const radius = isMe ? 12 : 9;

        if (p.isInVehicle && p.vehicleId) {
          if (handledVehicles.has(p.vehicleId)) return;
          handledVehicles.add(p.vehicleId);
          const occupants = Object.values(states).filter((o: any) => !o.isDead && !hidden(o.name) && o.vehicleId === p.vehicleId) as any[];
          
          const isAirplane = p.vehicleId.toLowerCase().includes("aircraft") || p.vehicleId.toLowerCase().includes("c130");
          const vehicleUnknown = occupants.length > 0 && occupants.every(isUnknown);

          ctx.save();
          if (vehicleUnknown) ctx.globalAlpha = DIM_ALPHA;
          ctx.translate(pt.x, pt.y);
          
          if (isAirplane) {
             ctx.fillStyle = "#e5e7eb";
             drawPlaneGlyph(ctx, zoomScale);
          } else {
            // 차량은 선수 점보다 눈에 띄지 않게 작게 그린다.
            ctx.fillStyle = "rgba(40,40,40,0.9)";
            ctx.strokeStyle = "#ffffff";
            ctx.lineWidth = 1.5;
            ctx.beginPath();
            if ((ctx as any).roundRect) (ctx as any).roundRect(-14, -9, 28, 18, 4);
            else ctx.rect(-14, -9, 28, 18);
            ctx.fill(); ctx.stroke();
            if (followed && occupants.some((m) => String(m.name).trim().toLowerCase() === followed)) {
              ctx.beginPath();
              if ((ctx as any).roundRect) (ctx as any).roundRect(-18, -13, 36, 26, 6);
              else ctx.rect(-18, -13, 36, 26);
              ctx.strokeStyle = "#38bdf8"; ctx.lineWidth = 2.5; ctx.stroke();
            }
            // 아이콘 아래에 탑승자 색 점을 찍어 누가 타고 있는지 보이게 한다(기절은 빨강).
            occupants.forEach((m, i) => {
              ctx.beginPath();
              ctx.arc(-((occupants.length - 1) * 8) / 2 + i * 8, 13, 3.5, 0, Math.PI * 2);
              ctx.fillStyle = m.isGroggy ? "#ff0000" : (m.color || "#ffffff");
              ctx.fill();
              ctx.strokeStyle = "#000000"; ctx.lineWidth = 1; ctx.stroke();
            });
            ctx.fillStyle = "#ffffff";
            ctx.scale(0.65, 0.65);
            drawVehicleGlyph(ctx);
          }
          ctx.restore();

          if (!isAirplane) {
            occupants.forEach((m) => {
              if (!vehicleUnknown && showName(m)) {
                nameLabels.push({ text: m.name, x: pt.x, y: pt.y - 18, color: m.isGroggy ? "#ff4444" : "#ffffff", font: "bold 10px Pretendard", priority: labelPriority(m) });
              }
            });
          }
          return;
        }

        const unknown = isUnknown(p);
        ctx.save();
        if (unknown) ctx.globalAlpha = DIM_ALPHA;
        ctx.translate(pt.x, pt.y);
        if (isGroggy) {
          const pulse = 0.5 + Math.sin(currentTimeMs / 150) * 0.4;
          ctx.beginPath(); ctx.arc(0, 0, radius + 5, 0, Math.PI * 2);
          ctx.fillStyle = `rgba(255, 0, 0, ${pulse * 0.4})`; ctx.fill();
        }
        ctx.beginPath(); ctx.arc(0, 0, radius, 0, Math.PI * 2);
        ctx.fillStyle = isGroggy ? "#ff0000" : (p.color || "#ffffff");
        ctx.fill();
        ctx.strokeStyle = isGroggy ? "#ffffff" : (isMe ? "#ffffff" : "#000000");
        ctx.lineWidth = isGroggy ? 3 : (isMe ? 2.5 : 1.5);
        ctx.stroke();
        if (followed && String(p.name).trim().toLowerCase() === followed) {
          ctx.beginPath(); ctx.arc(0, 0, radius + 4, 0, Math.PI * 2);
          ctx.strokeStyle = "#38bdf8"; ctx.lineWidth = 2.5; ctx.stroke();
        }

        const hpPct = Math.max(0, p.health / 100);
        const barWidth = radius * 2.5;
        ctx.fillStyle = "rgba(0,0,0,0.6)"; ctx.fillRect(-barWidth / 2, radius + 4, barWidth, 4);
        ctx.fillStyle = isGroggy ? "#ff0000" : (hpPct > 0.5 ? "#22c55e" : (hpPct > 0.2 ? "#f59e0b" : "#ef4444"));
        ctx.fillRect(-barWidth / 2, radius + 4, barWidth * hpPct, 4);

        if (!isGroggy && p.teamId != null) {
          ctx.font = `bold ${radius * 0.9}px Pretendard`; ctx.fillStyle = "#ffffff";
          ctx.textAlign = "center"; ctx.textBaseline = "middle";
          ctx.fillText(p.teamId.toString(), 0, 0);
        }

        ctx.restore();
        if (!unknown && showName(p)) {
          nameLabels.push({ text: p.name, x: pt.x, y: pt.y - radius - 12, color: isGroggy ? "#ff4444" : "#ffffff", font: isMe ? "bold 12px Pretendard" : "bold 10px Pretendard", priority: labelPriority(p) });
        }
      });
      drawNameLabels(ctx, nameLabels);

      overlayLabels.forEach((label) => {
        ctx.save();
        ctx.globalAlpha = label.alpha;
        drawNameLabel(ctx, label.text, label.x, label.y, label.color, "bold 10px Pretendard");
        ctx.restore();
      });

      ctx.restore();
      if (dataRef.current?.isPlaying) requestDraw();
    };

    requestDrawRef.current = requestDraw;
    map.on("viewreset move moveend zoom zoomend resize", requestDraw);
    map.on("dragstart", cancelFollowOnDrag);
    const container = map.getContainer();
    container.addEventListener("wheel", cancelAutoZoomOnUserZoom, { passive: true });
    container.addEventListener("dblclick", cancelAutoZoomOnUserZoom);
    container.addEventListener("touchstart", onPinch, { passive: true });
    container.addEventListener("click", onZoomControl);
    requestDraw();
    return () => {
      map.off("viewreset move moveend zoom zoomend resize", requestDraw);
      map.off("dragstart", cancelFollowOnDrag);
      container.removeEventListener("wheel", cancelAutoZoomOnUserZoom);
      container.removeEventListener("dblclick", cancelAutoZoomOnUserZoom);
      container.removeEventListener("touchstart", onPinch);
      container.removeEventListener("click", onZoomControl);
      requestDrawRef.current = () => {};
      followStartRef.current = () => {};
      if (animationRef.current) cancelAnimationFrame(animationRef.current);
      animationRef.current = null;
      if (pane && canvas) try { pane.removeChild(canvas); } catch (e) {}
    };
  }, [map]);

  // 지도 effect가 followStartRef를 연결한 뒤에 실행되도록 그 아래에 둔다.
  const followPlayer: string | null = telemetryData.followPlayer ?? null;
  useEffect(() => {
    if (followPlayer) followStartRef.current(followPlayer);
  }, [followPlayer]);

  return null;
};

export default TelemetryCanvasLayer;
