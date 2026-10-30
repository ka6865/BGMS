// 승패를 숫자와 막대로 함께 보여 준다. 막대는 장식이므로 읽기 도구에는 숫자만 전달한다.
export default function LolWinBar({ wins, losses }: { wins: number; losses: number }) {
  const games = wins + losses;
  const rate = games ? wins / games * 100 : 0;
  return <span className="flex min-w-0 items-center gap-2 text-xs tabular-nums text-zinc-400">
    <span aria-hidden="true" className="h-1.5 w-16 shrink-0 overflow-hidden rounded-full bg-rose-500/35">
      <span className="block h-full rounded-full bg-sky-400" style={{ width: `${rate}%` }} />
    </span>
    <span className="truncate">{wins}승 {losses}패 <span className={rate >= 55 ? "font-semibold text-sky-300" : ""}>{rate.toFixed(0)}%</span></span>
  </span>;
}
