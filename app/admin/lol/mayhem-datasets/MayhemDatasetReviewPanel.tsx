"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { MayhemDatasetAdminData } from "@/lib/lol/mayhemDatasetView";

const button = "inline-flex min-h-11 items-center justify-center rounded-lg border border-zinc-700 px-3 text-sm hover:bg-zinc-800 disabled:opacity-40";
const input = "min-h-11 w-full min-w-0 rounded-lg border border-zinc-700 bg-zinc-900 px-3 text-sm";
const date = (value: string | null) => value ? new Date(value).toLocaleString("ko-KR", { timeZone: "Asia/Seoul" }) + " KST" : "기록 없음";
const status: Record<string, string> = { pending: "검수 대기", validated: "검증 완료", approved: "승인됨", rejected: "제외됨" };

export default function MayhemDatasetReviewPanel() {
  const [data, setData] = useState<MayhemDatasetAdminData | null>(null);
  const [selected, setSelected] = useState(0);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");
  const [confirmed, setConfirmed] = useState(false);
  const [externalId, setExternalId] = useState("");
  const [platformId, setPlatformId] = useState("");
  const [evidence, setEvidence] = useState("");
  const [mappingPatchChoice, setMappingPatchChoice] = useState("");
  const [reviewReason, setReviewReason] = useState("");
  const requestId = useRef(0);
  const refresh = useCallback(async (signal?: AbortSignal) => {
    const id = ++requestId.current;
    const response = await fetch("/api/admin/lol/mayhem-datasets", { cache: "no-store", signal });
    if (!response.ok) throw new Error("검토 자료를 불러오지 못했습니다.");
    const next: MayhemDatasetAdminData = await response.json();
    if (!signal?.aborted && id === requestId.current) setData(next);
  }, []);
  useEffect(() => {
    const controller = new AbortController();
    void refresh(controller.signal).catch(() => { if (!controller.signal.aborted) setError("검토 자료를 불러오지 못했습니다."); });
    return () => controller.abort();
  }, [refresh]);
  const release = data?.releases.find(row => row.id === selected) ?? data?.releases[0];
  const publication = data?.publications.find(row => row.client_patch === release?.verified_client_patch);
  const mappingPatch = mappingPatchChoice || release?.verified_client_patch || "";
  async function act(action: string) {
    if (busy) return;
    setBusy(true); setError(""); setMessage("");
    try {
      const response = await fetch("/api/admin/lol/mayhem-datasets", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({
        action, id: release?.id, patch: action === "map" ? mappingPatch : release?.verified_client_patch, confirm: true, expectedPublication: publication?.release_id ?? null,
        externalId, platformId: Number(platformId), evidence, reason: reviewReason,
      }) });
      const result = await response.json();
      if (!response.ok) throw new Error(result.error ?? "요청에 실패했습니다.");
      setMessage(action === "sync" ? "원본을 저장하고 검토 후보를 갱신했습니다." : "검토 결과를 저장했습니다.");
      if (action === "sync" && result.id) { setSelected(result.id); setMappingPatchChoice(""); }
      if (action === "map") { setExternalId(""); setPlatformId(""); setEvidence(""); }
      setConfirmed(false);
      await refresh();
    } catch (cause) { setError(cause instanceof Error ? cause.message : "요청에 실패했습니다."); }
    finally { setBusy(false); }
  }
  return <main className="mx-auto w-full max-w-5xl space-y-5 p-4 text-zinc-100 sm:p-6" data-testid="mayhem-dataset-review">
    <header>
      <h1 className="text-xl font-semibold">증바람 해외 데이터셋 검토</h1>
      <p className="mt-2 text-sm text-zinc-400">전체 증강 선택률과 외부 추천 조합을 구분해 검수합니다. 챔피언별 등장 가능 여부는 이 자료로 판단하지 않습니다.</p>
    </header>
    <div className="flex flex-wrap gap-2">
      <button className={button} disabled={busy} onClick={() => { setError(""); void refresh().catch(() => setError("검토 자료를 불러오지 못했습니다.")); }}>상태 새로고침</button>
      <button className={button} disabled={busy} onClick={() => void act("sync")}>{busy ? "처리 중…" : "원본 확인·매핑 반영"}</button>
    </div>
    {error && <p role="alert" className="break-words text-sm text-red-300">{error}</p>}
    {message && <p role="status" className="text-sm text-emerald-300">{message}</p>}
    {!data && !error && <p role="status">자료를 불러오는 중입니다.</p>}
    {data && <>
      <section aria-label="데이터 최신화 상태" className="space-y-2 border-y border-zinc-800 py-4 text-sm">
        <h2 className="font-semibold">수집 상태</h2>
        {!data.sync.length && <p className="text-zinc-400">아직 실행 기록이 없습니다.</p>}
        {data.sync.map(job => <div key={job.job_key} className="space-y-1 break-words">
          <p>{job.job_key}</p><p className="text-zinc-400">확인 {date(job.last_checked_at)} · 성공 {date(job.last_success_at)}</p>
          {job.last_error_code && <p className="text-amber-300">{job.last_error_code} · 연속 실패 {job.consecutive_failures}회</p>}
        </div>)}
      </section>
      <label className="block space-y-2 text-sm"><span>검토할 수집본</span>
        <select aria-label="검토할 수집본" className={input} disabled={busy} value={release?.id ?? ""} onChange={event => { setSelected(Number(event.target.value)); setConfirmed(false); setExternalId(""); setMappingPatchChoice(""); setReviewReason(""); }}>
          {!data.releases.length && <option value="">수집본 없음</option>}
          {data.releases.map(row => <option key={row.id} value={row.id}>#{row.id} · {row.verified_client_patch} · {status[row.status] ?? row.status}</option>)}
        </select>
      </label>
      {release && <>
        <section className="space-y-2 text-sm" aria-label="수집본 정보">
          <p className="break-all">원본 버전 {release.upstream_release_id}</p>
          <p className="text-zinc-400">확인 {date(release.fetched_at)} · 원본 통계일 {release.metadata.sourceStatsDate ?? "미제공"}</p>
          <p>전체 증강 {release.metadata.augments ?? 0}행 · 외부 조합 {release.metadata.combos ?? 0}묶음</p>
          <p>미매핑 {release.metadata.unknown_count ?? 0}개 · 상태 {status[release.status] ?? release.status}</p>
          <div className="flex flex-wrap gap-2">{(["augments", "combos"] as const).map(kind => <a key={kind} className={button} href={`/api/admin/lol/mayhem-datasets?download=${release.id}&kind=${kind}`}>{kind === "augments" ? "선택률 원본 내려받기" : "조합 원본 내려받기"}</a>)}</div>
          <p className="text-zinc-400">현재 공개본 {publication ? `#${publication.release_id} · ${date(publication.published_at)}` : "없음"}</p>
        </section>
        <form className="space-y-3 border-y border-zinc-800 py-4" onSubmit={event => { event.preventDefault(); void act("map"); }}>
          <h2 className="font-semibold">증강 ID 매핑 검토</h2>
          <p className="text-sm text-zinc-400">원본과 공식 설명을 대조한 항목만 저장하세요. 저장 후 원본 확인·매핑 반영으로 후보를 다시 생성합니다.</p>
          <label className="block space-y-2 text-sm"><span>매핑 패치</span><select aria-label="매핑 패치" className={input} disabled={busy} value={mappingPatch} onChange={event => { setMappingPatchChoice(event.target.value); setPlatformId(""); }}>
            <option value={release.verified_client_patch}>조합 검수용 · {release.verified_client_patch}</option>
            {release.metadata.sourceClientPatch && release.metadata.sourceClientPatch !== release.verified_client_patch && <option value={release.metadata.sourceClientPatch}>전체 선택률 원본용 · {release.metadata.sourceClientPatch}</option>}
          </select></label>
          <p className="text-xs text-zinc-400">선택률 원본 패치와 조합 검수 패치가 다르면 각각 매핑합니다. 아래 공식 증강은 선택한 매핑 패치 기준입니다.</p>
          <label className="block space-y-2 text-sm"><span>외부 증강 ID</span><select aria-label="외부 증강 ID" className={input} required value={externalId} disabled={busy} onChange={event => setExternalId(event.target.value)}>
            <option value="">미매핑 항목 선택</option>{release.metadata.unknownExternalIds?.map(id => <option key={id} value={id}>{id}</option>)}
          </select></label>
          <label className="block space-y-2 text-sm"><span>공식 증강</span><select aria-label="공식 증강" className={input} required value={platformId} disabled={busy} onChange={event => setPlatformId(event.target.value)}>
            <option value="">공식 증강 선택</option>{data.augments.filter(augment => augment.patch === mappingPatch).map(augment => <option key={augment.platformId} value={augment.platformId}>{augment.name} · {augment.platformId}</option>)}
          </select></label>
          <label className="block space-y-2 text-sm"><span>검토 근거</span><textarea className={`${input} min-h-24 py-3`} value={evidence} required minLength={10} maxLength={2048} disabled={busy} onChange={event => setEvidence(event.target.value)} placeholder="이름·설명·등급을 대조한 근거와 출처" /></label>
          <button type="submit" className={button} disabled={busy || !externalId || !platformId || evidence.trim().length < 10}>확인한 매핑 저장</button>
          <details><summary className="min-h-11 cursor-pointer content-center text-sm">이 패치의 저장된 매핑</summary><ul className="space-y-2 text-xs text-zinc-400">{data.mappings.filter(mapping => mapping.client_patch === mappingPatch).map(mapping => <li key={mapping.external_id} className="break-words">{mapping.external_id} → {mapping.platform_id} · {mapping.status}</li>)}</ul></details>
        </form>
        <section aria-label="데이터셋 승인과 공개" className="space-y-3">
          <label className="block space-y-2 text-sm"><span>후보 제외 사유 · 제외할 때만 10자 이상 입력</span><textarea aria-label="후보 제외 사유" className={`${input} min-h-24 py-3`} disabled={busy} maxLength={2048} value={reviewReason} onChange={event => setReviewReason(event.target.value)} /></label>
          <label className="flex min-h-11 items-center gap-3 text-sm"><input type="checkbox" disabled={busy} checked={confirmed} onChange={event => setConfirmed(event.target.checked)} />#{release.id} 원본·매핑·검수 패치를 확인했습니다.</label>
          <div className="flex flex-wrap gap-2">
            <button className={button} disabled={busy || !confirmed || !!release.metadata.unknown_count || !["pending", "validated"].includes(release.status)} onClick={() => void act("approve")}>검수 승인</button>
            <button className={button} disabled={busy || !confirmed || release.status !== "approved" || publication?.release_id === release.id} onClick={() => void act("publish")}>승인본 공개</button>
            <button className={button} disabled={busy || !confirmed || release.status === "approved" || release.status === "rejected" || reviewReason.trim().length < 10} onClick={() => void act("reject")}>후보 제외</button>
            <button className={button} disabled={busy || !confirmed || publication?.previous_release_id !== release.id} onClick={() => void act("rollback")}>이전 공개본으로 복구</button>
          </div>
        </section>
      </>}
    </>}
  </main>;
}
