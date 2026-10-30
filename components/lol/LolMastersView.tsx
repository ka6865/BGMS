import Link from "next/link";
import type { LolChampion } from "@/lib/lol/champions";
import { MASTERY_CHAMPION_LIMIT, MASTERY_SAMPLE_MIN, type LolMasteryBoardView } from "@/lib/lol/ranking";
import { lolRiotIdPath } from "@/lib/lol/riotId";

// 장인 탭은 챔피언 숙련도 포인트 상위만 보여 준다. "점수", "실력", "1등" 표현은 쓰지 않는다.
export default function LolMastersView({ champions, championsError, board, boardError, selectedId }: {
  champions: LolChampion[]; championsError: boolean; board: LolMasteryBoardView | null; boardError: boolean; selectedId?: number;
}) {
  const withRows = new Set(board?.champions.map(item => item.championId) ?? []);
  const fallback = champions.find(champion => board?.champions.some(item => item.championId === champion.id && item.status === "ok"))
    ?? champions[0];
  const current = champions.find(champion => champion.id === selectedId) ?? fallback;
  const entry = current ? board?.champions.find(item => item.championId === current.id) : undefined;
  const observed = board ? new Date(board.observedAt).toLocaleString("ko-KR", { timeZone: "Asia/Seoul" }) : null;
  return <main className="mx-auto w-full max-w-4xl space-y-6 px-4 py-6 text-zinc-100">
    <header className="space-y-2">
      <h1 className="text-xl font-bold">장인 · 챔피언 숙련도 상위</h1>
      <p className="text-sm text-zinc-300">챔피언을 고르면 챌린저·그랜드마스터 명단 대상자 가운데 그 챔피언의 Riot 숙련도 포인트가 높은 순서입니다.</p>
      <p className="text-sm text-amber-200" role="note">챌린저·그랜드마스터 {board ? board.playerCount.toLocaleString() : "N"}명 중, 숙련도 상위 10개 챔피언 기준이며 서버 전체 순위가 아닙니다.</p>
    </header>

    {championsError && <p role="status" className="text-sm text-amber-300">챔피언 목록을 불러오지 못했습니다. 잠시 후 다시 확인해 주세요.</p>}
    {!championsError && champions.length > 0 && <form method="get" action="/lol/kr/masters" className="flex flex-wrap items-end gap-2">
      <label className="flex min-w-0 flex-1 flex-col gap-1 text-sm text-zinc-300">챔피언
        <select name="champion" defaultValue={current?.id} className="min-h-11 rounded-lg border border-zinc-700 bg-zinc-900 px-3 text-base text-zinc-100">
          {champions.map(champion => <option key={champion.id} value={champion.id}>{champion.name}{withRows.has(champion.id) ? "" : " (표본 없음)"}</option>)}
        </select>
      </label>
      <button type="submit" className="min-h-11 rounded-lg bg-amber-400 px-4 text-sm font-semibold text-zinc-950">보기</button>
    </form>}

    {boardError && <p role="status" className="text-sm text-amber-300">장인 게시본을 불러오지 못했습니다. 잠시 후 다시 확인해 주세요.</p>}
    {!boardError && !board && <p role="status" className="text-sm text-zinc-400">아직 집계되지 않았습니다. 수집이 끝나면 여기에 표시됩니다.</p>}

    {board && current && <section aria-label={`${current.name} 숙련도 상위`} className="min-w-0 space-y-3">
      <h2 className="font-semibold">{current.name} · 챔피언 숙련도 상위 {MASTERY_CHAMPION_LIMIT}명</h2>
      <p className="text-xs text-zinc-400">기준 {observed} KST · 공식 숙련도 포인트 순서입니다. 자체 계산 값이 아닙니다.</p>
      {!entry || entry.status === "insufficient"
        ? <p className="rounded-lg border border-zinc-800 px-3 py-4 text-sm text-zinc-300">
            표본 부족: 이 챔피언을 상위 10개 챔피언에 둔 명단 대상자가 {entry?.sampleSize ?? 0}명입니다(기준 {MASTERY_SAMPLE_MIN}명).
          </p>
        : <>
          <table className="hidden w-full text-left text-sm sm:table">
            <thead className="text-zinc-400"><tr><th scope="col" className="py-2">순위</th><th scope="col">Riot ID</th><th scope="col" className="text-right">숙련도 포인트</th><th scope="col" className="text-right">레벨</th></tr></thead>
            <tbody>{entry.entries.map(row => {
              const path = lolRiotIdPath(row.riotId, "/lol/kr");
              return <tr key={row.rank} className="border-t border-zinc-800">
                <td className="py-2 tabular-nums">{row.rank}</td>
                <td>{path ? <Link href={path} className="inline-flex min-h-11 items-center underline-offset-2 hover:underline">{row.riotId}</Link> : row.riotId}</td>
                <td className="text-right tabular-nums">{row.points.toLocaleString()}</td>
                <td className="text-right tabular-nums">{row.level}</td>
              </tr>;
            })}</tbody>
          </table>
          <ol className="space-y-2 sm:hidden">{entry.entries.map(row => {
            const path = lolRiotIdPath(row.riotId, "/lol/kr");
            return <li key={row.rank} className="flex min-w-0 items-center gap-3 rounded-lg border border-zinc-800 px-3 py-2">
              <span className="w-8 shrink-0 tabular-nums text-zinc-400">{row.rank}</span>
              <span className="min-w-0 flex-1">
                {path ? <Link href={path} className="block min-h-11 truncate py-2 font-medium underline-offset-2 hover:underline">{row.riotId}</Link>
                  : <span className="block truncate py-2 font-medium">{row.riotId}</span>}
                <span className="block text-xs text-zinc-400">{row.points.toLocaleString()} 포인트 · 레벨 {row.level}</span>
              </span>
            </li>;
          })}</ol>
        </>}
    </section>}

    <footer className="space-y-1 border-t border-zinc-800 pt-4 text-xs text-zinc-400">
      <p>이 화면은 하루 한 번 수집한 공식 숙련도 포인트를 보여 줍니다. 서버 전체 순위가 아니며 승률이나 플레이 수준을 평가하지 않습니다.</p>
      <p>Riot ID 삭제를 요청하면 다음 게시부터 이 화면에서 제외합니다. 절차는 <Link href="/privacy" className="underline">개인정보처리방침</Link>을 따릅니다.</p>
    </footer>
  </main>;
}
