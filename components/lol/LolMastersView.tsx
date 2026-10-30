import Link from "next/link";
import { Sparkles } from "lucide-react";
import type { LolChampion } from "@/lib/lol/champions";
import { lolRiotIdPath } from "@/lib/lol/riotId";
import type { LolMasterBoardView } from "@/lib/lol/ranking";
import LolMastersPicker from "./LolMastersPicker";
import LolTierEmblem from "./LolTierEmblem";
import LolWinBar from "./LolWinBar";

// 장인은 이번 시즌 솔로 랭크 판수 기준이다. 자체 점수, 평점, 승률 정렬을 쓰지 않는다. "점수", "실력", "1등" 표현은 쓰지 않는다.
export const LOL_MASTER_CONDITION = "이번 시즌 솔로 랭크 15판 이상, 승률 50% 이상, 판수 많은 순, 챌린저·그랜드마스터 대상";

export default function LolMastersView({ champions, version = null, championsError, board, boardError, selectedId }: {
  champions: LolChampion[]; version?: string | null; championsError: boolean; board: LolMasterBoardView | null; boardError: boolean; selectedId?: number;
}) {
  const available = board?.champions.filter(item => item.rows.length > 0).map(item => item.championId) ?? [];
  const fallback = champions.find(champion => available.includes(champion.id)) ?? champions[0];
  const current = champions.find(champion => champion.id === selectedId) ?? fallback;
  const entry = current ? board?.champions.find(item => item.championId === current.id) : undefined;
  const observed = board ? new Date(board.observedAt).toLocaleString("ko-KR", { timeZone: "Asia/Seoul" }) : null;
  const partial = board !== null && board.coverage < 100;
  return <main className="mx-auto w-full max-w-4xl space-y-4 px-4 py-6 text-zinc-100">
    <h1 className="text-xl font-bold">장인</h1>

    {current && <section aria-label={`${current.name} 장인 목록`} className="min-w-0 overflow-hidden rounded-xl border border-zinc-800 bg-zinc-900">
      <div className="relative flex min-h-44 items-end sm:min-h-56">
        <img src={`https://ddragon.leagueoflegends.com/cdn/img/champion/splash/${current.imageId}_0.jpg`} alt="" width={1215} height={717}
          className="absolute inset-0 size-full object-cover object-[50%_20%]" />
        <div aria-hidden="true" className="absolute inset-0 bg-linear-to-t from-zinc-900 via-zinc-900/45 to-transparent" />
        <div className="relative min-w-0 p-4">
          <h2 className="text-3xl font-black tracking-tight sm:text-4xl">{current.name}</h2>
          <p className="mt-1 flex items-center gap-1.5 text-sm font-medium text-amber-200"><Sparkles aria-hidden="true" className="size-4" />이번 시즌 솔로 랭크 판수 기준</p>
        </div>
      </div>
      <div className="space-y-2 p-3 sm:p-4">
        <p className="text-xs leading-5 text-zinc-300">조건: {LOL_MASTER_CONDITION}.</p>
        {partial && <p role="status" className="text-xs text-amber-200">수집 중, 판수가 실제보다 적을 수 있습니다.</p>}
        {!boardError && !board && <p role="status" className="py-4 text-center text-sm text-zinc-400">아직 집계되지 않았습니다. 수집이 끝나면 여기에 표시됩니다.</p>}
        {boardError && <p role="status" className="py-4 text-center text-sm text-amber-300">장인 게시본을 불러오지 못했습니다. 잠시 후 다시 확인해 주세요.</p>}
        {board && !entry && <p role="status" className="py-4 text-center text-sm text-zinc-300">조건을 만족한 플레이어가 아직 없습니다.</p>}
        {board && entry && <ol className="space-y-1">{entry.rows.map(row => {
          const path = lolRiotIdPath(row.riotId, "/lol/kr");
          const [name, tag] = row.riotId.split("#");
          const label = <><span className="truncate">{name}</span><span className="shrink-0 text-xs font-normal text-zinc-500">#{tag}</span></>;
          const nameClass = "flex min-h-7 min-w-0 items-center gap-1 text-sm font-semibold after:absolute after:inset-0";
          return <li key={row.rank} className="relative grid min-h-13 grid-cols-[1.5rem_auto_minmax(0,1fr)] items-center gap-x-2 py-1.5">
            <span className="text-right text-sm font-bold tabular-nums text-zinc-400">{row.rank}</span>
            <LolTierEmblem tier={row.tier} />
            <span className="min-w-0 space-y-1">
              {path ? <Link href={path} className={`${nameClass} hover:text-amber-200`}>{label}</Link> : <span className={nameClass}>{label}</span>}
              <span className="block text-xs tabular-nums text-zinc-400">{row.leaguePoints.toLocaleString()} LP · 판수 {row.games}</span>
              <LolWinBar wins={row.wins} losses={row.games - row.wins} />
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
      {board && <p role="note" className="text-amber-200">수집 범위: 챌린저·그랜드마스터 {board.playerCount.toLocaleString()}명 중 {board.coverage}% 확인. 판수는 수집된 경기 기준이며 시즌 전체 판수가 아닐 수 있습니다.</p>}
      {observed && <p>{observed} KST 기준. 공식 명단과 수집된 경기 기록의 집계이며 자체 계산 값이 아닙니다.</p>}
      <p>Riot ID 삭제를 요청하면 즉시 이 화면에서 제외하고 작업 데이터도 지웁니다. 절차는 <Link href="/privacy" className="underline">개인정보처리방침</Link>을 따릅니다.</p>
    </footer>
  </main>;
}
