"use client";

import { useEffect, useState } from "react";
import { BookOpen, ChevronDown, ChevronLeft, ChevronRight, ExternalLink, ImageOff, Layers, Plus, Search } from "lucide-react";
import { filterLolChampions, type LolChampion } from "@/lib/lol/champions";
import { sortMayhemChampions, type MayhemChampionTiers } from "@/lib/lol/mayhemChampionTiers";
import { MAYHEM_AVAILABILITY, MAYHEM_AVAILABILITY_LABELS, type MayhemAvailability, type MayhemArchivePage } from "@/lib/lol/mayhemArchive";
import { LOL_AUGMENT_RARITY_LABELS, type LolAugmentRarity } from "@/lib/lol/augments/catalog";

const control = "inline-flex min-h-11 items-center justify-center gap-2 rounded-lg border px-3 text-sm font-medium transition-colors focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-amber-300 disabled:opacity-40";
const input = "min-h-11 w-full min-w-0 rounded-lg border border-zinc-700 bg-zinc-950 px-3 text-sm outline-none placeholder:text-zinc-400 focus-visible:border-amber-400 focus-visible:ring-2 focus-visible:ring-amber-400/20";
const chip = (active: boolean) => `${control} ${active ? "border-amber-400/60 bg-amber-400/10 text-amber-200" : "border-zinc-700 text-zinc-300 hover:bg-zinc-800"}`;
const rarityColors: Record<LolAugmentRarity, string> = { prismatic: "text-fuchsia-300", gold: "text-amber-300", silver: "text-zinc-300" };
const statusColors: Record<MayhemAvailability, string> = { active: "bg-emerald-400/10 text-emerald-300", disabled: "bg-amber-400/10 text-amber-200", removed: "bg-rose-400/10 text-rose-300", unverified: "bg-zinc-800 text-zinc-300" };
const typeLabels: Record<string, string> = { god: "강력 추천", strong: "추천", trap: "주의", bug: "버그 제보", entertainment: "재미용", blackTech: "특수 활용" };

function Artwork({ src, size = 48 }: { src: string | null | undefined; size?: number }) {
  const [failed, setFailed] = useState(false);
  return <span aria-hidden="true" className="grid shrink-0 place-items-center overflow-hidden rounded-lg bg-zinc-950" style={{ width: size, height: size }}>
    {src && !failed ? <img src={src} alt="" width={size} height={size} loading="lazy" decoding="async" onError={() => setFailed(true)} className="size-full object-contain" />
      : <ImageOff size={20} className="text-zinc-500" />}
  </span>;
}
function StatusBadge({ status }: { status: MayhemAvailability }) {
  return <span className={`inline-flex shrink-0 items-center rounded px-2 py-1 text-xs font-medium ${statusColors[status]}`}>{MAYHEM_AVAILABILITY_LABELS[status]}</span>;
}

export default function LolMayhemArchive({ patch, champions, championVersion = null, championTiers = null }: { patch: string; champions: LolChampion[]; championVersion?: string | null; championTiers?: MayhemChampionTiers | null }) {
  const [kind, setKind] = useState<"combos" | "augments">("combos");
  const [status, setStatus] = useState<MayhemAvailability | "all">("active");
  const [query, setQuery] = useState("");
  const [championId, setChampionId] = useState("");
  const [championQuery, setChampionQuery] = useState("");
  const [pickerOpen, setPickerOpen] = useState(false);
  const [offset, setOffset] = useState(0);
  const [data, setData] = useState<MayhemArchivePage | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [retry, setRetry] = useState(0);
  useEffect(() => {
    const controller = new AbortController(); setLoading(true); setError("");
    const timer = setTimeout(() => {
      const params = new URLSearchParams({ patch, kind, status, q: query, offset: String(offset) });
      if (kind === "combos" && championId) params.set("championId", championId);
      void fetch(`/api/lol/mayhem/archive?${params}`, { cache: "no-store", signal: controller.signal }).then(async response => {
        const next = await response.json();
        if (!response.ok || next.patch !== patch || next.kind !== kind || !Array.isArray(next.rows) || !next.counts || !Number.isSafeInteger(next.total)) throw new Error();
        if (!controller.signal.aborted) setData(next);
      }).catch(() => { if (!controller.signal.aborted) setError("자료를 불러오지 못했습니다. 다시 시도해 주세요."); })
        .finally(() => { if (!controller.signal.aborted) setLoading(false); });
    }, query.trim() ? 250 : 0);
    return () => { clearTimeout(timer); controller.abort(); };
  }, [patch, kind, status, query, championId, offset, retry]);
  const championById = new Map(champions.map(c => [c.id, c]));
  const visibleChampions = filterLolChampions(sortMayhemChampions(champions, championTiers, patch), championQuery, null);
  const selectedChampion = championById.get(Number(championId));
  const chooseChampion = (id: string) => { setChampionId(id); setOffset(0); setPickerOpen(false); };
  return <div aria-label="증강·조합 상태 조회" className="space-y-5">
    <div className="grid grid-cols-2 gap-1 rounded-xl bg-zinc-900 p-1" aria-label="보존 자료 보기">
      {(["combos", "augments"] as const).map(value => {
        const Icon = value === "combos" ? Layers : BookOpen;
        return <button key={value} type="button" aria-pressed={kind === value} className={`${control} ${kind === value ? "border-zinc-600 bg-zinc-800 text-zinc-100" : "border-transparent text-zinc-400 hover:text-zinc-100"}`} onClick={() => { setKind(value); setOffset(0); }}><Icon aria-hidden="true" size={16} />{value === "combos" ? "챔피언 조합" : "증강 상태"}</button>;
      })}
    </div>
    <div className={kind === "combos" ? "grid items-start gap-5 lg:grid-cols-[224px_minmax(0,1fr)]" : ""}>
    {kind === "combos" && <aside aria-label="조합 챔피언 선택" className="min-w-0 rounded-xl border border-zinc-800 bg-zinc-900/40 lg:sticky lg:top-4">
      <button type="button" aria-label="조합 챔피언 선택 열기" aria-expanded={pickerOpen} aria-controls="mayhem-combo-champions" onClick={() => setPickerOpen(value => !value)} className="flex min-h-14 w-full items-center justify-between gap-3 px-4 text-left text-sm font-semibold focus-visible:outline-2 focus-visible:outline-amber-300 lg:hidden"><span>{selectedChampion?.name ?? "전체 챔피언"}</span><ChevronDown aria-hidden="true" size={18} className={pickerOpen ? "rotate-180" : ""} /></button>
      <div id="mayhem-combo-champions" className={`${pickerOpen ? "block" : "hidden"} p-3 lg:block`}>
        <h3 className="mb-3 hidden text-sm font-semibold lg:block">챔피언 선택</h3>
        <label className="relative mb-3 block"><span className="sr-only">조합 챔피언 검색</span><Search aria-hidden="true" size={16} className="pointer-events-none absolute top-3.5 left-3 text-zinc-400" /><input type="search" aria-label="조합 챔피언 검색" className={`${input} pl-9`} placeholder="이름·초성 검색" value={championQuery} onChange={event => setChampionQuery(event.target.value)} /></label>
        <button type="button" data-combo-champion-id="" aria-pressed={!championId} className={`mb-2 w-full ${chip(!championId)}`} onClick={() => chooseChampion("")}>전체 챔피언</button>
        <ul aria-label="조합 챔피언 목록" className="max-h-80 space-y-0.5 overflow-y-auto overscroll-contain lg:max-h-[calc(100dvh-240px)]">{visibleChampions.map(champion => {
          const portrait = championVersion ? `https://ddragon.leagueoflegends.com/cdn/${championVersion}/img/champion/${champion.imageId}.png` : null;
          const tier = championTiers?.patch === patch ? championTiers.tiers[String(champion.id)] : null;
          return <li key={champion.id}><button type="button" data-combo-champion-id={champion.id} aria-pressed={championId === String(champion.id)} className={`flex min-h-11 w-full items-center gap-2.5 rounded-lg px-2 text-left text-sm focus-visible:outline-2 focus-visible:outline-amber-300 ${championId === String(champion.id) ? "bg-amber-400/10 text-amber-200" : "text-zinc-300 hover:bg-zinc-800"}`} onClick={() => chooseChampion(String(champion.id))}><Artwork key={portrait} src={portrait} size={28} /><span className="min-w-0 flex-1 break-words">{champion.name}</span>{tier && <span className={`shrink-0 rounded px-1.5 py-1 text-[11px] font-semibold ${tier === 1 ? "bg-amber-400/10 text-amber-200" : "bg-zinc-800 text-zinc-300"}`}>{tier}티어</span>}</button></li>;
        })}</ul>
        {!visibleChampions.length && <p className="py-5 text-center text-xs text-zinc-400">검색한 챔피언이 없습니다.</p>}
      </div>
    </aside>}
    <div className="min-w-0 space-y-5">
    <div className="space-y-4">
      <div aria-label="자료 상태 필터" className="flex flex-wrap gap-2">
        {(["active", "disabled", "removed", "unverified", "all"] as const).map(value => <button key={value} type="button" aria-pressed={status === value} className={chip(status === value)} onClick={() => { setStatus(value); setOffset(0); }}>
          {value === "all" ? "전체" : MAYHEM_AVAILABILITY_LABELS[value]}{data?.kind === kind && !loading ? <span className="rounded bg-zinc-800 px-1.5 py-0.5 text-xs tabular-nums text-zinc-200">{value === "all" ? MAYHEM_AVAILABILITY.reduce((sum, key) => sum + data.counts[key], 0) : data.counts[value]}</span> : null}
        </button>)}
      </div>
      <div>
        <label className="block space-y-2 text-sm text-zinc-300"><span>증강 검색</span><span className="relative block"><Search aria-hidden="true" size={17} className="pointer-events-none absolute top-3.5 left-3 text-zinc-400" /><input type="search" aria-label="보존 증강 검색" className={`${input} pl-10`} maxLength={100} value={query} onChange={event => { setQuery(event.target.value); setOffset(0); }} placeholder="한글·영문 이름이나 효과" /></span></label>
      </div>
    </div>
    {status !== "active" && <p className="text-xs leading-5 text-zinc-400">비활성·삭제·확인 중 자료는 현재 추천에서 제외한 보존 기록입니다. 삭제 시점은 확인한 원본 기록을 표시합니다.</p>}
    {loading && <div role="status" className="space-y-3"><p className="text-sm text-zinc-400">자료를 불러오는 중입니다.</p>{[0, 1, 2].map(i => <div key={i} aria-hidden="true" className="flex items-center gap-4 rounded-xl border border-zinc-800 p-4 motion-safe:animate-pulse"><span className="size-12 rounded-lg bg-zinc-800" /><div className="flex-1 space-y-3"><div className="h-3 w-1/3 rounded bg-zinc-800" /><div className="h-3 w-2/3 rounded bg-zinc-900" /></div></div>)}</div>}
    {error && <div className="space-y-3 rounded-xl border border-zinc-800 bg-zinc-900/50 p-5"><p role="alert" className="text-sm text-red-300">{error}</p><button type="button" className={chip(false)} onClick={() => setRetry(value => value + 1)}>다시 시도</button></div>}
    {!loading && !error && data && <>
      {!data.rows.length && <div role="status" className="space-y-3 rounded-xl border border-dashed border-zinc-700 px-4 py-10 text-center"><Search aria-hidden="true" size={24} className="mx-auto text-zinc-400" /><p className="text-sm text-zinc-300">해당 조건의 자료가 없습니다.</p><button type="button" className={chip(false)} onClick={() => { setQuery(""); setChampionQuery(""); setChampionId(""); setStatus("active"); setOffset(0); }}>필터 초기화</button></div>}
      {data.kind === "augments" ? <ul aria-label="보존 증강 목록" className="space-y-3">{data.rows.map(a => <li key={a.key} className="min-w-0 rounded-xl border border-zinc-800 bg-zinc-900/60 p-4 sm:p-5">
        <div className="flex items-start gap-3 sm:gap-4">
          <Artwork key={a.iconUrl ?? a.key} src={a.iconUrl} size={56} />
          <div className="min-w-0 flex-1 space-y-1.5"><div className="flex flex-wrap items-center gap-x-2 gap-y-1"><h3 className="break-words text-base font-semibold text-zinc-100">{a.name}</h3>{a.rarity && <span className={`text-xs font-medium ${rarityColors[a.rarity]}`}>{LOL_AUGMENT_RARITY_LABELS[a.rarity]}</span>}</div>
            {a.nameEn && <p className="break-words text-xs leading-5 text-zinc-400">{a.nameEn}</p>}
            <div className="flex flex-wrap items-center gap-2"><StatusBadge status={a.status} />{a.removedPatch && <span className="text-xs text-zinc-400">{a.removedPatch} 삭제</span>}</div>
          </div>
        </div>
        {a.text && <p className="mt-4 max-w-prose whitespace-pre-line break-words text-sm leading-6 text-zinc-300">{a.text}</p>}
        {a.sourceName && a.sourceName !== a.name && <p className="mt-3 text-xs text-zinc-400">원본 이름: {a.sourceName}</p>}
        <div className="mt-3 flex flex-wrap items-start justify-between gap-x-4 border-t border-zinc-800 pt-1">
          <details className="min-w-0 flex-1 text-xs text-zinc-400"><summary className="min-h-11 cursor-pointer content-center focus-visible:outline-2 focus-visible:outline-amber-300">상태 근거</summary><p className="pb-3 leading-5">{a.reason}</p></details>
          {a.sourceUrl && <a className="inline-flex min-h-11 items-center gap-1.5 text-xs font-medium text-amber-300 underline-offset-4 hover:underline focus-visible:outline-2 focus-visible:outline-amber-300" href={a.sourceUrl} target="_blank" rel="noreferrer">원본 기록<ExternalLink aria-hidden="true" size={13} /></a>}
        </div>
      </li>)}</ul> : <ul aria-label="보존 조합 목록" className="space-y-3">{data.rows.map(c => {
        const champion = championById.get(c.championId);
        const portrait = champion && championVersion ? `https://ddragon.leagueoflegends.com/cdn/${championVersion}/img/champion/${champion.imageId}.png` : null;
        return <li key={c.id} className="min-w-0 rounded-xl border border-zinc-800 bg-zinc-900/60 p-4 sm:p-5">
          <div className="flex items-center justify-between gap-3"><div className="flex min-w-0 items-center gap-3"><Artwork key={portrait} src={portrait} size={40} /><div className="min-w-0"><h3 className="break-words text-base font-semibold">{champion?.name ?? `챔피언 ${c.championId}`}</h3><p className="mt-0.5 text-xs text-zinc-400">증강 {c.augments.length}개 조합</p></div></div><StatusBadge status={c.status} /></div>
          <ul aria-label="조합 증강" className="mt-5 flex flex-wrap gap-x-4 gap-y-4">{c.augments.map((a, index) => <li key={a.key} className="flex min-w-0 max-w-full items-center gap-3">
            {index > 0 && <Plus aria-hidden="true" size={14} className="shrink-0 text-zinc-500" />}<Artwork key={a.iconUrl ?? a.key} src={a.iconUrl} />
            <div className="min-w-0 max-w-48 space-y-1"><p className="break-words text-sm font-semibold leading-5">{a.name}</p>{a.rarity && <p className={`text-xs ${rarityColors[a.rarity]}`}>{LOL_AUGMENT_RARITY_LABELS[a.rarity]}</p>}{a.status !== "active" && <StatusBadge status={a.status} />}</div>
          </li>)}</ul>
          <div className="mt-4 flex flex-wrap items-center justify-between gap-x-4 border-t border-zinc-800 pt-1"><div className="flex min-h-11 flex-wrap items-center gap-2"><span className="text-xs text-zinc-400">원본 평가</span>{c.types.map(t => <span key={t} className={`rounded px-2 py-1 text-xs font-medium ${t === "trap" || t === "bug" ? "bg-rose-400/10 text-rose-300" : t === "god" || t === "strong" ? "bg-amber-400/10 text-amber-200" : "bg-zinc-800 text-zinc-300"}`}>{typeLabels[t] ?? t}</span>)}{!c.types.length && <span className="text-xs text-zinc-400">분류 없음</span>}</div>
            <a className="inline-flex min-h-11 items-center gap-1.5 text-xs font-medium text-amber-300 underline-offset-4 hover:underline focus-visible:outline-2 focus-visible:outline-amber-300" href={c.sourceUrl} target="_blank" rel="noreferrer">조합 출처<ExternalLink aria-hidden="true" size={13} /></a>
          </div>
        </li>;
      })}</ul>}
      {data.total > 0 && <div className="flex flex-wrap items-center justify-between gap-3 border-t border-zinc-800 pt-4 text-sm text-zinc-300">
        <span className="tabular-nums">{offset + 1}–{Math.min(offset + data.rows.length, data.total)} / {data.total}</span>
        <div className="flex gap-2"><button type="button" className={chip(false)} disabled={offset === 0} onClick={() => setOffset(Math.max(0, offset - data.pageSize))}><ChevronLeft aria-hidden="true" size={16} />이전</button><button type="button" className={chip(false)} disabled={offset + data.pageSize >= data.total} onClick={() => setOffset(offset + data.pageSize)} >다음<ChevronRight aria-hidden="true" size={16} /></button></div>
      </div>}
    </>}
    </div>
    </div>
  </div>;
}
