"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { ChampionDatasetAdminData } from "@/lib/lol/mayhemChampionDataset";
import type { MayhemDatasetAdminData } from "@/lib/lol/mayhemDatasetView";
import { championUpdateGroup, comboUpdateGroup, referenceUpdateGroup, type ReferenceAdminData, type UpdateGroup } from "@/lib/lol/mayhemAdminUpdates";
import { toDisplayPatch } from "@/lib/lol/augments/patchMap";
import { compareReferencePatches } from "@/lib/lol/mayhemReference";

const control = "inline-flex min-h-11 items-center justify-center rounded-lg border px-4 text-sm focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-zinc-300 disabled:opacity-40";
const button = `${control} border-zinc-700 hover:bg-zinc-800`;
const primary = `${control} border-zinc-400 bg-zinc-100 text-zinc-950 hover:bg-white`;
const date = (value?: string) => value ? new Date(value).toLocaleString("ko-KR", { timeZone: "Asia/Seoul" }) : "기록 없음";
const patches = (group: UpdateGroup) => {
  const values = [...new Set(group.rows.map(row => row.patch))].sort(compareReferencePatches).map(patch => toDisplayPatch(patch) ?? patch);
  return values.length > 2 ? `${values.at(-1)}~${values[0]}` : values.join(", ");
};

export default function LolMayhemUpdateSummary({ refreshVersion = 0, onOpenMapping }: { refreshVersion?: number; onOpenMapping?: () => void }) {
  const [groups, setGroups] = useState<UpdateGroup[]>([]);
  const [loading, setLoading] = useState(true);
  const [errors, setErrors] = useState<string[]>([]);
  const [confirming, setConfirming] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [progress, setProgress] = useState({ done: 0, total: 0 });
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");
  const mounted = useRef(true);
  const writing = useRef(false);
  const request = useRef<AbortController | null>(null);

  const refresh = useCallback(async () => {
    request.current?.abort();
    const controller = new AbortController(); request.current = controller;
    const sources = [
      { endpoint: "mayhem-champion-datasets", label: "챔피언별 증강", parse: (data: ChampionDatasetAdminData) => [championUpdateGroup(data)] },
      { endpoint: "mayhem-references", label: "티어·아이템·패치 순위", parse: (data: ReferenceAdminData) => [referenceUpdateGroup(data, "champion_tiers"), referenceUpdateGroup(data, "item_ratings"), referenceUpdateGroup(data, "augment_rankings")] },
      { endpoint: "mayhem-datasets", label: "증강 추천 조합", parse: (data: MayhemDatasetAdminData) => [comboUpdateGroup(data)] },
    ];
    const results = await Promise.allSettled(sources.map(async source => {
      const response = await fetch(`/api/admin/lol/${source.endpoint}`, { cache: "no-store", signal: controller.signal });
      if (!response.ok) throw new Error("load_failed");
      return source.parse(await response.json());
    }));
    if (controller.signal.aborted || !mounted.current) return;
    setGroups(results.flatMap(result => result.status === "fulfilled" ? result.value : []));
    setErrors(results.flatMap((result, index) => result.status === "rejected" ? [`${sources[index].label} 자료를 불러오지 못했습니다.`] : []));
    setConfirming(null); setLoading(false);
  }, []);

  useEffect(() => {
    mounted.current = true;
    void refresh();
    return () => { mounted.current = false; request.current?.abort(); };
  }, [refresh]);
  useEffect(() => { if (refreshVersion && !writing.current) void refresh(); }, [refreshVersion, refresh]);

  async function apply(group: UpdateGroup) {
    if (writing.current || confirming !== group.key || !group.targets.length || group.blocked || group.targets.some(row => row.blocked)) return;
    writing.current = true; setBusy(group.key); setError(""); setMessage("");
    setProgress({ done: 0, total: group.targets.length });
    let completed = 0;
    let approved = false;
    try {
      for (const row of group.targets) {
        approved = row.status === "approved";
        for (const action of row.status === "approved" ? ["publish"] : ["approve", "publish"]) {
          if (!mounted.current) return;
          const response = await fetch(group.endpoint, { method: "POST", headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ action, id: row.id, expectedPublication: row.expectedPublication, confirm: true, reason: null }) });
          const result = await response.json();
          if (!response.ok) throw new Error(result.error ?? "적용하지 못했습니다.");
          if (action === "approve") approved = true;
        }
        completed++;
        if (mounted.current) setProgress({ done: completed, total: group.targets.length });
      }
      if (mounted.current) setMessage(`${group.title} 자료 ${completed}개를 적용했습니다. 사용자 화면에 순차적으로 반영됩니다.`);
    } catch (cause) {
      if (mounted.current) setError(`${group.title} ${completed}/${group.targets.length}개 적용 후 중단했습니다. ${cause instanceof Error ? cause.message : "다시 확인해 주세요."}${approved ? " 검토를 마친 자료는 저장되어 있으니 새로고침 후 다시 적용하세요." : " 새로고침 후 다시 적용하세요."}`);
    } finally {
      if (mounted.current) { await refresh(); setBusy(null); }
      writing.current = false;
    }
  }

  return <section aria-label="수집 자료와 화면 적용" className="space-y-5">
    <div className="flex flex-wrap items-center justify-between gap-3">
      <p className="text-sm text-zinc-300">새 자료가 있으면 내용을 확인하고 적용하세요.</p>
      <button type="button" className={button} disabled={!!busy || loading} onClick={() => { setLoading(true); void refresh(); }}>새로고침</button>
    </div>
    {loading && <p role="status" className="text-sm text-zinc-400">수집한 자료를 확인하고 있습니다.</p>}
    {!!errors.length && <div role="alert" className="space-y-1 text-sm text-amber-300">{errors.map(text => <p key={text}>{text} 새로고침해 주세요.</p>)}</div>}
    {error && <p role="alert" className="break-words text-sm text-red-300">{error}</p>}
    {message && <p role="status" className="text-sm text-emerald-300">{message}</p>}
    <div className="divide-y divide-zinc-800">
      {groups.map(group => {
        const appliedAt = group.publications.map(pub => pub.published_at).sort().at(-1);
        const amount = group.key === "champions" || group.key === "champion_tiers" ? Math.max(0, ...group.rows.map(row => row.amount)) : group.rows.reduce((sum, row) => sum + row.amount, 0);
        const blocked = group.blocked || group.targets.find(row => row.blocked)?.blocked;
        const held = group.rows.some(row => row.status === "rejected" && row.id !== row.expectedPublication);
        return <article key={group.key} aria-label={group.title} className="space-y-3 py-5 first:pt-0">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <h2 className="text-base font-semibold">{group.title}</h2>
            <span className={`text-sm ${group.targets.length ? "text-amber-300" : appliedAt ? "text-emerald-300" : "text-zinc-400"}`}>
              {blocked ? "적용 전 확인 필요" : group.targets.length ? "새 자료 있음" : held ? "새 자료 보류" : appliedAt && group.rows.length ? "적용됨" : "수집 대기"}
            </span>
          </div>
          <p className="break-words text-sm">{group.rows.length ? `${patches(group)} 패치 · ${amount ? `${amount.toLocaleString("ko-KR")}${group.unit}` : `${group.rows.length}개 자료`} 수집했습니다.` : "아직 수집한 자료가 없습니다."}</p>
          <p className="text-sm text-zinc-300">{group.effect}</p>
          <p className="text-xs leading-relaxed text-zinc-400">최근 수집 {date(group.rows.map(row => row.fetchedAt).sort().at(-1))} · 최근 적용 {date(appliedAt)}</p>
          {group.syncError && <p className="text-sm text-amber-300">최근 수집이 완료되지 않았습니다. 기존 적용 자료는 유지됩니다.</p>}
          {blocked && <p className="text-sm text-amber-300">{blocked}</p>}
          {group.key === "combos" && group.targets.some(row => row.blocked) && onOpenMapping && <button type="button" className={button} disabled={!!busy} onClick={onOpenMapping}>이름 연결하기</button>}
          {held && <p className="text-sm text-zinc-400">최근 수집 자료는 적용에서 제외했습니다. 기존 적용 자료는 유지됩니다.</p>}
          {!!group.targets.length && !(group.key === "combos" && blocked && onOpenMapping) && <>
            {confirming !== group.key ? <button type="button" className={primary} disabled={!!busy || !!blocked} onClick={() => { setConfirming(group.key); setError(""); setMessage(""); }}>적용 내용 확인</button> : <div className="space-y-3 border-t border-zinc-800 pt-3" aria-label={`${group.title} 적용 확인`}>
              <p className="text-sm">새로 수집한 {group.targets.length}개 자료로 사용자 화면을 갱신합니다. 기존 적용 기록은 보관됩니다.</p>
              <details><summary className="min-h-11 cursor-pointer content-center text-sm text-zinc-300">적용할 자료 보기</summary>
                <ul className="max-h-60 space-y-2 overflow-y-auto py-2 text-sm text-zinc-400">{group.targets.map(row => <li key={row.id} className="break-words">{row.subject} · {row.previousPatch ? `${toDisplayPatch(row.previousPatch) ?? row.previousPatch} → ${toDisplayPatch(row.patch) ?? row.patch} 자료 교체` : `${toDisplayPatch(row.patch) ?? row.patch} 새 패치 추가`} · 자료 기준 {row.sourceDate}</li>)}</ul>
              </details>
              <div className="flex flex-wrap gap-2">
                <button type="button" className={primary} disabled={!!busy} onClick={() => void apply(group)}>확인하고 적용</button>
                <button type="button" className={button} disabled={!!busy} onClick={() => setConfirming(null)}>취소</button>
              </div>
            </div>}
            {busy === group.key && <p role="status" className="text-sm">적용 중 {progress.done}/{progress.total}개</p>}
          </>}
        </article>;
      })}
    </div>
  </section>;
}
