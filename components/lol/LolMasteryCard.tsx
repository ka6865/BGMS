import type { LolChampionPerformance, LolMasteryComparison } from "@/lib/lol/types";
import { hasGoodLolRecentPerformance, lolMasteryBadge } from "@/lib/lol/mastery";

function RecentPerformance({ champion, masteryTop }: { champion?: LolChampionPerformance; masteryTop?: boolean }) {
  if (!champion) return <p className="text-xs text-zinc-500">최근 성과 표본 없음</p>;
  const badge = masteryTop === undefined ? null : lolMasteryBadge(champion, masteryTop);
  return <div className="text-xs text-zinc-400">
    <p>{champion.games}판 · 승률 {champion.winRatePct.toFixed(0)}% · 합산 KDA {champion.perfect ? "Perfect" : champion.kda?.toFixed(2) ?? "—"}</p>
    {badge && <span className="mt-1 inline-block rounded bg-zinc-800 px-1.5 py-0.5 text-zinc-200">{badge}</span>}
  </div>;
}

export default function LolMasteryCard({ mastery }: { mastery?: LolMasteryComparison }) {
  const recent = mastery?.recent;
  const topIds = new Set(mastery?.champions.map(champion => champion.championId));
  const good = recent?.champions.filter(hasGoodLolRecentPerformance) ?? [];
  return <section aria-label="챔피언 숙련도와 최근 성과" data-testid="lol-mastery" className="min-w-0 rounded-xl border border-zinc-800 bg-zinc-900 p-4">
    <h3 className="text-sm font-semibold">챔피언 숙련도와 최근 성과</h3>
    <p className="mt-2 text-xs leading-relaxed text-zinc-500">누적 숙련도와 저장된 최근 성과를 각각 표시합니다.</p>
    <h4 className="mt-4 text-xs font-semibold text-zinc-300">많이 플레이(숙련도 상위)</h4>
    {!mastery || mastery.status === "failed" ? <p role="status" className="mt-2 text-xs text-zinc-400">숙련도 정보를 불러오지 못했습니다</p>
      : mastery.champions.length === 0 ? <p className="mt-2 text-xs text-zinc-500">숙련도 기록이 없습니다.</p>
        : <ul className="mt-2 divide-y divide-zinc-800">
          {mastery.champions.map(champion => <li key={champion.championId} className="min-w-0 py-2">
            <p className="break-words text-sm">{champion.championName}</p>
            <p className="mt-1 text-xs text-zinc-400">레벨 {champion.championLevel} · {champion.championPoints.toLocaleString("ko-KR")} 포인트</p>
            <p className="mb-1 text-xs text-zinc-500">마지막 플레이 {champion.lastPlayTime > 0
              ? new Date(champion.lastPlayTime).toLocaleDateString("ko-KR", { timeZone: "Asia/Seoul" }) : "기록 없음"}</p>
            {recent?.status === "ready" && <RecentPerformance champion={recent.champions.find(row => row.championId === champion.championId)} masteryTop />}
          </li>)}
        </ul>}
    <h4 className="mt-4 text-xs font-semibold text-zinc-300">최근 성과 좋음</h4>
    {recent?.status === "ready" ? <>
      <p className="mt-2 text-xs leading-relaxed text-zinc-500">BGMS에 저장된 최근 {recent.sampleSize}경기 기준 · 솔로·자유·일반·칼바람</p>
      <p className="mt-1 text-xs leading-relaxed text-zinc-500">다시하기·5분 미만 경기 제외. 3판 이상, 승률 60% 이상과 합산 KDA 3 이상(또는 Perfect).</p>
      {good.length ? <ul className="mt-2 divide-y divide-zinc-800">{good.map(champion => <li key={champion.championId} className="min-w-0 py-2">
        <p className="mb-1 break-words text-sm">{champion.championName}</p>
        <RecentPerformance champion={champion} masteryTop={mastery?.status === "ready" ? topIds.has(champion.championId) : undefined} />
      </li>)}</ul> : <p className="mt-2 text-xs text-zinc-500">조건을 충족하는 챔피언이 없습니다.</p>}
      <p className="mt-2 text-xs leading-relaxed text-zinc-500">떠오르는 챔피언은 숙련도 상위 10개 밖의 최근 성과입니다.</p>
    </> : <p className="mt-2 text-xs text-zinc-500">저장된 최근 성과를 불러오지 못했습니다.</p>}
  </section>;
}
