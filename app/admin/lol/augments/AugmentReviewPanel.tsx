"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { AugmentAdminData } from "@/lib/lol/augments/admin";

const button = "min-h-11 rounded-lg border border-zinc-700 px-3 py-2 text-sm disabled:opacity-40 hover:bg-zinc-800";
const labels: Record<string, string> = { added: "신규", removed: "삭제", changed: "변경", reenabled: "재활성화", unannounced_absent: "미공지 제외" };

export default function AugmentReviewPanel() {
  const [data, setData] = useState<AugmentAdminData | null>(null);
  const [patch, setPatch] = useState("");
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");
  const [confirmed, setConfirmed] = useState(false);
  const requestId = useRef(0);
  const refresh = useCallback(async (selected: string) => {
    const id = ++requestId.current;
    setLoading(true); setError(""); setConfirmed(false);
    try {
      const response = await fetch(`/api/admin/lol/augments${selected ? `?patch=${encodeURIComponent(selected)}` : ""}`, { cache: "no-store" });
      if (!response.ok) throw new Error("증강 검토 자료를 불러오지 못했습니다.");
      const next: AugmentAdminData = await response.json();
      if (id === requestId.current) setData(next);
    } catch (error) { if (id === requestId.current) setError(error instanceof Error ? error.message : "요청에 실패했습니다."); }
    finally { if (id === requestId.current) setLoading(false); }
  }, []);
  useEffect(() => {
    void refresh(patch);
    const id = requestId.current;
    return () => { requestId.current = id + 1; };
  }, [patch, refresh]);
  async function act(action: "publish" | "review", id?: string, status?: "approved" | "rejected") {
    if (!data?.detail || busy || loading) return;
    setBusy(true); setError(""); setMessage("");
    try {
      const response = await fetch("/api/admin/lol/augments", { method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action, patch: data.detail.patch, id, status, runId: data.detail.runId, confirm: true }) });
      const result = await response.json();
      if (!response.ok) throw new Error(result.error ?? "요청에 실패했습니다.");
      setMessage(action === "publish" ? "게시했습니다." : "검토 결과를 저장했습니다.");
      await refresh(patch);
    } catch (error) { setError(error instanceof Error ? error.message : "요청에 실패했습니다."); }
    finally { setBusy(false); }
  }
  const detail = data?.detail;
  const distribution = detail?.augments.reduce<Record<string, number>>((counts, a) => {
    counts[a.displaySource] = (counts[a.displaySource] ?? 0) + 1; return counts;
  }, {});
  const latestRun = data?.runs.find(run => run.client_patch === detail?.patch);
  const publishable = detail && !detail.published && ["review", "succeeded"].includes(latestRun?.status ?? "")
    && !detail.changes.some(c => c.review_status === "pending");
  return <main className="mx-auto w-full max-w-6xl space-y-6 overflow-y-auto p-4 text-zinc-100 sm:p-6" data-testid="augment-review">
    <header className="flex flex-wrap items-center justify-between gap-3">
      <h1 className="text-xl font-semibold">아수라장 증강 검토</h1>
      <button className={button} disabled={loading || busy} onClick={() => { setMessage(""); void refresh(patch); }}>새로고침</button>
    </header>
    {error && <p role="alert" className="break-words text-red-300">{error}</p>}
    {message && <p role="status" className="text-emerald-300">{message}</p>}
    {loading && <p role="status">자료를 불러오는 중입니다.</p>}
    {data && <>
      <section aria-label="최근 수집 실행" className="space-y-2">
        <h2 className="font-semibold">최근 실행</h2>
        {!data.runs.length && <p>수집 실행이 없습니다.</p>}
        <ul className="divide-y divide-white/10">
          {data.runs.map(run => <li key={run.id} className="flex flex-wrap gap-x-4 gap-y-1 py-2 text-sm">
            <span>{run.client_patch}</span><span>{run.status}</span><span>{run.counts.augments ?? 0}개</span>
            <span className="break-all text-red-300">{run.error_code}</span>
          </li>)}
        </ul>
      </section>
      <label className="flex flex-wrap items-center gap-3">검토 패치
        <select aria-label="검토 패치" className="min-h-11 rounded-lg border border-zinc-700 bg-zinc-950 px-3"
          value={patch || detail?.patch || ""} disabled={busy} onChange={e => { setPatch(e.target.value); setMessage(""); }}>
          {!data.patches.length && <option value="">수집된 패치 없음</option>}
          {data.patches.map(p => <option key={p.client_patch} value={p.client_patch}>{p.display_patch} ({p.client_patch}){p.published_at ? " · 게시됨" : ""}</option>)}
        </select>
      </label>
      {!loading && detail && <>
        <section aria-label="공식 대조와 검증" className="space-y-2 text-sm">
          <h2 className="font-semibold">공식 대조 · 검증</h2>
          {!detail.notes.length && <p>공식 노트 자료가 없습니다.</p>}
          {detail.notes.map(note => <div key={note.url} className="space-y-1 break-words">
            <a className="underline" href={note.url} target="_blank" rel="noreferrer">한국어 패치 노트</a>
            <p>{note.parse_status} · 발행 {note.published_at?.slice(0, 10) ?? "미확인"} · 신규 {note.added_names.length} / 삭제 {note.removed_names.length}</p>
          </div>)}
          <p>표시 출처: tooltip {distribution?.tooltip ?? 0} · desc {distribution?.desc ?? 0} · desc_partial {distribution?.desc_partial ?? 0}</p>
          {detail.warnings.map((warning, i) => <p key={i} className="break-words text-amber-300">{warning}</p>)}
        </section>
        <section aria-label="패치 변경 목록" className="space-y-2">
          <h2 className="font-semibold">신규 · 삭제 · 변경</h2>
          {!detail.changes.length && <p className="text-sm">변경 내역이 없습니다.</p>}
          <ul className="divide-y divide-white/10">{detail.changes.map(change => <li key={change.id} className="space-y-2 py-3">
            <p className="break-words text-sm">{labels[change.change_type]} · {change.summary_ko}</p>
            <div className="flex flex-wrap items-center gap-2 text-xs">
              <span>{change.official ? "공식 일치" : "수동 확인"} · {change.review_status}</span>
              {!detail.published && change.review_status === "pending" && <>
                <button className={button} disabled={busy} onClick={() => void act("review", change.id, "approved")}>변경 승인</button>
                <button className={button} disabled={busy} onClick={() => void act("review", change.id, "rejected")}>변경 제외</button>
              </>}
            </div>
          </li>)}</ul>
        </section>
        <section aria-label="패치 게시" className="space-y-3 border-y border-white/10 py-4">
          <p className="text-sm">미검토 변경과 검증 결과를 확인하세요. 게시한 패치는 수정 수집할 수 없습니다.</p>
          <label className="flex min-h-11 items-center gap-3 text-sm">
            <input type="checkbox" checked={confirmed} disabled={busy || !publishable} onChange={e => setConfirmed(e.target.checked)} />
            {detail.patch} 검토 결과를 확인했습니다.
          </label>
          <button className={button} disabled={!confirmed || !publishable || busy} onClick={() => void act("publish")}>게시</button>
          {detail.published && <p className="text-sm">이미 게시된 패치입니다.</p>}
        </section>
        <section aria-label="증강 목록 미리보기" className="space-y-3">
          <h2 className="font-semibold">증강 미리보기 ({detail.augments.length})</h2>
          <ul className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">{detail.augments.map(a => <li key={a.platformId} className="min-w-0 border-b border-white/10 pb-4">
            <div className="mb-2 flex items-center gap-3">
              {a.icon && /^assets\/ux\/(kiwi|cherry)\/augments\/icons\/[a-z0-9_-]+\.png$/.test(a.icon) &&
                // 버전 고정 프록시 이미지를 원래 크기로 표시한다.
                <img alt="" width={40} height={40} loading="lazy" src={`/api/lol/augment-icons/${detail.patch}/${a.icon}`} />}
              <div className="min-w-0"><h3 className="break-words font-medium">{a.name ?? `증강 ${a.platformId}`}</h3><p className="text-xs text-zinc-400">{a.rarity}</p></div>
            </div>
            <p className="whitespace-pre-wrap break-words text-sm">{a.tokens?.length ? a.tokens.map((token, index) => token.icon
              ? <span key={index} className="mx-0.5 inline-flex items-center gap-1 rounded bg-zinc-800 px-0.5 align-middle text-xs text-zinc-300"
                data-stat-icon={token.icon} role="img" aria-label={token.label ?? token.text}>
                <svg aria-hidden="true" width="12" height="12" viewBox="0 0 12 12" fill="currentColor"><path d="M6 1 11 6 6 11 1 6Z" /></svg>
                {token.text && <span aria-hidden="true">{token.text}</span>}
              </span>
              : <span key={index}>{token.text}</span>) : a.text}</p>
            {a.displaySource === "desc_partial" && <p className="mt-2 text-xs text-amber-300">일부 수치는 게임 안에서 확인하세요</p>}
            {a.tokens?.some(token => token.championDependent) && <p className="mt-2 text-xs text-zinc-400">스킬 이름은 챔피언마다 다릅니다</p>}
          </li>)}</ul>
        </section>
      </>}
    </>}
  </main>;
}
