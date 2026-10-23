import type { LolRankedHistory, LolRankedPoint } from "@/lib/lol/types";
import { formatKstDate } from "./lolFormat";

const TIERS = ["IRON", "BRONZE", "SILVER", "GOLD", "PLATINUM", "EMERALD", "DIAMOND"];
const LABELS = ["아이언", "브론즈", "실버", "골드", "플래티넘", "에메랄드", "다이아몬드"];
const DIVISIONS = ["IV", "III", "II", "I"];
const DAY = 86_400_000;

// LP는 디비전 내부 위치에만 사용하고 마스터 이상에서는 연속으로 연결한다.
export function rankedPosition(point: LolRankedPoint) {
  const tier = TIERS.indexOf(point.tier);
  return tier < 0 ? 28 + point.lp / 100 : tier * 4 + Math.max(0, DIVISIONS.indexOf(point.rank)) + Math.min(99, point.lp) / 100;
}

function rankLabel(position: number) {
  if (position >= 28) return position === 28 ? "마스터" : `마스터+ ${Math.round((position - 28) * 100)} LP`;
  const division = Math.max(0, Math.floor(position));
  return `${LABELS[Math.floor(division / 4)]} ${4 - division % 4}`;
}

export default function LolRankedGraph({ history, label, today = formatKstDate(new Date().toISOString()) }: {
  history?: LolRankedHistory["RANKED_SOLO_5x5"];
  label: string;
  today?: string;
}) {
  const end = Date.parse(`${today}T00:00:00Z`);
  const start = end - 29 * DAY;
  const points = (history?.points ?? []).filter((point) => point.isBaseline ||
    (Date.parse(point.date) >= start && Date.parse(point.date) <= end));
  const positions = points.map(rankedPosition);
  const bottom = Math.max(0, Math.floor(Math.min(...positions)));
  const top = Math.max(bottom + 1, Math.ceil(Math.max(...positions)));
  const x = (date: string) => 82 + Math.max(0, Math.min(29, (Date.parse(date) - start) / DAY)) * 218 / 29;
  const y = (position: number) => 106 - (position - bottom) / (top - bottom) * 84;
  const realPoints = points.filter((point) => !point.isBaseline);
  const ticks = [...new Set([bottom, Math.floor((bottom + top) / 2), top])];
  return (
    <div className="mt-4 min-w-0" data-testid="lol-ranked-graph">
      <h4 className="text-xs font-medium text-zinc-300">최근 30일 티어 그래프</h4>
      {points.length ? (
        <svg viewBox="0 0 324 132" role="img" aria-label={`${label} 최근 30일 티어 그래프`} className="mt-2 w-full text-blue-300">
          <title>한국 날짜 기준 최근 30일의 일별 마지막 랭크 기록</title>
          {ticks.map((tick) => <g key={tick}>
            <text x="2" y={y(tick) + 3} fill="#a1a1aa" fontSize="9">{rankLabel(tick)}</text>
            <line x1="80" x2="302" y1={y(tick)} y2={y(tick)} stroke="#3f3f46" />
          </g>)}
          {[0, 14, 29].map((offset) => {
            const date = new Date(start + offset * DAY).toISOString().slice(0, 10);
            return <text key={offset} x={x(date)} y="126" textAnchor="middle" fill="#a1a1aa" fontSize="10">{date.slice(5)}</text>;
          })}
          {points.length > 1 && <polyline
            points={points.map((point) => `${x(point.date)},${y(rankedPosition(point))}`).join(" ")}
            fill="none" stroke="currentColor" strokeWidth="2"
          />}
          {points.map((point) => <circle
            key={point.recordedAt} cx={x(point.date)} cy={y(rankedPosition(point))} r={point.isBaseline ? 3 : 3.5}
            fill={point.isBaseline ? "#18181b" : "currentColor"} stroke="currentColor"
          >
            <title>{`${point.date} · ${point.tier} ${point.rank} · ${point.lp} LP${point.isBaseline ? " · 30일 이전 시작점" : ""}`}</title>
          </circle>)}
        </svg>
      ) : <p className="mt-2 text-xs text-zinc-500">최근 30일 기록 없음</p>}
      {points.some((point) => point.isBaseline) && <p className="text-xs text-zinc-500">빈 점: 30일 이전 마지막 기록</p>}
      {realPoints.length < 2 && history?.trackingSince ? (
        <p className="mt-2 text-xs text-zinc-500">기록이 쌓이면 추이가 표시됩니다(기록 시작 {formatKstDate(history.trackingSince)})</p>
      ) : history?.trackingSince && <p className="mt-2 text-xs text-zinc-500">기록 시작 {formatKstDate(history.trackingSince)}</p>}
    </div>
  );
}
