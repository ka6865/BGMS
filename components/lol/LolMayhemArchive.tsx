"use client";

import { useEffect, useState } from "react";
import type { LolChampion } from "@/lib/lol/champions";
import { MAYHEM_AVAILABILITY, MAYHEM_AVAILABILITY_LABELS, type MayhemAvailability, type MayhemArchivePage } from "@/lib/lol/mayhemArchive";
import { LOL_AUGMENT_RARITY_LABELS } from "@/lib/lol/augments/catalog";

const control = "inline-flex min-h-11 items-center justify-center rounded-lg border border-zinc-700 px-3 text-sm hover:bg-zinc-800 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-zinc-300 disabled:opacity-40";
const input = "min-h-11 w-full min-w-0 rounded-lg border border-zinc-700 bg-zinc-900 px-3 text-sm";
const typeLabels: Record<string, string> = { god: "강력 추천", strong: "추천", trap: "주의", bug: "버그 제보", entertainment: "재미용", blackTech: "특수 활용" };
export default function LolMayhemArchive({ patch, champions }: { patch: string; champions: LolChampion[] }) {
  const [kind, setKind] = useState<"combos" | "augments">("combos");
  const [status, setStatus] = useState<MayhemAvailability | "all">("active");
  const [query, setQuery] = useState("");
  const [championId, setChampionId] = useState("");
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
  const names = new Map(champions.map(c => [c.id, c.name]));
  return <div aria-label="증강·조합 상태 조회" className="space-y-4">
    <div className="grid grid-cols-2 gap-2" aria-label="보존 자료 보기">
      {(["combos", "augments"] as const).map(value => <button key={value} type="button" aria-pressed={kind === value} className={`${control} ${kind === value ? "border-zinc-400 bg-zinc-800" : ""}`} onClick={() => { setKind(value); setOffset(0); }}>{value === "combos" ? "챔피언 조합" : "증강 상태"}</button>)}
    </div>
    <div aria-label="자료 상태 필터" className="flex flex-wrap gap-2">
      {(["active", "disabled", "removed", "unverified", "all"] as const).map(value => <button key={value} type="button" aria-pressed={status === value} className={`${control} ${status === value ? "border-zinc-400 bg-zinc-800" : ""}`} onClick={() => { setStatus(value); setOffset(0); }}>
        {value === "all" ? "전체" : MAYHEM_AVAILABILITY_LABELS[value]}{data?.kind === kind && !loading ? <span className="ml-1 tabular-nums">{value === "all" ? MAYHEM_AVAILABILITY.reduce((sum, key) => sum + data.counts[key], 0) : data.counts[value]}</span> : null}
      </button>)}
    </div>
    <div className="grid gap-3 sm:grid-cols-2">
      <label className="block space-y-2 text-sm"><span>증강 검색</span><input type="search" aria-label="보존 증강 검색" className={input} maxLength={100} value={query} onChange={event => { setQuery(event.target.value); setOffset(0); }} placeholder="한글·영문 이름이나 효과" /></label>
      {kind === "combos" && <label className="block space-y-2 text-sm"><span>챔피언</span><select aria-label="보존 조합 챔피언" className={input} value={championId} onChange={event => { setChampionId(event.target.value); setOffset(0); }}>
        <option value="">전체 챔피언</option>{champions.map(c => <option key={c.id} value={c.id}>{c.name}</option>)}
      </select></label>}
    </div>
    {status !== "active" && <p className="text-xs text-zinc-400">비활성·삭제·확인 중 자료는 현재 추천에서 제외한 보존 기록입니다. 삭제 시점은 확인한 원본 기록을 표시합니다.</p>}
    {loading && <p role="status" className="text-sm text-zinc-400">자료를 불러오는 중입니다.</p>}
    {error && <div className="space-y-2"><p role="alert" className="text-sm text-red-300">{error}</p><button type="button" className={control} onClick={() => setRetry(value => value + 1)}>다시 시도</button></div>}
    {!loading && !error && data && <>
      {!data.rows.length && <p role="status" className="text-sm text-zinc-400">해당 조건의 자료가 없습니다.</p>}
      {data.kind === "augments" ? <ul aria-label="보존 증강 목록" className="divide-y divide-zinc-800">{data.rows.map(a => <li key={a.key} className="space-y-2 break-words py-4 text-sm">
        <div className="flex flex-wrap items-center gap-2"><strong>{a.name}</strong><span className="text-xs text-zinc-400">{a.rarity ? LOL_AUGMENT_RARITY_LABELS[a.rarity] : ""} · {MAYHEM_AVAILABILITY_LABELS[a.status]}</span></div>
        {a.nameEn && <p className="text-xs text-zinc-400">{a.nameEn}</p>}
        {a.sourceName && a.sourceName !== a.name && <p className="text-xs text-zinc-400">원본 이름: {a.sourceName}</p>}
        {!!a.text && <p className="whitespace-pre-line text-zinc-300">{a.text}</p>}
        <p className="text-xs text-zinc-400">{a.reason}</p>
        {a.sourceUrl && <a className="inline-flex min-h-11 items-center text-amber-300 underline underline-offset-4" href={a.sourceUrl} target="_blank" rel="noreferrer">원본 기록 보기</a>}
      </li>)}</ul> : <ul aria-label="보존 조합 목록" className="divide-y divide-zinc-800">{data.rows.map(c => <li key={c.id} className="space-y-2 break-words py-4 text-sm">
        <div className="flex flex-wrap items-center justify-between gap-2"><strong>{names.get(c.championId) ?? `챔피언 ${c.championId}`}</strong><span className="text-xs text-zinc-400">{MAYHEM_AVAILABILITY_LABELS[c.status]}</span></div>
        <p>{c.augments.map((a, index) => <span key={a.key}>{index ? " + " : ""}{a.name}{a.status !== "active" && <span className="ml-1 text-xs text-zinc-400">({MAYHEM_AVAILABILITY_LABELS[a.status]})</span>}</span>)}</p>
        <p className="text-xs text-zinc-400">원본 평가: {c.types.map(t => typeLabels[t] ?? t).join(" · ") || "분류 없음"}</p>
        <a className="inline-flex min-h-11 items-center text-amber-300 underline underline-offset-4" href={c.sourceUrl} target="_blank" rel="noreferrer">조합 출처 보기</a>
      </li>)}</ul>}
      {data.total > 0 && <div className="flex flex-wrap items-center justify-between gap-3 text-sm">
        <span className="tabular-nums">{offset + 1}–{Math.min(offset + data.rows.length, data.total)} / {data.total}</span>
        <div className="flex gap-2"><button type="button" className={control} disabled={offset === 0} onClick={() => setOffset(Math.max(0, offset - data.pageSize))}>이전</button><button type="button" className={control} disabled={offset + data.pageSize >= data.total} onClick={() => setOffset(offset + data.pageSize)}>다음</button></div>
      </div>}
    </>}
  </div>;
}
