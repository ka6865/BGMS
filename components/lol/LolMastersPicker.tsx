"use client";

import Link from "next/link";
import { Search } from "lucide-react";
import { useMemo, useState } from "react";
import type { LolChampion } from "@/lib/lol/champions";

export default function LolMastersPicker({ champions, version, available, selectedId }: {
  champions: LolChampion[]; version: string | null; available: number[]; selectedId?: number;
}) {
  const [query, setQuery] = useState("");
  const ready = useMemo(() => new Set(available), [available]);
  const visible = useMemo(() => {
    const needle = query.trim().toLocaleLowerCase("ko");
    return champions.filter(champion => !needle || champion.name.toLocaleLowerCase("ko").includes(needle))
      .sort((a, b) => Number(ready.has(b.id)) - Number(ready.has(a.id)) || a.name.localeCompare(b.name, "ko"));
  }, [champions, query, ready]);
  return <section aria-label="챔피언 선택" className="space-y-2">
    <label className="relative block">
      <span className="sr-only">챔피언 검색</span>
      <Search aria-hidden="true" className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-zinc-500" />
      <input type="search" value={query} onChange={event => setQuery(event.target.value)} placeholder="챔피언 검색"
        className="min-h-11 w-full rounded-lg border border-zinc-700 bg-zinc-900 pl-9 pr-3 text-sm outline-none placeholder:text-zinc-500 focus:border-amber-400" />
    </label>
    {visible.length === 0 ? <p className="px-1 py-3 text-sm text-zinc-400">검색한 이름의 챔피언이 없습니다.</p>
      : <ul className="grid max-h-44 grid-cols-[repeat(auto-fill,minmax(44px,1fr))] gap-1.5 overflow-y-auto pr-1 sm:max-h-32">{visible.map(champion => {
        const selected = champion.id === selectedId;
        return <li key={champion.id}>
          <Link href={`/lol/kr/masters?champion=${champion.id}`} aria-label={champion.name} aria-current={selected ? "true" : undefined} title={champion.name}
            className={`block aspect-square overflow-hidden rounded-md outline-offset-1 transition focus-visible:outline-2 focus-visible:outline-amber-400 ${selected
              ? "ring-2 ring-amber-400" : ready.has(champion.id) ? "hover:ring-1 hover:ring-zinc-400" : "opacity-35 grayscale hover:opacity-60"}`}>
            {version && <img src={`https://ddragon.leagueoflegends.com/cdn/${version}/img/champion/${champion.imageId}.png`} alt="" width={44} height={44}
              loading="lazy" decoding="async" className="size-full bg-zinc-800 object-cover" />}
          </Link>
        </li>;
      })}</ul>}
  </section>;
}
