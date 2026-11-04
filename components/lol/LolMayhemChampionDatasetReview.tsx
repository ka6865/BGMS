"use client";

import { useCallback, useEffect, useState } from "react";
import type { ChampionDatasetAdminData, ChampionDatasetReadiness } from "@/lib/lol/mayhemChampionDataset";

const button = "inline-flex min-h-11 items-center justify-center rounded-lg border border-zinc-700 px-3 text-sm hover:bg-zinc-800 disabled:opacity-40";
const input = "min-h-11 w-full min-w-0 rounded-lg border border-zinc-700 bg-zinc-900 px-3 text-sm";
const labels: Record<keyof ChampionDatasetReadiness, string> = { apiKeyConfigured: "API 키 설정", reuseConfirmed: "재사용 조건 확인", enabled: "기능 활성화", persistenceEnabled: "영속 저장 활성화" };

export default function LolMayhemChampionDatasetReview() {
  const [data, setData] = useState<(ChampionDatasetAdminData & { databaseAvailable?: boolean }) | null>(null);
  const [selected, setSelected] = useState(0);
  const [confirmed, setConfirmed] = useState(false);
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");
  const refresh = useCallback(async (signal?: AbortSignal) => {
    const response = await fetch("/api/admin/lol/mayhem-champion-datasets", { cache: "no-store", signal });
    if (!response.ok) throw new Error("챔피언 통계 검토 상태를 불러오지 못했습니다.");
    setData(await response.json());
  }, []);
  useEffect(() => {
    const controller = new AbortController();
    void refresh(controller.signal).catch(() => { if (!controller.signal.aborted) setError("챔피언 통계 검토 상태를 불러오지 못했습니다."); });
    return () => controller.abort();
  }, [refresh]);

  const release = data?.releases.find(row => row.id === selected) ?? data?.releases[0];
  const publication = data?.publications.find(row => row.client_patch === release?.client_patch);
  const canApply = !!data && Object.values(data.readiness).every(Boolean);
  const canWrite = !!data?.readiness.persistenceEnabled;
  const completeManifest = !!release && release.metadata.expectedChampionIds.length > 0
    && release.metadata.expectedChampionIds.length === release.metadata.files.length
    && release.metadata.expectedChampionIds.every(id => release.metadata.files.some(file => file.championId === id
      && /^external\/champion-stats\/champion_api_v1\/objects\/[a-f0-9]{64}\.json$/.test(file.rawPath)
      && /^external\/champion-stats\/champion_api_v1\/objects\/[a-f0-9]{64}\.json$/.test(file.normalizedPath)
      && /^[a-f0-9]{64}$/.test(file.rawHash) && /^[a-f0-9]{64}$/.test(file.normalizedHash)));
  async function act(action: "approve" | "reject" | "publish" | "rollback") {
    if (!release || !canWrite || ((action === "approve" || action === "publish") && (!canApply || !completeManifest)) || !confirmed || busy) return;
    setBusy(true); setError(""); setMessage("");
    try {
      const response = await fetch("/api/admin/lol/mayhem-champion-datasets", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({
        action, id: release.id, expectedPublication: publication?.release_id ?? null, confirm: true, reason: reason.trim() || null,
      }) });
      const result = await response.json();
      if (!response.ok) throw new Error(result.error ?? "검토 요청에 실패했습니다.");
      setMessage("검토 상태를 저장했습니다."); setConfirmed(false); await refresh();
    } catch (cause) { setError(cause instanceof Error ? cause.message : "검토 요청에 실패했습니다."); }
    finally { setBusy(false); }
  }

  return <section aria-label="챔피언 통계 데이터셋 검토" className="space-y-4 border-y border-zinc-800 py-5">
    <header><h2 className="text-lg font-semibold">챔피언별 선택 통계 검토</h2><p className="mt-1 text-sm text-zinc-400">수집은 CLI에서만 실행합니다. 이 화면은 후보 검토와 공개 상태 변경을 담당합니다.</p></header>
    {!data && !error && <p role="status" className="text-sm text-zinc-400">검토 상태를 불러오는 중입니다.</p>}
    {data && <>
      <div className="flex flex-wrap gap-2 text-xs">{(Object.entries(labels) as [keyof ChampionDatasetReadiness, string][]).map(([key, label]) => <span key={key} className={`rounded border px-2 py-1 ${data.readiness[key] ? "border-emerald-800 text-emerald-300" : "border-amber-800 text-amber-300"}`}>{label}: {data.readiness[key] ? "준비됨" : "미설정"}</span>)}</div>
      {!data.databaseAvailable && <p className="text-sm text-amber-300">키·사용 조건 또는 영속 저장을 확인할 수 없어 데이터베이스 조회를 생략했습니다.</p>}
      {data.sync.map(row => <p key={row.job_key} className="break-words text-xs text-zinc-400">수집 상태 {row.job_key} · 확인 {row.last_checked_at ?? "기록 없음"} · {row.last_error_code ?? "오류 없음"}</p>)}
      {!data.releases.length ? <p className="text-sm text-zinc-400">검토할 챔피언 통계 후보가 없습니다.</p> : <>
        <label className="block space-y-2 text-sm"><span>검토 후보</span><select aria-label="챔피언 통계 후보" className={input} disabled={busy} value={release?.id ?? ""} onChange={event => { setSelected(Number(event.target.value)); setConfirmed(false); setReason(""); }}>
          {data.releases.map(row => <option key={row.id} value={row.id}>#{row.id} · {row.client_patch} · {row.status}</option>)}
        </select></label>
        {release && <>
        <div className="space-y-1 break-words text-sm" aria-label="챔피언 통계 후보 정보">
          <p>원천 버전 {release.upstream_version} · 원천 패치 {release.metadata.clientPatch} · 통계 기준일 {release.source_data_date} · 수집 {release.fetched_at}</p>
          <p className="text-zinc-400">예상 챔피언 {release.metadata.expectedChampionIds.length}명 · 수집 파일 {release.metadata.files.length}개 · {completeManifest ? "manifest 검사 완료" : "manifest 검증 누락"} · 카탈로그 {release.metadata.catalogHash}</p>
          <p className="text-zinc-400">출처 표기: {release.metadata.attribution} · 사용 조건: {release.metadata.rightsBasis}</p>
          <p className="text-zinc-400">선택률 분모는 미확인입니다. 파일별 선택률·표본 수의 출처 범위를 구분해 확인해야 합니다.</p>
          <p className="text-zinc-400">현재 공개본 {publication ? `#${publication.release_id}` : "없음"} · 후보 상태 {release.status}</p>
        </div>
        <label className="block space-y-2 text-sm"><span>제외 사유 (제외 시 10자 이상)</span><textarea className={`${input} min-h-20 py-3`} maxLength={2048} disabled={busy} value={reason} onChange={event => setReason(event.target.value)} /></label>
        <label className="flex min-h-11 items-center gap-3 text-sm"><input type="checkbox" disabled={busy || !canWrite} checked={confirmed} onChange={event => setConfirmed(event.target.checked)} />패치·출처·분모·사용 조건과 현재 공개 상태를 확인했습니다.</label>
        <div className="flex flex-wrap gap-2">
          <button className={button} disabled={!canApply || !completeManifest || !confirmed || busy || release.status !== "pending"} onClick={() => void act("approve")}>검수 승인</button>
          <button className={button} disabled={!canWrite || !confirmed || busy || release.status !== "pending" || reason.trim().length < 10} onClick={() => void act("reject")}>후보 제외</button>
          <button className={button} disabled={!canApply || !completeManifest || !confirmed || busy || release.status !== "approved" || publication?.release_id === release.id} onClick={() => void act("publish")}>승인본 공개</button>
          <button className={button} disabled={!canWrite || !confirmed || busy || !publication || publication.previous_release_id !== release.id} onClick={() => void act("rollback")}>이전 공개본으로 복구</button>
        </div>
        </>}
      </>}
    </>}
    {error && <p role="alert" className="break-words text-sm text-red-300">{error} <button className={`${button} ml-2`} onClick={() => { setError(""); void refresh().catch(() => setError("챔피언 통계 검토 상태를 불러오지 못했습니다.")); }}>다시 시도</button></p>}
    {message && <p role="status" className="text-sm text-emerald-300">{message}</p>}
    <button className={button} disabled={busy} onClick={() => void refresh().catch(() => setError("챔피언 통계 검토 상태를 불러오지 못했습니다."))}>챔피언 통계 상태 새로고침</button>
  </section>;
}
