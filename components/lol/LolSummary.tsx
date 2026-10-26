import { useState, type ReactNode } from "react";
import type { LolQueueSummary } from "@/lib/lol/riotSearch.server";
import { formatMetric, formatPercent } from "./lolFormat";

const POSITIONS = [
  ["TOP", "탑"], ["JUNGLE", "정글"], ["MIDDLE", "미드"],
  ["BOTTOM", "원딜"], ["UTILITY", "서폿"],
] as const;

const QUEUE_LABELS = { all: "전체", solo: "솔로", flex: "자유", aram: "칼바람" };

export default function LolSummary({ summary, children }: {
  summary?: LolQueueSummary;
  children: ReactNode;
}) {
  const winRate = summary?.winRatePct;
  const percentage = winRate == null ? 0 : Math.max(0, Math.min(100, winRate));
  return (
    <header data-testid="lol-summary-header" className="rounded-xl border border-zinc-800 bg-zinc-900 p-4 tabular-nums">
      <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
        <div>
          <h2 className="text-sm font-semibold">최근 경기</h2>
          <p className="mt-1 text-[11px] text-zinc-500">
            최근 {summary?.sampleSize ?? 0}경기 중 유효 {summary?.validSampleSize ?? 0}경기 · 제외 {summary?.excludedCount ?? 0}경기 · {QUEUE_LABELS[summary?.queue ?? "all"]}
          </p>
        </div>
        {children}
      </div>
      {/* 유효 경기가 없으면 "미제공"을 반복하지 않고 안내 한 줄만 보여 준다. */}
      {!summary?.validSampleSize ? (
        <p data-testid="lol-summary-empty" className="text-xs text-zinc-500">
          {summary?.sampleSize ? "다시하기·5분 미만 경기만 있어 요약할 경기가 없습니다." : "요약할 경기가 없습니다."}
        </p>
      ) : (
      <div data-testid="lol-summary-metrics" className="grid grid-cols-2 items-center gap-3 @min-[560px]/history:grid-cols-[auto_1.3fr_1fr_.8fr]">
        <div className="flex items-center gap-3">
          <svg viewBox="0 0 40 40" className="h-14 w-14 shrink-0" role="img" aria-label={`승률 ${formatPercent(winRate)}`}>
            <circle cx="20" cy="20" r="16" fill="none" stroke="currentColor" strokeWidth="4" className="text-red-400/30" />
            <circle cx="20" cy="20" r="16" fill="none" stroke="currentColor" strokeWidth="4"
              pathLength="100" strokeDasharray={`${percentage} 100`} transform="rotate(-90 20 20)" className="text-blue-400" />
            <text x="20" y="22" textAnchor="middle" fill="currentColor" fontSize="7">{formatPercent(winRate)}</text>
          </svg>
          <p className="text-xs leading-5">
            <b className="whitespace-nowrap">{summary?.validSampleSize ?? 0}전</b><br />
            <span className="whitespace-nowrap text-blue-300">{formatMetric(summary?.wins)}승</span>{" "}
            <span className="whitespace-nowrap text-red-300">{formatMetric(summary?.losses)}패</span>
          </p>
        </div>
        <div>
          <h3 className="text-[11px] text-zinc-500">평균 K/D/A</h3>
          <p className="mt-1 text-sm font-bold">
            {formatMetric(summary?.averageKills, 1)} / {formatMetric(summary?.averageDeaths, 1)} / {formatMetric(summary?.averageAssists, 1)}
          </p>
        </div>
        <div>
          <h3 className="text-[11px] text-zinc-500">KDA 비율</h3>
          <p className="mt-1 text-sm font-bold">
            {summary?.perfect ? "Perfect" : summary?.averageKda == null ? "미제공" : `${summary.averageKda.toFixed(2)}:1`}
          </p>
        </div>
        <div>
          <h3 className="text-[11px] text-zinc-500">평균 관여율</h3>
          <p className="mt-1 text-sm font-bold">{formatPercent(summary?.averageKillParticipationPct)}</p>
        </div>
      </div>
      )}
    </header>
  );
}

export function LolSidebarStats({ summary, onSearch, dataDragonVersion }: {
  summary?: LolQueueSummary;
  dataDragonVersion?: string;
  onSearch: (riotId: string, ref?: string) => void;
}) {
  const champions = [...(summary?.champions ?? [])].sort((a, b) => b.games - a.games);
  return (
    <>
      <p className="text-[11px] text-zinc-500">최근 {summary?.sampleSize ?? 0}경기 · {QUEUE_LABELS[summary?.queue ?? "all"]}</p>
      <section aria-label="최근 챔피언" className="rounded-xl border border-zinc-800 bg-zinc-900 p-4 tabular-nums">
        <h3 className="text-xs font-semibold text-zinc-400">최근 표본 챔피언</h3>
        <ul aria-label="챔피언별 최근 통계" className="mt-3 space-y-3">
          {champions.map((champion) => (
            <li key={champion.championId} className="flex min-w-0 items-center gap-2">
              <img src={champion.championImageId
                ? `https://ddragon.leagueoflegends.com/cdn/${dataDragonVersion}/img/champion/${champion.championImageId}.png`
                : undefined}
                alt="" width={32} height={32} className="h-8 w-8 shrink-0 rounded bg-zinc-800"
                onError={(event) => { event.currentTarget.hidden = true; }} />
              <div className="min-w-0 flex-1 text-[11px]">
                <b className="block truncate text-xs">{champion.championName}</b>
                <span className="text-zinc-400">{champion.games}전 {champion.wins}승 {champion.games - champion.wins}패</span>
              </div>
              <div className="shrink-0 text-right text-[11px]">
                <b>{formatPercent(champion.winRatePct)}</b>
                <p className="mt-0.5 text-zinc-400">
                  KDA {champion.perfect ? "Perfect" : champion.averageKda == null ? "미제공" : `${champion.averageKda.toFixed(2)}:1`}
                </p>
              </div>
            </li>
          ))}
        </ul>
        {!champions.length && <p className="mt-3 text-xs text-zinc-500">표시할 챔피언 통계 없음</p>}
      </section>
      <section className="rounded-xl border border-zinc-800 bg-zinc-900 p-4 tabular-nums">
        <h3 className="text-xs font-semibold text-zinc-400">포지션 분포</h3>
        <div aria-label="포지션별 경기 수" className="mt-3 grid grid-cols-5 gap-2">
          {POSITIONS.map(([key, label]) => {
            const count = summary?.positions?.[key];
            const height = summary?.validSampleSize ? ((count ?? 0) / summary.validSampleSize) * 100 : 0;
            return (
              <div key={key} className="text-center text-[11px] text-zinc-400">
                <div className="mb-2 flex h-12 items-end overflow-hidden rounded bg-zinc-800">
                  <div className="w-full rounded bg-amber-400" style={{ height: `${height}%` }} />
                </div>
                {label} {count ?? "미제공"}
              </div>
            );
          })}
        </div>
        {!!summary?.positions?.미분류 && <p className="mt-2 text-[11px] text-zinc-500">미분류 {summary.positions.미분류}경기</p>}
      </section>
      <LolPeers summary={summary} dataDragonVersion={dataDragonVersion} onSearch={onSearch} />
    </>
  );
}

function winRateClass(value: number | null) {
  if (value === null) return "text-zinc-500";
  if (value >= 60) return "text-sky-300";
  if (value < 50) return "text-rose-300";
  return "text-zinc-200";
}

function LolPeers({ summary, onSearch, dataDragonVersion }: {
  summary?: LolQueueSummary;
  dataDragonVersion?: string;
  onSearch: (riotId: string, ref?: string) => void;
}) {
  const [side, setSide] = useState<"teammates" | "opponents">("teammates");
  const rows = side === "teammates" ? summary?.teammates : summary?.opponents;
  return (
    <section aria-label="함께 플레이한 소환사" className="overflow-hidden rounded-xl border border-zinc-800 bg-zinc-900 tabular-nums">
      <h3 className="px-4 pt-4 text-center text-xs font-semibold text-zinc-300">
        함께 플레이한 소환사 <span className="text-zinc-500">(최근 {summary?.validSampleSize ?? 0}게임)</span>
      </h3>
      <div role="tablist" aria-label="소환사 구분" className="grid grid-cols-2 gap-2 px-4 py-3">
        {([["teammates", "우리 팀"], ["opponents", "상대 팀"]] as const).map(([key, label]) => (
          <button
            key={key}
            type="button"
            role="tab"
            aria-selected={side === key}
            onClick={() => setSide(key)}
            className={`min-h-11 rounded-lg border text-xs font-semibold transition ${side === key
              ? "border-emerald-400/70 bg-emerald-400/10 text-emerald-300"
              : "border-zinc-700 text-zinc-400 hover:text-zinc-200"}`}
          >
            {label}
          </button>
        ))}
      </div>
      {rows?.length ? (
        <table className="w-full table-fixed text-xs">
          <thead className="border-y border-zinc-800 text-[11px] text-zinc-500">
            <tr>
              <th scope="col" className="py-2 pl-4 text-left font-medium">소환사 정보</th>
              <th scope="col" className="w-11 font-medium">게임 수</th>
              <th scope="col" className="w-12 font-medium">승패</th>
              <th scope="col" className="w-12 pr-4 text-right font-medium">승률</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-zinc-800/70">
            {rows.map((player) => {
              const [gameName, tagLine] = player.riotId.split("#");
              return (
                <tr key={player.playerKey ?? player.riotId} data-testid="lol-peer">
                  <td className="py-2 pl-4">
                    <button
                      type="button"
                      onClick={() => onSearch(player.riotId, player.ref)}
                      className="flex w-full min-w-0 items-center gap-2 text-left hover:text-amber-300"
                    >
                      {player.profileIconId !== undefined && dataDragonVersion ? (
                        <img
                          src={`https://ddragon.leagueoflegends.com/cdn/${dataDragonVersion}/img/profileicon/${player.profileIconId}.png`}
                          alt=""
                          width={28}
                          height={28}
                          onError={(event) => { event.currentTarget.style.visibility = "hidden"; }}
                          className="h-7 w-7 shrink-0 rounded-md bg-zinc-800"
                        />
                      ) : <span aria-hidden="true" className="h-7 w-7 shrink-0 rounded-md bg-zinc-800" />}
                      <span className="min-w-0 truncate font-semibold">
                        {gameName}
                        {tagLine !== undefined && <span className="ml-1 font-normal text-zinc-500">#{tagLine}</span>}
                      </span>
                    </button>
                  </td>
                  <td className="text-center text-zinc-300">{player.games}</td>
                  <td className="text-center text-zinc-300">{player.wins}-{player.losses}</td>
                  <td className={`pr-4 text-right font-semibold ${winRateClass(player.winRatePct)}`}>{formatPercent(player.winRatePct)}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      ) : (
        <p className="border-t border-zinc-800 px-4 py-4 text-xs text-zinc-500">
          {rows ? `2경기 이상 함께한 ${side === "teammates" ? "팀원" : "상대"} 없음` : side === "opponents" ? "상대 팀 정보 미제공" : "함께한 소환사 미제공"}
        </p>
      )}
    </section>
  );
}
