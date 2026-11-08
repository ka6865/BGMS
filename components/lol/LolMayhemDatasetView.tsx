"use client";

import { useState } from "react";
import type { LolChampion } from "@/lib/lol/champions";
import type { LolMayhemCatalog } from "@/lib/lol/augments/catalog";
import LolMayhemArchive from "./LolMayhemArchive";
import type { PublicMayhemDataset } from "@/lib/lol/mayhemDatasetView";

export default function LolMayhemDatasetView({ data, champions, catalog }: { data: PublicMayhemDataset; champions: LolChampion[]; catalog: LolMayhemCatalog }) {
  const [championId, setChampionId] = useState("");
  if (data.archiveAvailable) return <section aria-label="해외 증바람 자료" className="space-y-4 py-4">
    <header><h2 className="text-lg font-semibold">조합·증강 상태</h2><p className="mt-1 text-xs text-zinc-400">기준 패치 {data.patch.replace(/^16\./, "26.")}{data.patch !== catalog.clientPatch && " (새 패치 자료 준비 중)"} · 공개 {new Date(data.publishedAt).toLocaleDateString("ko-KR", { timeZone: "Asia/Seoul" })}</p><p className="mt-2 text-sm text-zinc-400">해외 편집 자료의 추천·주의·재미용 조합입니다. 실제 선택률이나 등장 확률을 뜻하지 않습니다.</p></header>
    <LolMayhemArchive patch={data.patch} champions={champions} />
    <a className="inline-flex min-h-11 items-center text-xs text-zinc-400 underline" href="https://arammayhem.com/data/" target="_blank" rel="noreferrer">데이터 출처: arammayhem.com · CC BY 4.0</a>
  </section>;
  const names = new Map(catalog.augments.map(augment => [augment.id, augment.name]));
  const supported = new Set(data.combos.map(combo => combo.championId));
  const visible = data.combos.filter(combo => combo.championId === Number(championId));
  return <section aria-label="해외 증바람 자료" className="mt-8 space-y-4 border-t border-zinc-800 pt-6">
    <div>
      <h2 className="text-lg font-semibold">챔피언별 외부 추천 조합</h2>
      <p className="mt-1 text-sm text-zinc-400">해외 편집 자료입니다. 실제 선택률이나 해당 챔피언의 등장 확률을 뜻하지 않습니다.</p>
      <p className="mt-2 text-xs text-zinc-400">검수 패치 {data.patch.replace(/^16\./, "26.")}{data.patch !== catalog.clientPatch && " (새 패치 자료 준비 중)"} · 공개 {new Date(data.publishedAt).toLocaleDateString("ko-KR", { timeZone: "Asia/Seoul" })}</p>
    </div>
    <label className="block text-sm">챔피언
      <select value={championId} onChange={event => setChampionId(event.target.value)} className="mt-2 block min-h-11 w-full rounded-lg border border-zinc-700 bg-zinc-900 px-3 sm:max-w-sm">
        <option value="">챔피언을 선택해 주세요</option>
        {champions.filter(champion => supported.has(champion.id)).map(champion => <option key={champion.id} value={champion.id}>{champion.name}</option>)}
      </select>
    </label>
    {championId && <ul className="divide-y divide-zinc-800">{visible.map(combo => <li key={combo.id} className="space-y-2 py-3 text-sm">
      <p className="font-semibold">{combo.augmentIds.map(id => names.get(id) ?? `증강 ${id}`).join(" + ")}</p>
      <p className="text-xs text-zinc-400">원본 분류: {combo.types.join(", ") || "없음"}</p>
      <a href={combo.sourceUrl} target="_blank" rel="noreferrer" className="inline-flex min-h-11 items-center text-amber-300 underline underline-offset-4">조합 출처 보기</a>
    </li>)}</ul>}
    <details>
      <summary className="min-h-11 cursor-pointer content-center text-sm font-semibold">전체 증강 선택률 보기</summary>
      <p className="mt-2 text-xs text-zinc-400">원본 패치 {data.sourcePatch ?? "미제공"} · 통계 기준일 {data.sourceStatsDate ?? "미제공"}{data.statsDateSource === "estimated" ? " (추정)" : ""}. 챔피언별 수치가 아니며 표본 수와 분모는 제공되지 않았습니다.</p>
      <ul className="mt-3 grid gap-x-6 text-sm sm:grid-cols-2">{data.rates.map(rate => <li key={rate.augmentId} className="flex justify-between gap-3 border-b border-zinc-800 py-3">
        <span>{names.get(rate.augmentId) ?? `증강 ${rate.augmentId}`}</span><span className="shrink-0 tabular-nums">{rate.pickRate === null ? "미제공" : `${rate.pickRate.toFixed(2)}%`}</span>
      </li>)}</ul>
    </details>
    <p className="text-xs text-zinc-400"><a href="https://arammayhem.com/data/" target="_blank" rel="noreferrer" className="inline-flex min-h-11 items-center underline">데이터 출처: arammayhem.com · CC BY 4.0</a> · BGMS에서 ID 매핑·패치 검수·표시를 가공했습니다.</p>
  </section>;
}
