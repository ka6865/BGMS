"use client";

import { useEffect, useState } from "react";
import { ChevronDown, ExternalLink, Plus, Search } from "lucide-react";
import { filterLolChampions, type LolChampion } from "@/lib/lol/champions";
import { MAYHEM_AVAILABILITY, MAYHEM_AVAILABILITY_LABELS, type MayhemAvailability, type MayhemArchivePage } from "@/lib/lol/mayhemArchive";
import { LOL_AUGMENT_RARITY_LABELS, type LolAugmentRarity, type LolMayhemCatalog } from "@/lib/lol/augments/catalog";
import { ChampionPortrait } from "./LolMayhemChampionStats";

const control = "inline-flex min-h-11 items-center justify-center rounded-lg border border-zinc-700 px-3 text-sm hover:bg-zinc-800 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-zinc-300 disabled:opacity-40";
const pressed = "border-amber-400 bg-amber-400/10 text-amber-300";
const input = "min-h-11 w-full min-w-0 rounded-lg border border-zinc-700 bg-zinc-900 px-3 text-sm";
// 원본 평가 순서와 색. 목록에 없는 분류는 회색으로 보여 준다.
const TYPES: Record<string, { label: string; tone: string }> = {
  god: { label: "강력 추천", tone: "border-amber-400/40 bg-amber-400/15 text-amber-300" },
  strong: { label: "추천", tone: "border-emerald-400/40 bg-emerald-400/10 text-emerald-300" },
  blackTech: { label: "특수 활용", tone: "border-sky-400/40 bg-sky-400/10 text-sky-300" },
  entertainment: { label: "재미용", tone: "border-violet-400/40 bg-violet-400/10 text-violet-300" },
  trap: { label: "주의", tone: "border-red-400/40 bg-red-400/10 text-red-300" },
  bug: { label: "버그 제보", tone: "border-orange-400/40 bg-orange-400/10 text-orange-300" },
};
const typeInfo = (type: string) => TYPES[type] ?? { label: type, tone: "border-zinc-700 bg-zinc-800 text-zinc-300" };
const rarityRing: Record<LolAugmentRarity, string> = { prismatic: "border-fuchsia-400/70", gold: "border-amber-400/70", silver: "border-zinc-400/60" };
const rarityText: Record<LolAugmentRarity, string> = { prismatic: "text-fuchsia-300", gold: "text-amber-300", silver: "text-zinc-300" };

function AugmentIcon({ icon, patch, rarity, size }: { icon: string | null | undefined; patch: string; rarity: LolAugmentRarity | null | undefined; size: number }) {
  const ring = rarity ? rarityRing[rarity] : "border-zinc-700";
  return icon ? <img src={`/api/lol/augment-icons/${patch}/${icon}`} alt="" width={size} height={size} loading="lazy" decoding="async" className={`shrink-0 rounded-lg border-2 bg-zinc-950 ${ring}`} style={{ width: size, height: size }} />
    : <span aria-hidden="true" className={`shrink-0 rounded-lg border-2 border-dashed bg-zinc-900 ${ring}`} style={{ width: size, height: size }} />;
}

function ChampionPicker({ champions, version, value, onChange }: { champions: LolChampion[]; version: string | null; value: string; onChange: (id: string) => void }) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const selected = champions.find(c => String(c.id) === value);
  const pick = (id: string) => { onChange(id); setOpen(false); setQuery(""); };
  return <div className="relative space-y-2 text-sm" onKeyDown={event => { if (event.key === "Escape") setOpen(false); }}>
    <span id="archive-champion-label">챔피언</span>
    <button type="button" aria-labelledby="archive-champion-label" aria-expanded={open} aria-controls="archive-champion-list" onClick={() => setOpen(v => !v)} className={`${input} flex items-center gap-2 text-left`}>
      {selected ? <ChampionPortrait champion={selected} version={version} size={24} /> : <span aria-hidden="true" className="size-6 shrink-0 rounded-lg bg-zinc-800" />}
      <span className="min-w-0 flex-1 truncate">{selected?.name ?? "전체 챔피언"}</span>
      <ChevronDown aria-hidden="true" size={16} className={`text-zinc-400 transition-transform ${open ? "rotate-180" : ""}`} />
    </button>
    {open && <div id="archive-champion-list" className="absolute inset-x-0 top-full z-20 mt-1 overflow-hidden rounded-xl border border-zinc-700 bg-zinc-900 shadow-xl">
      <label className="relative block p-2"><span className="sr-only">조합 챔피언 찾기</span><Search aria-hidden="true" size={16} className="pointer-events-none absolute left-5 top-5.5 text-zinc-400" />
        <input type="search" autoFocus aria-label="조합 챔피언 찾기" placeholder="이름, 초성" value={query} onChange={event => setQuery(event.target.value)} className={`${input} pl-9`} />
      </label>
      <div role="group" aria-label="조합 챔피언 목록" className="max-h-72 overflow-y-auto overscroll-contain border-t border-zinc-800 p-1.5">
        {!query && <button type="button" aria-pressed={!value} onClick={() => pick("")} className={`flex min-h-11 w-full items-center rounded-lg px-2.5 text-left ${!value ? "bg-amber-400/10 font-semibold text-amber-300" : "text-zinc-300 hover:bg-zinc-800"}`}>전체 챔피언</button>}
        {filterLolChampions(champions, query, null).map(c => <button key={c.id} type="button" aria-pressed={String(c.id) === value} onClick={() => pick(String(c.id))}
          className={`flex min-h-11 w-full items-center gap-3 rounded-lg px-2.5 text-left ${String(c.id) === value ? "bg-amber-400/10 font-semibold text-amber-300" : "text-zinc-300 hover:bg-zinc-800"}`}>
          <ChampionPortrait champion={c} version={version} size={28} /><span className="min-w-0 flex-1 truncate">{c.name}</span>
        </button>)}
      </div>
    </div>}
  </div>;
}

export default function LolMayhemArchive({ patch, champions, catalog, championVersion = null }: { patch: string; champions: LolChampion[]; catalog: LolMayhemCatalog; championVersion?: string | null }) {
  const [kind, setKind] = useState<"combos" | "augments">("combos");
  const [status, setStatus] = useState<MayhemAvailability | "all">("active");
  const [type, setType] = useState("");
  const [query, setQuery] = useState("");
  const [championId, setChampionId] = useState("");
  const [offset, setOffset] = useState(0);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [data, setData] = useState<MayhemArchivePage | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [retry, setRetry] = useState(0);
  useEffect(() => {
    const controller = new AbortController(); setLoading(true); setError("");
    const timer = setTimeout(() => {
      const params = new URLSearchParams({ patch, kind, status, q: query, offset: String(offset) });
      if (kind === "combos" && championId) params.set("championId", championId);
      if (kind === "combos" && type) params.set("type", type);
      void fetch(`/api/lol/mayhem/archive?${params}`, { cache: "no-store", signal: controller.signal }).then(async response => {
        const next = await response.json();
        if (!response.ok || next.patch !== patch || next.kind !== kind || !Array.isArray(next.rows) || !next.counts || !Number.isSafeInteger(next.total)) throw new Error();
        if (!controller.signal.aborted) setData(next);
      }).catch(() => { if (!controller.signal.aborted) setError("자료를 불러오지 못했습니다. 다시 시도해 주세요."); })
        .finally(() => { if (!controller.signal.aborted) setLoading(false); });
    }, query.trim() ? 250 : 0);
    return () => { clearTimeout(timer); controller.abort(); };
  }, [patch, kind, status, type, query, championId, offset, retry]);
  const championMap = new Map(champions.map(c => [c.id, c]));
  const augmentMap = new Map(catalog.augments.map(a => [a.id, a]));
  const reset = () => setOffset(0);
  const typeCounts = data?.kind === "combos" && kind === "combos" ? data.typeCounts : null;
  return <div aria-label="증강·조합 상태 조회" className="space-y-4">
    <div className="grid grid-cols-2 gap-1 rounded-xl bg-zinc-900 p-1" aria-label="보존 자료 보기">
      {(["combos", "augments"] as const).map(value => <button key={value} type="button" aria-pressed={kind === value} className={`min-h-11 rounded-lg text-sm font-semibold focus-visible:outline-2 focus-visible:outline-amber-400 ${kind === value ? "bg-zinc-700 text-white" : "text-zinc-400 hover:text-white"}`} onClick={() => { setKind(value); setType(""); reset(); }}>{value === "combos" ? "챔피언 조합" : "증강 상태"}</button>)}
    </div>
    <div className="grid gap-3 sm:grid-cols-2">
      {kind === "combos" && <ChampionPicker champions={champions} version={championVersion} value={championId} onChange={id => { setChampionId(id); reset(); }} />}
      <label className="block space-y-2 text-sm"><span>증강 검색</span><input type="search" aria-label="보존 증강 검색" className={input} maxLength={100} value={query} onChange={event => { setQuery(event.target.value); reset(); }} placeholder="한글·영문 이름이나 효과" /></label>
    </div>
    {typeCounts && (Object.keys(typeCounts).length > 0 || type) && <div aria-label="원본 평가 필터" className="flex flex-wrap gap-2">
      <button type="button" aria-pressed={!type} className={`${control} ${!type ? pressed : ""}`} onClick={() => { setType(""); reset(); }}>모든 평가</button>
      {[...Object.keys(TYPES), ...Object.keys(typeCounts).filter(t => !TYPES[t])].filter(t => typeCounts[t] || t === type).map(t => <button key={t} type="button" aria-pressed={type === t} className={`${control} ${type === t ? pressed : ""}`} onClick={() => { setType(t); reset(); }}>
        {typeInfo(t).label}<span className="ml-1 tabular-nums text-zinc-400">{typeCounts[t] ?? 0}</span>
      </button>)}
    </div>}
    <div aria-label="자료 상태 필터" className="flex flex-wrap items-center gap-x-1 gap-y-2 border-t border-zinc-800 pt-3 text-xs">
      <span className="mr-1 text-zinc-400">자료 상태</span>
      {(["active", "disabled", "removed", "unverified", "all"] as const).filter(value => value === "active" || value === "all" || value === status || !data || data.kind !== kind || data.counts[value] > 0).map(value => <button key={value} type="button" aria-pressed={status === value}
        className={`inline-flex min-h-11 items-center rounded-lg px-2.5 focus-visible:outline-2 focus-visible:outline-amber-400 ${status === value ? "bg-zinc-800 font-semibold text-white" : "text-zinc-400 hover:text-white"}`} onClick={() => { setStatus(value); reset(); }}>
        {value === "all" ? "전체" : MAYHEM_AVAILABILITY_LABELS[value]}{data?.kind === kind && !loading ? <span className="ml-1 tabular-nums">{value === "all" ? MAYHEM_AVAILABILITY.reduce((sum, key) => sum + data.counts[key], 0) : data.counts[value]}</span> : null}
      </button>)}
    </div>
    {status !== "active" && <p className="text-xs text-zinc-400">비활성·삭제·확인 중 자료는 현재 추천에서 제외한 보존 기록입니다. 삭제 시점은 확인한 원본 기록을 표시합니다.</p>}
    {loading && <p role="status" className="text-sm text-zinc-400">자료를 불러오는 중입니다.</p>}
    {error && <div className="space-y-2"><p role="alert" className="text-sm text-red-300">{error}</p><button type="button" className={control} onClick={() => setRetry(value => value + 1)}>다시 시도</button></div>}
    {!loading && !error && data && <>
      {!data.rows.length && <p role="status" className="text-sm text-zinc-400">해당 조건의 자료가 없습니다.</p>}
      {data.kind === "augments" ? <ul aria-label="보존 증강 목록" className="grid gap-3 md:grid-cols-2">{data.rows.map(a => {
        const icon = a.officialId ? augmentMap.get(a.officialId)?.icon : null;
        const open = expanded.has(a.key);
        return <li key={a.key} className="flex min-w-0 gap-3 break-words rounded-xl border border-zinc-800 bg-zinc-900/70 p-4 text-sm">
          <AugmentIcon icon={icon} patch={catalog.clientPatch} rarity={a.rarity} size={48} />
          <div className="min-w-0 flex-1 space-y-1.5">
            <div className="flex flex-wrap items-center gap-x-2 gap-y-1"><strong>{a.name}</strong>{a.rarity && <span className={`text-xs font-semibold ${rarityText[a.rarity]}`}>{LOL_AUGMENT_RARITY_LABELS[a.rarity]}</span>}{a.status !== "active" && <span className="rounded bg-zinc-800 px-1.5 py-0.5 text-xs text-zinc-300">{MAYHEM_AVAILABILITY_LABELS[a.status]}</span>}</div>
            {(a.nameEn || (a.sourceName && a.sourceName !== a.name)) && <p className="text-xs text-zinc-400">{[a.nameEn, a.sourceName && a.sourceName !== a.name ? `원본 이름: ${a.sourceName}` : null].filter(Boolean).join(" · ")}</p>}
            {!!a.text && <p className={`whitespace-pre-line text-zinc-300 ${open ? "" : "line-clamp-2"}`}>{a.text}</p>}
            {(a.text.length > 60 || a.text.includes("\n")) && <button type="button" aria-expanded={open} className="min-h-11 text-xs text-zinc-400 underline underline-offset-4 hover:text-white" onClick={() => setExpanded(prev => { const next = new Set(prev); if (open) next.delete(a.key); else next.add(a.key); return next; })}>{open ? "효과 접기" : "효과 펼치기"}</button>}
            <p className="text-xs text-zinc-400">{a.reason}{a.sourceUrl && <> · <a className="inline-flex min-h-11 items-center text-amber-300 underline underline-offset-4" href={a.sourceUrl} target="_blank" rel="noreferrer">원본 기록 보기</a></>}</p>
          </div>
        </li>;
      })}</ul> : <ul aria-label="보존 조합 목록" className="grid gap-2 md:grid-cols-2 lg:grid-cols-3">{data.rows.map(c => {
        const champion = championMap.get(c.championId);
        return <li key={c.id} className="flex min-w-0 flex-col gap-2.5 break-words rounded-xl border border-zinc-800 bg-zinc-900/70 p-3 text-sm">
          <div className="flex items-center gap-2.5">
            {champion ? <ChampionPortrait champion={champion} version={championVersion} size={36} /> : <span aria-hidden="true" className="size-9 shrink-0 rounded-lg bg-zinc-800" />}
            <div className="min-w-0 flex-1">
              <strong className="block truncate">{champion?.name ?? `챔피언 ${c.championId}`}</strong>
              {(c.types.length > 0 || c.status !== "active") && <div aria-label="원본 평가" className="mt-0.5 flex flex-wrap gap-1">{c.types.map(t => <span key={t} className={`rounded border px-1.5 text-[11px] font-semibold leading-5 ${typeInfo(t).tone}`}>{typeInfo(t).label}</span>)}{c.status !== "active" && <span className="rounded bg-zinc-800 px-1.5 text-[11px] leading-5 text-zinc-300">{MAYHEM_AVAILABILITY_LABELS[c.status]}</span>}</div>}
            </div>
            <a href={c.sourceUrl} target="_blank" rel="noreferrer" aria-label={`${champion?.name ?? "이"} 조합 출처 보기`} title="조합 출처 보기" className="inline-flex size-11 shrink-0 items-center justify-center rounded-lg text-zinc-500 hover:bg-zinc-800 hover:text-amber-300"><ExternalLink aria-hidden="true" size={15} /></a>
          </div>
          <ol aria-label="조합 증강" className="flex flex-wrap items-center gap-1.5">{c.augments.map((a, index) => {
            const official = a.officialId ? augmentMap.get(a.officialId) : undefined;
            return <li key={a.key} className="flex min-w-0 items-center gap-1.5">
              {index > 0 && <Plus aria-hidden="true" size={12} className="shrink-0 text-zinc-500" />}
              <span className="flex min-w-0 items-center gap-2 rounded-lg bg-zinc-950/60 py-1 pl-1 pr-2.5">
                <AugmentIcon icon={official?.icon} patch={catalog.clientPatch} rarity={official?.rarity} size={32} />
                <span className={`min-w-0 text-[13px] ${official ? rarityText[official.rarity] : "text-zinc-200"}`}>{a.name}{a.status !== "active" && <span className="ml-1 text-[11px] text-zinc-400">({MAYHEM_AVAILABILITY_LABELS[a.status]})</span>}</span>
              </span>
            </li>;
          })}</ol>
        </li>;
      })}</ul>}
      {data.total > 0 && <div className="flex flex-wrap items-center justify-between gap-3 text-sm">
        <span className="tabular-nums">{offset + 1}–{Math.min(offset + data.rows.length, data.total)} / {data.total}</span>
        <div className="flex gap-2"><button type="button" className={control} disabled={offset === 0} onClick={() => setOffset(Math.max(0, offset - data.pageSize))}>이전</button><button type="button" className={control} disabled={offset + data.pageSize >= data.total} onClick={() => setOffset(offset + data.pageSize)}>다음</button></div>
      </div>}
    </>}
  </div>;
}
