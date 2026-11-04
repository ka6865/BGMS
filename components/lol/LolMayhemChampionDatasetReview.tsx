"use client";

import { useCallback, useEffect, useState } from "react";
import type { ChampionDatasetAdminData, ChampionDatasetReadiness } from "@/lib/lol/mayhemChampionDataset";

const button = "inline-flex min-h-11 items-center justify-center rounded-lg border border-zinc-700 px-3 text-sm hover:bg-zinc-800 disabled:opacity-40";
const input = "min-h-11 w-full min-w-0 rounded-lg border border-zinc-700 bg-zinc-900 px-3 text-sm";
const labels: Record<keyof ChampionDatasetReadiness, string> = { apiKeyConfigured: "API 키 설정", reuseConfirmed: "재사용 조건 확인", enabled: "기능 활성화", persistenceEnabled: "영속 저장 활성화" };
const status: Record<string, string> = { pending: "검수 대기", approved: "승인됨", rejected: "제외됨" };
const date = (value: string | null) => value ? `${new Date(value).toLocaleString("ko-KR", { timeZone: "Asia/Seoul" })} KST` : "기록 없음";

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
  const primary = release?.status === "pending" ? "approve" : release?.status === "approved" && publication?.release_id !== release.id ? "publish" : null;

  return <section aria-label="챔피언 통계 데이터셋 검토" className="space-y-4">
    <header><h2 className="text-lg font-semibold">챔피언 증강 통계</h2><p className="mt-1 text-sm text-zinc-400">CN 출처의 챔피언별 통계입니다. 전체 증강 순위나 증강 등장 가능 여부와는 다른 자료입니다.</p></header>
    {!data && !error && <p role="status" className="text-sm text-zinc-400">검토 상태를 불러오는 중입니다.</p>}
    {error && <p role="alert" className="break-words text-sm text-red-300">{error}</p>}
    {data && <>
      {!data.releases.length ? <p className="text-sm text-zinc-400">검토할 챔피언 통계 후보가 없습니다.</p> : <>
        <label className="block space-y-2 text-sm"><span>검토 후보</span><select aria-label="챔피언 통계 후보" className={input} disabled={busy} value={release?.id ?? ""} onChange={event => { setSelected(Number(event.target.value)); setConfirmed(false); setReason(""); }}>
          {data.releases.map(row => <option key={row.id} value={row.id}>패치 {row.client_patch} · {date(row.fetched_at)} · {status[row.status] ?? row.status}</option>)}
        </select></label>
        {release && <>
          <div className="space-y-2 break-words text-sm" aria-label="챔피언 통계 후보 정보">
            <p><strong>현재 후보:</strong> 패치 {release.client_patch} · 통계일 {release.source_data_date} · {status[release.status] ?? release.status}</p>
            <p><strong>현재 공개본:</strong> {publication ? `패치 ${publication.client_patch} · ${date(publication.published_at)}` : "없음"}</p>
            <p>{primary === "approve" ? "다음 단계: 출처와 통계를 확인한 뒤 검수 승인하세요." : primary === "publish" ? "다음 단계: 승인된 통계를 확인한 뒤 공개하세요." : release.status === "rejected" ? "이 후보는 제외되었습니다." : "현재 후보가 공개되어 있습니다."}</p>
            <p className="text-zinc-400">CN 챔피언별 선택 통계이며 선택률 분모와 증강 등장 가능 여부는 확인되지 않았습니다.</p>
          </div>
          {primary && <>
            <label className="flex min-h-11 items-center gap-3 text-sm"><input type="checkbox" disabled={busy || !canWrite} checked={confirmed} onChange={event => setConfirmed(event.target.checked)} />출처·통계일·현재 공개 상태를 확인했습니다.</label>
            <button className={button} disabled={!canWrite || !canApply || !completeManifest || !confirmed || busy} onClick={() => void act(primary)}>{busy ? "처리 중…" : primary === "approve" ? "검수 승인" : "승인본 공개"}</button>
            {(!canWrite || !canApply || !completeManifest) && <p className="text-sm text-amber-300">저장·사용 조건 또는 후보 파일 검증을 확인해야 진행할 수 있습니다.</p>}
          </>}
          <details><summary className="min-h-11 cursor-pointer content-center text-sm">상세 정보 · 운영 설정</summary><div className="space-y-2 break-all pb-2 text-sm text-zinc-400">
            <p>원천 버전 {release.upstream_version} · 수집 {date(release.fetched_at)} · 예상 챔피언 {release.metadata.expectedChampionIds.length}명 · 파일 {release.metadata.files.length}개</p>
            <p>출처 표기: {release.metadata.attribution} · 사용 조건: {release.metadata.rightsBasis}</p>
            <p>{completeManifest ? "후보 파일 검증 완료" : "후보 파일 검증 누락"} · 카탈로그 해시 {release.metadata.catalogHash}</p>
            {release.metadata.files.map(file => <p key={file.championId}>챔피언 {file.championId}: {file.rawPath} · {file.normalizedPath}</p>)}
            <div className="flex flex-wrap gap-2">{(Object.entries(labels) as [keyof ChampionDatasetReadiness, string][]).map(([key, label]) => <span key={key} className={`rounded border px-2 py-1 ${data.readiness[key] ? "border-emerald-800 text-emerald-300" : "border-amber-800 text-amber-300"}`}>{label}: {data.readiness[key] ? "준비됨" : "미설정"}</span>)}</div>
            {!data.databaseAvailable && <p className="text-amber-300">데이터베이스 상태를 확인할 수 없습니다.</p>}
            {data.sync.map(row => <p key={row.job_key}>수집 상태 {row.job_key} · 확인 {date(row.last_checked_at)} · 최근 성공 {date(row.last_success_at)} · {row.last_error_code ?? "오류 없음"}</p>)}
          </div></details>
          <details><summary className="min-h-11 cursor-pointer content-center text-sm">기타 작업</summary><div className="space-y-3 py-2">
            <label className="block space-y-2 text-sm"><span>후보 제외 사유 · 제외 시 10자 이상</span><textarea aria-label="후보 제외 사유" className={`${input} min-h-20 py-3`} disabled={busy} maxLength={2048} value={reason} onChange={event => setReason(event.target.value)} /></label>
            <label className="flex min-h-11 items-center gap-3 text-sm"><input type="checkbox" disabled={busy || !canWrite} checked={confirmed} onChange={event => setConfirmed(event.target.checked)} />현재 후보와 공개 상태를 확인했습니다.</label>
            <div className="flex flex-wrap gap-2">
              <button className={button} disabled={!canWrite || !confirmed || busy || release.status !== "pending" || reason.trim().length < 10} onClick={() => void act("reject")}>후보 제외</button>
              <button className={button} disabled={!canWrite || !confirmed || busy || publication?.release_id !== release.id || publication.previous_release_id === null} onClick={() => void act("rollback")}>이전 공개본으로 복구</button>
            </div>
          </div></details>
        </>}
      </>}
    </>}
    {error && <button className={button} onClick={() => { setError(""); void refresh().catch(() => setError("챔피언 통계 검토 상태를 불러오지 못했습니다.")); }}>다시 시도</button>}
    {message && <p role="status" className="text-sm text-emerald-300">{message}</p>}
    <button className={button} disabled={busy} onClick={() => void refresh().catch(() => setError("챔피언 통계 검토 상태를 불러오지 못했습니다."))}>상태 새로고침</button>
  </section>;
}
