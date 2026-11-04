"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { ReferenceKind, ReferencePublication, ReferenceRelease } from "@/lib/lol/mayhemReference";

type Data = { enabled: boolean; publicEnabled?: boolean; champions?: { id: number; name: string }[]; truncatedKinds?: ReferenceKind[]; releases: ReferenceRelease[]; publications: ReferencePublication[]; sync: unknown[] };
const button = "inline-flex min-h-11 items-center justify-center rounded-lg border border-zinc-700 px-3 text-sm hover:bg-zinc-800 disabled:opacity-40";
const input = "min-h-11 w-full min-w-0 rounded-lg border border-zinc-700 bg-zinc-900 px-3 text-sm";
const kinds: { id: ReferenceKind; label: string; scope: string }[] = [
  { id: "champion_tiers", label: "챔피언 티어 · ARAMGG", scope: "ARAMGG 티어 참고 자료입니다. BGMS 챔피언별 통계 아카이브가 아닙니다." },
  { id: "item_ratings", label: "아이템 평가 · IESDEV", scope: "IESDEV 아이템 평가 참고 자료입니다." },
  { id: "augment_rankings", label: "증강 순위 · arammayhem", scope: "arammayhem 전체 증강 순위이며 챔피언별 자료가 아닙니다." },
];
const date = (value: string | null) => value ? `${new Date(value).toLocaleString("ko-KR", { timeZone: "Asia/Seoul" })} KST` : "기록 없음";
const status = { pending: "검수 대기", approved: "승인됨", rejected: "제외됨" };
const aborted = (cause: unknown) => cause instanceof DOMException && cause.name === "AbortError";

export default function LolMayhemReferenceReview() {
  const [data, setData] = useState<Data | null>(null);
  const [kind, setKind] = useState<ReferenceKind>("champion_tiers");
  const [selected, setSelected] = useState(0);
  const [search, setSearch] = useState("");
  const [confirmed, setConfirmed] = useState(false);
  const [batchConfirmed, setBatchConfirmed] = useState<"approve" | "publish" | null>(null);
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");
  const [batchProgress, setBatchProgress] = useState<{ action: "approve" | "publish"; completed: number; total: number } | null>(null);
  const requestId = useRef(0);
  const controllerRef = useRef<AbortController | null>(null);
  const mountedRef = useRef(true);
  const refresh = useCallback(async () => {
    controllerRef.current?.abort();
    const controller = new AbortController();
    controllerRef.current = controller;
    const id = ++requestId.current;
    const response = await fetch("/api/admin/lol/mayhem-references", { cache: "no-store", signal: controller.signal });
    if (!response.ok) throw new Error("참조 자료 상태를 불러오지 못했습니다.");
    const next: Data = await response.json();
    if (!controller.signal.aborted && id === requestId.current) { setData(next); setConfirmed(false); setBatchConfirmed(null); }
    return next;
  }, []);
  useEffect(() => {
    mountedRef.current = true;
    void refresh().catch(cause => { if (!aborted(cause)) setError("참조 자료 상태를 불러오지 못했습니다."); });
    return () => { mountedRef.current = false; controllerRef.current?.abort(); };
  }, [refresh]);

  const allReleases = data?.releases.filter(row => row.kind === kind) ?? [];
  const terms = search.trim().toLowerCase().split(/\s+/).filter(Boolean);
  const championName = (id: number) => data?.champions?.find(champion => champion.id === id)?.name;
  const releases = allReleases.filter(row => terms.every(term => `${row.id} ${row.client_patch} ${row.champion_id} ${championName(row.champion_id) ?? ""} ${row.source_data_date} ${row.status} ${status[row.status]}`.toLowerCase().includes(term)));
  const release = releases.find(row => row.id === selected) ?? releases[0];
  const publication = data?.publications.find(row => row.kind === release?.kind && row.client_patch === release.client_patch && row.champion_id === release.champion_id);
  const canWrite = !!data?.enabled;
  const seenScopes = new Set<string>();
  const latestByChampion = allReleases.filter(row => {
    const scope = `${row.kind}:${row.client_patch}:${row.champion_id}`;
    if (seenScopes.has(scope)) return false;
    seenScopes.add(scope);
    return true;
  });
  const patchReleases = latestByChampion.filter(row => row.client_patch === release?.client_patch);
  const pendingBatch = patchReleases.filter(row => row.status === "pending");
  const publishBatch = patchReleases.filter(row => row.status === "approved" && data?.publications.find(pub => pub.kind === row.kind && pub.client_patch === row.client_patch && pub.champion_id === row.champion_id)?.release_id !== row.id);
  const dateRange = (rows: ReferenceRelease[]) => {
    const dates = rows.map(row => row.source_data_date).sort();
    return dates.length ? `${dates[0]} ~ ${dates[dates.length - 1]}` : "기록 없음";
  };
  const primary = release?.status === "pending" ? "approve" : release?.status === "approved" && publication?.release_id !== release.id ? "publish" : null;
  async function act(action: "approve" | "reject" | "publish" | "rollback") {
    if (!release || !confirmed || busy || !canWrite) return;
    if (action === "approve" && release.status !== "pending") return;
    if (action === "reject" && (release.status !== "pending" || reason.trim().length < 10)) return;
    if (action === "publish" && (release.status !== "approved" || publication?.release_id === release.id)) return;
    if (action === "rollback" && (publication?.release_id !== release.id || publication.previous_release_id === null)) return;
    setBusy(true); setError(""); setMessage("");
    try {
      const response = await fetch("/api/admin/lol/mayhem-references", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({
        action, id: release.id, expectedPublication: publication?.release_id ?? null, confirm: true, reason: action === "reject" ? reason.trim() : null,
      }) });
      const result = await response.json();
      if (!response.ok) throw new Error(result.error ?? "검토 요청에 실패했습니다.");
      setMessage("참조 자료 상태를 저장했습니다."); setConfirmed(false); await refresh();
    } catch (cause) { setError(cause instanceof Error ? cause.message : "검토 요청에 실패했습니다."); }
    finally { setBusy(false); }
  }
  async function runBatch(action: "approve" | "publish") {
    const targets = [...(action === "approve" ? pendingBatch : publishBatch)];
    if (!data || !canWrite || batchConfirmed !== action || busy || !targets.length) return;
    setBusy(true); setError(""); setMessage(""); setBatchConfirmed(null);
    let completed = 0;
    let actionFailed = false;
    setBatchProgress({ action, completed, total: targets.length });
    try {
      for (const target of targets) {
        if (!mountedRef.current) return;
        const current = data.publications.find(pub => pub.kind === target.kind && pub.client_patch === target.client_patch && pub.champion_id === target.champion_id);
        const response = await fetch("/api/admin/lol/mayhem-references", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({
          action, id: target.id, expectedPublication: current?.release_id ?? null, confirm: true, reason: null,
        }) });
        if (!mountedRef.current) return;
        const result = await response.json();
        if (!response.ok) throw new Error(result.error ?? `후보 #${target.id} 처리에 실패했습니다.`);
        completed += 1;
        setBatchProgress({ action, completed, total: targets.length });
      }
      if (mountedRef.current) setMessage(`${completed}개 후보 ${action === "approve" ? "검수 승인" : "공개"}을 완료했습니다.`);
    } catch (cause) {
      actionFailed = true;
      if (mountedRef.current) setError(`${completed}/${targets.length}개 처리 후 중단했습니다. ${cause instanceof Error ? cause.message : "요청에 실패했습니다."}`);
    } finally {
      if (mountedRef.current) {
        try { await refresh(); } catch { if (!actionFailed) setError("처리 후 최신 상태를 불러오지 못했습니다. 다시 시도해 주세요."); }
        if (mountedRef.current) { setBatchConfirmed(null); setBusy(false); }
      }
    }
  }
  const refreshWithMessage = () => { setError(""); void refresh().catch(cause => { if (!aborted(cause)) setError("참조 자료 상태를 불러오지 못했습니다."); }); };
  const sourceScope = kinds.find(row => row.id === kind)?.scope;

  return <section aria-label="증바람 외부 참조 자료 검토" className="space-y-4">
    <header><h2 className="text-lg font-semibold">티어·아이템·패치 순위</h2><p className="mt-1 text-sm text-zinc-400">참고 자료를 확인하고 검수·공개 상태를 관리합니다. 공개와 사용자 화면 적용은 별도입니다.</p></header>
    {error && <p role="alert" className="break-words text-sm text-red-300">{error}</p>}
    {data && <>
      {!data.enabled && <p className="text-sm text-amber-300">기능이 비활성화되어 자료 변경을 할 수 없습니다.</p>}
      {data.publicEnabled === false && <p className="text-sm text-amber-300">저장된 자료의 사용자 화면 적용은 대기 중입니다.</p>}
      <label className="block space-y-2 text-sm"><span>자료 종류</span><select aria-label="자료 종류" className={input} disabled={busy} value={kind} onChange={event => { setKind(event.target.value as ReferenceKind); setSelected(0); setConfirmed(false); setBatchConfirmed(null); setReason(""); }}>
        {kinds.map(row => <option key={row.id} value={row.id}>{row.label}</option>)}
      </select></label>
      <p className="text-sm text-zinc-400">{sourceScope}</p>
      {data.truncatedKinds?.includes(kind) && <p role="status" className="text-sm text-amber-300">최근 수집본 500개를 표시합니다.</p>}
      <label className="block space-y-2 text-sm"><span>후보 검색</span><input aria-label="후보 검색" type="search" disabled={busy} className={input} value={search} onChange={event => { setSearch(event.target.value); setConfirmed(false); setBatchConfirmed(null); }} placeholder="패치, 날짜, 챔피언, 상태" /></label>
      <p className="text-xs text-zinc-400">{releases.length === allReleases.length ? `${data.truncatedKinds?.includes(kind) ? "최근 수집본" : "후보"} ${allReleases.length}개` : `${releases.length}개 표시 · 전체 ${allReleases.length}개`}</p>
      {!releases.length ? <p className="text-sm text-zinc-400">{allReleases.length ? "검색 조건에 맞는 후보가 없습니다." : "이 종류의 검토 후보가 없습니다."}</p> : <>
        <label className="block space-y-2 text-sm"><span>검토 후보</span><select aria-label="검토 후보" className={input} disabled={busy} value={release?.id ?? ""} onChange={event => { setSelected(Number(event.target.value)); setConfirmed(false); setBatchConfirmed(null); setReason(""); }}>
          {releases.map(row => <option key={row.id} value={row.id}>패치 {row.client_patch} · {row.champion_id ? championName(row.champion_id) ?? `챔피언 ID ${row.champion_id}` : "전체 순위"} · {row.source_data_date} · {status[row.status]}</option>)}
        </select></label>
        {release && <>
          <div aria-label="참조 자료 요약" className="space-y-2 break-words text-sm">
            <p><strong>현재 후보:</strong> {release.source} · 패치 {release.client_patch} · {release.champion_id ? `${championName(release.champion_id) ?? `챔피언 ID ${release.champion_id}`} (ID ${release.champion_id})` : "전체 순위"} · 기준일 {release.source_data_date} · {status[release.status]}</p>
            <p><strong>현재 공개본:</strong> {publication ? `#${publication.release_id} · ${date(publication.published_at)}` : "없음"}</p>
            <p>{primary === "approve" ? "다음 단계: 출처와 기준일을 확인한 뒤 검수 승인하세요." : primary === "publish" ? "다음 단계: 승인된 자료를 확인한 뒤 공개하세요." : release.status === "rejected" ? "이 후보는 제외되었습니다." : "현재 후보가 공개되어 있습니다."}</p>
          </div>
          {primary && <>
            <label className="flex min-h-11 items-center gap-3 text-sm"><input type="checkbox" disabled={busy || !canWrite} checked={confirmed} onChange={event => setConfirmed(event.target.checked)} />출처·사용 권한·자료일·현재 공개 상태를 확인했습니다.</label>
            <button className={button} disabled={!canWrite || busy || !confirmed} onClick={() => void act(primary)}>{busy ? "처리 중…" : primary === "approve" ? "검수 승인" : "승인본 공개"}</button>
          </>}
          <details><summary className="min-h-11 cursor-pointer content-center text-sm">상세 정보</summary><div aria-label="참조 자료 출처 및 해시" className="space-y-2 break-all pb-2 text-sm text-zinc-400">
            <p>원천 버전 {release.upstream_version} · 수집 {date(release.fetched_at)}</p>
            <p>출처 표기: {release.attribution} · 사용 권한: {release.rights_basis}</p>
            <p>원본 경로 {release.raw_path} · SHA-256 {release.raw_hash} · {release.raw_bytes} bytes</p>
            <p>정규화 경로 {release.normalized_path} · SHA-256 {release.normalized_hash} · {release.normalized_bytes} bytes</p>
            <div className="flex flex-wrap gap-2"><a aria-disabled={!canWrite} tabIndex={canWrite ? undefined : -1} className={`${button} ${canWrite ? "" : "pointer-events-none opacity-40"}`} href={`/api/admin/lol/mayhem-references?download=${release.id}&kind=raw`}>원본 내려받기</a><a aria-disabled={!canWrite} tabIndex={canWrite ? undefined : -1} className={`${button} ${canWrite ? "" : "pointer-events-none opacity-40"}`} href={`/api/admin/lol/mayhem-references?download=${release.id}&kind=normalized`}>정규화 자료 내려받기</a></div>
            {data.sync.map(row => <p key={typeof row === "string" ? row : JSON.stringify(row)}>최근 수집 상태: {typeof row === "string" ? row : JSON.stringify(row)}</p>)}
          </div></details>
          <details><summary className="min-h-11 cursor-pointer content-center text-sm">기타 작업</summary><div className="space-y-3 py-2">
            <label className="block space-y-2 text-sm"><span>후보 제외 사유 · 제외 시 10자 이상</span><textarea aria-label="후보 제외 사유" className={`${input} min-h-24 py-3`} disabled={busy || !canWrite} maxLength={2048} value={reason} onChange={event => setReason(event.target.value)} /></label>
            <label className="flex min-h-11 items-center gap-3 text-sm"><input type="checkbox" disabled={busy || !canWrite} checked={confirmed} onChange={event => setConfirmed(event.target.checked)} />현재 후보와 공개 상태를 확인했습니다.</label>
            <div className="flex flex-wrap gap-2">
              <button className={button} disabled={!canWrite || busy || !confirmed || release.status !== "pending" || reason.trim().length < 10} onClick={() => void act("reject")}>후보 제외</button>
              <button className={button} disabled={!canWrite || busy || !confirmed || publication?.release_id !== release.id || publication.previous_release_id === null} onClick={() => void act("rollback")}>이전 공개본으로 복구</button>
            </div>
          </div></details>
          <section aria-label="패치별 일괄 작업" className="space-y-3 border-t border-zinc-800 pt-3">
            <h3 className="font-medium">이 패치 일괄 작업</h3>
            <p className="text-sm text-zinc-400">{release.source} · 패치 {release.client_patch} · 원본 기준일 {dateRange(pendingBatch.length ? pendingBatch : publishBatch)}</p>
            {pendingBatch.length > 1 && <>
              <p className="text-sm">검수 승인 대상 {pendingBatch.length}개 · 기준일 {dateRange(pendingBatch)} · 상태 검수 대기</p>
              <details><summary className="min-h-11 cursor-pointer content-center text-sm">검수 대상 {pendingBatch.length}개 목록</summary><ul className="max-h-64 space-y-1 overflow-y-auto break-words py-2 text-sm text-zinc-400">{pendingBatch.map(row => <li key={row.id}>#{row.id} · {row.source_data_date} · {row.champion_id ? championName(row.champion_id) ?? `챔피언 ID ${row.champion_id}` : "전체 순위"} · {status[row.status]}</li>)}</ul></details>
              <label className="flex min-h-11 items-center gap-3 text-sm"><input type="checkbox" disabled={busy || !canWrite} checked={batchConfirmed === "approve"} onChange={event => setBatchConfirmed(event.target.checked ? "approve" : null)} />패치 {release.client_patch}의 검수 대기 {pendingBatch.length}개를 모두 승인할 대상으로 확인했습니다.</label>
              <button className={button} disabled={!canWrite || busy || batchConfirmed !== "approve"} onClick={() => void runBatch("approve")}>이 패치 {pendingBatch.length}개 검수 승인</button>
            </>}
            {publishBatch.length > 1 && <>
              <p className="text-sm">공개 대상 {publishBatch.length}개 · 기준일 {dateRange(publishBatch)} · 상태 승인됨, 미공개</p>
              <details><summary className="min-h-11 cursor-pointer content-center text-sm">공개 대상 {publishBatch.length}개 목록</summary><ul className="max-h-64 space-y-1 overflow-y-auto break-words py-2 text-sm text-zinc-400">{publishBatch.map(row => <li key={row.id}>#{row.id} · {row.source_data_date} · {row.champion_id ? championName(row.champion_id) ?? `챔피언 ID ${row.champion_id}` : "전체 순위"} · {status[row.status]} · 미공개</li>)}</ul></details>
              <label className="flex min-h-11 items-center gap-3 text-sm"><input type="checkbox" disabled={busy || !canWrite} checked={batchConfirmed === "publish"} onChange={event => setBatchConfirmed(event.target.checked ? "publish" : null)} />패치 {release.client_patch}의 승인된 미공개 후보 {publishBatch.length}개를 모두 공개할 대상으로 확인했습니다.</label>
              <button className={button} disabled={!canWrite || busy || batchConfirmed !== "publish"} onClick={() => void runBatch("publish")}>이 패치 {publishBatch.length}개 공개</button>
            </>}
            {batchProgress && <p role="status" className="text-sm">{batchProgress.action === "approve" ? "검수 승인" : "공개"} 진행 {batchProgress.completed}/{batchProgress.total}</p>}
          </section>
        </>}
      </>}
    </>}
    {!data && !error && <p role="status" className="text-sm text-zinc-400">참조 자료 상태를 불러오는 중입니다.</p>}
    {error && <button className={button} onClick={refreshWithMessage}>다시 시도</button>}
    {message && <p role="status" className="text-sm text-emerald-300">{message}</p>}
    <button className={button} disabled={busy} onClick={refreshWithMessage}>상태 새로고침</button>
  </section>;
}
