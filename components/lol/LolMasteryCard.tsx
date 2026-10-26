import { useState } from "react";
import type { LolChampionPerformance, LolMasteryComparison } from "@/lib/lol/types";
import { hasGoodLolRecentPerformance, lolMasteryBadge } from "@/lib/lol/mastery";

// 숙련도 상위 10개를 모두 펼치면 모바일에서 카드가 길어지므로 처음에는 5개만 보여 준다.
const MASTERY_PREVIEW = 5;

function winRateClass(value: number) {
  if (value >= 60) return "text-sky-300";
  if (value < 50) return "text-rose-300";
  return "text-zinc-200";
}

function kdaClass(champion: LolChampionPerformance) {
  if (champion.perfect || (champion.kda ?? 0) >= 5) return "text-amber-300";
  if ((champion.kda ?? 0) >= 3) return "text-sky-300";
  return "text-zinc-400";
}

function ChampionIcon({ imageId, version, level }: { imageId: string; version?: string; level?: number }) {
  return <div className="relative h-10 w-10 shrink-0">
    <img loading="lazy" decoding="async" src={imageId && version ? `https://ddragon.leagueoflegends.com/cdn/${version}/img/champion/${imageId}.png` : undefined}
      alt="" width={40} height={40} className="h-10 w-10 rounded-lg bg-zinc-800"
      onError={(event) => { event.currentTarget.style.visibility = "hidden"; }} />
    {level !== undefined && <span className="absolute -bottom-1 -right-1 rounded-md border border-zinc-900 bg-violet-600 px-1 text-[10px] font-bold leading-4 text-white tabular-nums">
      {level}
    </span>}
  </div>;
}

function Badge({ label }: { label: string }) {
  const style = label === "주력" ? "bg-amber-400/15 text-amber-300 ring-amber-400/30" : "bg-emerald-400/15 text-emerald-300 ring-emerald-400/30";
  return <span className={`shrink-0 rounded px-1.5 py-0.5 text-[10px] font-semibold ring-1 ${style}`}>{label}</span>;
}

function RecentStats({ champion }: { champion?: LolChampionPerformance }) {
  if (!champion) return <p className="w-24 shrink-0 text-right text-[11px] text-zinc-600">최근 성과 표본 없음</p>;
  return <div className="w-24 shrink-0 text-right tabular-nums">
    <p className={`text-sm font-semibold ${winRateClass(champion.winRatePct)}`}>
      {champion.winRatePct.toFixed(0)}%<span className="ml-1 text-[11px] font-normal text-zinc-500">{champion.games}판</span>
    </p>
    <div className="mt-1 h-1 overflow-hidden rounded bg-zinc-800" aria-hidden>
      <div className="h-full rounded bg-sky-400" style={{ width: `${Math.min(100, Math.max(0, champion.winRatePct))}%` }} />
    </div>
    <p className={`mt-1 text-[11px] ${kdaClass(champion)}`}>KDA {champion.perfect ? "Perfect" : champion.kda?.toFixed(2) ?? "—"}</p>
  </div>;
}

export default function LolMasteryCard({ mastery, dataDragonVersion }: { mastery?: LolMasteryComparison; dataDragonVersion?: string }) {
  const [showAll, setShowAll] = useState(false);
  const recent = mastery?.recent;
  const ready = recent?.status === "ready";
  const topIds = new Set(mastery?.champions.map(champion => champion.championId));
  const rising = ready && mastery?.status === "ready"
    ? recent.champions.filter(champion => hasGoodLolRecentPerformance(champion) && !topIds.has(champion.championId)) : [];
  const champions = mastery?.champions ?? [];
  const visibleChampions = showAll ? champions : champions.slice(0, MASTERY_PREVIEW);
  const hiddenCount = champions.length - MASTERY_PREVIEW;
  return <section aria-label="챔피언 숙련도와 최근 성과" data-testid="lol-mastery" className="min-w-0 rounded-xl border border-zinc-800 bg-zinc-900 p-4">
    <div className="flex items-baseline justify-between gap-2">
      <h3 className="text-sm font-semibold">챔피언 숙련도와 최근 성과</h3>
      {ready && <span className="shrink-0 text-[11px] text-zinc-500 tabular-nums">최근 {recent.sampleSize}경기</span>}
    </div>
    <h4 className="mt-3 text-[11px] font-semibold text-zinc-500">많이 플레이(숙련도 상위)</h4>
    {!mastery || mastery.status === "failed" ? <p role="status" className="mt-2 text-xs text-zinc-400">숙련도 정보를 불러오지 못했습니다</p>
      : mastery.champions.length === 0 ? <p className="mt-2 text-xs text-zinc-500">숙련도 기록이 없습니다.</p>
        : <><ul className="mt-1 divide-y divide-zinc-800/70">
          {visibleChampions.map(champion => {
            const performance = ready ? recent.champions.find(row => row.championId === champion.championId) : undefined;
            const badge = performance ? lolMasteryBadge(performance, true) : null;
            return <li key={champion.championId} className="flex min-w-0 items-center gap-3 py-2.5">
              <ChampionIcon imageId={champion.championImageId} version={dataDragonVersion} level={champion.championLevel} />
              <div className="min-w-0 flex-1">
                <p className="flex min-w-0 items-center gap-1.5">
                  <span className="truncate text-sm font-semibold">{champion.championName}</span>
                  {badge && <Badge label={badge} />}
                </p>
                <p className="mt-0.5 text-[11px] text-zinc-400 tabular-nums">{champion.championPoints.toLocaleString("ko-KR")} 포인트</p>
                <p className="text-[11px] text-zinc-600">마지막 플레이 {champion.lastPlayTime > 0
                  ? new Date(champion.lastPlayTime).toLocaleDateString("ko-KR", { timeZone: "Asia/Seoul", month: "long", day: "numeric" }) : "기록 없음"}</p>
              </div>
              {ready && <RecentStats champion={performance} />}
            </li>;
          })}
        </ul>
        {hiddenCount > 0 && <button
          type="button"
          aria-expanded={showAll}
          onClick={() => setShowAll(value => !value)}
          className="mt-1 min-h-11 w-full rounded-lg border border-zinc-800 text-xs font-semibold text-zinc-300 hover:text-white"
        >
          {showAll ? "접기" : `숙련도 상위 ${hiddenCount}개 더 보기`}
        </button>}</>}
    {ready ? rising.length > 0 && <>
      <h4 className="mt-3 text-[11px] font-semibold text-zinc-500">숙련도 상위 밖 최근 성과 좋음</h4>
      <ul className="mt-1 divide-y divide-zinc-800/70">{rising.map(champion => <li key={champion.championId} className="flex min-w-0 items-center gap-3 py-2.5">
        <ChampionIcon imageId={champion.championImageId} version={dataDragonVersion} />
        <p className="flex min-w-0 flex-1 items-center gap-1.5">
          <span className="truncate text-sm font-semibold">{champion.championName}</span>
          <Badge label={lolMasteryBadge(champion, false) ?? "떠오르는 챔피언"} />
        </p>
        <RecentStats champion={champion} />
      </li>)}</ul>
    </> : <p className="mt-3 text-xs text-zinc-500">저장된 최근 성과를 불러오지 못했습니다.</p>}
    <details className="group mt-3 border-t border-zinc-800 pt-2 text-[11px] leading-relaxed text-zinc-500">
      <summary className="cursor-pointer list-none text-zinc-500 hover:text-zinc-300">
        <span className="mr-1 inline-block transition group-open:rotate-90">›</span>집계 기준
      </summary>
      <p className="mt-1">숙련도는 Riot 누적 기록이고, 최근 성과는 {ready ? `BGMS에 저장된 최근 ${recent.sampleSize}경기 기준` : "BGMS에 저장된 경기 기준"} · 솔로·자유·일반·칼바람입니다.</p>
      <p>다시하기·5분 미만 경기는 제외합니다. 3판 이상, 승률 60% 이상과 합산 KDA 3 이상(또는 Perfect)이면 주력 또는 떠오르는 챔피언으로 표시합니다.</p>
    </details>
  </section>;
}
