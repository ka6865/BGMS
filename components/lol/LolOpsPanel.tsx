"use client";

import { useState } from "react";
import LolCollectionPanel from "./LolCollectionPanel";
import type { LolCleanupBatch, LolCleanupCounts, LolOpsStatus } from "@/lib/lol/types";

const COUNT_LABELS = { cache_rows: "캐시", match_rows: "경기", lease_rows: "잠금", public_rate_limit_rows: "공개 요청 제한" };
const METRIC_LABELS: Record<string, string> = {
  riot_success: "Riot 성공", riot_429: "Riot 429", riot_5xx: "Riot 서버 오류", riot_network: "Riot 네트워크 오류",
  riot_timeout: "Riot 시간 초과", riot_key_error: "Riot 키·권한 오류", riot_4xx: "Riot 기타 요청 오류",
  search_cache_hit: "검색 캐시 적중", search_cache_miss: "검색 캐시 미적중",
  detail_cache_hit: "상세 캐시 적중", detail_cache_miss: "상세 캐시 미적중", raw_reuse: "저장 원문 재사용",
  cleanup_deleted: "정리 누적 삭제(행)", cleanup_remaining: "정리 후 남은 대상(행)", cleanup_duration_ms: "최근 정리 배치 소요(ms)",
  db_error: "DB 오류", db_timeout: "DB 시간 초과",
};

function formatCounts(counts: LolCleanupCounts) {
  return (Object.entries(COUNT_LABELS) as Array<[keyof LolCleanupCounts, string]>)
    .map(([key, label]) => `${label} ${(counts[key] ?? 0).toLocaleString()}행`).join(" · ");
}

export default function LolOpsPanel() {
  const [riotId, setRiotId] = useState("");
  const [deleteTarget, setDeleteTarget] = useState<string | null>(null);
  const [deleteConfirmed, setDeleteConfirmed] = useState(false);
  const [deleteResult, setDeleteResult] = useState<string | null>(null);
  const [status, setStatus] = useState<LolOpsStatus | null>(null);
  const [preview, setPreview] = useState<LolCleanupCounts | null>(null);
  const [batch, setBatch] = useState<LolCleanupBatch | null>(null);
  const [confirmed, setConfirmed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function run(action: "status" | "preview" | "cleanup") {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      const response = await fetch("/api/admin/lol/operations", {
        cache: "no-store",
        ...(action === "status" ? {} : {
          method: "POST", headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ action, ...(action === "cleanup" ? { confirm: confirmed, limit: 100 } : {}) }),
        }),
      });
      const payload = await response.json();
      if (!response.ok) throw new Error(typeof payload?.error === "string" ? payload.error : "운영 상태를 불러오지 못했습니다.");
      if (action === "status") setStatus(payload);
      else if (action === "preview") { setPreview(payload); setBatch(null); setConfirmed(false); }
      else { setBatch(payload); setPreview(payload.remaining); setConfirmed(false); }
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "운영 요청에 실패했습니다.");
    } finally { setBusy(false); }
  }

  async function deleteAccount(execute: boolean) {
    if (busy || (execute && (!deleteTarget || !deleteConfirmed))) return;
    setBusy(true);
    setError(null);
    setDeleteResult(null);
    try {
      const response = await fetch("/api/admin/lol/operations", {
        method: "POST", cache: "no-store", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: execute ? "account-delete" : "account-preview", riotId: execute ? deleteTarget : riotId, confirm: execute }),
      });
      const payload = await response.json();
      if (!response.ok) throw new Error(payload.error || "계정 삭제 요청에 실패했습니다.");
      if (execute) {
        setDeleteResult(`계정 ${payload.account_rows}행 · 랭크 이력 ${payload.history_rows}행 · 본인 경기 요약 ${payload.summary_rows}행 삭제`);
        setDeleteTarget(null);
        setRiotId("");
        setStatus(null);
        setPreview(null);
        setBatch(null);
      } else setDeleteTarget(payload.riotId);
      setDeleteConfirmed(false);
    } catch (cause) { setError(cause instanceof Error ? cause.message : "계정 삭제 요청에 실패했습니다."); }
    finally { setBusy(false); }
  }

  return (
    <details className="mb-4 min-w-0 rounded-lg border border-zinc-800 p-3" onToggle={(event) => {
      if (event.currentTarget.open && !status && !busy) void run("status");
    }}>
      <summary className="min-h-8 cursor-pointer text-sm font-medium text-zinc-300">운영 상태</summary>
      <div className="mt-3 min-w-0 space-y-3 text-xs text-zinc-400" aria-label="LoL 운영 상태">
        <button className="min-h-11 rounded border border-zinc-700 px-3 disabled:opacity-50" disabled={busy} onClick={() => void run("status")}>
          {busy ? "처리 중…" : "상태 새로고침"}
        </button>
        {deleteResult && <p role="status">{deleteResult}</p>}
        {error && <p role="alert" className="text-red-300">{error}</p>}
        {status && <>
          <p>마지막 랭크 컷 스냅샷: {status.lastLadderSnapshotAt
            ? new Date(status.lastLadderSnapshotAt).toLocaleString("ko-KR", { timeZone: "Asia/Seoul" }) + " KST"
            : status.lastLadderSnapshotAt === null ? "기록 시작일 이후 표시" : "확인 불가"}</p>
          {!status.enabled && <p>영속 저장이 비활성화되어 있습니다.</p>}
          <p className={status.keyNeedsAttention ? "text-amber-300" : ""}>{status.keyNeedsAttention ? "키 확인 필요" : "오늘 키 오류 감지 없음"}</p>
          {status.benchmarks && <p>벤치마크 처리 {status.benchmarks.processed}경기 · 제외 {status.benchmarks.skipped}경기</p>}
          <p>오늘 Riot 호출 {status.todayRiotCalls.toLocaleString()}회 · {status.today} KST</p>
          <p>{status.cooldownActive ? "429 쿨다운 중" : "429 쿨다운 없음"}</p>
          {status.rateLimits.map((row) => <p key={row.host}>
            {row.host} 예약 호출 {row.usedCount.toLocaleString()}회 (UTC {row.budgetDay})
            {row.blockedUntil && ` · 차단 해제 ${row.blockedUntil}`}
          </p>)}
          <div className="overflow-x-auto">
            <table className="w-full text-left"><caption className="mb-2 text-left">LoL 테이블별 행 수·총 용량</caption>
              <thead><tr><th scope="col">테이블</th><th scope="col">행</th><th scope="col">용량</th></tr></thead>
              <tbody>{status.tables.map((row) => <tr key={row.table}>
                <th scope="row" className="break-all py-1 pr-2 font-normal">{row.table}</th>
                <td className="px-2">{row.rows.toLocaleString()}</td><td>{(row.totalBytes / 1024).toFixed(1)} KiB</td>
              </tr>)}</tbody>
            </table>
          </div>
          <details><summary className="min-h-8 cursor-pointer">최근 7일 메트릭</summary>
            {status.metrics.length ? status.metrics.map((row) => <p key={`${row.day}:${row.metric}`} className="py-1">
              {row.day} · {METRIC_LABELS[row.metric] ?? row.metric} {row.value.toLocaleString()}회
            </p>) : <p>집계된 기록 없음</p>}
          </details>
          <p>만료 대기: {formatCounts(preview ?? status.pending)}</p>
          <p>계정·랭크 이력·본인 경기 요약은 보관, 캐시·7일 지난 경기 원문·만료 잠금만 정리합니다. 경기 참가자도 원문과 함께 정리하며 테이블별 최대 100행을 처리합니다.</p>
          <div className="flex flex-wrap gap-2">
            <button className="min-h-11 rounded border border-zinc-700 px-3 disabled:opacity-50"
              disabled={busy || !status.enabled} onClick={() => void run("preview")}>정리 미리보기</button>
            <button className="min-h-11 rounded border border-red-900 px-3 text-red-300 disabled:opacity-50"
              disabled={busy || !status.enabled || !preview || !confirmed} onClick={() => void run("cleanup")}>정리 실행(배치 1회)</button>
          </div>
          {preview && <label className="flex min-h-11 items-center gap-2">
            <input type="checkbox" checked={confirmed} onChange={(event) => setConfirmed(event.target.checked)} />
            미리보기 대상을 확인했으며 만료 데이터 삭제에 동의합니다.
          </label>}
          {batch && <p role="status">삭제: {formatCounts(batch.deleted)} · 남음: {formatCounts(batch.remaining)}</p>}
          <LolCollectionPanel enabled={status.enabled} />
          <fieldset className="min-w-0 space-y-2 border-t border-zinc-800 pt-3">
            <legend className="pt-3 text-zinc-300">계정 데이터 삭제</legend>
            <p>삭제 요청을 확인한 뒤 Riot ID로 조회합니다. 랭크·요약·관련 원문과 캐시를 삭제하며 되돌릴 수 없습니다.</p>
            <label className="block">삭제할 Riot ID
              <input aria-label="삭제할 Riot ID" value={riotId} maxLength={81} disabled={busy}
                onChange={(event) => { setRiotId(event.target.value); setDeleteTarget(null); setDeleteConfirmed(false); setDeleteResult(null); }}
                className="mt-1 block min-h-11 w-full rounded border border-zinc-700 bg-zinc-950 px-2" placeholder="이름#태그" />
            </label>
            <button disabled={busy || !status.enabled || !riotId.trim()} onClick={() => void deleteAccount(false)}
              className="min-h-11 rounded border border-zinc-700 px-3 disabled:opacity-50">삭제 대상 확인</button>
            {deleteTarget && <>
              <p className="break-all">삭제 대상: {deleteTarget}</p>
              <label className="flex min-h-11 items-center gap-2">
                <input type="checkbox" aria-label="계정 영구 삭제 확인" checked={deleteConfirmed} onChange={(event) => setDeleteConfirmed(event.target.checked)} />
                대상과 삭제 요청을 확인했으며 영구 삭제에 동의합니다.
              </label>
              <button disabled={busy || !deleteConfirmed} onClick={() => void deleteAccount(true)}
                className="min-h-11 rounded border border-red-900 px-3 text-red-300 disabled:opacity-50">계정 영구 삭제 실행</button>
            </>}
          </fieldset>
        </>}
      </div>
    </details>
  );
}
