"use client";

import { useEffect, useState } from "react";
import { Search } from "lucide-react";
import type { LolMayhemCatalog } from "@/lib/lol/augments/catalog";
import { observationLabel, type ObservationHistory, type ObservationStatus } from "@/lib/lol/mayhemObservationHistory";

const displayPatch = (patch: string) => patch.replace(/^(15|16)\./, major => `${Number(major.slice(0, -1)) + 10}.`);
const labels: Record<ObservationStatus, string> = { observed: "선택 관측", unobserved: "연속 미관측", never_observed: "관측 이력 없음", insufficient: "자료 부족" };
const colors: Record<ObservationStatus, string> = { observed: "text-emerald-300", unobserved: "text-amber-300", never_observed: "text-zinc-300", insufficient: "text-zinc-400" };
const control = "min-h-11 rounded-lg border border-zinc-700 bg-zinc-950 px-3 text-sm text-zinc-100 outline-none focus-visible:border-amber-400";

export default function LolMayhemObservationHistory({ championId, patch, catalog }: { championId: number; patch: string; catalog: LolMayhemCatalog }) {
  const [query, setQuery] = useState("");
  const [status, setStatus] = useState<ObservationStatus | "all">("all");
  const [retry, setRetry] = useState(0);
  const [response, setResponse] = useState<{ key: string; history: ObservationHistory | null; error: boolean } | null>(null);
  const key = `${patch}:${championId}:${retry}`;
  const current = response?.key === key ? response : null;
  useEffect(() => {
    const controller = new AbortController();
    fetch(`/api/lol/mayhem/champion-history/${championId}?patch=${encodeURIComponent(patch)}`, { cache: "no-store", signal: controller.signal })
      .then(async result => { if (!result.ok) throw new Error("history_unavailable"); return result.json() as Promise<{ history: ObservationHistory }>; })
      .then(result => { if (!controller.signal.aborted) setResponse({ key, history: result.history, error: false }); })
      .catch(() => { if (!controller.signal.aborted) setResponse({ key, history: null, error: true }); });
    return () => controller.abort();
  }, [championId, patch, key]);

  if (!current) return <p role="status" className="py-12 text-center text-sm text-zinc-400">관측 이력을 불러오는 중입니다.</p>;
  const history = current.history;
  if (current.error || !history) return <div role="alert" className="space-y-3 py-10 text-center text-sm text-zinc-400">
    <p>관측 이력을 불러오지 못했습니다.</p><button className={control} onClick={() => setRetry(value => value + 1)}>다시 시도</button>
  </div>;
  const augments = new Map(catalog.augments.map(augment => [augment.id, augment]));
  const term = query.trim().toLocaleLowerCase("ko");
  const order: ObservationStatus[] = ["unobserved", "observed", "never_observed", "insufficient"];
  const rows = history.rows.filter(row => (status === "all" || row.status === status)
    && (!term || (augments.get(row.augmentPlatformId)?.name ?? `증강 ${row.augmentPlatformId}`).toLocaleLowerCase("ko").includes(term)))
    .sort((a, b) => order.indexOf(a.status) - order.indexOf(b.status) || a.augmentPlatformId - b.augmentPlatformId);

  return <section aria-label="선택 관측 이력" data-champion-id={championId} className="min-w-0 space-y-4">
    <header className="space-y-1"><h3 className="text-base font-semibold">관측 이력</h3>
      <p className="text-xs leading-5 text-zinc-400">최근 최대 4패치 · {displayPatch(history.patches.at(-1)?.patch ?? patch)}~{displayPatch(patch)}</p>
      <p className="text-xs leading-5 text-zinc-400">조회 범위의 선택 기록입니다. 미관측은 등장 불가를 뜻하지 않습니다.</p>
    </header>
    <ul aria-label="패치별 자료 상태" className="grid grid-cols-2 gap-2 sm:grid-cols-4">{history.patches.map(item => <li key={item.patch} className="flex items-center justify-between gap-2 rounded-lg bg-zinc-900 px-3 py-2 text-xs">
      <span>{displayPatch(item.patch)}</span><span className={item.available ? "text-emerald-300" : "text-zinc-400"}>{item.available ? "자료 있음" : "자료 부족"}</span>
    </li>)}</ul>
    <div className="flex flex-col gap-2 sm:flex-row">
      <label className="relative min-w-0 flex-1"><span className="sr-only">관측 증강 검색</span><Search aria-hidden="true" size={16} className="pointer-events-none absolute left-3 top-3.5 text-zinc-400" />
        <input type="search" aria-label="관측 증강 검색" value={query} onChange={event => setQuery(event.target.value)} className={`${control} w-full pl-9`} />
      </label>
      <select aria-label="관측 상태" value={status} onChange={event => setStatus(event.target.value as ObservationStatus | "all")} className={control}>
        <option value="all">전체</option>{Object.entries(labels).map(([value, label]) => <option key={value} value={value}>{label}</option>)}
      </select>
    </div>
    {rows.length ? <ul aria-label="증강 관측 이력" className="grid grid-cols-1 gap-2">{rows.map(row => {
      const augment = augments.get(row.augmentPlatformId);
      return <li key={row.augmentPlatformId} data-observation={row.status} className="flex min-w-0 items-start gap-3 rounded-xl border border-zinc-800 bg-zinc-900 p-4">
        {augment?.icon && <img src={`/api/lol/augment-icons/${catalog.clientPatch}/${augment.icon}`} width={36} height={36} alt="" loading="lazy" decoding="async" className="size-9 shrink-0" />}
        <div className="min-w-0 flex-1 space-y-1"><h4 className="break-words text-sm font-semibold">{augment?.name ?? `증강 ${row.augmentPlatformId}`}</h4>
          <p className={`break-words text-xs leading-5 ${colors[row.status]}`}>{observationLabel(row)}</p>
          {row.lastObservedPatch && row.lastObservedPatch !== patch && <p className="text-xs leading-5 text-zinc-400">마지막 선택 관측 {displayPatch(row.lastObservedPatch)}</p>}
        </div>
      </li>;
    })}</ul> : <div role="status" className="space-y-3 py-10 text-center text-sm text-zinc-400"><p>조건에 맞는 관측 이력이 없습니다.</p>
      <button className={control} onClick={() => { setQuery(""); setStatus("all"); }}>필터 초기화</button>
    </div>}
  </section>;
}
