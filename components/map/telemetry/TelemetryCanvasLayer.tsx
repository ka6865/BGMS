"use client";

import React, { useEffect, useRef } from "react";
import { useMap } from "react-leaflet";
import L from "leaflet";
import { toCalibratedCoords } from "../../../utils/coordinate";

interface TelemetryCanvasLayerProps {
  telemetryData: any;
  showZones?: boolean;
  isHighPrecision?: boolean;
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
  isHighPrecision = false,
  showFlightPath = true
}: TelemetryCanvasLayerProps): React.ReactElement | null => {
  const map = useMap();
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const animationRef = useRef<number | null>(null);
  const dataRef = useRef(telemetryData);
  const posLogsRef = useRef<Record<string, { x: number, y: number, t: number, rotation: number }[]>>({});
  const flightPathRef = useRef<{ start: {x: number, y: number}, end: {x: number, y: number} } | null>(null);

  useEffect(() => {
    dataRef.current = telemetryData;
  }, [telemetryData]);

  useEffect(() => {
    const evs = telemetryData.events;
    if (!evs) return;
    const newLogs: Record<string, any[]> = {};
    evs.forEach((ev: any) => {
      const type = (ev._T || ev.type || "").toString();
      if (type === "position" || type === "enemy_position" || type === "LogPlayerPosition") {
        const name = (ev.name || ev.character?.name || "").trim().toLowerCase();
        if (!name) return;
        if (!newLogs[name]) newLogs[name] = [];
        const loc = ev.location || ev;
        newLogs[name].push({ 
          t: ev.relativeTimeMs, 
          x: loc.x, 
          y: loc.y, 
          rotation: ev.rotation || ev.character?.rotation || 0 
        });
      }
    });
    Object.keys(newLogs).forEach(name => newLogs[name].sort((a, b) => a.t - b.t));
    posLogsRef.current = newLogs;

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
  }, [telemetryData.events]);

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

    const getInterpolatedPos = (rawName: string, time: number) => {
      const name = (rawName || "").trim().toLowerCase();
      const logs = posLogsRef.current[name];
      if (!logs || logs.length === 0) return null;
      if (time <= logs[0].t) return logs[0];
      if (time >= logs[logs.length - 1].t) return logs[logs.length - 1];
      let low = 0, high = logs.length - 1;
      while (low <= high) {
        const mid = Math.floor((low + high) / 2);
        if (logs[mid].t < time) low = mid + 1;
        else high = mid - 1;
      }
      const p1 = logs[Math.max(0, low - 1)], p2 = logs[low];
      if (!p1 || !p2 || p1.t === p2.t) return p1 || p2;
      const r = (time - p1.t) / (p2.t - p1.t);
      return { x: p1.x + (p2.x - p1.x) * r, y: p1.y + (p2.y - p1.y) * r, rotation: p1.rotation + (p2.rotation - p1.rotation) * r };
    };

    const getPoint = (lat: number, lng: number) => {
      if (typeof lat !== "number" || typeof lng !== "number" || isNaN(lat) || isNaN(lng)) {
        return { x: -9999, y: -9999 }; // 화면 밖으로 밀어냄
      }
      try {
        const calibrated = toCalibratedCoords(lng, lat, telemetryData.mapName);
        const p = map.latLngToContainerPoint(calibrated);
        return { x: p.x, y: p.y };
      } catch (e) {
        return { x: -9999, y: -9999 };
      }
    };

    const draw = () => {
      if (!canvas || !map) return;
      const ctx = canvas.getContext("2d");
      if (!ctx) return;

      const { currentStates: states, currentTimeMs, events, zoneEvents, showZone } = dataRef.current;
      if (!states) { 
        animationRef.current = requestAnimationFrame(draw); 
        return; 
      }

      const size = map.getSize(), dpr = window.devicePixelRatio || 1;
      canvas.width = size.x * dpr; canvas.height = size.y * dpr;
      canvas.style.width = `${size.x}px`; canvas.style.height = `${size.y}px`;
      L.DomUtil.setPosition(canvas, map.containerPointToLayerPoint([0, 0]));

      ctx.clearRect(0, 0, canvas.width, canvas.height);
      ctx.save(); ctx.scale(dpr, dpr);

      //  줌 레벨에 따른 스케일 계산
      const currentZoom = map.getZoom();
      const zoomScale = Math.pow(1.5, currentZoom - 1); 

      // [A] 인게임 스타일 자기장 (반전 채우기 & 보간 적용)
      const isZoneVisible = showZones && showZone !== false;
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

          // White zone interpolation
          const startWhiteX = prevZone.whiteX ?? nextZone.whiteX;
          const endWhiteX = nextZone.whiteX ?? prevZone.whiteX;
          const startWhiteY = prevZone.whiteY ?? nextZone.whiteY;
          const endWhiteY = nextZone.whiteY ?? prevZone.whiteY;
          const startWhiteRadius = prevZone.whiteRadius ?? nextZone.whiteRadius;
          const endWhiteRadius = nextZone.whiteRadius ?? prevZone.whiteRadius;

          if (
            typeof startX !== "number" || typeof endX !== "number" ||
            typeof startY !== "number" || typeof endY !== "number" ||
            typeof startRadius !== "number" || typeof endRadius !== "number"
          ) {
            ctx.restore();
            animationRef.current = requestAnimationFrame(draw);
            return;
          }

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

      // [A-2] 비행기 경로 (Flight Path)
      if (dataRef.current.showFlightPath && flightPathRef.current) {
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

      // [B] 전투 이펙트
      if (events && Array.isArray(events)) {
        events.forEach((ev: any) => {
          const type = (ev._T || ev.type || "").toString();
          const ageMs = currentTimeMs - (ev.relativeTimeMs || 0);
          
          if (ageMs < -1000 || ageMs > 40000) return;
          if (typeof ev.x !== "number" || typeof ev.y !== "number" || isNaN(ev.x) || isNaN(ev.y)) return;
          
          const pt = getPoint(ev.y, ev.x);
          if (pt.x === -9999) return;
          let rendered = false;

          // 1. 기절 효과
          if (type === "groggy" && ageMs >= 0 && ageMs < 2500) {
            const t = ageMs / 2500;
            ctx.beginPath();
            ctx.arc(pt.x, pt.y, Math.max(0, 100 * t * zoomScale), 0, Math.PI * 2);
            ctx.strokeStyle = `rgba(251, 191, 36, ${1 - t})`;
            ctx.lineWidth = 6 * (1 - t);
            ctx.stroke();
            rendered = true;
          } 
          
          if (!rendered) {
            // [VFX 1] 수류탄 폭발
            if (type === "grenade" && ageMs >= 0 && ageMs < 3000) {
              const t = ageMs / 3000;
              const rad = 80 * zoomScale;
              ctx.beginPath();
              ctx.arc(pt.x, pt.y, Math.max(0, rad * t), 0, Math.PI * 2); 
              ctx.strokeStyle = `rgba(255, 255, 255, ${0.9 * (1 - t)})`;
              ctx.lineWidth = 6 * (1 - t);
              ctx.stroke();
              
              ctx.beginPath();
              ctx.arc(pt.x, pt.y, Math.max(0, (rad * 0.5) * (1 - t)), 0, Math.PI * 2);
              ctx.fillStyle = `rgba(255, 80, 0, ${0.9 * (1 - t)})`;
              ctx.fill();

              if (ev.name && ageMs < 5000) {
                ctx.fillStyle = "white";
                ctx.font = `bold ${Math.max(9, 11 * zoomScale)}px Pretendard`;
                ctx.textAlign = "center";
                ctx.fillText(ev.isEstimated ? `${ev.name}의 수류탄 (예측)` : `${ev.name}의 수류탄`, pt.x, pt.y - (rad * 0.6));
              }
              rendered = true;
            } 
            // [VFX 2] 연막탄 구름
            else if (type === "smoke" && ageMs >= 0 && ageMs < 40000) {
              let op = 0.75, sc = 1.0;
              if (ageMs < 4000) { op = (ageMs / 4000) * 0.75; sc = 0.4 + (ageMs / 4000) * 0.6; }
              else if (ageMs > 30000) { op = (1 - (ageMs - 30000) / 10000) * 0.75; }
              
              const rad = 45 * sc * zoomScale;
              ctx.save();
              ctx.globalAlpha = Math.max(0, Math.min(op, 1));
              
              if (ev.isEstimated) {
                ctx.setLineDash([5, 5]);
                ctx.strokeStyle = "rgba(255,255,255,0.5)";
                ctx.lineWidth = 1;
                ctx.strokeRect(pt.x - rad, pt.y - rad, rad*2, rad*2);
              }

              ctx.beginPath();
              for (let a = 0; a < Math.PI * 2; a += Math.PI / 4) {
                const ox = Math.cos(a) * rad * 0.5;
                const oy = Math.sin(a) * rad * 0.5;
                ctx.moveTo(pt.x + ox, pt.y + oy);
                ctx.arc(pt.x + ox, pt.y + oy, Math.max(0, rad * 0.8), 0, Math.PI * 2);
              }
              ctx.fillStyle = "#ffffff";
              ctx.fill();

              if (ev.name && ageMs < 5000) {
                ctx.fillStyle = "white";
                ctx.font = `bold ${Math.max(9, 11 * zoomScale)}px Pretendard`;
                ctx.textAlign = "center";
                ctx.fillText(ev.isEstimated ? `${ev.name}의 연막 (예측)` : `${ev.name}의 연막`, pt.x, pt.y - (rad + 10));
              }
              ctx.restore();
              rendered = true;
            }
            // [VFX 3] 섬광탄
            else if (type === "flash" && ageMs >= 0 && ageMs < 2000) {
              const t = ageMs / 2000;
              const rad = 150 * zoomScale;
              ctx.beginPath();
              ctx.arc(pt.x, pt.y, rad * (1 - t), 0, Math.PI * 2);
              ctx.fillStyle = `rgba(255, 255, 255, ${0.8 * (1 - t)})`;
              ctx.fill();
              rendered = true;
            }
            // [VFX 4] 화염병
            else if (type === "molotov" && ageMs >= 0 && ageMs < 10000) {
              const t = ageMs / 10000;
              const rad = (40 + Math.sin(ageMs / 100) * 5) * zoomScale;
              ctx.beginPath();
              ctx.arc(pt.x, pt.y, rad, 0, Math.PI * 2);
              ctx.fillStyle = `rgba(255, 60, 0, ${0.6 * (1 - t)})`;
              ctx.fill();
              rendered = true;
            }
            // [VFX 5] 블루존 수류탄
            else if (type === "bluezone" && ageMs >= 0 && ageMs < 10000) {
              const t = ageMs / 10000;
              const rad = 100 * zoomScale;
              ctx.beginPath();
              ctx.arc(pt.x, pt.y, rad, 0, Math.PI * 2);
              ctx.strokeStyle = `rgba(0, 150, 255, ${0.8 * (1 - t)})`;
              ctx.lineWidth = 4;
              ctx.stroke();
              ctx.fillStyle = `rgba(0, 100, 255, ${0.2 * (1 - t)})`;
              ctx.fill();
              rendered = true;
            }
            // [VFX 6] 긴급 엄폐 (Shield)
            else if (type === "shield" && ageMs >= 0 && ageMs < 40000) {
              const op = ageMs > 35000 ? (1 - (ageMs - 35000) / 5000) : 1;
              const w = 30 * zoomScale, h = 16 * zoomScale;
              ctx.save();
              ctx.globalAlpha = Math.max(0, op);
              ctx.fillStyle = "#707070";
              ctx.fillRect(pt.x - w/2, pt.y - h/2, w, h);
              ctx.strokeStyle = "#ffffff";
              ctx.lineWidth = 1;
              ctx.strokeRect(pt.x - w/2, pt.y - h/2, w, h);

              if (ev.name && ageMs < 5000) {
                ctx.fillStyle = "white";
                ctx.font = `bold ${Math.max(9, 11 * zoomScale)}px Pretendard`;
                ctx.textAlign = "center";
                ctx.fillText(ev.isEstimated ? `${ev.name}의 엄폐 (예측)` : `${ev.name}의 엄폐`, pt.x, pt.y - h/2 - 10);
              }
              ctx.restore();
              rendered = true;
            }
            // [고정밀 전용] 사격 궤적
            else if (isHighPrecision && type === "damage" && ageMs < 600) {
              const op = 1 - (ageMs / 600);
              const attacker = getInterpolatedPos(ev.attackerName, currentTimeMs);
              const victim = getInterpolatedPos(ev.victimName, currentTimeMs);
              if (attacker && victim) {
                const aPt = getPoint(attacker.y, attacker.x), vPt = getPoint(victim.y, victim.x);
                ctx.beginPath();
                ctx.moveTo(aPt.x, aPt.y);
                ctx.lineTo(vPt.x, vPt.y);
                ctx.strokeStyle = `rgba(255, 50, 50, ${op})`;
                ctx.lineWidth = 3.5 * op;
                ctx.stroke();
              }
              rendered = true;
            }
          }
          
          // 3. 총구 화염 (Muzzle Flash)
          if (!rendered && (type === "shot" || type.includes("Attack")) && ageMs >= 0 && ageMs < 400) {
            const op = 1 - (ageMs / 400);
            const rot = (ev.rotation || 0) * (Math.PI / 180);
            
            ctx.save();
            ctx.translate(pt.x, pt.y);
            if (ev.vX != null && ev.vY != null) {
              const angle = Math.atan2(ev.vY, ev.vX);
              ctx.rotate(angle);
            } else {
              ctx.rotate(rot - Math.PI / 2);
            }

            ctx.beginPath();
            ctx.arc(0, 0, 24 * op * zoomScale, 0, Math.PI * 2);
            ctx.fillStyle = `rgba(255, 230, 100, ${op})`;
            ctx.fill();
            
            ctx.beginPath();
            ctx.arc(0, 0, 12 * op * zoomScale, 0, Math.PI * 2);
            ctx.fillStyle = `white`;
            ctx.fill();
            ctx.restore();
          }
        });
      }

      // [C] 플레이어 & 차량 (기존 로직 유지)
      const handledVehicles = new Set();
      Object.values(states).forEach((p: any) => {
        if (p.isDead) return;
        const pos = getInterpolatedPos(p.name, currentTimeMs) || { x: p.x, y: p.y, rotation: 0 };
        const pt = getPoint(pos.y, pos.x);
        const isMe = p.name === telemetryData.nickname;
        const isGroggy = p.isGroggy;
        const isTeam = !p.isEnemy;
        const radius = isMe ? 12 : 9;

        if (p.isInVehicle && p.vehicleId) {
          if (handledVehicles.has(p.vehicleId)) return;
          handledVehicles.add(p.vehicleId);
          const occupants = Object.values(states).filter((o: any) => !o.isDead && o.vehicleId === p.vehicleId) as any[];
          
          const isAirplane = p.vehicleId.toLowerCase().includes("aircraft") || p.vehicleId.toLowerCase().includes("c130");

          ctx.save();
          ctx.translate(pt.x, pt.y);
          if (pos.rotation) ctx.rotate((pos.rotation * Math.PI) / 180);
          
          if (isAirplane) {
             ctx.fillStyle = "#e5e7eb";
             drawPlaneGlyph(ctx, zoomScale);
          } else {
            ctx.fillStyle = "rgba(40,40,40,0.9)";
            ctx.strokeStyle = "#ffffff";
            ctx.lineWidth = 2;
            ctx.beginPath();
            if ((ctx as any).roundRect) (ctx as any).roundRect(-22, -14, 44, 28, 6);
            else ctx.rect(-22, -14, 44, 28);
            ctx.fill(); ctx.stroke();
            ctx.fillStyle = "#ffffff";
            drawVehicleGlyph(ctx);
          }
          ctx.restore();

          if (!isAirplane) {
            occupants.forEach((m, i) => {
              if (telemetryData.showPlayerNames || m.name === telemetryData.nickname) {
                ctx.font = "bold 10px Pretendard";
                ctx.fillStyle = m.isGroggy ? "#ff4444" : "#ffffff";
                ctx.textAlign = "center";
                ctx.fillText(m.name, pt.x, pt.y - 20 - (i * 12));
              }
            });
          }
          return;
        }

        ctx.save();
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

        if (telemetryData.showPlayerNames || isMe || (isTeam && isGroggy)) {
          ctx.font = isMe ? "bold 12px Pretendard" : "bold 10px Pretendard";
          ctx.fillStyle = isGroggy ? "#ff4444" : "#ffffff"; ctx.textAlign = "center";
          ctx.shadowColor = "black"; ctx.shadowBlur = 4;
          ctx.fillText(p.name, 0, -radius - 12);
          ctx.shadowBlur = 0;
        }
        ctx.restore();
      });

      ctx.restore();
      animationRef.current = requestAnimationFrame(draw);
    };

    const reset = () => { if (animationRef.current) cancelAnimationFrame(animationRef.current); animationRef.current = requestAnimationFrame(draw); };
    map.on("viewreset move moveend zoomend", reset);
    reset();
    return () => {
      map.off("viewreset move moveend zoomend", reset);
      if (animationRef.current) cancelAnimationFrame(animationRef.current);
      if (pane && canvas) try { pane.removeChild(canvas); } catch (e) {}
    };
  }, [map, isHighPrecision]);

  return null;
};

export default TelemetryCanvasLayer;
