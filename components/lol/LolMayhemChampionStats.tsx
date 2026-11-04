"use client";

import { useEffect, useState } from "react";
import type { LolChampion } from "@/lib/lol/champions";
import type { LolMayhemCatalog } from "@/lib/lol/augments/catalog";
import type { PublicChampionStats } from "@/lib/lol/mayhemChampionDataset";

type Result = { dataset: PublicChampionStats | null };
const button = "inline-flex min-h-11 items-center justify-center rounded-lg border border-zinc-700 px-3 text-sm hover:bg-zinc-800";
const date = (value: string) => new Date(value).toLocaleString("ko-KR", { timeZone: "Asia/Seoul" }) + " KST";

export default function LolMayhemChampionStats({ enabled = false, patch, champions, catalog }: {
  enabled?: boolean; patch: string; champions: LolChampion[]; catalog: LolMayhemCatalog;
}) {
  const [championId, setChampionId] = useState("");
  const [dataset, setDataset] = useState<PublicChampionStats | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(false);
  const [retry, setRetry] = useState(0);
  const names = new Map(catalog.augments.map(augment => [augment.id, augment.name]));

  useEffect(() => {
    setDataset(null); setError(false);
    if (!enabled || !championId) { setLoading(false); return; }
    const controller = new AbortController();
    setLoading(true);
    fetch(`/api/lol/mayhem/champion-stats/${championId}?patch=${encodeURIComponent(patch)}`, { cache: "no-store", signal: controller.signal })
      .then(async response => { if (!response.ok) throw new Error("champion_stats_unavailable"); return response.json() as Promise<Result>; })
      .then(result => { if (!controller.signal.aborted) setDataset(result.dataset); })
      .catch(() => { if (!controller.signal.aborted) setError(true); })
      .finally(() => { if (!controller.signal.aborted) setLoading(false); });
    return () => controller.abort();
  }, [enabled, patch, championId, retry]);

  if (!enabled) return null;
  return <section aria-label="챔피언별 선택 통계" className="mt-6 space-y-3 border-t border-zinc-800 pt-5">
    <div>
      <h2 className="text-lg font-semibold">챔피언별 선택 통계</h2>
      <p className="mt-1 text-sm text-zinc-400">출처가 제공한 선택률입니다. 분모와 증강 제시 여부는 확인되지 않았습니다.</p>
    </div>
    <label className="block space-y-2 text-sm"><span>챔피언</span>
      <select aria-label="통계 챔피언 선택" className="block min-h-11 w-full rounded-lg border border-zinc-700 bg-zinc-900 px-3 sm:max-w-sm" value={championId} onChange={event => { setChampionId(event.target.value); setRetry(0); }}>
        <option value="">챔피언을 선택해 주세요</option>{champions.map(champion => <option key={champion.id} value={champion.id}>{champion.name}</option>)}
      </select>
    </label>
    {!champions.length && <p role="alert" className="text-sm text-amber-300">챔피언 목록을 불러오지 못했습니다.</p>}
    {loading && <p role="status" className="text-sm text-zinc-400">챔피언 통계를 불러오는 중입니다.</p>}
    {error && <div className="flex flex-wrap items-center gap-2 text-sm" role="alert"><span>챔피언 통계를 불러오지 못했습니다.</span><button className={button} onClick={() => setRetry(value => value + 1)}>다시 시도</button></div>}
    {!loading && !error && championId && !dataset && <p role="status" className="text-sm text-zinc-400">이 챔피언의 선택 통계가 아직 없습니다.</p>}
    {dataset && <>
      {dataset.clientPatch !== patch && <p className="text-sm text-amber-300">이전 패치 통계 · 원천 패치 {dataset.clientPatch}</p>}
      <p className="text-xs leading-5 text-zinc-400">출처: {dataset.attribution} · 원천 버전 {dataset.upstreamVersion} · 통계 기준일 {dataset.sourceDataDate} · 서버 확인 {date(dataset.fetchedAt)} · 공개 {date(dataset.publishedAt)}</p>
      {!dataset.rows.length && <p className="text-sm text-zinc-400">이 챔피언의 선택 통계가 아직 없습니다.</p>}
      {!!dataset.rows.length && <ul className="grid gap-x-6 sm:grid-cols-2">{dataset.rows.map(row => <li key={row.augmentPlatformId} className="flex min-w-0 flex-col gap-2 border-b border-zinc-800 py-3 text-sm sm:flex-row sm:justify-between">
        <span className="min-w-0 break-words">{names.get(row.augmentPlatformId) ?? `증강 ${row.augmentPlatformId}`}</span>
        <span className="min-w-0 break-words tabular-nums sm:text-right">{row.reportedPickRate === null ? "미제공" : `${(Number(row.reportedPickRate) * 100).toFixed(2)}%`}
          <span className="block whitespace-normal break-words text-xs text-zinc-400">선택률 출처 {row.rateSource ?? "미제공"} · 지역 {row.rateRegion ?? "미제공"}</span>
          {row.reportedSampleCount !== null && <span className="block whitespace-normal break-words text-xs text-zinc-400">출처 제공 표본 {row.reportedSampleCount.toLocaleString("ko-KR")} · {row.countSource ?? "미제공"} · {row.countRegion ?? "지역 미제공"}</span>}
        </span>
      </li>)}</ul>}
      <p className="text-xs text-zinc-500">출처 제공 선택률 · 분모 미확인 · 제시 여부 미확인</p>
    </>}
  </section>;
}
