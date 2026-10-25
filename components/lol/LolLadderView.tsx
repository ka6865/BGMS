import Link from "next/link";
import LolLegalNotice from "./LolLegalNotice";
import { LOL_LADDER_QUEUES, LOL_LADDER_TIERS, type LolLadderDaily, type LolLadderTier } from "@/lib/lol/ladder";

const tierNames: Record<LolLadderTier, string> = { CHALLENGER: "챌린저", GRANDMASTER: "그랜드마스터", MASTER: "마스터" };
const colors = { CHALLENGER: "#fbbf24", GRANDMASTER: "#f87171", MASTER: "#c084fc" };

function CutGraph({ rows, today }: { rows: LolLadderDaily[]; today: string }) {
  const points = rows.filter(row => row.cutoff_lp !== null);
  if (!points.length) return <p className="py-6 text-sm text-zinc-400">기록 시작일 이후 표시됩니다.</p>;
  const max = Math.max(1, ...points.map(row => row.cutoff_lp!));
  const first = Date.parse(`${today}T00:00:00+09:00`) - 29 * 86400_000;
  const x = (day: string) => 48 + (Date.parse(`${day}T00:00:00+09:00`) - first) / 86400_000 / 29 * 500;
  const y = (lp: number) => 150 - lp / max * 120;
  return <figure className="min-w-0">
    <figcaption className="text-sm text-zinc-300">최근 30일 컷 LP · KST</figcaption>
    <svg viewBox="0 0 570 190" role="img" aria-label="최근 30일 티어별 최저 LP 기록" className="mt-2 block w-full">
      <line x1="48" y1="150" x2="548" y2="150" stroke="#52525b" />
      <text x="4" y="35" fill="#a1a1aa" fontSize="12">{max} LP</text>
      <text x="12" y="153" fill="#a1a1aa" fontSize="12">0 LP</text>
      <text x="48" y="178" fill="#a1a1aa" fontSize="12">{new Date(first).toISOString().slice(5, 10)}</text>
      <text x="510" y="178" fill="#a1a1aa" fontSize="12">{today.slice(5)}</text>
      {LOL_LADDER_TIERS.map(tier => {
        const series = points.filter(row => row.tier === tier);
        return <g key={tier}>
          {series.slice(1).map((row, index) => {
            const prev = series[index];
            // 누락된 날짜를 연속 관측으로 보이지 않도록 선을 끊는다.
            return Date.parse(row.day) - Date.parse(prev.day) === 86400_000
              ? <line key={row.day} x1={x(prev.day)} y1={y(prev.cutoff_lp!)} x2={x(row.day)} y2={y(row.cutoff_lp!)} stroke={colors[tier]} strokeWidth="2" /> : null;
          })}
          {series.map(row => <circle key={row.day} cx={x(row.day)} cy={y(row.cutoff_lp!)} r="3" fill={colors[tier]}>
            <title>{row.day} {tierNames[tier]} {row.cutoff_lp} LP</title>
          </circle>)}
        </g>;
      })}
    </svg>
    <div className="flex flex-wrap gap-4 text-xs">{LOL_LADDER_TIERS.map(tier => <span key={tier} style={{ color: colors[tier] }}>{tierNames[tier]}</span>)}</div>
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
