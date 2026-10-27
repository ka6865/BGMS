"use client";

import Link from "next/link";
import { useMemo, useState } from "react";
import { LOL_CHAMPION_TAG_LABELS, LOL_CHAMPION_TAGS, filterLolChampions, type LolChampion, type LolChampionTag } from "@/lib/lol/champions";
import {
  LOL_STAT_MIN_GAMES, LOL_STAT_POSITION_LABELS, LOL_STAT_POSITIONS, LOL_STAT_TIER_FILTERS, lolRate,
  type LolChampionStatRow, type LolStatPosition,
} from "@/lib/lol/championStats";

export type LolChampionListStats = { patch: string | null; matches: number; rows: LolChampionStatRow[]; tierFilter: string; error?: boolean };
type SortKey = "winRate" | "pickRate" | "banRate" | "games";

const percent = (value: number | null) => value === null ? "—" : `${(value * 100).toFixed(1)}%`;

function ChampionImage({ version, champion, size = 56 }: { version: string | null; champion: LolChampion; size?: number }) {
  return <img
    loading="lazy"
    decoding="async"
    src={`https://ddragon.leagueoflegends.com/cdn/${version}/img/champion/${champion.imageId}.png`}
    alt=""
    width={size}
    height={size}
    className="shrink-0 rounded-md bg-zinc-800"
    style={{ width: size, height: size }}
  />;
}

export default function LolChampionList({ champions, version, error = false, stats, initialPosition }: {
  champions: LolChampion[]; version: string | null; error?: boolean; stats?: LolChampionListStats; initialPosition?: LolStatPosition;
}) {
  const [query, setQuery] = useState("");
  const [tag, setTag] = useState<LolChampionTag | null>(null);
  const [position, setPosition] = useState<LolStatPosition>(initialPosition ?? "TOP");
  const [sort, setSort] = useState<SortKey>("pickRate");
  const hasStats = Boolean(stats && stats.rows.length);
  const visible = useMemo(() => filterLolChampions(champions, query, hasStats ? null : tag), [champions, query, tag, hasStats]);
  const byId = useMemo(() => new Map(champions.map(champion => [champion.id, champion])), [champions]);
  const tableRows = useMemo(() => {
    if (!stats || !hasStats) return [];
    const allowed = new Set(visible.map(champion => champion.id));
    return stats.rows.filter(row => row.team_position === position && allowed.has(row.champion_id) && byId.has(row.champion_id))
      .map(row => ({ ...row, champion: byId.get(row.champion_id)!, winRate: lolRate(row.wins, row.games), pickRate: lolRate(row.games, row.matches),
        banRate: lolRate(row.bans, row.matches), enough: row.games >= LOL_STAT_MIN_GAMES }))
      .sort((a, b) => Number(b.enough) - Number(a.enough) || (sort === "games" ? b.games - a.games : (b[sort] ?? -1) - (a[sort] ?? -1)));
  }, [stats, hasStats, visible, position, byId, sort]);
  const filters: [LolChampionTag | null, string][] = [[null, "전체"], ...LOL_CHAMPION_TAGS.map(item => [item, LOL_CHAMPION_TAG_LABELS[item]] as [LolChampionTag, string])];
  const tierQuery = stats?.tierFilter ?? "emerald_plus";

  return <main className="mx-auto w-full max-w-5xl space-y-5 px-4 py-6 text-zinc-100">
    <header>
      <h1 className="text-xl font-bold">챔피언</h1>
      <p className="mt-2 text-sm text-zinc-400">
        {hasStats && stats
          ? `${stats.patch} 패치 · 솔로 랭크 ${stats.matches.toLocaleString()}경기 표본입니다. BGMS가 모은 표본이라 실제 전체 통계와 다를 수 있습니다.`
          : `${version ? `${version} 패치 기준 ` : ""}챔피언 목록입니다. 승률·픽률·밴률은 표본을 모으는 중입니다.`}
      </p>
    </header>
    {error && <p role="status" className="text-sm text-amber-300">챔피언 목록을 불러오지 못했습니다. 잠시 후 다시 확인해 주세요.</p>}
    {stats?.error && <p role="status" className="text-sm text-amber-300">챔피언 통계를 불러오지 못했습니다. 잠시 후 다시 확인해 주세요.</p>}
    {!error && <>
      <div className="space-y-3">
        <label className="sr-only" htmlFor="lol-champion-search">챔피언 검색</label>
        <input
          id="lol-champion-search"
          type="search"
          value={query}
          onChange={event => setQuery(event.target.value)}
          placeholder="챔피언 이름 또는 초성"
          autoComplete="off"
          maxLength={40}
          className="min-h-11 w-full rounded-lg border border-zinc-700 bg-zinc-900 px-3 text-sm outline-none placeholder:text-zinc-600 focus:border-amber-400 sm:max-w-xs"
        />
        {hasStats ? <>
          <div role="group" aria-label="포지션" className="flex flex-wrap gap-1.5">
            {LOL_STAT_POSITIONS.map(item => <button key={item} type="button" aria-pressed={position === item} onClick={() => setPosition(item)}
              className={`min-h-9 rounded-lg px-3 text-[13px] font-semibold transition ${position === item
                ? "bg-amber-400 text-zinc-950" : "bg-zinc-900 text-zinc-300 ring-1 ring-zinc-800 hover:bg-zinc-800"}`}>{LOL_STAT_POSITION_LABELS[item]}</button>)}
          </div>
          <nav aria-label="티어" className="flex gap-1.5 overflow-x-auto pb-1">
            {LOL_STAT_TIER_FILTERS.map(item => <Link key={item.id} href={`/lol/kr/champions?tier=${item.id}&position=${position}`}
              aria-current={tierQuery === item.id ? "true" : undefined} scroll={false}
              className={`inline-flex min-h-9 shrink-0 items-center rounded-lg px-3 text-[13px] font-semibold ${tierQuery === item.id
                ? "bg-zinc-100 text-zinc-950" : "bg-zinc-900 text-zinc-400 ring-1 ring-zinc-800 hover:text-zinc-100"}`}>{item.label}</Link>)}
          </nav>
        </> : <div role="group" aria-label="역할군" className="flex flex-wrap gap-1.5">
          {filters.map(([value, label]) => <button
            key={label}
            type="button"
            aria-pressed={tag === value}
            onClick={() => setTag(value)}
            className={`min-h-9 rounded-lg px-3 text-[13px] font-semibold transition ${tag === value
              ? "bg-amber-400 text-zinc-950" : "bg-zinc-900 text-zinc-300 ring-1 ring-zinc-800 hover:bg-zinc-800"}`}
          >{label}</button>)}
        </div>}
      </div>
      {hasStats ? <section aria-label="챔피언 통계">
        {tableRows.length ? <table className="w-full table-fixed border-separate border-spacing-0 text-sm">
          <thead className="text-xs text-zinc-400">
            <tr>
              <th scope="col" className="w-8 py-2 text-left font-medium">#</th>
              <th scope="col" className="py-2 text-left font-medium">챔피언</th>
              {([["winRate", "승률"], ["pickRate", "픽률"], ["banRate", "밴률"]] as const).map(([key, label]) => <th key={key} scope="col" className="w-[17%] py-2 text-right font-medium sm:w-24">
                <button type="button" onClick={() => setSort(key)} aria-pressed={sort === key} className={`min-h-9 ${sort === key ? "text-amber-300" : "hover:text-zinc-100"}`}>{label}</button>
              </th>)}
              <th scope="col" className="hidden w-24 py-2 text-right font-medium sm:table-cell">
                <button type="button" onClick={() => setSort("games")} aria-pressed={sort === "games"} className={`min-h-9 ${sort === "games" ? "text-amber-300" : "hover:text-zinc-100"}`}>판수</button>
              </th>
            </tr>
          </thead>
          <tbody>
            {tableRows.map((row, index) => <tr key={row.champion_id} className={row.enough ? "" : "text-zinc-500"}>
              <td className="border-t border-zinc-800 py-2 text-xs tabular-nums text-zinc-500">{index + 1}</td>
              <td className="border-t border-zinc-800 py-2">
                <Link href={`/lol/kr/champions/${row.champion.imageId.toLowerCase()}?tier=${tierQuery}&position=${position}`} className="flex min-w-0 items-center gap-2 hover:text-amber-300">
                  <ChampionImage version={version} champion={row.champion} size={32} />
                  <span className="min-w-0">
                    <span className="block truncate font-semibold">{row.champion.name}</span>
                    <span className="block text-[11px] text-zinc-500 sm:hidden">{row.games.toLocaleString()}판</span>
                  </span>
                </Link>
              </td>
              <td className="border-t border-zinc-800 py-2 text-right tabular-nums">{row.enough ? percent(row.winRate) : "표본 부족"}</td>
              <td className="border-t border-zinc-800 py-2 text-right tabular-nums">{percent(row.pickRate)}</td>
              <td className="border-t border-zinc-800 py-2 text-right tabular-nums">{percent(row.banRate)}</td>
              <td className="hidden border-t border-zinc-800 py-2 text-right tabular-nums sm:table-cell">{row.games.toLocaleString()}</td>
            </tr>)}
          </tbody>
        </table> : <p className="py-6 text-sm text-zinc-400">조건에 맞는 챔피언이 없습니다.</p>}
        <p className="mt-3 text-xs text-zinc-500">{LOL_STAT_MIN_GAMES}판 미만은 승률 대신 “표본 부족”으로 표시하고 목록 아래에 둡니다.</p>
      </section> : <>
        <p className="text-xs text-zinc-500" aria-live="polite">{visible.length}개 챔피언</p>
        {visible.length ? <ul aria-label="챔피언 목록" className="grid grid-cols-3 gap-2 min-[400px]:grid-cols-4 sm:grid-cols-6 lg:grid-cols-8">
          {visible.map(champion => <li key={champion.id} className="min-w-0 rounded-lg bg-zinc-900 p-2 text-center ring-1 ring-zinc-800">
            <div className="flex justify-center"><ChampionImage version={version} champion={champion} /></div>
            <p className="mt-1.5 truncate text-[13px] font-semibold">{champion.name}</p>
            <p className="truncate text-[11px] text-zinc-500">{champion.tags.map(item => LOL_CHAMPION_TAG_LABELS[item]).join(" · ") || "\u00a0"}</p>
          </li>)}
        </ul> : <p className="py-6 text-sm text-zinc-400">조건에 맞는 챔피언이 없습니다.</p>}
      </>}
    </>}
  </main>;
}
