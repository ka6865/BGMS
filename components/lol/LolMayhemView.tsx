"use client";

import { useState } from "react";
import type { MayhemChampionTiers } from "@/lib/lol/mayhemChampionTiers";
import LolMayhemPatchRankings from "./LolMayhemPatchRankings";
import LolMayhemPatchNotes from "./LolMayhemPatchNotes";
import type { MayhemPatchNote } from "@/lib/lol/augments/patchNotes";
import type { LolChampion } from "@/lib/lol/champions";
import type { PublicMayhemDataset } from "@/lib/lol/mayhemDatasetView";
import LolMayhemDatasetView from "./LolMayhemDatasetView";
import LolMayhemTips from "./LolMayhemTips";
import type { MayhemTipItem } from "@/lib/lol/mayhemTips";
import LolMayhemChampionStats from "./LolMayhemChampionStats";
import { MAYHEM_RANDOM_GRANTERS, mayhemOfferNotes, mayhemRandomExcluded, type MayhemOfferNote, type MayhemOfferRule } from "@/lib/lol/mayhemOfferRules";
import {
  LOL_AUGMENT_RARITIES, LOL_AUGMENT_RARITY_LABELS, filterLolMayhemAugments,
  type LolAugmentRarity, type LolMayhemCatalog,
} from "@/lib/lol/augments/catalog";

const rarityColors: Record<LolAugmentRarity, string> = { prismatic: "text-fuchsia-300", gold: "text-amber-300", silver: "text-zinc-300" };
const granters = new Set<number>(MAYHEM_RANDOM_GRANTERS);
const SourceBadge = ({ rule }: { rule: Pick<MayhemOfferNote, "verified" | "patch"> }) => <span className={`mr-1.5 inline-block rounded px-1.5 align-[1px] text-[10px] font-bold ${rule.verified ? "bg-emerald-400/15 text-emerald-300" : "bg-orange-400/15 text-orange-300"}`}>{rule.verified ? "공식" : "확인 필요"}{rule.patch && ` · ${rule.patch}`}</span>;
const chip = (active: boolean) => `min-h-11 rounded-lg border px-3 text-sm font-semibold transition ${active
  ? "border-amber-400 bg-amber-400/10 text-amber-300" : "border-zinc-700 text-zinc-400 hover:text-zinc-100"}`;

export default function LolMayhemView({ catalog, error = false, dataset, champions = [], championStatsEnabled = false, championVersion = null, itemsEnabled = false, championTiers = null, patchRankingsEnabled = false, patchNotes = [], tipItems = null, offerRules = [] }: { catalog: LolMayhemCatalog | null; error?: boolean; dataset?: PublicMayhemDataset | null; champions?: LolChampion[]; championStatsEnabled?: boolean; championVersion?: string | null; itemsEnabled?: boolean; championTiers?: MayhemChampionTiers|null; patchRankingsEnabled?: boolean; patchNotes?: MayhemPatchNote[]; tipItems?: MayhemTipItem[] | null; offerRules?: MayhemOfferRule[] }) {
  const [query, setQuery] = useState("");
  const [rarity, setRarity] = useState<LolAugmentRarity | null>(null);
  const [newOnly, setNewOnly] = useState(false);
  const [offerOnly, setOfferOnly] = useState(false);
  const [tipDraft, setTipDraft] = useState<{ augmentId: number; summary: string } | null>(null);
  const randomExcluded = mayhemRandomExcluded(offerRules);
  const hasOfferInfo = (id: number) => (granters.has(id) && randomExcluded.ids.length > 0) || mayhemOfferNotes(offerRules, id).length > 0;
  const [view, setView] = useState(championStatsEnabled || itemsEnabled ? "champions" : "catalog");
  const augments = catalog?.augments;
  const visible = filterLolMayhemAugments(augments ?? [], query, rarity, newOnly).filter(augment => !offerOnly || hasOfferInfo(augment.id));
  const augmentNames = new Map((augments ?? []).map(augment => [augment.id, augment.name]));
  const excludedNames = randomExcluded.ids.flatMap(id => augmentNames.get(id) ?? []);
  const newCount = augments?.filter(augment => augment.isNew).length ?? 0;

  return <main className={`mx-auto w-full px-4 py-6 text-zinc-100 sm:px-6 ${view === "champions" ? "max-w-7xl" : "max-w-5xl"}`}>
    <h1 className="text-xl font-bold">증바람 증강</h1>
    <p className="mt-1 text-sm text-zinc-400">무작위 총력전: 아수라장의 챔피언별 선택 통계와 증강 도감입니다.</p>
    {(championStatsEnabled || itemsEnabled || patchRankingsEnabled || dataset?.archiveAvailable || patchNotes.length > 0 || tipItems) && <div role="group" aria-label="증바람 보기" className="mt-5 flex flex-wrap gap-2">
      {(championStatsEnabled || itemsEnabled) && <button aria-pressed={view === "champions"} className={chip(view === "champions")} onClick={() => setView("champions")}>챔피언별 정보</button>}
      {patchRankingsEnabled && <button aria-pressed={view === "rankings"} className={chip(view === "rankings")} onClick={() => setView("rankings")}>패치별 증강 순위</button>}
      {dataset?.archiveAvailable && <button aria-pressed={view === "archive"} className={chip(view === "archive")} onClick={() => setView("archive")}>조합·증강 상태</button>}
      {tipItems && catalog && <button aria-pressed={view === "tips"} className={chip(view === "tips")} onClick={() => setView("tips")}>유저 조합 제보</button>}
      {patchNotes.length > 0 && <button aria-pressed={view === "notes"} className={chip(view === "notes")} onClick={() => setView("notes")}>패치노트</button>}
      <button aria-pressed={view === "catalog"} className={chip(view === "catalog")} onClick={() => setView("catalog")}>전체 증강 도감</button>
    </div>}
    {catalog && dataset && !dataset.archiveAvailable && <details className="mt-4 rounded-lg border border-zinc-800 px-3">
      <summary className="min-h-11 cursor-pointer content-center text-sm font-semibold text-amber-300">챔피언별 해외 조합·전체 선택률</summary>
      <LolMayhemDatasetView data={dataset} champions={champions} catalog={catalog} />
    </details>}
    {view === "tips" && catalog && tipItems ? <LolMayhemTips champions={champions} championVersion={championVersion} catalog={catalog} items={tipItems} draft={tipDraft} onDraftUsed={() => setTipDraft(null)}/> : view === "archive" && catalog && dataset?.archiveAvailable ? <LolMayhemDatasetView data={dataset} champions={champions} catalog={catalog} championVersion={championVersion}/> : view === "rankings" && patchRankingsEnabled ? <LolMayhemPatchRankings catalog={catalog}/> : view === "notes" && patchNotes.length > 0 ? <LolMayhemPatchNotes notes={patchNotes}/> : !catalog ? <p role={error ? "alert" : undefined} className="mt-6 rounded-lg border border-zinc-800 px-4 py-8 text-center text-sm text-zinc-400">
      {error ? "증강 정보를 불러오지 못했습니다. 잠시 후 다시 시도해 주세요." : "아직 게시된 증강 정보가 없습니다."}
    </p> : <>
      <p className="mt-3 text-sm text-zinc-300">
        증강 도감 {catalog.displayPatch} · 증강 {catalog.augments.length}개 · 신규 {newCount}개
        {catalog.notesUrl && <> · <a href={catalog.notesUrl} target="_blank" rel="noreferrer" className="text-amber-300 underline underline-offset-2">공식 패치 노트</a></>}
      </p>
      {(championStatsEnabled || itemsEnabled) && view === "champions" && <LolMayhemChampionStats enabled={championStatsEnabled} patch={catalog.clientPatch} champions={champions} catalog={catalog} championVersion={championVersion} itemsEnabled={itemsEnabled} championTiers={championTiers} />}
      {view === "catalog" && <><div className="mt-4 flex flex-col gap-3 lg:flex-row lg:items-center">
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
          <button type="button" aria-pressed={offerOnly} className={chip(offerOnly)} onClick={() => setOfferOnly(value => !value)}>등장 조건 있음</button>
        </div>
      </div>
      {visible.length === 0
        ? <p className="mt-6 rounded-lg border border-zinc-800 px-4 py-8 text-center text-sm text-zinc-400">조건에 맞는 증강이 없습니다.</p>
        : <ul aria-label="증강 목록" className="mt-4 grid grid-cols-1 gap-2">{visible.map(augment => <li key={augment.id}
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
            {hasOfferInfo(augment.id) && <div aria-label="등장 조건" className="mt-2 space-y-1 rounded-md bg-zinc-950/60 px-2.5 py-2 text-xs leading-5 text-zinc-300">
              {granters.has(augment.id) && excludedNames.length > 0 && <p><SourceBadge rule={randomExcluded} />나오지 않는 증강: {excludedNames.join(", ")}</p>}
              {mayhemOfferNotes(offerRules, augment.id).map(rule => <p key={rule.text}><SourceBadge rule={rule} />{rule.text}</p>)}
              {tipItems && <button type="button" onClick={() => { setTipDraft({ augmentId: augment.id, summary: `${augment.name} 등장 조건 제보` }); setView("tips"); }}
                className="inline-flex min-h-11 items-center text-[11px] text-zinc-400 underline underline-offset-4 hover:text-white">정보가 다르면 알려 주세요</button>}
            </div>}
          </div>
        </li>)}</ul>}
      {catalog.removed.length > 0 && <section aria-label="삭제된 증강" className="mt-6 border-t border-zinc-800 pt-4">
        <h2 className="text-sm font-semibold">패치 {catalog.displayPatch}에서 삭제</h2>
        <p className="mt-1 break-words text-sm leading-6 text-zinc-400">{catalog.removed.join(", ")}</p>
      </section>}</>}
      <p className="mt-6 text-xs leading-5 text-zinc-500">
        등장 조건 중 &quot;확인 필요&quot;는 Riot 공식 원문으로 확인하지 못한 커뮤니티 정리 정보입니다.
        증강 이름·설명은 게임 클라이언트 자료(CommunityDragon)를 기준으로 합니다. Riot 정책에 따라 증강 승률은 제공하지 않으며,
        Riot API가 아수라장 경기를 공개하지 않아 전적에도 표시되지 않습니다.
      </p>
    </>}
  </main>;
}
