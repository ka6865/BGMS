import Link from "next/link";
import LolLegalNotice from "./LolLegalNotice";
import { LOL_LADDER_QUEUES, LOL_LADDER_TIERS, type LolLadderDaily, type LolLadderTier } from "@/lib/lol/ladder";

const tierNames: Record<LolLadderTier, string> = { CHALLENGER: "챌린저", GRANDMASTER: "그랜드마스터", MASTER: "마스터" };
const colors = { CHALLENGER: "#fbbf24", GRANDMASTER: "#f87171", MASTER: "#c084fc" };

const DAY_MS = 86400_000;
const W = 300;
const H = 120;
const LEFT = 52;
const RIGHT = 292;
const TOP = 14;
const BOTTOM = 92;

// 티어마다 컷 범위가 수백 LP씩 달라 한 축에 그리면 변화가 묻히므로, 티어별로 자기 범위에 맞춘 작은 그래프를 그린다.
function TierCutGraph({ tier, series, first, today }: { tier: LolLadderTier; series: LolLadderDaily[]; first: number; today: string }) {
  const values = series.map(row => row.cutoff_lp!);
  const low = Math.min(...values);
  const high = Math.max(...values);
  // 변화가 거의 없어도 선이 축에 붙지 않도록 최소 20 LP 폭과 여백을 둔다.
  const pad = Math.max(10, (high - low) * 0.15);
  const min = Math.max(0, Math.floor(low - pad));
  const max = Math.ceil(high + pad);
  const x = (day: string) => LEFT + (Date.parse(`${day}T00:00:00+09:00`) - first) / DAY_MS / 29 * (RIGHT - LEFT);
  const y = (lp: number) => BOTTOM - (lp - min) / (max - min) * (BOTTOM - TOP);
  const latest = series.at(-1);
  const change = series.length > 1 ? latest!.cutoff_lp! - series[0].cutoff_lp! : null;
  return <div className="min-w-0">
    <p className="flex items-baseline justify-between gap-2 text-xs">
      <span style={{ color: colors[tier] }} className="font-semibold">{tierNames[tier]}</span>
      {change !== null && <span className="tabular-nums text-zinc-400">30일 {change > 0 ? "+" : ""}{change.toLocaleString()} LP</span>}
    </p>
    <svg viewBox={`0 0 ${W} ${H}`} role="img" aria-label={`최근 30일 ${tierNames[tier]} 최저 LP 기록`} className="mt-1 block w-full">
      <line x1={LEFT} y1={TOP} x2={RIGHT} y2={TOP} stroke="#3f3f46" />
      <line x1={LEFT} y1={BOTTOM} x2={RIGHT} y2={BOTTOM} stroke="#52525b" />
      <text x={LEFT - 6} y={TOP + 4} textAnchor="end" fill="#a1a1aa" fontSize="11">{max.toLocaleString()}</text>
      <text x={LEFT - 6} y={BOTTOM + 4} textAnchor="end" fill="#a1a1aa" fontSize="11">{min.toLocaleString()}</text>
      <text x={LEFT} y={H - 8} fill="#a1a1aa" fontSize="11">{new Date(first).toISOString().slice(5, 10)}</text>
      <text x={RIGHT} y={H - 8} textAnchor="end" fill="#a1a1aa" fontSize="11">{today.slice(5)}</text>
      {series.slice(1).map((row, index) => {
        const prev = series[index];
        // 누락된 날짜를 연속 관측으로 보이지 않도록 선을 끊는다.
        return Date.parse(row.day) - Date.parse(prev.day) === DAY_MS
          ? <line key={row.day} x1={x(prev.day)} y1={y(prev.cutoff_lp!)} x2={x(row.day)} y2={y(row.cutoff_lp!)} stroke={colors[tier]} strokeWidth="2" /> : null;
      })}
      {series.map(row => <circle key={row.day} cx={x(row.day)} cy={y(row.cutoff_lp!)} r="2.5" fill={colors[tier]}>
        <title>{row.day} {tierNames[tier]} {row.cutoff_lp} LP</title>
      </circle>)}
    </svg>
  </div>;
}

function CutGraph({ rows, today }: { rows: LolLadderDaily[]; today: string }) {
  const points = rows.filter(row => row.cutoff_lp !== null);
  if (!points.length) return <p className="py-6 text-sm text-zinc-400">기록 시작일 이후 표시됩니다.</p>;
  const first = Date.parse(`${today}T00:00:00+09:00`) - 29 * DAY_MS;
  return <figure className="min-w-0">
    <figcaption className="text-sm text-zinc-300">최근 30일 컷 LP · KST · 티어별 범위</figcaption>
    <div className="mt-2 grid gap-4 sm:grid-cols-3">
      {LOL_LADDER_TIERS.map(tier => {
        const series = points.filter(row => row.tier === tier);
        return series.length ? <TierCutGraph key={tier} tier={tier} series={series} first={first} today={today} /> : null;
      })}
    </div>
  </figure>;
}

export default function LolLadderView({ rows, today, error = false }: { rows: LolLadderDaily[]; today: string; error?: boolean }) {
  return <main className="mx-auto w-full max-w-4xl space-y-6 px-4 py-6 text-zinc-100">
    <header><h1 className="text-xl font-bold">한국 서버 랭크 컷 기록</h1>
      <p className="mt-2 text-sm text-zinc-400">{today} KST · 하루 한 번 확인한 티어별 최저 LP입니다. 승급 예측이나 실시간 승급 기준이 아닙니다.</p>
      <nav aria-label="LoL 공개 메뉴" className="mt-2 flex flex-wrap gap-4 text-sm text-sky-300">
        <Link href="/lol/kr" className="inline-flex min-h-11 items-center">전적 검색</Link><Link href="/lol/kr/status" className="inline-flex min-h-11 items-center">서버 상태</Link>
      </nav>
    </header>
    {error && <p role="status" className="text-sm text-amber-300">기록을 불러오지 못했습니다. 잠시 후 다시 확인해 주세요.</p>}
    {!rows.length && !error && <p className="text-sm text-zinc-400">기록 시작일 이후 표시됩니다.</p>}
    {LOL_LADDER_QUEUES.map(queue => <section key={queue} aria-label={queue === "RANKED_SOLO_5x5" ? "솔로 랭크 컷" : "자유 랭크 컷"} className="min-w-0 space-y-4 border-t border-zinc-800 pt-4">
      <h2 className="font-semibold">{queue === "RANKED_SOLO_5x5" ? "솔로 랭크" : "자유 랭크"}</h2>
      <div className="grid gap-4 sm:grid-cols-3">{LOL_LADDER_TIERS.map(tier => {
        const row = rows.find(item => item.day === today && item.queue === queue && item.tier === tier);
        return <article key={tier} className="min-w-0 space-y-1 text-sm">
          <h3 style={{ color: colors[tier] }}>{tierNames[tier]}</h3>
          <p className="text-lg font-semibold">{!row ? "오늘 기록 없음" : row.cutoff_lp === null ? "컷 없음" : `${row.cutoff_lp.toLocaleString()} LP`}</p>
          {row && <>
            <p className="text-zinc-300">인원 {row.player_count.toLocaleString()}명</p>
            <p className="text-zinc-400">신규 진입 {row.fresh_blood_count}명 · 연승 중 {row.hot_streak_count}명</p>
            <p className="text-zinc-400">최고 {row.top_lp ?? "—"} LP · 중위 {row.median_lp ?? "—"} LP</p>
            <p className="text-xs text-zinc-500">관측 {new Date(row.observed_at).toLocaleString("ko-KR", { timeZone: "Asia/Seoul" })}</p>
          </>}
        </article>;
      })}</div>
      <CutGraph rows={rows.filter(row => row.queue === queue)} today={today} />
      <details className="text-sm text-zinc-400"><summary className="min-h-11 cursor-pointer py-3">날짜별 관측 기록</summary>
        <ul className="space-y-2">{rows.filter(row => row.queue === queue).map(row => <li key={`${row.day}:${row.tier}`}>
          {row.day} · {tierNames[row.tier]} · 컷 {row.cutoff_lp ?? "—"} LP
        </li>)}</ul>
      </details>
    </section>)}
    <LolLegalNotice />
  </main>;
}
