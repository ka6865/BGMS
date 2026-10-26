import { useState } from "react";
import type { LolSearchResult } from "@/lib/lol/riotSearch.server";
import LolTierEmblem from "./LolTierEmblem";
import LolRankedGraph from "./LolRankedGraph";
import { formatLolTier, formatPercent } from "./lolFormat";

const QUEUES = [
  ["RANKED_SOLO_5x5", "솔로 랭크"],
  ["RANKED_FLEX_SR", "자유 랭크"],
] as const;

type Queue = (typeof QUEUES)[number][0];

export default function LolRankCards({ ranked, rankedHistory }: {
  ranked: LolSearchResult["ranked"];
  rankedHistory?: LolSearchResult["rankedHistory"];
}) {
  // 모바일·태블릿에서는 첫 경기 카드가 빨리 보이도록 그래프를 접어 두고, 넓은 화면(lg)에서는 항상 펼친다.
  const [openGraphs, setOpenGraphs] = useState<Partial<Record<Queue, boolean>>>({});
  return (
    <section aria-label="랭크" data-testid="lol-ranks" className="grid min-w-0 grid-cols-2 gap-3 lg:grid-cols-1">
      {QUEUES.map(([queue, label]) => {
        const rank = ranked.find((entry) => entry.queueType === queue);
        const total = rank ? rank.wins + rank.losses : 0;
        const history = rankedHistory?.[queue];
        const graphOpen = !!openGraphs[queue];
        const graphId = `lol-ranked-graph-${queue}`;
        const winRate = formatPercent(total ? (rank!.wins / total) * 100 : null);
        return (
          <div key={queue} className="min-w-0 rounded-xl border border-zinc-800 bg-zinc-900 p-3 tabular-nums lg:p-4">
            <h3 className="text-xs font-semibold text-zinc-400">{label}</h3>
            <div className="mt-2 flex min-w-0 items-center justify-between gap-3">
              <LolTierEmblem tier={rank?.tier} rank={rank?.rank} />
              {rank && <span className="hidden shrink-0 text-sm font-semibold lg:inline">{rank.leaguePoints} LP</span>}
            </div>
            {rank ? (
              <p className="mt-2 text-xs text-zinc-400">
                {/* 모바일은 두 큐를 나란히 두므로 LP와 승패만 짧게 보여 준다. */}
                <span className="mb-1 block font-semibold text-zinc-100 lg:hidden">{rank.leaguePoints} LP</span>
                <span className="mb-1 hidden lg:block">이번 시즌 {total}게임 · {label} 한정</span>
                <span className="text-blue-300">{rank.wins}승</span>{" "}
                <span className="text-red-300">{rank.losses}패</span> · <span className="lg:hidden">{winRate}</span>
                <span className="hidden lg:inline">승률 {winRate}</span>
              </p>
            ) : <p className="mt-2 text-xs text-zinc-500">이번 시즌 랭크 기록 없음</p>}
            <button
              type="button"
              aria-expanded={graphOpen}
              aria-controls={graphId}
              onClick={() => setOpenGraphs((current) => ({ ...current, [queue]: !current[queue] }))}
              className="mt-1 inline-flex min-h-11 items-center text-xs font-semibold text-zinc-300 underline-offset-2 hover:text-white hover:underline lg:hidden"
            >
              {graphOpen ? "기록 접기" : "티어 기록 보기"}
            </button>
            <div id={graphId} className={`${graphOpen ? "" : "hidden"} lg:block`}>
              <p className="mt-2 text-xs text-zinc-400 lg:mt-3">
                최고 티어(BGMS 기록): {history?.highest
                  ? `${formatLolTier(history.highest.tier, history.highest.rank)} · ${history.highest.lp} LP`
                  : "기록 없음"}
              </p>
              <LolRankedGraph history={history} label={label} />
            </div>
          </div>
        );
      })}
    </section>
  );
}
