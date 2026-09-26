import type { DailyEncounterSnapshot } from "@/lib/learn/dailyCombatStory";

function time(seconds: number) {
  const value = Math.max(0, Math.round(seconds));
  return `${String(Math.floor(value / 60)).padStart(2, "0")}:${String(value % 60).padStart(2, "0")}`;
}

const VIEW_WIDTH = 360;
const VIEW_HEIGHT = 160;
const CENTER_X = VIEW_WIDTH / 2;
const CENTER_Y = VIEW_HEIGHT / 2;
const PLOT_RADIUS = 64;

function EncounterSnapshotPlot({ snapshot, bounds, scaleMeters, scalePixels, playerNumbers, ownSideLabel }: {
  snapshot: DailyEncounterSnapshot;
  bounds: { x: number; y: number; span: number };
  scaleMeters: number;
  scalePixels: number;
  playerNumbers: Map<string, number>;
  ownSideLabel: string;
}) {
  const points = snapshot.points;
  const dotPositions = points.map((point) => ({
    ...point,
    cx: CENTER_X + ((point.x - bounds.x) / bounds.span) * PLOT_RADIUS * 2,
    cy: CENTER_Y - ((point.y - bounds.y) / bounds.span) * PLOT_RADIUS * 2,
  }));
  const offsetLabel = snapshot.offsetSeconds === 0 ? snapshot.anchorLabel : `${snapshot.offsetSeconds > 0 ? "+" : "−"}30초 · ${snapshot.anchorLabel} 기준`;

  return <li className="min-w-0 rounded-xl border border-zinc-800 bg-zinc-950/50 p-3">
    <div className="flex flex-wrap items-baseline justify-between gap-x-2 gap-y-1">
      <h4 className="text-sm font-semibold text-zinc-200">{offsetLabel} · 기준 {time(snapshot.targetTimeSeconds)}</h4>
      <span className="text-[11px] text-zinc-500">위치 표본, 북쪽 방향 표시 없음</span>
    </div>
    {points.length > 0 ? <svg className="mt-2 block h-auto w-full" viewBox={`0 0 ${VIEW_WIDTH} ${VIEW_HEIGHT}`} role="img"
      aria-label={`${time(snapshot.targetTimeSeconds)} 기준 ${ownSideLabel} 및 상대 위치 표본`}>
      <rect x="1" y="1" width={VIEW_WIDTH - 2} height={VIEW_HEIGHT - 2} rx="10" fill="#09090b" stroke="#27272a" />
      <line x1={CENTER_X} y1="12" x2={CENTER_X} y2={VIEW_HEIGHT - 12} stroke="#27272a" strokeDasharray="3 5" />
      <line x1="12" y1={CENTER_Y} x2={VIEW_WIDTH - 12} y2={CENTER_Y} stroke="#27272a" strokeDasharray="3 5" />
      {dotPositions.map((point) => {
        const isAlly = point.side === "ally";
        const number = playerNumbers.get(`${point.side}:${point.player}`);
        return <g key={`${point.side}-${point.player}`}>
          <title>{`${number} · ${point.player} · ${time(point.sampleTimeSeconds)} 표본`}</title>
          <circle cx={point.cx} cy={point.cy} r={point.directlyInvolved ? "8" : "7"} fill={isAlly ? "#34d399" : "#fb7185"} stroke={point.directlyInvolved ? "#f4f4f5" : "#09090b"} strokeWidth={point.directlyInvolved ? "1.5" : "2"} />
          <text x={point.cx} y={point.cy + 3} textAnchor="middle" fill="#09090b" fontSize="9" fontWeight="700">{number}</text>
        </g>;
      })}
      <line x1={VIEW_WIDTH - 14 - scalePixels} y1={VIEW_HEIGHT - 13} x2={VIEW_WIDTH - 14} y2={VIEW_HEIGHT - 13} stroke="#d4d4d8" strokeWidth="2" />
      <text x={VIEW_WIDTH - 14} y={VIEW_HEIGHT - 17} textAnchor="end" fill="#a1a1aa" fontSize="8">{scaleMeters}m</text>
    </svg> : <p className="mt-3 rounded-lg bg-zinc-900 px-3 py-2 text-xs leading-5 text-zinc-400">이 시점 근처에는 보여줄 위치 기록이 없습니다.</p>}
    <div className="mt-2 flex flex-wrap gap-x-3 gap-y-1 text-[11px] text-zinc-400" aria-label="위치 표본 범례">
      <span><i className="mr-1 inline-block size-2 rounded-full bg-emerald-400" />{ownSideLabel}</span>
      <span><i className="mr-1 inline-block size-2 rounded-full bg-rose-400" />상대</span>
      {dotPositions.map((point) => <span key={`sample-${point.side}-${point.player}`} className={point.ageSeconds > 15 ? "text-amber-300" : ""}>
        <b className={`mr-1 inline-grid size-4 place-items-center rounded-full text-[10px] text-zinc-950 ${point.side === "ally" ? "bg-emerald-400" : "bg-rose-400"}`}>{playerNumbers.get(`${point.side}:${point.player}`)}</b>
        {point.player}: {time(point.sampleTimeSeconds)} 표본{point.ageSeconds > 15 ? ` · 기준 시점과 ${Math.round(point.ageSeconds)}초 차이` : ""}
      </span>)}
      {snapshot.missingPlayers.length > 0 && <span className="text-zinc-500">위치 미기록: {snapshot.missingPlayers.join(" · ")}</span>}
    </div>
  </li>;
}

export default function DailyEncounterSnapshots({ snapshots, ownSideLabel }: { snapshots: DailyEncounterSnapshot[]; ownSideLabel: string }) {
  if (!snapshots.length) return null;
  const allPoints = snapshots.flatMap((snapshot) => snapshot.points);
  const playerNumbers = new Map<string, number>();
  for (const point of allPoints) {
    const key = `${point.side}:${point.player}`;
    if (!playerNumbers.has(key)) playerNumbers.set(key, playerNumbers.size + 1);
  }
  const xMin = allPoints.length ? Math.min(...allPoints.map((point) => point.x)) : 0;
  const xMax = allPoints.length ? Math.max(...allPoints.map((point) => point.x)) : 0;
  const yMin = allPoints.length ? Math.min(...allPoints.map((point) => point.y)) : 0;
  const yMax = allPoints.length ? Math.max(...allPoints.map((point) => point.y)) : 0;
  const span = Math.max(xMax - xMin, yMax - yMin, 50000);
  const bounds = { x: (xMin + xMax) / 2, y: (yMin + yMax) / 2, span };
  const spanMeters = span / 100;
  const desiredScale = spanMeters / 5;
  const scaleBase = 10 ** Math.floor(Math.log10(Math.max(desiredScale, 1)));
  const scaleStep = desiredScale / scaleBase;
  const scaleMeters = (scaleStep >= 5 ? 5 : scaleStep >= 2 ? 2 : 1) * scaleBase;
  const scalePixels = (scaleMeters / spanMeters) * PLOT_RADIUS * 2;
  return <details className="mt-3 min-w-0 rounded-xl border border-zinc-800 bg-zinc-950/40">
    <summary className="min-h-11 cursor-pointer px-3 py-2.5 text-sm font-medium text-sky-200">{ownSideLabel}{ownSideLabel === "랭커" ? "와" : "과"} 상대 위치 표본 보기</summary>
    <div className="space-y-2 px-3 pb-3">
      <p className="text-xs leading-5 text-zinc-400">처음 확인된 피해 전후의 위치 표본입니다. 세 그림은 같은 축척을 씁니다. 번호는 아래 선수 목록과 연결되고, 가까운 위치의 표식은 겹칠 수 있습니다. 테두리가 있는 점은 교전 기록에 직접 등장한 선수, 작은 테두리 점은 직접 교전이 기록되지 않은 {ownSideLabel}입니다. 점 사이를 잇지 않았으며, 시야·엄폐·건물 안팎이나 이동 의도를 나타내지 않습니다.</p>
      <ol className="grid min-w-0 gap-2">{snapshots.map((snapshot) => <EncounterSnapshotPlot key={snapshot.offsetSeconds} snapshot={snapshot} bounds={bounds} scaleMeters={scaleMeters} scalePixels={scalePixels} playerNumbers={playerNumbers} ownSideLabel={ownSideLabel} />)}</ol>
      <p className="text-[11px] text-zinc-500">각 그림의 축척 막대는 약 {scaleMeters}m입니다. 세 그림은 같은 좌표 범위로 표시합니다.</p>
    </div>
  </details>;
}
