import React, { memo, useRef, useEffect, useState } from "react";
import getApiUrl from "../../lib/api-config";
import {
  MapContainer,
  TileLayer,
  Marker,
  Popup,
  Polyline,
  Polygon,
  Tooltip,
  CircleMarker,
  useMapEvents,
  useMap,
} from "react-leaflet";
import L, { CRS } from "leaflet";
import "leaflet/dist/leaflet.css";
import type { MapTab, MapMarker, AuthUser, PendingVehicle } from "../../types/map";
import ReportForm from "./ReportForm";
import HotDropLayer from "./HotDropLayer";
import { supabase } from "../../lib/supabase";
import { MAP_DIMENSIONS } from "../../lib/map_config";
import { toast } from "sonner";
import { InlineIconLabel } from "@/components/common/InlineIconLabel";

// 리팩토링으로 분리된 텔레메트리 컴포넌트 임포트
import { ZoneRenderer } from "./telemetry/ZoneRenderer";
import { CombatRenderer } from "./telemetry/CombatRenderer";
import { ShotRenderer } from "./telemetry/ShotRenderer";
import { PlayerPathRenderer } from "./telemetry/PlayerPathRenderer";
import { TelemetryCanvasLayer } from "./telemetry/TelemetryCanvasLayer";
import { SimulatorLayer } from "./SimulatorLayer";

const mortarStartIcon = L.divIcon({
  className: "custom-mortar",
  html: `<div style="width:14px;height:14px;background:#34A853;border:2px solid white;border-radius:50%;"></div>`,
  iconSize: [14, 14],
});
const mortarEndIcon = L.divIcon({
  className: "custom-mortar",
  html: `<div style="width:14px;height:14px;background:#ea4335;border:2px solid white;border-radius:50%;"></div>`,
  iconSize: [14, 14],
});
const emptyIcon = L.divIcon({
  className: "empty-icon",
  html: "",
  iconSize: [0, 0],
});

type MortarAnalysis = {
  p1: L.LatLng;
  p2: L.LatLng;
  horizontalDistance: number;
  distance3D: number;
  deltaH: number;
  mortarSetting: number;
  isRangeValid: boolean;
};
const flightPointIcon = L.divIcon({
  className: "flight-point",
  html: `<div style="width:16px;height:16px;background:#3b82f6;border:2px solid white;border-radius:50%;"></div>`,
  iconSize: [16, 16],
});
const reportPlacementIcon = L.divIcon({
  className: "custom-report-placement",
  html: `
    <div class="relative flex items-center justify-center">
      <div class="absolute w-8 h-8 bg-green-500 rounded-full opacity-40 animate-ping"></div>
      <div class="relative w-5 h-5 bg-green-600 border-2 border-white rounded-full flex items-center justify-center font-bold text-white text-xs shadow-lg">?</div>
    </div>
  `,
  iconSize: [32, 32],
  iconAnchor: [16, 16],
});

interface PUBGGridProps {
  activeMapId: string;
}

const PUBGGrid = memo(({ activeMapId }: PUBGGridProps) => {
  const lines = [];
  const totalUnits = 8192;
  const kmSize = MAP_DIMENSIONS[activeMapId] || 8;
  const unitsPerKm = totalUnits / kmSize;
  const unitsPer100m = unitsPerKm / 10;

  // 100m 단위로 선을 긋습니다.
  const lineCount = kmSize * 10;

  for (let i = 0; i <= lineCount; i++) {
    const pos = i * unitsPer100m;
    const isMajor = i % 10 === 0;
    const color = isMajor ? "#F2A900" : "#ffffff";
    const weight = isMajor ? 2 : 1;
    const opacity = isMajor ? 0.4 : 0.1;

    // 수평선
    lines.push(
      <Polyline
        key={`h-${i}`}
        positions={[
          [pos, 0],
          [pos, totalUnits],
        ]}
        color={color}
        weight={weight}
        opacity={opacity}
        interactive={false}
      />
    );
    // 수직선
    lines.push(
      <Polyline
        key={`v-${i}`}
        positions={[
          [0, pos],
          [totalUnits, pos],
        ]}
        color={color}
        weight={weight}
        opacity={opacity}
        interactive={false}
      />
    );
  }
  return <>{lines}</>;
});
PUBGGrid.displayName = "PUBGGrid";

interface MapInteractionProps {
  activeMode: "none" | "mortar" | "flight" | "report" | "simulate";
  setMortarPoints: React.Dispatch<React.SetStateAction<L.LatLng[]>>;
  setFlightPoints: React.Dispatch<React.SetStateAction<L.LatLng[]>>;
  setIsVehicleFilterOn: React.Dispatch<React.SetStateAction<boolean>>;
  setActiveMode: React.Dispatch<
    React.SetStateAction<"none" | "mortar" | "flight" | "report" | "simulate">
  >;
  setReportLocation: React.Dispatch<React.SetStateAction<L.LatLng | null>>;
}

const MapInteraction = ({
  activeMode,
  setMortarPoints,
  setFlightPoints,
  setIsVehicleFilterOn,
  setActiveMode,
  setReportLocation,
}: MapInteractionProps) => {
  useMapEvents({
    click(e) {
      if (activeMode === "mortar") {
        setMortarPoints((prev) =>
          prev.length >= 2 ? [e.latlng] : [...prev, e.latlng]
        );
      } else if (activeMode === "flight") {
        setFlightPoints((prev) => {
          if (prev.length >= 2) {
            setIsVehicleFilterOn(false);
            return [e.latlng];
          }
          return [...prev, e.latlng];
        });
      } else if (activeMode === "report") {
        setReportLocation(null);
        setTimeout(() => setReportLocation(e.latlng), 10);
      }
    },
    contextmenu(e) {
      e.originalEvent.preventDefault();
      if (activeMode === "mortar") setMortarPoints([]);
      if (activeMode === "flight") {
        setFlightPoints([]);
        setIsVehicleFilterOn(false);
      }
      if (activeMode === "report") {
        setActiveMode("none");
        setReportLocation(null);
      }
    },
  });
  return null;
};

const MapResizer = () => {
  const map = useMap();
  useEffect(() => {
    // Leaflet의 tap 핸들러가 모바일에서 click 이벤트를 삼키는 현상을 방지
    if ((map as any).tap) {
      (map as any).tap.disable();
    }

    const container = map.getContainer();
    const resizeObserver = new ResizeObserver(() => {
      // 컨테이너가 화면에 있고 크기가 유효할 때만 실행 (IndexSizeError 방지)
      if (container.offsetWidth > 0 && container.offsetHeight > 0) {
        map.invalidateSize();
      }
    });
    resizeObserver.observe(container);
    return () => resizeObserver.disconnect();
  }, [map]);
  return null;
};

interface MapViewProps {
  activeMapId: string;
  currentMap: MapTab | undefined;
  bounds: [[number, number], [number, number]];
  icons: Record<string, L.DivIcon>;
  imageHeight: number;
  imageWidth: number;
  activeMode: "none" | "mortar" | "flight" | "report" | "simulate";
  mortarPoints: L.LatLng[];
  flightPoints: L.LatLng[];
  flightPolygonCoords: [number, number][];
  displayedVehicles: MapMarker[];
  isGridOn: boolean;
  mapScale: number;
  setMortarPoints: React.Dispatch<React.SetStateAction<L.LatLng[]>>;
  setFlightPoints: React.Dispatch<React.SetStateAction<L.LatLng[]>>;
  setIsVehicleFilterOn: React.Dispatch<React.SetStateAction<boolean>>;
  setActiveMode: React.Dispatch<
    React.SetStateAction<"none" | "mortar" | "flight" | "report" | "simulate">
  >;
  setReportLocation: React.Dispatch<React.SetStateAction<L.LatLng | null>>;
  reportLocation: L.LatLng | null;
  currentUser: AuthUser | null;
  isAdmin?: boolean;
  pendingVehicles: PendingVehicle[];
  filters: Record<string, boolean>;
  telemetryData?: any;
  isHotDropOn?: boolean;
  isHighPrecision?: boolean;
  simulatorStep?: number;
  simulatorPhases?: L.LatLng[];
  setSimulatorStep?: React.Dispatch<React.SetStateAction<number>>;
  setSimulatorPhases?: React.Dispatch<React.SetStateAction<L.LatLng[]>>;
}





const MapView = memo(
  ({
    activeMapId,
    currentMap,
    bounds,
    icons,
    imageHeight,
    imageWidth,
    activeMode,
    mortarPoints,
    flightPoints,
    flightPolygonCoords,
    displayedVehicles,
    isGridOn,
    mapScale,
    setMortarPoints,
    setFlightPoints,
    setIsVehicleFilterOn,
    setActiveMode,
    setReportLocation,
    reportLocation,
    currentUser,
    isAdmin,
    pendingVehicles,
    filters,
    telemetryData,
    isHotDropOn = false,
    isHighPrecision = false,
    simulatorStep = 0,
    simulatorPhases = [],
    setSimulatorStep,
    setSimulatorPhases,
  }: MapViewProps) => {
    const isActionRunningRef = useRef(false);
    const [heightmapVersion, setHeightmapVersion] = useState(0);
    const [mortarAnalysis, setMortarAnalysis] = useState<MortarAnalysis | null>(null);
    const heightmapDataRef = useRef<{
      canvas: HTMLCanvasElement | null;
      width: number;
      height: number;
      mapId: string;
    } | null>(null);

    useEffect(() => {
      if (typeof window === "undefined") return;

      const mapId = activeMapId;
      // 손상된 PNG를 우회하여 정상 JPG 하이트맵을 모든 맵에서 일관되게 사용
      const imageUrl = `/assets/map/${mapId}_HeightMap.jpg`;
      const supportedMaps = [
        "Erangel", "Miramar", "Vikendi", "Taego", "Deston", "Rondo"
      ];

      if (!supportedMaps.includes(mapId)) {
        heightmapDataRef.current = null;
        return;
      }

      const img = new Image();
      img.crossOrigin = "anonymous";
      img.src = imageUrl;
      img.onload = () => {
        const canvas = document.createElement("canvas");
        canvas.width = img.width;
        canvas.height = img.height;
        const ctx = canvas.getContext("2d");
        if (ctx) {
          ctx.drawImage(img, 0, 0);
          heightmapDataRef.current = {
            canvas,
            width: img.width,
            height: img.height,
            mapId,
          };
          setHeightmapVersion((version) => version + 1);
        }
      };
      img.onerror = () => {
        console.warn(`Failed to load heightmap for ${mapId}`);
        heightmapDataRef.current = null;
        setHeightmapVersion((version) => version + 1);
      };
    }, [activeMapId]);

    useEffect(() => {
      if (activeMode !== "mortar" || mortarPoints.length !== 2) {
        setMortarAnalysis(null);
        return;
      }

      const readElevation = (latlng: L.LatLng): number => {
        const heightData = heightmapDataRef.current;
        if (!heightData || heightData.mapId !== activeMapId || !heightData.canvas) {
          return 0;
        }

        const { canvas, width, height } = heightData;
        const ctx = canvas.getContext("2d");
        if (!ctx) return 0;

        const pxX = Math.round((latlng.lng / 8192) * width);
        const pxY = Math.round((latlng.lat / 8192) * height);
        const clampedX = Math.max(0, Math.min(width - 1, pxX));
        const clampedY = Math.max(0, Math.min(height - 1, pxY));

        try {
          const imgData = ctx.getImageData(clampedX, clampedY, 1, 1).data;
          if (imgData[3] === 0) return 0;
          return (imgData[0] - 128) * 2.048;
        } catch (e) {
          console.error("Failed to read elevation pixel data", e);
          return 0;
        }
      };

      const p1 = mortarPoints[0];
      const p2 = mortarPoints[1];
      const horizontalDistance = Math.round(
        Math.sqrt(
          Math.pow(p1.lat - p2.lat, 2) + Math.pow(p1.lng - p2.lng, 2)
        ) * mapScale
      );
      const rawDeltaH = readElevation(p2) - readElevation(p1);
      const deltaH = rawDeltaH * 0.4;
      const distance3D = Math.round(
        Math.sqrt(Math.pow(horizontalDistance, 2) + Math.pow(rawDeltaH, 2))
      );
      const mortarSetting = Math.round(horizontalDistance + deltaH);

      setMortarAnalysis({
        p1,
        p2,
        horizontalDistance,
        distance3D,
        deltaH,
        mortarSetting,
        isRangeValid: mortarSetting >= 121 && mortarSetting <= 700,
      });
    }, [activeMapId, activeMode, heightmapVersion, mapScale, mortarPoints]);


    const handleCloseReport = () => {
      setReportLocation(null);
      setActiveMode("none");
    };

    const handleVote = async (
      markerId: string | number,
      voteType: "up" | "down"
    ) => {
      if (isActionRunningRef.current) return;
      isActionRunningRef.current = true;

      if (!currentUser) {
        isActionRunningRef.current = false;
        return toast.error("로그인 후 참여 가능합니다.");
      }

      const {
        data: { session },
      } = await supabase.auth.getSession();
      if (!session) {
        isActionRunningRef.current = false;
        return toast.warning("인증 정보가 만료되었습니다. 다시 로그인 해 주세요.");
      }

      try {
        const res = await fetch("/api/report/vote", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${session.access_token}`,
          },
          body: JSON.stringify({ markerId, voteType }),
        });

        const data = await res.json();
        if (!res.ok) throw new Error(data.error || "처리 오류");

        toast.success(`[${voteType === "up" ? "진실" : "거짓"}] 평가 완료!`, {
          description: "2초 후 지도에 반영됩니다.",
        });
        sessionStorage.setItem("showPendingReports", "true");
        setTimeout(() => window.location.reload(), 2000);

        if (data.triggerNotify) {
          fetch("/api/report/notify", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ markerId, type: data.triggerNotify }),
          }).catch(console.error);
        }
      } catch {
        toast.error("투표 결과를 반영하지 못했습니다. 잠시 후 다시 시도해 주세요.");
        isActionRunningRef.current = false;
      }
    };

    const handleAdminAction = async (markerId: string | number, action: "approve" | "reject") => {
      if (isActionRunningRef.current) return;
      isActionRunningRef.current = true;

      if (!currentUser) {
        isActionRunningRef.current = false;
        return toast.error("로그인 후 참여 가능합니다.");
      }

      const { data: { session } } = await supabase.auth.getSession();
      if (!session) {
        isActionRunningRef.current = false;
        return toast.warning("인증 정보가 만료되었습니다. 다시 로그인 해 주세요.");
      }

      try {
        const apiUrl = getApiUrl(`/api/admin/${action}`);
        const res = await fetch(apiUrl, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${session.access_token}`,
          },
          body: JSON.stringify({ id: markerId }),
        });

        const data = await res.json();
        if (!res.ok) throw new Error(data.error || "처리 오류");

        toast.success(`관리자 권한으로 ${action === "approve" ? "승인(데이터베이스 반영)" : "파기(삭제)"} 되었습니다!`);
        sessionStorage.setItem("showPendingReports", "true");
        setTimeout(() => window.location.reload(), 1000);
      } catch {
        toast.error("정보를 처리하지 못했습니다. 잠시 후 다시 시도해 주세요.");
        isActionRunningRef.current = false;
      }
    };

    return (
      <MapContainer
        key={activeMapId}
        center={[imageHeight / 2, imageWidth / 2]}
        zoom={-3}
        minZoom={-5}
        maxZoom={2}
        crs={CRS.Simple}
        maxBounds={[[-2000, -2000], [imageHeight + 2000, imageWidth + 2000]]}
        maxBoundsViscosity={0.5}
        style={{ height: "100%", width: "100%", background: "#0b0f19" }}
        zoomControl={false}
      >
        {/* 🌟 기절 상태 맥박 효과 및 마커 이동 부드럽게 설정 */}
        <style>{`
          @keyframes groggy-pulse {
            0% { transform: scale(1.0); opacity: 0.9; }
            70% { transform: scale(3.5); opacity: 0; }
            100% { transform: scale(1.0); opacity: 0; }
          }
          .groggy-pulse-effect {
            width: 24px;
            height: 24px;
            background: rgba(255, 0, 255, 0.8);
            border-radius: 50%;
            animation: groggy-pulse 1.2s infinite ease-out;
            box-shadow: 0 0 12px rgba(255, 0, 255, 0.7);
          }
          /* 텔레메트리 마커 부드러운 이동을 위한 트랜지션 */
          .leaflet-marker-icon, .leaflet-marker-shadow {
            transition: transform 0.15s linear !important;
          }
          .leaflet-interactive {
            transition: all 0.15s linear !important;
          }
          /* 궤적(Polyline)은 트랜지션 제외 (깜빡임 방지) */
          .leaflet-pane path.leaflet-interactive[stroke-dasharray] {
            transition: none !important;
          }
          /* Leaflet 툴팁 기본 오버라이드 */
          .custom-mortar-tooltip {
            background: transparent !important;
            border: none !important;
            box-shadow: none !important;
            padding: 0 !important;
          }
          .custom-mortar-tooltip::before {
            display: none !important;
          }
        `}</style>
        {currentMap && (
          <TileLayer
            url={`/tiles/${activeMapId}/{z}/{x}/{y}.jpg`}
            minZoom={-5}
            maxZoom={2}
            maxNativeZoom={0}
            zoomOffset={5}
            bounds={bounds}
            noWrap={true}
          />
        )}
        <MapResizer />
        {isGridOn && <PUBGGrid activeMapId={activeMapId} />}
        <MapInteraction
          activeMode={activeMode}
          setMortarPoints={setMortarPoints}
          setFlightPoints={setFlightPoints}
          setIsVehicleFilterOn={setIsVehicleFilterOn}
          setActiveMode={setActiveMode}
          setReportLocation={setReportLocation}
        />

        {activeMode === "report" && reportLocation && (
          <Marker position={reportLocation} icon={reportPlacementIcon}>
            <Popup
              autoClose={false}
              closeButton={false}
              className="custom-report-popup"
              maxWidth={300}
            >
              <ReportForm
                location={reportLocation}
                activeMapId={activeMapId}
                icons={icons}
                currentUser={currentUser}
                onClose={handleCloseReport}
              />
            </Popup>
          </Marker>
        )}

        {displayedVehicles.map((v) => (
          <Marker
            key={v.id}
            position={[v.y, v.x]}
            icon={icons[v.type] || icons["Esports"]}
          >
            <Popup>{v.name}</Popup>
          </Marker>
        ))}

        {/* 🌟 진행 중인 제보 히트맵 표시! */}
        {filters["pending"] &&
          pendingVehicles.map((v) => {
            const weight = v.weight || 1;
            const radius = 15 + weight * 4;
            const color = weight >= 5 ? "#ef4444" : "#f59e0b";
            return (
              <CircleMarker
                key={v.id}
                center={[v.y, v.x]}
                radius={radius}
                color={color}
                fillColor={color}
                fillOpacity={0.4}
                weight={2}
              >
                <Popup>
                  <div style={{ textAlign: "center", minWidth: "160px", padding: "4px" }}>
                    <b style={{ fontSize: "14px", color: "#333", display: "block", marginBottom: "4px" }}>
                      <InlineIconLabel icon="eye" iconSize={14}>제보 확인 중</InlineIconLabel>
                    </b>
                    <span style={{ fontSize: "13px", color: "#666" }}>
                      종류: <b>{v.marker_type}</b>
                    </span>
                    <hr style={{ margin: "8px 0" }} />
                    <div style={{ display: "flex", gap: "8px", justifyContent: "center" }}>
                      <button
                        onClick={() => handleVote(v.id, "up")}
                        title="진실 (추천)"
                        style={{
                          flex: 1, backgroundColor: "#10b981", color: "white",
                          border: "none", borderRadius: "4px", padding: "6px",
                          cursor: "pointer", fontWeight: "bold", fontSize: "12px"
                        }}
                      >
                        <InlineIconLabel icon="check" iconSize={12}>승인</InlineIconLabel>
                      </button>
                      {isAdmin && (
                        <>
                          <button
                            onClick={() => handleAdminAction(v.id, "approve")}
                            style={{
                              flex: 1, backgroundColor: "#3b82f6", color: "white",
                              border: "none", borderRadius: "4px", padding: "4px 0",
                              cursor: "pointer", fontWeight: "bold", fontSize: "11px"
                            }}
                          >
                            <InlineIconLabel icon="check" iconSize={11}>관리자 승인</InlineIconLabel>
                          </button>
                          <button
                            onClick={() => handleAdminAction(v.id, "reject")}
                            style={{
                              flex: 1, backgroundColor: "#d93025", color: "white",
                              border: "none", borderRadius: "4px", padding: "4px 0",
                              cursor: "pointer", fontWeight: "bold", fontSize: "11px"
                            }}
                          >
                            <InlineIconLabel icon="delete" iconSize={11}>관리자 파기</InlineIconLabel>
                          </button>
                        </>
                      )}
                    </div>
                  </div>
                </Popup>
              </CircleMarker>
            );
          })}

        {activeMode === "mortar" && mortarPoints.length > 0 && (
          <>
            {mortarPoints.map((p, i) => (
              <Marker
                key={i}
                position={p}
                icon={i === 0 ? mortarStartIcon : mortarEndIcon}
              />
            ))}
            {mortarAnalysis && (
                <>
                  <Polyline
                    positions={mortarPoints.map((p) => [p.lat, p.lng])}
                    color="#ea4335"
                    weight={3}
                    dashArray="8, 8"
                    interactive={false}
                  />
                  <Marker
                    position={[
                      (mortarAnalysis.p1.lat + mortarAnalysis.p2.lat) / 2,
                      (mortarAnalysis.p1.lng + mortarAnalysis.p2.lng) / 2,
                    ]}
                    icon={emptyIcon}
                    interactive={false}
                  >
                    <Tooltip permanent direction="center" opacity={0.98} className="custom-mortar-tooltip">
                      <div className="bg-slate-900/95 backdrop-blur-sm text-slate-100 p-3 rounded-xl border border-slate-700/50 shadow-2xl text-left min-w-[155px] font-sans flex flex-col gap-1.5">
                        <div className="text-[10px] text-slate-400 font-bold tracking-wider uppercase">박격포 포격 분석</div>
                        <div className="h-[1px] bg-slate-700/50 my-0.5" />
                        <div className="flex justify-between items-center gap-4">
                          <span className="text-xs text-slate-400">수평 거리</span>
                          <span className="text-sm font-semibold text-slate-200">{mortarAnalysis.horizontalDistance}m</span>
                        </div>
                        <div className="flex justify-between items-center gap-4">
                          <span className="text-xs text-slate-400">3D 실제 거리</span>
                          <span className="text-sm font-semibold text-slate-200">{mortarAnalysis.distance3D}m</span>
                        </div>
                        <div className="flex justify-between items-center gap-4">
                          <span className="text-xs text-slate-400">고도 차이</span>
                          <span className={`text-sm font-semibold ${mortarAnalysis.deltaH > 0 ? "text-emerald-400" : mortarAnalysis.deltaH < 0 ? "text-sky-400" : "text-slate-200"}`}>
                            {mortarAnalysis.deltaH > 0 ? "+" : ""}{Math.round(mortarAnalysis.deltaH)}m
                          </span>
                        </div>
                        <div className="h-[1px] bg-slate-700/50 my-0.5" />
                        <div className="flex justify-between items-center gap-4">
                          <span className="text-xs text-slate-400 font-bold">조준 거리</span>
                          <span className="text-base font-extrabold text-red-500">
                            {mortarAnalysis.isRangeValid ? `${mortarAnalysis.mortarSetting}m` : "도달 불가"}
                          </span>
                        </div>
                      </div>
                    </Tooltip>
                  </Marker>
                </>
            )}
          </>
        )}

        {activeMode === "flight" && flightPoints.length > 0 && (
          <>
            {flightPoints.map((p, i) => (
              <Marker key={i} position={p} icon={flightPointIcon} />
            ))}
            {flightPoints.length === 2 && flightPolygonCoords.length > 0 && (
              <>
                <Polygon
                  positions={flightPolygonCoords}
                  color="#3b82f6"
                  fillColor="#3b82f6"
                  fillOpacity={0.15}
                  weight={1}
                  interactive={false}
                />
                <Polyline
                  positions={flightPoints.map((p) => [p.lat, p.lng])}
                  color="#ffffff"
                  weight={4}
                  dashArray="10, 10"
                  interactive={false}
                />
              </>
            )}
          </>
        )}

        {/* 🚀 텔레메트리 관련 렌더링 (기존 ZoneRenderer 복구 및 캔버스 레이어) 🚀 */}
        {telemetryData && (
          <>
            <ZoneRenderer 
              telemetryData={telemetryData} 
              showZones={telemetryData.showZone} 
            />
            <TelemetryCanvasLayer 
              telemetryData={telemetryData} 
              showZones={telemetryData.showZone}
              isHighPrecision={isHighPrecision}
            />
          </>
        )}

        {/* 🔥 핫드랍 히트맵 레이어 */}
        <HotDropLayer mapName={activeMapId} visible={isHotDropOn} />

        {/* 🎲 시뮬레이터 레이어 */}
        <SimulatorLayer 
          activeMode={activeMode} 
          mapScale={mapScale} 
          activeMapId={activeMapId}
          currentStep={simulatorStep}
          simulatorPhases={simulatorPhases}
          setSimulatorPhases={setSimulatorPhases}
          setSimulatorStep={setSimulatorStep}
          flightPoints={flightPoints}
          setFlightPoints={setFlightPoints}
        />

      </MapContainer>
    );
  }
);

MapView.displayName = "MapView";
export default MapView;
