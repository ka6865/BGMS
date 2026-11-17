"use client";

import { useEffect, useRef, useState } from "react";
import { MapContainer, TileLayer, CircleMarker, Tooltip, useMap, useMapEvents } from "react-leaflet";
import { CRS, DomEvent } from "leaflet";
import { Expand, Minus, Plus } from "lucide-react";
import "leaflet/dist/leaflet.css";
import { CATEGORIES, MAP_BOUNDS, tileCropRight, worldToMap, type Landmark } from "@/lib/gta6/map";
import styles from "./gta6.module.css";

const overviewBounds: [[number, number], [number, number]] = [worldToMap([-11000, -9000]), worldToMap([3500, 10000])];

function MapControls({ selected }: { selected: Landmark | null }) {
  const map = useMap();
  const controls = useRef<HTMLDivElement>(null);
  useEffect(() => {
    map.fitBounds(overviewBounds, { padding: [12, 12], animate: false });
    if (controls.current) {
      DomEvent.disableClickPropagation(controls.current);
      DomEvent.disableScrollPropagation(controls.current);
    }
  }, [map]);
  useEffect(() => {
    if (selected) map.setView(worldToMap(selected.coordinates), Math.max(map.getZoom(), -1), { animate: false });
  }, [map, selected]);
  useEffect(() => {
    const observer = new ResizeObserver(() => map.invalidateSize({ pan: false }));
    observer.observe(map.getContainer());
    return () => observer.disconnect();
  }, [map]);
  return <div ref={controls} className={styles.controls} role="group" aria-label="지도 조작">
    <button type="button" onClick={() => map.zoomIn()} aria-label="지도 확대" title="확대"><Plus size={19} /></button>
    <button type="button" onClick={() => map.zoomOut()} aria-label="지도 축소" title="축소"><Minus size={19} /></button>
    <button type="button" onClick={() => map.fitBounds(overviewBounds, { padding: [16, 16] })} aria-label="전체 지도 보기" title="전체 지도"><Expand size={18} /></button>
  </div>;
}

function PlaceMarkers({ places, selected, visited, onSelect }: {
  places: Landmark[]; selected: Landmark | null; visited: Set<string>; onSelect: (id: string) => void;
}) {
  const [zoom, setZoom] = useState(-4);
  const map = useMapEvents({ zoomend: () => setZoom(map.getZoom()) });
  return <>
    {places.filter(place => place.id !== selected?.id && (zoom >= -4 || !place.name.startsWith("이름 미확인"))).map(place => <CircleMarker key={place.id} center={worldToMap(place.coordinates)}
      radius={zoom < -5 ? 1.5 : zoom < -3 ? 2.5 : 4} pathOptions={{ color: "#27272a", weight: 1, fillColor: CATEGORIES[place.category].color, fillOpacity: visited.has(place.id) ? 0.35 : 0.9 }}
      eventHandlers={{ click: () => onSelect(place.id) }}>
      <Tooltip direction="top">{place.name} · {place.id}</Tooltip>
    </CircleMarker>)}
    {selected && <CircleMarker center={worldToMap(selected.coordinates)} radius={9}
      pathOptions={{ color: "#18181b", weight: 3, fillColor: "#fcd34d", fillOpacity: 1 }}>
      <Tooltip direction="top" permanent>{selected.name}</Tooltip>
    </CircleMarker>}
    {zoom < -4 && <p className="pointer-events-none absolute bottom-6 left-3 z-[500] max-w-[calc(100%-80px)] rounded bg-zinc-950/90 px-2 py-1 text-[10px] leading-relaxed text-zinc-200">이름이 있는 장소만 표시 · 확대하면 전체 표시</p>}
  </>;
}

export default function GtaMap({ places, selected, visited, onSelect }: {
  places: Landmark[]; selected: Landmark | null; visited: Set<string>; onSelect: (id: string) => void;
}) {
  const [tileError, setTileError] = useState(false);
  const [attempt, setAttempt] = useState(0);
  return <div className={`${styles.map} relative h-full w-full`} data-testid="gta6-map">
    <MapContainer center={worldToMap([-4000, 2000])} zoom={-4} minZoom={-7} maxZoom={2} zoomSnap={0.25}
      crs={CRS.Simple} maxBounds={MAP_BOUNDS} maxBoundsViscosity={0.8} preferCanvas zoomControl={false}
      style={{ height: "100%", width: "100%", background: "#2c66a5" }}>
      <TileLayer key={attempt} url="/gta6/tiles/yanis-17/{z}/{z},{y},{x}.jpg" bounds={MAP_BOUNDS}
        minZoom={-7} maxZoom={2} minNativeZoom={-5} maxNativeZoom={0} zoomOffset={5} noWrap
        attribution='<a href="https://github.com/rolux/gtadb.org" target="_blank" rel="noreferrer">gtadb.org and all contributors</a> · <a href="https://creativecommons.org/licenses/by/4.0/" target="_blank" rel="noreferrer">CC BY 4.0</a>'
        eventHandlers={{
          tileloadstart: ({ tile, coords }) => { tile.style.clipPath = `inset(0 ${tileCropRight(coords.x, coords.z)}px 0 0)`; },
          tileerror: () => setTileError(true),
        }} />
      <PlaceMarkers places={places} selected={selected} visited={visited} onSelect={onSelect} />
      <MapControls selected={selected} />
    </MapContainer>
    <p className="pointer-events-none absolute left-3 top-3 z-[500] rounded-md bg-zinc-950/90 px-3 py-2 text-xs font-medium text-zinc-100">YANIS v17 <span className="ml-2 text-zinc-300">커뮤니티 추정 지도</span></p>
    {tileError && <div role="alert" className="absolute bottom-8 left-3 right-16 z-[500] rounded-lg bg-zinc-950 p-3 text-xs leading-relaxed text-zinc-100">
      일부 지도를 불러오지 못했습니다.
      <button type="button" className="ml-2 min-h-11 px-2 font-semibold text-amber-300 underline" onClick={() => { setTileError(false); setAttempt(a => a + 1); }}>다시 불러오기</button>
    </div>}
  </div>;
}
