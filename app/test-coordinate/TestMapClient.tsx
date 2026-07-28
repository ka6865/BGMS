"use client";

import React, { useState, useMemo, useEffect } from "react";
import { MapContainer, TileLayer, Marker, Popup, Circle } from "react-leaflet";
import L, { CRS } from "leaflet";
import "leaflet/dist/leaflet.css";

// 랜드마크 기준물: 에란겔 밀타 파워(Mylta Power) 대형 냉각탑의 실제 펍지 텔레메트리 cm 좌표
const MYLTA_POWER_CENTER_RAW = { x: 642800, y: 486100 }; 

const createSimpleIcon = (color: string, label: string) => {
  return L.divIcon({
    className: "custom-test-pin",
    html: `
      <div style="display: flex; flex-direction: column; align-items: center; justify-content: center; position: relative;">
        <div style="
          width: 14px; height: 14px; 
          background-color: ${color}; 
          border: 2px solid white; 
          border-radius: 50%;
          box-shadow: 0 0 8px rgba(0,0,0,0.6);
        "></div>
        <span style="
          background: rgba(0,0,0,0.85); 
          color: white; 
          font-size: 9px; 
          font-weight: bold; 
          padding: 1px 4px; 
          border-radius: 4px; 
          margin-top: 3px;
          white-space: nowrap;
          border: 1px solid rgba(255,255,255,0.15);
        ">${label}</span>
      </div>
    `,
    iconSize: [60, 30],
    iconAnchor: [30, 7],
  });
};

export default function TestMapClient() {
  const [dx, setDx] = useState<number>(3.5);
  const [dy, setDy] = useState<number>(-2.0);
  const [mapInstance, setMapInstance] = useState<L.Map | null>(null);

  // 1. 보정 전 (기존 819200 분모 스케일링, 무보정)
  const posBefore = useMemo(() => {
    const scale = 8192 / 819200;
    const x = MYLTA_POWER_CENTER_RAW.x * scale;
    const y = MYLTA_POWER_CENTER_RAW.y * scale;
    return [8192 - y, x] as [number, number];
  }, []);

  // 2. 보정 후 (기존 819200 분모 스케일링 + dx, dy 오프셋 수동 조정)
  const posAfter = useMemo(() => {
    const scale = 8192 / 819200;
    const x = (MYLTA_POWER_CENTER_RAW.x * scale) + dx;
    const y = (MYLTA_POWER_CENTER_RAW.y * scale) + dy;
    return [8192 - y, x] as [number, number];
  }, [dx, dy]);

  // 3. 공식 스펙 기준 (실제 월드 800000 분모 스케일링 적용 시)
  const posSpec = useMemo(() => {
    const scale = 8192 / 800000;
    const x = MYLTA_POWER_CENTER_RAW.x * scale;
    const y = MYLTA_POWER_CENTER_RAW.y * scale;
    return [8192 - y, x] as [number, number];
  }, []);

  // 4. 최초 로드 시 밀타 파워 냉각탑 위치로 지도 줌 포커싱
  useEffect(() => {
    if (mapInstance) {
      mapInstance.setView(posSpec, -1); // 줌 -1 레벨로 이동
    }
  }, [mapInstance, posSpec]);

  return (
    <div className="w-full h-screen relative">
      {/* 어드민 캘리브레이션 튜닝 카드 패널 (Glassmorphism 적용) */}
      <div className="absolute top-6 left-6 z-[1000] p-6 w-80 rounded-2xl border border-white/10 bg-neutral-950/85 backdrop-blur-md text-neutral-200 shadow-2xl font-sans">
        <h2 className="font-bold text-white text-base flex items-center gap-2 mb-2">
          PUBG 좌표 정밀 캘리브레이션
        </h2>
        <p className="text-xs text-neutral-400 mb-4 leading-relaxed">
          에란겔의 랜드마크인 <b>밀타 파워 냉각탑 정중앙</b>(펍지 좌표 6428m, 4861m)을 기준으로 오차를 실측합니다.
        </p>

        {/* 튜닝 슬라이더 X */}
        <div className="mb-3">
          <div className="flex justify-between text-xs font-semibold mb-1">
            <span className="text-neutral-400">X축 오프셋 (동/서)</span>
            <span className="text-emerald-400 font-bold">{dx > 0 ? `+${dx}` : dx}m</span>
          </div>
          <input
            type="range"
            min="-10"
            max="10"
            step="0.5"
            value={dx}
            onChange={(e) => setDx(Number(e.target.value))}
            className="w-full h-1.5 rounded-lg bg-neutral-800 appearance-none cursor-pointer accent-emerald-500"
          />
        </div>

        {/* 튜닝 슬라이더 Y */}
        <div className="mb-4">
          <div className="flex justify-between text-xs font-semibold mb-1">
            <span className="text-neutral-400">Y축 오프셋 (남/북)</span>
            <span className="text-emerald-400 font-bold">{dy > 0 ? `+${dy}` : dy}m</span>
          </div>
          <input
            type="range"
            min="-10"
            max="10"
            step="0.5"
            value={dy}
            onChange={(e) => setDy(Number(e.target.value))}
            className="w-full h-1.5 rounded-lg bg-neutral-800 appearance-none cursor-pointer accent-emerald-500"
          />
        </div>

        {/* 대조 데이터 상태창 */}
        <div className="space-y-1.5 text-[11px] font-mono bg-neutral-900/50 p-3 rounded-lg border border-white/5">
          <div className="flex justify-between">
            <span className="text-red-400">● 보정 전:</span>
            <span>[{posBefore[0].toFixed(1)}, {posBefore[1].toFixed(1)}]</span>
          </div>
          <div className="flex justify-between">
            <span className="text-emerald-400">● 현재 보정:</span>
            <span>[{posAfter[0].toFixed(1)}, {posAfter[1].toFixed(1)}]</span>
          </div>
          <div className="flex justify-between">
            <span className="text-blue-400">● 80만 스펙:</span>
            <span>[{posSpec[0].toFixed(1)}, {posSpec[1].toFixed(1)}]</span>
          </div>
        </div>

        <div className="text-[10px] text-neutral-500 mt-4 leading-normal">
          * 파란색(80만 스펙)과 초록색(보정값)이 겹치는 오프셋이 가장 정확한 타일 매칭 오프셋입니다.
        </div>
      </div>

      <MapContainer
        center={[4096, 4096]}
        zoom={-3}
        minZoom={-5}
        maxZoom={2}
        crs={CRS.Simple}
        maxBounds={[[0, 0], [8192, 8192]]}
        style={{ height: "100%", width: "100%", background: "#0b0f19" }}
        ref={setMapInstance}
        zoomControl={false}
      >
        <TileLayer
          url="/tiles/Erangel/{z}/{x}/{y}.jpg"
          minZoom={-5}
          maxZoom={2}
          maxNativeZoom={0}
          zoomOffset={5}
          bounds={[[0, 0], [8192, 8192]]}
          noWrap={true}
        />

        {/* 1. 보정 전 (Red) */}
        <Marker position={posBefore} icon={createSimpleIcon("#ef4444", "Before (Red)")}>
          <Popup>보정 전 기존 수식 좌표</Popup>
        </Marker>

        {/* 2. 현재 보정 (Green) */}
        <Marker position={posAfter} icon={createSimpleIcon("#10b981", "Calibrated (Green)")}>
          <Popup>실시간 오프셋 반영 좌표</Popup>
        </Marker>

        {/* 3. 공식 스펙 기준 (Blue) */}
        <Marker position={posSpec} icon={createSimpleIcon("#3b82f6", "Spec (Blue)")}>
          <Popup>800000 공식 스펙 좌표</Popup>
        </Marker>

        {/* 냉각탑 주변 가이드 원 */}
        <Circle 
          center={posSpec} 
          radius={50} 
          pathOptions={{ color: "#3b82f6", fillColor: "transparent", weight: 1.5, dashArray: "5, 5" }} 
        />
      </MapContainer>
    </div>
  );
}
