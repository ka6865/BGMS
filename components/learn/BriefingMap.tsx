"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { Minus, Plus, RotateCcw } from "lucide-react";
import type { RankerScene } from "@/lib/learn/lessons";

type Snapshot = NonNullable<RankerScene["mapSnapshot"]>;

function mapY(y: number) {
  return y;
}

export default function BriefingMap({ snapshot, mapId }: { snapshot: Snapshot; mapId: string }) {
  const svgRef = useRef<SVGSVGElement>(null);
  const drag = useRef<{ x: number; y: number; viewX: number; viewY: number } | null>(null);
  const [view, setView] = useState({ x: 0, y: 0, size: snapshot.viewSize });
  const initial = { x: 0, y: 0, size: snapshot.viewSize };
  const points = [...snapshot.path, ...(snapshot.kills ?? [])];
  const xs = points.map((point) => point.x);
  const ys = points.map((point) => mapY(point.y));
  const centerX = (Math.min(...xs) + Math.max(...xs)) / 2;
  const centerY = (Math.min(...ys) + Math.max(...ys)) / 2;
  const minX = centerX - snapshot.viewSize / 2;
  const maxX = centerX + snapshot.viewSize / 2;
  const minY = centerY - snapshot.viewSize / 2;
  const maxY = centerY + snapshot.viewSize / 2;
  const tileZoom = snapshot.viewSize >= 3500 ? 2 : 3;
  const tileWorldSize = 8192 / 2 ** tileZoom;
  const minTileX = Math.max(0, Math.floor(minX / tileWorldSize));
  const maxTileX = Math.min(2 ** tileZoom - 1, Math.floor((maxX - 1) / tileWorldSize));
  const minTileY = Math.max(-(2 ** tileZoom), Math.floor((minY - 8192) / tileWorldSize));
  const maxTileY = Math.min(-1, Math.floor((maxY - 8193) / tileWorldSize));
  const tiles = [];
  for (let y = minTileY; y <= maxTileY; y += 1) {
    for (let x = minTileX; x <= maxTileX; x += 1) tiles.push({ x, y });
  }
  const currentMinX = centerX - view.size / 2 + view.x;
  const currentMinY = centerY - view.size / 2 + view.y;
  const viewBox = `${currentMinX} ${currentMinY} ${view.size} ${view.size}`;
  const path = snapshot.path.map((point) => `${point.x},${mapY(point.y)}`).join(" ");
  const start = snapshot.path[0];
  const current = snapshot.path.at(-1);
  const moved = start && current && (start.x !== current.x || start.y !== current.y);
  const playerMarkerRadius = view.size * 0.008;
  const killMarkerRadius = view.size * 0.009;
  const markerStroke = view.size * 0.003;

  const zoom = useCallback((factor: number, clientX?: number, clientY?: number) => {
    const rect = svgRef.current?.getBoundingClientRect();
    if (!rect) return;
    const px = clientX === undefined ? rect.width / 2 : clientX - rect.left;
    const py = clientY === undefined ? rect.height / 2 : clientY - rect.top;
    setView((current) => {
      const nextSize = Math.max(snapshot.viewSize / 5, Math.min(snapshot.viewSize, current.size * factor));
      if (nextSize === current.size) return current;
      const minX = centerX - current.size / 2 + current.x;
      const minY = centerY - current.size / 2 + current.y;
      const anchorX = minX + (px / rect.width) * current.size;
      const anchorY = minY + (py / rect.height) * current.size;
      const x = anchorX - (px / rect.width) * nextSize - (centerX - nextSize / 2);
      const y = anchorY - (py / rect.height) * nextSize - (centerY - nextSize / 2);
      return { x, y, size: nextSize };
    });
  }, [centerX, centerY, snapshot.viewSize]);

  useEffect(() => {
    const svg = svgRef.current;
    if (!svg) return;
    const handleWheel = (event: WheelEvent) => {
      event.preventDefault();
      zoom(event.deltaY < 0 ? 0.8 : 1.25, event.clientX, event.clientY);
    };
    svg.addEventListener("wheel", handleWheel, { passive: false });
    return () => svg.removeEventListener("wheel", handleWheel);
  }, [zoom]);

  function pan(clientX: number, clientY: number) {
    if (!drag.current || !svgRef.current) return;
    const rect = svgRef.current.getBoundingClientRect();
    const x = drag.current.viewX - ((clientX - drag.current.x) / rect.width) * view.size;
    const y = drag.current.viewY - ((clientY - drag.current.y) / rect.height) * view.size;
    const maxOffset = (snapshot.viewSize - view.size) / 2;
    setView({ ...view, x: Math.max(-maxOffset, Math.min(maxOffset, x)), y: Math.max(-maxOffset, Math.min(maxOffset, y)) });
  }

  return (
    <div className="relative aspect-square overflow-hidden rounded-xl border border-zinc-700 bg-[#111827]">
      <svg
        ref={svgRef}
        viewBox={viewBox}
        role="img"
        aria-label={`${mapId} 지도에 표시한 경기 위치와 이동 경로. 확대 후 드래그해 이동할 수 있습니다.`}
        className="h-full w-full cursor-grab touch-none active:cursor-grabbing"
        onPointerDown={(event) => { drag.current = { x: event.clientX, y: event.clientY, viewX: view.x, viewY: view.y }; event.currentTarget.setPointerCapture(event.pointerId); }}
        onPointerMove={(event) => pan(event.clientX, event.clientY)}
        onPointerUp={() => { drag.current = null; }}
        onPointerCancel={() => { drag.current = null; }}
      >
        {tiles.map((tile) => (
          <image
            key={`${tile.x}-${tile.y}`}
            href={`/tiles/${mapId}/${tileZoom}/${tile.x}/${tile.y}.jpg`}
            x={tile.x * tileWorldSize}
            y={8192 + tile.y * tileWorldSize}
            width={tileWorldSize}
            height={tileWorldSize}
          />
        ))}
        {snapshot.zone && (
          <circle cx={snapshot.zone.x} cy={mapY(snapshot.zone.y)} r={snapshot.zone.radius} fill="#facc15" fillOpacity="0.07" stroke="#facc15" strokeWidth={view.size * 0.004} strokeDasharray={`${view.size * 0.05} ${view.size * 0.035}`} />
        )}
        {snapshot.path.length > 1 && <polyline points={path} fill="none" stroke="#34d399" strokeWidth={view.size * 0.005} strokeDasharray={`${view.size * 0.015} ${view.size * 0.012}`} strokeLinecap="round" strokeLinejoin="round" opacity="0.95" />}
        {start && <circle cx={start.x} cy={mapY(start.y)} r={playerMarkerRadius} fill="#34d399" stroke="white" strokeWidth={markerStroke} />}
        {moved && current && <circle cx={current.x} cy={mapY(current.y)} r={playerMarkerRadius} fill="#34d399" stroke="white" strokeWidth={markerStroke} />}
        {snapshot.kills?.map((kill, index) => (
          <circle key={`${kill.x}-${kill.y}-${index}`} cx={kill.x} cy={mapY(kill.y)} r={killMarkerRadius} fill="#fb7185" stroke="white" strokeWidth={markerStroke}>
            {kill.label && <title>{kill.label}</title>}
          </circle>
        ))}
        {snapshot.marks?.map((mark, index) => (
          <g key={`${mark.label}-${index}`}>
            <circle cx={mark.x} cy={mapY(mark.y)} r={playerMarkerRadius * 0.8} fill={mark.kind === "throw" ? "#fb923c" : mark.kind === "teammate" ? "#22d3ee" : "#60a5fa"} stroke="white" strokeWidth={markerStroke} />
            <title>{mark.label}</title>
          </g>
        ))}
      </svg>
      <div className="absolute right-2 top-2 flex overflow-hidden rounded-lg border border-zinc-700 bg-zinc-950/90 shadow-lg" aria-label="지도 확대 도구">
        <button type="button" onClick={() => zoom(0.75)} aria-label="지도 확대" className="grid size-10 place-items-center text-zinc-200 hover:bg-zinc-800"><Plus size={17} /></button>
        <button type="button" onClick={() => zoom(1.33)} aria-label="지도 축소" className="grid size-10 place-items-center border-l border-zinc-700 text-zinc-200 hover:bg-zinc-800"><Minus size={17} /></button>
        <button type="button" onClick={() => setView(initial)} aria-label="지도 보기 초기화" className="grid size-10 place-items-center border-l border-zinc-700 text-zinc-200 hover:bg-zinc-800"><RotateCcw size={15} /></button>
      </div>
      <div className="pointer-events-none absolute bottom-2 left-2 flex flex-wrap gap-2 rounded-lg bg-zinc-950/85 px-2.5 py-1.5 text-[10px] font-medium text-zinc-200">
        <span><i className="mr-1 inline-block h-2 w-2 rounded-full bg-emerald-400" />{snapshot.playerLabel ?? "선수 위치"}</span>
        {snapshot.zone && <span><i className="mr-1 inline-block h-2 w-2 rounded-full bg-yellow-400" />관측된 원</span>}
        {!!snapshot.kills?.length && <span><i className="mr-1 inline-block h-2 w-2 rounded-full bg-rose-400" />사망 위치</span>}
        {snapshot.marks?.some((mark) => mark.kind === "teammate") && <span><i className="mr-1 inline-block h-2 w-2 rounded-full bg-cyan-400" />팀원 위치</span>}
        {snapshot.marks?.some((mark) => mark.kind === "throw") && <span><i className="mr-1 inline-block h-2 w-2 rounded-full bg-orange-400" />투척 위치</span>}
        {snapshot.marks?.some((mark) => mark.kind === "opponent") && <span><i className="mr-1 inline-block h-2 w-2 rounded-full bg-blue-400" />상대 위치</span>}
      </div>
    </div>
  );
}
