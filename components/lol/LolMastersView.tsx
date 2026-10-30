import Link from "next/link";
import { Sparkles, Star } from "lucide-react";
import type { LolChampion } from "@/lib/lol/champions";
import { MASTERY_SAMPLE_MIN, type LolMasteryBoardView } from "@/lib/lol/ranking";
import { lolRiotIdPath } from "@/lib/lol/riotId";
import LolMastersPicker from "./LolMastersPicker";

// 장인 탭은 챔피언 숙련도 포인트 상위만 보여 준다. "점수", "실력", "1등" 표현은 쓰지 않는다.
export default function LolMastersView({ champions, version = null, championsError, board, boardError, selectedId }: {
  champions: LolChampion[]; version?: string | null; championsError: boolean; board: LolMasteryBoardView | null; boardError: boolean; selectedId?: number;
}) {
  const available = board?.champions.filter(item => item.status === "ok").map(item => item.championId) ?? [];
  const fallback = champions.find(champion => available.includes(champion.id)) ?? champions[0];
  const current = champions.find(champion => champion.id === selectedId) ?? fallback;
  const entry = current ? board?.champions.find(item => item.championId === current.id) : undefined;
  const observed = board ? new Date(board.observedAt).toLocaleString("ko-KR", { timeZone: "Asia/Seoul" }) : null;
  const top = entry?.entries[0]?.points ?? 0;
  const scope = `챌린저·그랜드마스터 ${board ? board.playerCount.toLocaleString() : "N"}명 중, 숙련도 상위 10개 챔피언 기준이며 서버 전체 순위가 아닙니다.`;
  return <main className="mx-auto w-full max-w-4xl space-y-4 px-4 py-6 text-zinc-100">
    <h1 className="text-xl font-bold">장인</h1>

    {current && <section aria-label={`${current.name} 숙련도 상위`} className="min-w-0 overflow-hidden rounded-xl border border-zinc-800 bg-zinc-900">
      <div className="relative flex min-h-44 items-end sm:min-h-56">
        <img src={`https://ddragon.leagueoflegends.com/cdn/img/champion/splash/${current.imageId}_0.jpg`} alt="" width={1215} height={717}
          className="absolute inset-0 size-full object-cover object-[50%_20%]" />
        <div aria-hidden="true" className="absolute inset-0 bg-linear-to-t from-zinc-900 via-zinc-900/45 to-transparent" />
        <div className="relative min-w-0 p-4">
          <h2 className="text-3xl font-black tracking-tight sm:text-4xl">{current.name}</h2>
          <p className="mt-1 flex items-center gap-1.5 text-sm font-medium text-amber-200"><Sparkles aria-hidden="true" className="size-4" />챔피언 숙련도 상위</p>
        </div>
      </div>
      <div className="space-y-2 p-3 sm:p-4">
        {!boardError && !board && <p role="status" className="py-4 text-center text-sm text-zinc-400">아직 집계되지 않았습니다. 수집이 끝나면 여기에 표시됩니다.</p>}
        {boardError && <p role="status" className="py-4 text-center text-sm text-amber-300">장인 게시본을 불러오지 못했습니다. 잠시 후 다시 확인해 주세요.</p>}
        {board && (!entry || entry.status === "insufficient") && <p className="py-4 text-center text-sm text-zinc-300">
          표본 부족: 이 챔피언을 상위 10개 챔피언에 둔 명단 대상자가 {entry?.sampleSize ?? 0}명입니다(기준 {MASTERY_SAMPLE_MIN}명).
        </p>}
        {board && entry?.status === "ok" && <ol className="space-y-1">{entry.entries.map(row => {
          const path = lolRiotIdPath(row.riotId, "/lol/kr");
          const [name, tag] = row.riotId.split("#");
          const label = <><span className="truncate">{name}</span><span className="shrink-0 text-xs font-normal text-zinc-500">#{tag}</span></>;
          const nameClass = "flex min-h-7 min-w-0 items-center gap-1 text-sm font-semibold after:absolute after:inset-0";
          return <li key={row.rank} className="relative grid min-h-13 grid-cols-[1.5rem_minmax(0,1fr)_auto] items-center gap-x-2 py-1.5">
            <span className="text-right text-sm font-bold tabular-nums text-zinc-400">{row.rank}</span>
            <span className="min-w-0">
              {path ? <Link href={path} className={`${nameClass} hover:text-amber-200`}>{label}</Link> : <span className={nameClass}>{label}</span>}
              <span aria-hidden="true" className="block h-1.5 overflow-hidden rounded-full bg-zinc-800">
                <span className="block h-full rounded-full bg-linear-to-r from-amber-600 to-amber-300" style={{ width: `${top ? row.points / top * 100 : 0}%` }} />
              </span>
            </span>
            <span className="text-right">
              <span className="block text-sm font-bold tabular-nums">{row.points.toLocaleString()}</span>
              <span className="flex items-center justify-end gap-1 text-[11px] tabular-nums text-zinc-400"><Star aria-hidden="true" className="size-3 fill-amber-300 text-amber-300" />레벨 {row.level}</span>
            </span>
          </li>;
        })}</ol>}
      </div>
    </section>}

    {!current && boardError && <p role="status" className="text-sm text-amber-300">장인 게시본을 불러오지 못했습니다. 잠시 후 다시 확인해 주세요.</p>}
    {!current && !boardError && !board && <p role="status" className="text-sm text-zinc-400">아직 집계되지 않았습니다. 수집이 끝나면 여기에 표시됩니다.</p>}
    {championsError && <p role="status" className="text-sm text-amber-300">챔피언 목록을 불러오지 못했습니다. 잠시 후 다시 확인해 주세요.</p>}
    {!championsError && champions.length > 0 && <LolMastersPicker champions={champions} version={version} available={available} selectedId={current?.id} />}

    <footer className="space-y-1 border-t border-zinc-800 pt-3 text-xs leading-5 text-zinc-400">
      <p role="note" className="text-amber-200">{scope}</p>
      {observed && <p>{observed} KST 기준. Riot 공식 숙련도 포인트이며 승률이나 플레이 수준을 평가하지 않습니다.</p>}
      <p>Riot ID 삭제를 요청하면 다음 게시부터 이 화면에서 제외합니다. 절차는 <Link href="/privacy" className="underline">개인정보처리방침</Link>을 따릅니다.</p>
    </footer>
  </main>;
}
