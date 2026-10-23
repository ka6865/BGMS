import type { LolSearchResult } from "@/lib/lol/riotSearch.server";
import LolTierEmblem from "./LolTierEmblem";
import LolRankedGraph from "./LolRankedGraph";
import { formatPercent } from "./lolFormat";

const QUEUES = [
  ["RANKED_SOLO_5x5", "솔로 랭크"],
  ["RANKED_FLEX_SR", "자유 랭크"],
] as const;

export default function LolRankCards({ ranked, rankedHistory }: {
  ranked: LolSearchResult["ranked"];
  rankedHistory?: LolSearchResult["rankedHistory"];
}) {
  return (
    <section aria-label="랭크" data-testid="lol-ranks" className="grid min-w-0 gap-3 sm:grid-cols-2 lg:grid-cols-1">
      {QUEUES.map(([queue, label]) => {
        const rank = ranked.find((entry) => entry.queueType === queue);
        const total = rank ? rank.wins + rank.losses : 0;
        const history = rankedHistory?.[queue];
        return (
          <div key={queue} className="rounded-xl border border-zinc-800 bg-zinc-900 p-4 tabular-nums">
            <h3 className="text-xs font-semibold text-zinc-400">{label}</h3>
            <div className="mt-3 flex items-center justify-between gap-3">
              <LolTierEmblem tier={rank?.tier} rank={rank?.rank} />
              {rank && <span className="shrink-0 text-sm font-semibold">{rank.leaguePoints} LP</span>}
            </div>
            {rank ? (
              <p className="mt-3 text-xs text-zinc-400">
                <span className="mb-1 block">이번 시즌 {total}게임 · {label} 한정</span>
                <span className="text-blue-300">{rank.wins}승</span>{" "}
                <span className="text-red-300">{rank.losses}패</span> · 승률{" "}
                {formatPercent(total ? (rank.wins / total) * 100 : null)}
              </p>
            ) : <p className="mt-3 text-xs text-zinc-500">이번 시즌 랭크 기록 없음</p>}
            <p className="mt-3 text-xs text-zinc-400">
              최고 티어(BGMS 기록): {history?.highest
                ? `${history.highest.tier} ${history.highest.rank} · ${history.highest.lp} LP`
                : "기록 없음"}
            </p>
            <LolRankedGraph history={history} label={label} />
          </div>
        );
      })}
    </section>
  );
}
