"use client";

import { useMemo, useState } from "react";
import {
  LOL_AUGMENT_RARITIES, LOL_AUGMENT_RARITY_LABELS, filterLolMayhemAugments,
  type LolAugmentRarity, type LolMayhemCatalog,
} from "@/lib/lol/augments/catalog";

const rarityColors: Record<LolAugmentRarity, string> = { prismatic: "text-fuchsia-300", gold: "text-amber-300", silver: "text-zinc-300" };
const chip = (active: boolean) => `min-h-11 rounded-lg border px-3 text-sm font-semibold transition ${active
  ? "border-amber-400 bg-amber-400/10 text-amber-300" : "border-zinc-700 text-zinc-400 hover:text-zinc-100"}`;

export default function LolMayhemView({ catalog, error = false }: { catalog: LolMayhemCatalog | null; error?: boolean }) {
  const [query, setQuery] = useState("");
  const [rarity, setRarity] = useState<LolAugmentRarity | null>(null);
  const [newOnly, setNewOnly] = useState(false);
  const augments = catalog?.augments;
  const visible = useMemo(() => filterLolMayhemAugments(augments ?? [], query, rarity, newOnly), [augments, query, rarity, newOnly]);
  const newCount = augments?.filter(augment => augment.isNew).length ?? 0;

  return <main className="mx-auto w-full max-w-5xl px-4 py-6 text-zinc-100 sm:px-6">
    <h1 className="text-xl font-bold">증바람 증강</h1>
    <p className="mt-1 text-sm text-zinc-400">무작위 총력전: 아수라장의 현재 증강을 찾아볼 수 있습니다.</p>
    {!catalog ? <p role={error ? "alert" : undefined} className="mt-6 rounded-lg border border-zinc-800 px-4 py-8 text-center text-sm text-zinc-400">
      {error ? "증강 정보를 불러오지 못했습니다. 잠시 후 다시 시도해 주세요." : "아직 게시된 증강 정보가 없습니다."}
    </p> : <>
      <p className="mt-3 text-sm text-zinc-300">
        패치 {catalog.displayPatch} · 증강 {catalog.augments.length}개 · 신규 {newCount}개
        {catalog.notesUrl && <> · <a href={catalog.notesUrl} target="_blank" rel="noreferrer" className="text-amber-300 underline underline-offset-2">공식 패치 노트</a></>}
      </p>
      <div className="mt-4 flex flex-col gap-3 lg:flex-row lg:items-center">
        <input
          type="search" value={query} onChange={event => setQuery(event.target.value)}
          placeholder="이름이나 효과로 검색" aria-label="증강 검색"
          className="min-h-11 w-full rounded-lg border border-zinc-700 bg-zinc-900 px-3 text-sm outline-none placeholder:text-zinc-600 focus:border-amber-400 lg:max-w-xs"
        />
        <div role="group" aria-label="등급" className="flex flex-wrap gap-1.5">
          <button type="button" aria-pressed={rarity === null} className={chip(rarity === null)} onClick={() => setRarity(null)}>전체</button>
          {LOL_AUGMENT_RARITIES.map(item => <button key={item} type="button" aria-pressed={rarity === item} className={chip(rarity === item)}
            onClick={() => setRarity(item)}>{LOL_AUGMENT_RARITY_LABELS[item]}</button>)}
          <button type="button" aria-pressed={newOnly} className={chip(newOnly)} onClick={() => setNewOnly(value => !value)}>신규만</button>
        </div>
      </div>
      {visible.length === 0
        ? <p className="mt-6 rounded-lg border border-zinc-800 px-4 py-8 text-center text-sm text-zinc-400">조건에 맞는 증강이 없습니다.</p>
        : <ul aria-label="증강 목록" className="mt-4 grid gap-3 md:grid-cols-2">{visible.map(augment => <li key={augment.id}
          data-rarity={augment.rarity} className="flex min-w-0 gap-3 rounded-lg border border-zinc-800 bg-zinc-900/60 p-3">
          {augment.icon
            // 버전을 고정한 프록시 이미지를 원래 크기로 표시한다.
            ? <img src={`/api/lol/augment-icons/${catalog.clientPatch}/${augment.icon}`} alt="" width={44} height={44} loading="lazy" decoding="async"
              className="size-11 shrink-0 rounded-md bg-zinc-800" />
            : <span aria-hidden="true" className="size-11 shrink-0 rounded-md bg-zinc-800" />}
          <div className="min-w-0 flex-1">
            <h2 className="flex flex-wrap items-center gap-x-2 text-sm font-semibold">
              <span className="min-w-0 break-words">{augment.name}</span>
              <span className={`text-xs font-medium ${rarityColors[augment.rarity]}`}>{LOL_AUGMENT_RARITY_LABELS[augment.rarity]}</span>
              {augment.isNew && <span className="rounded bg-amber-400/15 px-1.5 py-0.5 text-[11px] font-bold text-amber-300">신규</span>}
            </h2>
            <p className="mt-1 whitespace-pre-wrap break-words text-sm leading-6 text-zinc-300">{augment.text}</p>
            {augment.notice && <p className="mt-1 text-xs text-zinc-500">{augment.notice}</p>}
          </div>
        </li>)}</ul>}
      {catalog.removed.length > 0 && <section aria-label="삭제된 증강" className="mt-6 border-t border-zinc-800 pt-4">
        <h2 className="text-sm font-semibold">패치 {catalog.displayPatch}에서 삭제</h2>
        <p className="mt-1 break-words text-sm leading-6 text-zinc-400">{catalog.removed.join(", ")}</p>
      </section>}
      <p className="mt-6 text-xs leading-5 text-zinc-500">
        증강 이름·설명은 게임 클라이언트 자료(CommunityDragon)를 기준으로 합니다. Riot 정책에 따라 증강 승률은 제공하지 않으며,
        Riot API가 아수라장 경기를 공개하지 않아 전적에도 표시되지 않습니다.
      </p>
    </>}
  </main>;
}
