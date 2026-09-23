"use client";

import { useEffect, useState } from "react";
import { CircleMarker, MapContainer, Polyline, TileLayer, Tooltip, useMap } from "react-leaflet";
import { CRS } from "leaflet";
import "leaflet/dist/leaflet.css";
import { toCalibratedCoords } from "@/utils/coordinate";

export type RoutePoint = { timeSeconds: number; x: number; y: number; place: string | null; spreadMeters: number;
  players: { name: string; x: number; y: number }[] };

const MAP_IDS: Record<string, string> = {
  "에란겔": "Erangel", "미라마": "Miramar", "태이고": "Taego", "론도": "Rondo",
  "비켄디": "Vikendi", "데스턴": "Deston", "사녹": "Sanhok", "카라킨": "Karakin",
  "파라모": "Paramo", "헤이븐": "Haven",
};
const timeLabel = (seconds: number) => {
  const whole = Math.round(seconds);
  return `${Math.floor(whole / 60).toString().padStart(2, "0")}:${(whole % 60).toString().padStart(2, "0")}`;
};

function Focus({ point, mapName }: { point: RoutePoint; mapName: string }) {
  const map = useMap();
  useEffect(() => { map.setView(toCalibratedCoords(point.x, point.y, mapName), Math.max(map.getZoom(), -1), { animate: true }); }, [map, point, mapName]);
  return null;
}

export default function DailyRouteMap({ route, mapName, nickname }: { route: RoutePoint[]; mapName: string; nickname: string }) {
  const [selectedIndex, setSelectedIndex] = useState(0);
  const point = route[selectedIndex] ?? route[0];
  const mapId = MAP_IDS[mapName] ?? Object.values(MAP_IDS).find((id) => id.toLowerCase() === mapName.toLowerCase());
  if (!point || !mapId) return <p className="text-sm text-zinc-400">이 맵의 위치 지도를 표시할 수 없습니다.</p>;
  const path = route.map((sample) => toCalibratedCoords(sample.x, sample.y, mapName));
  return <div className="min-w-0">
    <div className="h-[280px] overflow-hidden rounded-xl border border-zinc-700 sm:h-[380px]">
      <MapContainer center={toCalibratedCoords(point.x, point.y, mapName)} zoom={-1} minZoom={-5} maxZoom={2}
        crs={CRS.Simple} scrollWheelZoom={false} attributionControl={false} className="h-full w-full bg-zinc-950">
        <TileLayer url={`/tiles/${mapId}/{z}/{x}/{y}.jpg`} minZoom={-5} maxZoom={2} maxNativeZoom={0} zoomOffset={5}
          noWrap bounds={[[0, 0], [8192, 8192]]} />
        <Focus point={point} mapName={mapName} />
        <Polyline positions={path} pathOptions={{ color: "#fbbf24", weight: 2, opacity: 0.8, dashArray: "5 5" }} />
        {point.players.map((player) => <CircleMarker key={player.name} center={toCalibratedCoords(player.x, player.y, mapName)}
          radius={player.name === nickname ? 5 : 4}
          pathOptions={{ color: "#0f172a", weight: 1, fillColor: player.name === nickname ? "#34d399" : "#38bdf8", fillOpacity: 1 }}>
          <Tooltip direction="top">{player.name}</Tooltip>
        </CircleMarker>)}
      </MapContainer>
    </div>
    <p className="mt-2 text-xs leading-5 text-zinc-400">노란 점선은 간헐적으로 기록된 대상 선수의 위치를 잇습니다. 실제 이동 경로가 아닙니다. 초록 점은 대상, 파란 점은 팀원입니다. 확대·축소할 수 있습니다.</p>
    <div className="mt-3 flex gap-2 overflow-x-auto pb-2" aria-label="위치 관측 시점 선택">
      {route.map((sample, index) => <button key={`${sample.timeSeconds}-${index}`} type="button" onClick={() => setSelectedIndex(index)}
        aria-pressed={selectedIndex === index} className={`min-h-11 shrink-0 rounded-lg border px-3 text-xs font-semibold ${selectedIndex === index ? "border-emerald-400 bg-emerald-400/15 text-emerald-200" : "border-zinc-700 text-zinc-300"}`}>
        {timeLabel(sample.timeSeconds)}
      </button>)}
    </div>
    <p className="mt-1 text-sm text-zinc-300">{timeLabel(point.timeSeconds)} · {point.place ?? "지역명 미기록"} · 팀 {point.players.length}명 위치 확인{point.players.length > 1 ? ` · 대상과 최대 약 ${Math.round(point.spreadMeters)}m` : ""}</p>
  </div>;
}
