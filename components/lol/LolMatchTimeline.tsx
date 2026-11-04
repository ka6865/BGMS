import { useState } from "react";
import type { LolTimelinePoint } from "@/lib/lol/matchBuild";

const time = (timestamp: number) => `${Math.floor(timestamp / 60_000)}:${String(Math.floor(timestamp / 1000) % 60).padStart(2, "0")}`;
const LABELS = { gold: "누적 골드", cs: "CS" } as const;

export default function LolMatchTimeline({ points }: { points: LolTimelinePoint[] }) {
  const [metric, setMetric] = useState<"gold" | "cs">("gold");
  const [selectedTime, setSelectedTime] = useState<number | null>(null);
  if (!points.length) return <p className="text-xs text-zinc-400">골드·CS 기록이 없습니다.</p>;
  const selectedIndex = Math.max(0, selectedTime === null ? points.length - 1 : points.findIndex(point => point.timestamp === selectedTime));
  const selected = points[selectedIndex];
  const label = LABELS[metric];
  const value = selected[metric];
  const max = Math.max(1, ...points.map(point => point[metric] ?? 0));
  const end = Math.max(1, points.at(-1)!.timestamp);
  const x = (timestamp: number) => 42 + timestamp / end * 266;
  const y = (amount: number) => 142 - amount / max * 120;
  const path = points.map((point, index) => {
    const amount = point[metric];
    if (amount === null) return "";
    const previous = points[index - 1];
    const command = previous && previous[metric] !== null && point.timestamp - previous.timestamp <= 90_000 ? "L" : "M";
    return `${command}${x(point.timestamp)},${y(amount)}`;
  }).join(" ");
  const hasData = points.some(point => point[metric] !== null);

  return <section aria-label="골드·CS 변화" data-testid="lol-match-timeline" className="min-w-0 space-y-3 border-t border-zinc-800 pt-4">
    <div className="flex flex-wrap items-center justify-between gap-2">
      <h4 className="text-sm font-semibold text-zinc-100">경기 흐름</h4>
      <div role="group" aria-label="경기 흐름 지표" className="flex gap-1">
        {(["gold", "cs"] as const).map(key => <button key={key} type="button" aria-pressed={metric === key}
          onClick={() => setMetric(key)}
          className={`min-h-11 rounded-lg px-3 text-xs font-semibold focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-amber-400 ${metric === key ? "bg-zinc-700 text-zinc-100" : "text-zinc-400 hover:bg-zinc-800"}`}>
          {LABELS[key]}
        </button>)}
      </div>
    </div>
    {hasData ? <svg role="img" aria-label={`${label} 변화 그래프`} viewBox="0 0 324 170" className="w-full overflow-visible text-sky-300">
      <title>{label} 변화. 아래 경기 시점 슬라이더로 각 시점의 값을 확인할 수 있습니다.</title>
      {[0, max / 2, max].map(tick => <g key={tick}>
        <line x1="42" x2="308" y1={y(tick)} y2={y(tick)} stroke="#3f3f46" />
        <text x="36" y={y(tick) + 4} textAnchor="end" fill="#a1a1aa" fontSize="10">{Math.round(tick).toLocaleString("ko-KR")}</text>
      </g>)}
      <path d={path} fill="none" stroke="currentColor" strokeWidth="2" />
      {points.map(point => point[metric] !== null && <circle key={point.timestamp} cx={x(point.timestamp)} cy={y(point[metric]!)} r="2" fill="currentColor">
        <title>{time(point.timestamp)} · {label} {point[metric]!.toLocaleString("ko-KR")}</title>
      </circle>)}
      <line x1={x(selected.timestamp)} x2={x(selected.timestamp)} y1="18" y2="142" stroke="#fbbf24" strokeDasharray="3 3" />
      <text x="42" y="163" fill="#a1a1aa" fontSize="10">0:00</text>
      <text x="308" y="163" textAnchor="end" fill="#a1a1aa" fontSize="10">{time(end)}</text>
    </svg> : <p className="text-xs text-zinc-400">{label} 기록이 없습니다.</p>}
    <label className="block text-xs text-zinc-300">
      <span className="flex flex-wrap justify-between gap-2"><span>경기 시점</span>
        <output className="font-semibold tabular-nums text-zinc-100">{time(selected.timestamp)} · {label} {value === null ? "기록 없음" : value.toLocaleString("ko-KR")}</output>
      </span>
      <input type="range" aria-label="경기 시점" min={0} max={points.length - 1} value={selectedIndex}
        disabled={points.length === 1} aria-valuetext={`${time(selected.timestamp)} · ${label} ${value === null ? "기록 없음" : value.toLocaleString("ko-KR")}`}
        onChange={event => setSelectedTime(points[Number(event.target.value)].timestamp)}
        className="min-h-11 w-full accent-amber-400 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-amber-400" />
    </label>
    <p className="text-xs leading-5 text-zinc-400">CS는 라인·정글 몬스터 처치 수의 합입니다. 기록이 누락된 구간은 선을 연결하지 않습니다.</p>
  </section>;
}
