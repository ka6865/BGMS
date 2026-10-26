"use client";

import { useMemo, useState } from "react";
import { LOL_CHAMPION_TAG_LABELS, LOL_CHAMPION_TAGS, filterLolChampions, type LolChampion, type LolChampionTag } from "@/lib/lol/champions";

// 운영 키 승인 전 표본은 검색한 사람의 경기에 치우쳐 있어 승률·픽률·밴률은 공개하지 않는다.
export default function LolChampionList({ champions, version, error = false }: { champions: LolChampion[]; version: string | null; error?: boolean }) {
  const [query, setQuery] = useState("");
  const [tag, setTag] = useState<LolChampionTag | null>(null);
  const visible = useMemo(() => filterLolChampions(champions, query, tag), [champions, query, tag]);
  const filters: [LolChampionTag | null, string][] = [[null, "전체"], ...LOL_CHAMPION_TAGS.map(item => [item, LOL_CHAMPION_TAG_LABELS[item]] as [LolChampionTag, string])];
  return <main className="mx-auto w-full max-w-5xl space-y-5 px-4 py-6 text-zinc-100">
    <header>
      <h1 className="text-xl font-bold">챔피언</h1>
      <p className="mt-2 text-sm text-zinc-400">
        {version ? `${version} 패치 기준 ` : ""}챔피언 목록입니다. 승률·픽률·밴률은 표본을 충분히 모은 뒤 공개합니다.
      </p>
    </header>
    {error && <p role="status" className="text-sm text-amber-300">챔피언 목록을 불러오지 못했습니다. 잠시 후 다시 확인해 주세요.</p>}
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
        <div role="group" aria-label="역할군" className="flex flex-wrap gap-1.5">
          {filters.map(([value, label]) => <button
            key={label}
            type="button"
            aria-pressed={tag === value}
            onClick={() => setTag(value)}
            className={`min-h-9 rounded-lg px-3 text-[13px] font-semibold transition ${tag === value
              ? "bg-amber-400 text-zinc-950" : "bg-zinc-900 text-zinc-300 ring-1 ring-zinc-800 hover:bg-zinc-800"}`}
          >{label}</button>)}
        </div>
      </div>
      <p className="text-xs text-zinc-500" aria-live="polite">{visible.length}개 챔피언</p>
      {visible.length ? <ul aria-label="챔피언 목록" className="grid grid-cols-3 gap-2 min-[400px]:grid-cols-4 sm:grid-cols-6 lg:grid-cols-8">
        {visible.map(champion => <li key={champion.id} className="min-w-0 rounded-lg bg-zinc-900 p-2 text-center ring-1 ring-zinc-800">
          <img
            loading="lazy"
            decoding="async"
            src={`https://ddragon.leagueoflegends.com/cdn/${version}/img/champion/${champion.imageId}.png`}
            alt=""
            width={56}
            height={56}
            className="mx-auto size-14 rounded-md bg-zinc-800"
          />
          <p className="mt-1.5 truncate text-[13px] font-semibold">{champion.name}</p>
          <p className="truncate text-[11px] text-zinc-500">{champion.tags.map(item => LOL_CHAMPION_TAG_LABELS[item]).join(" · ") || "\u00a0"}</p>
        </li>)}
      </ul> : <p className="py-6 text-sm text-zinc-400">조건에 맞는 챔피언이 없습니다.</p>}
    </>}
  </main>;
}
