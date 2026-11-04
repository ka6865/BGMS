"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { suggestedMapping, type MappingPreview, type MappingSource } from "@/lib/lol/mayhemMappingReview";
import { LOL_AUGMENT_RARITY_LABELS, type LolMayhemAugment } from "@/lib/lol/augments/catalog";
import { toDisplayPatch } from "@/lib/lol/augments/patchMap";
import type { MayhemDatasetAdminData } from "@/lib/lol/mayhemDatasetView";

const button = "inline-flex min-h-11 items-center justify-center rounded-lg border border-zinc-700 px-4 text-sm hover:bg-zinc-800 focus-visible:outline-2 focus-visible:outline-offset-2 disabled:opacity-40";
const input = "min-h-11 w-full min-w-0 rounded-lg border border-zinc-700 bg-zinc-900 px-3 text-sm";
const label = (source: MappingSource) => source.name ?? source.nameEn ?? "원본 이름 미제공";
type Pair = { source: MappingSource; target: LolMayhemAugment };

export default function LolMayhemComboMapping({ onPrepared }: { onPrepared: () => void }) {
  const [data, setData] = useState<MappingPreview | null>(null);
  const [patchChoice, setPatchChoice] = useState("");
  const [selected, setSelected] = useState("");
  const [targetId, setTargetId] = useState(0);
  const [query, setQuery] = useState("");
  const [officialQuery, setOfficialQuery] = useState("");
  const [confirmation, setConfirmation] = useState<"one" | "batch" | null>(null);
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState("");
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");
  const mounted = useRef(true);
  const writing = useRef(false);
  const controller = useRef<AbortController | null>(null);
  const load = useCallback(async () => {
    controller.current?.abort();
    const request = new AbortController(); controller.current = request;
    try {
      const response = await fetch("/api/admin/lol/mayhem-datasets", { cache: "no-store", signal: request.signal });
      if (!response.ok) throw new Error();
      const admin: MayhemDatasetAdminData = await response.json();
      const release = admin.releases[0];
      if (!release) { if (!request.signal.aborted) setMessage("아직 수집한 조합 자료가 없습니다."); return; }
      const preview = await fetch(`/api/admin/lol/mayhem-datasets?mapping=${release.id}`, { cache: "no-store", signal: request.signal });
      if (!preview.ok) throw new Error();
      const next: MappingPreview = await preview.json();
      if (next.releaseId !== release.id || !Array.isArray(next.sources) || !Array.isArray(next.patches) || !Array.isArray(next.mappings)) throw new Error();
      if (!request.signal.aborted && mounted.current) { setData(next); setPatchChoice(""); setSelected(""); setTargetId(0); setConfirmation(null); setError(""); }
    } catch { if (!request.signal.aborted && mounted.current) setError("연결할 증강 이름을 불러오지 못했습니다. 다시 불러와 주세요."); }
  }, []);
  useEffect(() => { mounted.current = true; void load(); return () => { mounted.current = false; controller.current?.abort(); }; }, [load]);
  const patch = data?.patches.find(row => row.patch === patchChoice) ?? data?.patches[0];
  const linked = new Set(data?.mappings.filter(row => row.client_patch === patch?.patch && row.status === "approved").map(row => row.external_id));
  const pending = data?.sources.filter(row => patch?.externalIds.includes(row.externalId) && !linked.has(row.externalId)) ?? [];
  const visible = pending.filter(row => [row.name, row.nameEn].some(name => name?.toLocaleLowerCase("ko").includes(query.trim().toLocaleLowerCase("ko"))) || (!query.trim() && !row.name && !row.nameEn));
  const source = pending.find(row => row.externalId === selected) ?? visible[0];
  const suggestion = source && suggestedMapping(source, patch?.augments ?? []);
  const target = patch?.augments.find(row => row.id === targetId) ?? (!targetId ? suggestion : null);
  const candidates = patch?.augments.filter(row => [row.name, row.nameEn, row.text].some(text => text?.toLocaleLowerCase("ko").includes(officialQuery.trim().toLocaleLowerCase("ko")))) ?? [];
  const batch: Pair[] = pending.flatMap(source => { const target = suggestedMapping(source, patch?.augments ?? []); return target ? [{ source, target }] : []; });

  async function save(pairs: Pair[], mode: "one" | "batch") {
    if (!patch || !pairs.length || confirmation !== mode || writing.current) return;
    const currentPatch = patch.patch;
    writing.current = true; setBusy(true); setError(""); setMessage("");
    setProgress(`0/${pairs.length}개 연결 저장 중`);
    let done = 0;
    try {
      for (const { source, target } of pairs) {
        if (!mounted.current) return;
        const response = await fetch("/api/admin/lol/mayhem-datasets", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({
          action: "map", patch: currentPatch, externalId: source.externalId, platformId: target.id, confirm: true,
          evidence: `관리자가 외부 이름 '${label(source)}' (${source.nameEn ?? "영문명 미제공"})과 공식 이름 '${target.name}' 및 공식 설명을 확인하고 연결했습니다.`,
        }) });
        const result = await response.json();
        if (!response.ok || result.ok !== true) throw new Error();
        done++;
        if (mounted.current) {
          setProgress(`${done}/${pairs.length}개 연결 저장 중`);
          setData(current => current && ({ ...current, mappings: [...current.mappings.filter(row => !(row.external_id === source.externalId && row.client_patch === currentPatch)), { external_id: source.externalId, client_patch: currentPatch, platform_id: target.id, status: "approved" }] }));
        }
      }
      if (mounted.current) { setMessage(`${done}개 이름 연결을 저장했습니다. 연결 결과 반영을 누르면 조합 자료를 다시 준비합니다.`); setSelected(""); setTargetId(0); setOfficialQuery(""); }
    } catch { if (mounted.current) setError(`${done}/${pairs.length}개 연결 후 중단했습니다. 저장한 연결은 유지됩니다. 다시 불러온 뒤 남은 이름을 확인해 주세요.`); }
    finally { writing.current = false; if (mounted.current) { setBusy(false); setConfirmation(null); setProgress(""); } }
  }
  async function prepare() {
    if (writing.current) return;
    writing.current = true; setBusy(true); setError(""); setMessage("");
    setProgress("연결 결과를 반영한 조합 자료를 준비하고 있습니다.");
    try {
      const response = await fetch("/api/admin/lol/mayhem-datasets", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action: "sync", confirm: true }) });
      const result = await response.json();
      if (!response.ok || result.ok !== true) throw new Error();
      if (mounted.current) { setMessage("연결 결과를 반영한 자료를 준비했습니다. 위의 증강 추천 조합에서 내용을 확인하고 적용하세요."); onPrepared(); await load(); }
    } catch { if (mounted.current) setError("조합 자료를 다시 준비하지 못했습니다. 저장한 이름 연결은 유지됩니다. 다시 시도해 주세요."); }
    finally { writing.current = false; if (mounted.current) { setBusy(false); setProgress(""); } }
  }

  return <section aria-label="증강 이름 연결" className="space-y-4 py-3">
    <p className="text-sm text-zinc-300">수집한 증강 이름을 게임에서 쓰는 증강과 연결합니다. 연결만 저장하며 사용자 화면은 바뀌지 않습니다.</p>
    {error && <p role="alert" className="text-sm text-red-300">{error}</p>}
    {message && <p role="status" className="text-sm text-emerald-300">{message}</p>}
    {!data && !error && !message && <p role="status" className="text-sm text-zinc-400">증강 이름을 불러오는 중입니다.</p>}
    {data && <>
      {data.patches.length > 1 ? <label className="block space-y-2 text-sm"><span>연결할 자료</span><select aria-label="연결할 자료" className={input} disabled={busy} value={patch?.patch} onChange={event => { setPatchChoice(event.target.value); setSelected(""); setTargetId(0); setOfficialQuery(""); setConfirmation(null); }}>
        {data.patches.map(row => <option key={row.patch} value={row.patch}>{row.purpose} · {toDisplayPatch(row.patch)}</option>)}
      </select></label> : <p className="text-sm">{toDisplayPatch(patch?.patch ?? "")} 패치 · 연결할 이름 {pending.length}개</p>}
      {!!batch.length && <details className="border-y border-zinc-800 py-2"><summary className="min-h-11 cursor-pointer content-center text-sm">이름이 일치하는 {batch.length}개 한 번에 확인</summary>
        <ul className="max-h-80 space-y-4 overflow-y-auto py-3 text-sm">{batch.map(({ source, target }) => <li key={source.externalId} className="space-y-1 break-words"><p>{label(source)} → {target.name} · {LOL_AUGMENT_RARITY_LABELS[target.rarity]}</p><p className="text-xs text-zinc-400">{target.text}</p></li>)}</ul>
        <label className="flex min-h-11 items-center gap-3 text-sm"><input type="checkbox" disabled={busy} checked={confirmation === "batch"} onChange={event => setConfirmation(event.target.checked ? "batch" : null)} />위 이름과 공식 설명을 확인했습니다.</label>
        <button type="button" className={button} disabled={busy || confirmation !== "batch"} onClick={() => void save(batch, "batch")}>확인한 {batch.length}개 연결 저장</button>
      </details>}
      {pending.length > 0 ? <>
        <label className="block space-y-2 text-sm"><span>연결할 증강 찾기</span><input aria-label="연결할 증강 찾기" type="search" className={input} disabled={busy} value={query} onChange={event => { setQuery(event.target.value); setSelected(""); setTargetId(0); setOfficialQuery(""); setConfirmation(null); }} placeholder="한글 또는 영문 이름" /></label>
        <ul aria-label="연결할 증강 이름" className="max-h-48 divide-y divide-zinc-800 overflow-y-auto">{visible.map((row, index) => <li key={row.externalId}><button type="button" className="min-h-11 w-full break-words px-2 py-2 text-left text-sm hover:bg-zinc-800 disabled:opacity-40" aria-pressed={source?.externalId === row.externalId} disabled={busy} onClick={() => { setSelected(row.externalId); setTargetId(0); setOfficialQuery(""); setConfirmation(null); }}>{label(row)}{!row.name && !row.nameEn ? ` ${index + 1}` : ""}</button></li>)}</ul>
        {!visible.length && <p className="text-sm text-zinc-400">해당 이름이 없습니다. 검색어를 바꿔 주세요.</p>}
        {source && <div className="space-y-3 border-t border-zinc-800 pt-3" aria-label="증강 이름 비교">
          <p className="text-sm"><strong>수집한 이름</strong> · {label(source)}{source.nameEn && source.nameEn !== source.name ? ` (${source.nameEn})` : ""}{source.rarity ? ` · ${LOL_AUGMENT_RARITY_LABELS[source.rarity]}` : ""}</p>
          {source.conflict && <p className="text-sm text-amber-300">원본에서 이름이 다르게 쓰입니다. 같은 증강인지 직접 확인해 주세요.</p>}
          <p className="text-xs text-zinc-400">원본에는 효과 설명이 없어 공식 설명과 이름을 함께 확인해야 합니다.</p>
          <label className="block space-y-2 text-sm"><span>게임 증강 검색</span><input aria-label="게임 증강 검색" type="search" className={input} disabled={busy} value={officialQuery} onChange={event => { setOfficialQuery(event.target.value); setTargetId(0); setConfirmation(null); }} placeholder="이름이나 효과로 찾기" /></label>
          <label className="block space-y-2 text-sm"><span>연결할 게임 증강</span><select aria-label="연결할 게임 증강" className={input} disabled={busy} value={target?.id ?? ""} onChange={event => { setTargetId(Number(event.target.value)); setConfirmation(null); }}>
            <option value="">같은 증강을 선택하세요</option>{[...new Map([...(target ? [target] : []), ...candidates].map(row => [row.id, row])).values()].map(row => <option key={row.id} value={row.id}>{row.name} · {LOL_AUGMENT_RARITY_LABELS[row.rarity]}</option>)}
          </select></label>
          {target && <p className="whitespace-pre-wrap break-words text-sm text-zinc-300"><strong>{target.name}</strong> · {target.text}</p>}
          {!patch?.augments.length && <p className="text-sm text-amber-300">이 패치의 공식 증강 자료가 없어 연결할 수 없습니다.</p>}
          <label className="flex min-h-11 items-center gap-3 text-sm"><input type="checkbox" disabled={busy || !target} checked={confirmation === "one"} onChange={event => setConfirmation(event.target.checked ? "one" : null)} />수집한 이름과 공식 설명을 확인했습니다.</label>
          <button type="button" className={button} disabled={busy || !target || confirmation !== "one"} onClick={() => target && void save([{ source, target }], "one")}>이 이름 연결 저장</button>
        </div>}
      </> : <p role="status" className="text-sm">이 자료의 증강 이름 연결을 마쳤습니다.</p>}
      {!!progress && <p role="status" className="text-sm">{progress}</p>}
      <div className="flex flex-wrap gap-2 border-t border-zinc-800 pt-3">
        <button type="button" className={button} disabled={busy} onClick={() => void load()}>다시 불러오기</button>
        <button type="button" className={button} disabled={busy || !data.sources.length} onClick={() => void prepare()}>연결 결과 반영</button>
      </div>
    </>}
    {!data && error && <button type="button" className={button} onClick={() => void load()}>다시 불러오기</button>}
  </section>;
}
