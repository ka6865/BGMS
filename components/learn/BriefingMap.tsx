"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { Minus, Plus, RotateCcw } from "lucide-react";
import type { DailyScene } from "@/lib/learn/dailyScenes";
import { formatLessonTime } from "@/lib/learn/lessons";

type Snapshot = NonNullable<DailyScene["mapSnapshot"]> & {
  blueZone?: { x: number; y: number; radius: number; observedSeconds: number; sourceIndex: number;
    status: "waiting" | "shrinking" | "complete" | "unknown"; countdownSeconds?: number; phase?: number };
};

function mapY(y: number) {
  return y;
}

export default function BriefingMap({ snapshot, mapId }: { snapshot: Snapshot; mapId: string }) {
  const svgRef = useRef<SVGSVGElement>(null);
  const drag = useRef<{ x: number; y: number; viewX: number; viewY: number } | null>(null);
  const [tileLoadFailed, setTileLoadFailed] = useState(false);
  const [svgWidth, setSvgWidth] = useState(500);
  useEffect(() => {
    const svg = svgRef.current;
    if (!svg) return;
    const updateWidth = () => {
      const width = svg.getBoundingClientRect().width;
      if (width > 0) setSvgWidth(width);
    };
    updateWidth();
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(updateWidth);
    observer.observe(svg);
    return () => observer.disconnect();
  }, []);
  const blueZone = snapshot.blueZone && Number.isFinite(snapshot.blueZone.x) && Number.isFinite(snapshot.blueZone.y)
    && Number.isFinite(snapshot.blueZone.radius) && snapshot.blueZone.radius > 0 ? snapshot.blueZone : undefined;
  const localPoints = [...snapshot.path, ...(snapshot.kills ?? []), ...(snapshot.zone ? [snapshot.zone] : [])];
  const points = [...localPoints,
    ...(blueZone ? [
      { x: Math.max(0, blueZone.x - blueZone.radius), y: Math.max(0, blueZone.y - blueZone.radius) },
      { x: Math.min(8192, blueZone.x + blueZone.radius), y: Math.min(8192, blueZone.y + blueZone.radius) },
    ] : [])];
  const localXs = localPoints.map((point) => point.x);
  const localYs = localPoints.map((point) => mapY(point.y));
  const centerX = (Math.min(...localXs) + Math.max(...localXs)) / 2;
  const centerY = (Math.min(...localYs) + Math.max(...localYs)) / 2;
  const localSize = Math.max(snapshot.viewSize, (Math.max(...localXs) - Math.min(...localXs)) * 1.1, (Math.max(...localYs) - Math.min(...localYs)) * 1.1);
  const minMapSize = 32;
  const focusPoints = [...snapshot.path, ...(snapshot.kills ?? []), ...(snapshot.marks ?? [])];
  const focusXs = (focusPoints.length ? focusPoints : localPoints).map(({ x }) => x);
  const focusYs = (focusPoints.length ? focusPoints : localPoints).map(({ y }) => mapY(y));
  const focusCenterX = (Math.min(...focusXs) + Math.max(...focusXs)) / 2;
  const focusCenterY = (Math.min(...focusYs) + Math.max(...focusYs)) / 2;
  const xs = points.map((point) => point.x);
  const ys = points.map((point) => mapY(point.y));
  const fullCenterX = (Math.min(...xs) + Math.max(...xs)) / 2;
  const fullCenterY = (Math.min(...ys) + Math.max(...ys)) / 2;
  const requiredSize = Math.max(snapshot.viewSize, (Math.max(...xs) - Math.min(...xs)) * 1.1, (Math.max(...ys) - Math.min(...ys)) * 1.1);
  const maxMapSize = blueZone ? Math.min(8192, requiredSize) : requiredSize;
  const focusSize = Math.min(maxMapSize, Math.max(64,
    (Math.max(...focusXs) - Math.min(...focusXs)) * 1.5,
    (Math.max(...focusYs) - Math.min(...focusYs)) * 1.5));
  const [view, setView] = useState({ x: 0, y: 0, size: localSize });
  const initial = { x: 0, y: 0, size: localSize };
  const currentMinX = centerX - view.size / 2 + view.x;
  const currentMinY = centerY - view.size / 2 + view.y;
  const viewBox = `${currentMinX} ${currentMinY} ${view.size} ${view.size}`;
  const minX = currentMinX;
  const maxX = currentMinX + view.size;
  const minY = currentMinY;
  const maxY = currentMinY + view.size;
  const tileZoom = view.size >= 3500 ? 2 : view.size >= 1500 ? 3 : view.size >= 600 ? 4 : 5;
  const tileWorldSize = 8192 / 2 ** tileZoom;
  const minTileX = Math.max(0, Math.floor(minX / tileWorldSize));
  const maxTileX = Math.min(2 ** tileZoom - 1, Math.floor((maxX - 1) / tileWorldSize));
  const minTileY = Math.max(-(2 ** tileZoom), Math.floor((minY - 8192) / tileWorldSize));
  const maxTileY = Math.min(-1, Math.floor((maxY - 8193) / tileWorldSize));
  useEffect(() => {
    // SVG image errors are not consistently emitted by browsers; check the same cached URLs with HTML images.
    const checks: HTMLImageElement[] = [];
    for (let y = minTileY; y <= maxTileY; y++) {
      for (let x = minTileX; x <= maxTileX; x++) {
        const check = new Image();
        check.onerror = () => setTileLoadFailed(true);
        check.src = `/tiles/${mapId}/${tileZoom}/${x}/${y}.jpg`;
        checks.push(check);
      }
    }
    return () => { checks.forEach(check => { check.onerror = null; }); };
  }, [mapId, tileZoom, minTileX, maxTileX, minTileY, maxTileY]);
  const tiles = [];
  for (let y = minTileY; y <= maxTileY; y += 1) {
    for (let x = minTileX; x <= maxTileX; x += 1) tiles.push({ x, y });
  }
  const fullOffsetX = fullCenterX - centerX;
  const fullOffsetY = fullCenterY - centerY;
  const showingWholeZone = Boolean(blueZone && view.size === maxMapSize && view.x === fullOffsetX && view.y === fullOffsetY);
  const pathSegments = snapshot.pathSegments ?? [snapshot.path];
  const start = snapshot.path[0];
  const current = snapshot.path.at(-1);
  const moved = start && current && (start.x !== current.x || start.y !== current.y);
  const playerMarkerRadius = view.size * 0.008;
  const killMarkerRadius = view.size * 0.009;
  const markerStroke = view.size * 0.003;
  const routeArrows = pathSegments.flatMap((segment) => segment.slice(1).flatMap((point, index) => {
    const previous = segment[index];
    const dx = point.x - previous.x;
    const dy = mapY(point.y) - mapY(previous.y);
    if (Math.hypot(dx, dy) < view.size * 0.055) return [];
    return [{ x: (point.x + previous.x) / 2, y: (mapY(point.y) + mapY(previous.y)) / 2, angle: Math.atan2(dy, dx) * 180 / Math.PI }];
  }));
  const arrowSize = view.size * 0.025;
  const labelFontSize = view.size * 12 / svgWidth;
  const labelStroke = labelFontSize * 0.06;
  const playerMarks = (snapshot.marks ?? []).filter((mark) => mark.kind !== "throw");
  const labelFor = (label: string) => label.match(/(?:^|\s)(본인|팀원\s+\d+|상대\s+\d+)(?:\s|$)/)?.[1] ?? label;
  const labelWidth = (label: string) => Math.max(labelFontSize * 3, label.length * labelFontSize + labelFontSize * 0.8);
  const primaryMarkIndices = new Set(playerMarks.flatMap((mark, index) =>
    playerMarks.findLastIndex((candidate) => labelFor(candidate.label) === labelFor(mark.label)) === index ? [index] : []));
  const captions = [
    ...(start ? [{ key: "start", x: start.x, y: mapY(start.y), text: "본인 시작", color: "#34d399" }] : []),
    ...(moved && current ? [{ key: "end", x: current.x, y: mapY(current.y), text: "본인 마지막", color: "#c084fc" }] : []),
    ...playerMarks.flatMap((mark, index) => primaryMarkIndices.has(index)
      ? [{ key: `mark-${index}`, x: mark.x, y: mapY(mark.y), text: labelFor(mark.label), color: mark.kind === "teammate" ? "#22d3ee" : "#fb526b" }]
      : []),
  ].filter((caption) => caption.x >= currentMinX && caption.x <= currentMinX + view.size
    && caption.y >= currentMinY && caption.y <= currentMinY + view.size);
  const captionLayouts = new Map<string, { x: number; y: number; width: number; leaderX: number; leaderY: number }>();
  const occupiedCaptions: { x: number; y: number; width: number; height: number }[] = [];
  // ponytail: quadratic caption placement is bounded by scene markers; use a spatial index only if scenes grow large.
  for (const caption of captions) {
    const width = labelWidth(caption.text);
    const height = labelFontSize * 1.45;
    const gap = labelFontSize * 0.25;
    let chosen: { x: number; y: number } | undefined;
    for (let row = 0; row < captions.length + 2 && !chosen; row++) {
      for (const side of [1, -1]) {
        for (const vertical of [-1, 1]) {
          const rawX = caption.x + side * (playerMarkerRadius + gap) - (side < 0 ? width : 0);
          const rawY = caption.y + vertical * (playerMarkerRadius + gap + row * (height + gap)) - (vertical < 0 ? height : 0);
          const x = Math.max(currentMinX, Math.min(currentMinX + view.size - width, rawX));
          const y = Math.max(currentMinY, Math.min(currentMinY + view.size - height, rawY));
          if (!occupiedCaptions.some((other) => x < other.x + other.width + gap && x + width + gap > other.x
            && y < other.y + other.height + gap && y + height + gap > other.y)) {
            chosen = { x, y };
            break;
          }
        }
        if (chosen) break;
      }
    }
    chosen ??= {
      x: Math.max(currentMinX, Math.min(currentMinX + view.size - width, caption.x + gap)),
      y: Math.max(currentMinY, Math.min(currentMinY + view.size - height, caption.y - height - gap)),
    };
    occupiedCaptions.push({ ...chosen, width, height });
    captionLayouts.set(caption.key, {
      ...chosen, width,
      leaderX: Math.max(chosen.x, Math.min(caption.x, chosen.x + width)),
      leaderY: Math.max(chosen.y, Math.min(caption.y, chosen.y + height)),
    });
  }
  const startCaption = captionLayouts.get("start");
  const endCaption = captionLayouts.get("end");

  const zoom = useCallback((factor: number, clientX?: number, clientY?: number) => {
    const rect = svgRef.current?.getBoundingClientRect();
    if (!rect) return;
    const px = clientX === undefined ? rect.width / 2 : clientX - rect.left;
    const py = clientY === undefined ? rect.height / 2 : clientY - rect.top;
    setView((current) => {
      const nextSize = Math.max(minMapSize, Math.min(maxMapSize, current.size * factor));
      if (nextSize === current.size) return current;
      const minX = centerX - current.size / 2 + current.x;
      const minY = centerY - current.size / 2 + current.y;
      const anchorX = minX + (px / rect.width) * current.size;
      const anchorY = minY + (py / rect.height) * current.size;
      const x = anchorX - (px / rect.width) * nextSize - (centerX - nextSize / 2);
      const y = anchorY - (py / rect.height) * nextSize - (centerY - nextSize / 2);
      return { x, y, size: nextSize };
    });
  }, [centerX, centerY, minMapSize, maxMapSize]);

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
    setView({ ...view,
      x: Math.max(view.size / 2 - centerX, Math.min(8192 - view.size / 2 - centerX, x)),
      y: Math.max(view.size / 2 - centerY, Math.min(8192 - view.size / 2 - centerY, y)),
    });
  }

  return (
    <div className="space-y-2">
      <div className="relative aspect-square overflow-hidden rounded-xl border border-zinc-700 bg-[#111827]">
      <svg
        ref={svgRef}
        viewBox={viewBox}
        role="img"
        aria-label={`${mapId} 지도에 경기 중 기록된 위치를 시간순으로 표시. 첫 위치는 초록색, 마지막 위치는 보라색입니다. 확대 후 드래그해 이동할 수 있습니다.`}
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
            onError={() => setTileLoadFailed(true)}
            x={tile.x * tileWorldSize}
            y={8192 + tile.y * tileWorldSize}
            width={tileWorldSize}
            height={tileWorldSize}
          />
        ))}
        {blueZone && <g aria-label="관측된 현재 안전구역과 바깥 닫힌 영역">
          <path data-testid="blue-zone-outside" d={`M0 0 H8192 V8192 H0 Z M${blueZone.x + blueZone.radius} ${mapY(blueZone.y)} A${blueZone.radius} ${blueZone.radius} 0 1 0 ${blueZone.x - blueZone.radius} ${mapY(blueZone.y)} A${blueZone.radius} ${blueZone.radius} 0 1 0 ${blueZone.x + blueZone.radius} ${mapY(blueZone.y)} Z`}
            fill="#38bdf8" fillOpacity="0.22" fillRule="evenodd" pointerEvents="none" />
          <circle cx={blueZone.x} cy={mapY(blueZone.y)} r={blueZone.radius} fill="none" stroke="#38bdf8" strokeWidth={view.size * 0.004} pointerEvents="none">
            <title>관측된 현재 안전구역 경계</title>
          </circle>
        </g>}
        {snapshot.zone && (
          <g>
            <circle cx={snapshot.zone.x} cy={mapY(snapshot.zone.y)} r={snapshot.zone.radius} fill="#facc15" fillOpacity="0.07" stroke="#facc15" strokeWidth={view.size * 0.004} strokeDasharray={`${view.size * 0.05} ${view.size * 0.035}`} />
            <circle cx={snapshot.zone.x} cy={mapY(snapshot.zone.y)} r={view.size * 0.012} fill="#facc15" stroke="#111827" strokeWidth={view.size * 0.003}>
              <title>표시된 원의 중심</title>
            </circle>
          </g>
        )}
        {pathSegments.map((segment, index) => segment.length > 1 && <polyline key={index} points={segment.map((point) => `${point.x},${mapY(point.y)}`).join(" ")} fill="none" stroke="#34d399" strokeWidth={view.size * 0.005} strokeDasharray={`${view.size * 0.015} ${view.size * 0.012}`} strokeLinecap="round" strokeLinejoin="round" opacity="0.95" />)}
        {routeArrows.map((arrow, index) => (
          <polygon key={index} points={`${-arrowSize / 2},${-arrowSize / 2} ${arrowSize / 2},0 ${-arrowSize / 2},${arrowSize / 2}`} transform={`translate(${arrow.x} ${arrow.y}) rotate(${arrow.angle})`} fill="#34d399" stroke="#052e16" strokeWidth={markerStroke} />
        ))}
        {start && <g>
          {startCaption && <>
            <path data-caption-leader="start" d={`M${start.x} ${mapY(start.y)} L${startCaption.leaderX} ${startCaption.leaderY}`} stroke="#34d399" strokeWidth={labelStroke} />
            <rect data-map-caption="start" x={startCaption.x} y={startCaption.y} width={startCaption.width} height={labelFontSize * 1.45} rx={labelFontSize * 0.2} fill="#090d16" stroke="#34d399" strokeWidth={labelStroke} />
            <text x={startCaption.x + labelFontSize * 0.4} y={startCaption.y + labelFontSize * 1.1} fontSize={labelFontSize} fontWeight="700" fill="white">본인 시작</text>
          </>}
          <circle cx={start.x} cy={mapY(start.y)} r={playerMarkerRadius} fill="#052e16" stroke="#34d399" strokeWidth={markerStroke * 1.5}>
            <title>{`본인 시작 위치${snapshot.pathStartSeconds === undefined ? "" : ` · ${formatLessonTime(snapshot.pathStartSeconds)}`}`}</title>
          </circle>
        </g>}
        {moved && current && <g>
          {endCaption && <>
            <path data-caption-leader="end" d={`M${current.x} ${mapY(current.y)} L${endCaption.leaderX} ${endCaption.leaderY}`} stroke="#c084fc" strokeWidth={labelStroke} />
            <rect data-map-caption="end" x={endCaption.x} y={endCaption.y} width={endCaption.width} height={labelFontSize * 1.45} rx={labelFontSize * 0.2} fill="#090d16" stroke="#c084fc" strokeWidth={labelStroke} />
            <text x={endCaption.x + labelFontSize * 0.4} y={endCaption.y + labelFontSize * 1.1} fontSize={labelFontSize} fontWeight="700" fill="white">본인 마지막</text>
          </>}
          <circle cx={current.x} cy={mapY(current.y)} r={playerMarkerRadius} fill="#c084fc" stroke="white" strokeWidth={markerStroke}>
            <title>{`본인 마지막 위치${snapshot.pathEndSeconds === undefined ? "" : ` · ${formatLessonTime(snapshot.pathEndSeconds)}`}`}</title>
          </circle>
        </g>}
        {snapshot.kills?.map((kill, index) => (
          <circle key={`${kill.x}-${kill.y}-${index}`} cx={kill.x} cy={mapY(kill.y)} r={killMarkerRadius} fill="#fb7185" stroke="white" strokeWidth={markerStroke}>
            {kill.label && <title>{kill.label}</title>}
          </circle>
        ))}
        {snapshot.marks?.map((mark, index) => {
          const label = labelFor(mark.label);
          const markIndex = playerMarks.indexOf(mark);
          const caption = captionLayouts.get(`mark-${markIndex}`);
          const color = mark.kind === "teammate" ? "#22d3ee" : mark.kind === "opponent" ? "#fb526b" : "#fb923c";
          return <g key={`${mark.label}-${index}`} data-player-mark={mark.kind}>
            {mark.kind === "opponent"
              ? <polygon points={`${mark.x},${mapY(mark.y) - playerMarkerRadius} ${mark.x + playerMarkerRadius},${mapY(mark.y)} ${mark.x},${mapY(mark.y) + playerMarkerRadius} ${mark.x - playerMarkerRadius},${mapY(mark.y)}`} fill={color} stroke="white" strokeWidth={markerStroke} />
              : <circle cx={mark.x} cy={mapY(mark.y)} r={playerMarkerRadius * 0.8} fill={color} stroke="white" strokeWidth={markerStroke} />}
            {caption && <>
              <path data-caption-leader={`mark-${markIndex}`} d={`M${mark.x} ${mapY(mark.y)} L${caption.leaderX} ${caption.leaderY}`} stroke={color} strokeWidth={labelStroke} />
              <rect data-map-caption={`mark-${markIndex}`} x={caption.x} y={caption.y} width={caption.width} height={labelFontSize * 1.45} rx={labelFontSize * 0.2} fill="#090d16" stroke={color} strokeWidth={labelStroke} />
              <text x={caption.x + labelFontSize * 0.4} y={caption.y + labelFontSize * 1.1} fontSize={labelFontSize} fontWeight="700" fill="white">{label}</text>
            </>}
            <title>{mark.label}</title>
          </g>;
        })}
      </svg>
      {tileLoadFailed && <p role="status" className="pointer-events-none absolute left-1/2 top-1/2 w-[min(85%,22rem)] -translate-x-1/2 -translate-y-1/2 rounded-lg border border-zinc-700 bg-zinc-950/95 p-3 text-center text-xs leading-5 text-zinc-200">지도 이미지를 불러오지 못했습니다. 장면 해설은 계속 읽을 수 있습니다.</p>}
      {snapshot.pathStartSeconds !== undefined && snapshot.pathEndSeconds !== undefined && moved && (
        <div className="pointer-events-none absolute left-2 top-2 rounded-md bg-zinc-950/90 px-2 py-1 text-[11px] font-semibold tabular-nums text-zinc-100">
          위치 기록 {formatLessonTime(snapshot.pathStartSeconds)} → {formatLessonTime(snapshot.pathEndSeconds)}
        </div>
      )}
      {blueZone && maxMapSize > localSize && <button type="button" aria-pressed={showingWholeZone}
        onClick={() => setView(showingWholeZone ? initial : { x: fullOffsetX, y: fullOffsetY, size: maxMapSize })}
        className={`absolute left-2 z-10 min-h-11 max-w-[calc(100%-7rem)] rounded-lg border border-sky-500 bg-zinc-950/90 px-3 text-xs font-semibold text-sky-100 hover:bg-zinc-900 ${snapshot.pathStartSeconds !== undefined && snapshot.pathEndSeconds !== undefined && moved ? "top-12" : "top-2"}`}>
        {showingWholeZone ? "교전 위치 보기" : "현재 원 전체 보기"}
      </button>}
      <div className="absolute right-2 top-2 flex overflow-hidden rounded-lg border border-zinc-700 bg-zinc-950/90 shadow-lg" aria-label="지도 확대 도구">
        <button type="button" onClick={() => zoom(0.75)} aria-label="지도 확대" disabled={view.size <= minMapSize} className="grid size-11 place-items-center text-zinc-200 enabled:hover:bg-zinc-800 disabled:cursor-not-allowed disabled:opacity-40"><Plus size={17} /></button>
        <button type="button" onClick={() => zoom(1.33)} aria-label="지도 축소" disabled={view.size >= maxMapSize} className="grid size-11 place-items-center border-l border-zinc-700 text-zinc-200 enabled:hover:bg-zinc-800 disabled:cursor-not-allowed disabled:opacity-40"><Minus size={17} /></button>
        <button type="button" onClick={() => setView(initial)} aria-label="지도 보기 초기화" className="grid size-11 place-items-center border-l border-zinc-700 text-zinc-200 hover:bg-zinc-800"><RotateCcw size={15} /></button>
      </div>
      </div>
      <button type="button" onClick={() => setView({ x: focusCenterX - centerX, y: focusCenterY - centerY, size: focusSize })}
        className="min-h-11 rounded-lg border border-zinc-600 bg-zinc-900 px-3 text-sm font-semibold text-zinc-100 hover:bg-zinc-800">
        교전 위치 확대
      </button>
      <div aria-label="지도 범례" className="flex flex-wrap gap-x-3 gap-y-1 rounded-lg bg-zinc-950/85 px-3 py-2 text-[11px] font-medium text-zinc-200">
        <span><i className="mr-1 inline-block h-2 w-2 rounded-full border border-emerald-400 bg-emerald-950" />{snapshot.playerLabel ?? (moved ? "본인 시작" : "본인 위치")}</span>
        {moved && <span><i className="mr-1 inline-block h-2 w-2 rounded-full bg-purple-400" />본인 마지막</span>}
        {blueZone && <span><i className="mr-1 inline-block h-2 w-2 rounded-full border border-sky-400" />파란 현재 안전구역 경계</span>}
        {blueZone && <span><i className="mr-1 inline-block h-2 w-2 rounded-full bg-sky-400/40" />파란 바깥 닫힌 영역</span>}
        {snapshot.zone && <span><i className="mr-1 inline-block h-2 w-2 rounded-full bg-yellow-400" />노란 다음 원</span>}
        {snapshot.zone && <span><i className="mr-1 inline-block h-2 w-2 rounded-full border border-zinc-950 bg-yellow-400" />원 중심</span>}
        {!!snapshot.kills?.length && <span><i className="mr-1 inline-block h-2 w-2 rounded-full bg-rose-400" />사망 위치</span>}
        {snapshot.marks?.some((mark) => mark.kind === "teammate") && <span><i className="mr-1 inline-block h-2 w-2 rounded-full border border-white bg-cyan-400" />팀원 (원)</span>}
        {snapshot.marks?.some((mark) => mark.kind === "throw") && <span><i className="mr-1 inline-block h-2 w-2 rounded-full bg-orange-400" />투척 위치</span>}
        {snapshot.marks?.some((mark) => mark.kind === "opponent") && <span><i className="mr-1 inline-block h-2 w-2 rotate-45 border border-white bg-rose-500" />상대 (다이아몬드)</span>}
      </div>
    </div>
  );
}
