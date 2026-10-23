"use client";

import { useEffect, useRef, useState } from "react";
import type { LolCollectionResult } from "@/lib/lol/types";

export default function LolCollectionPanel({ enabled }: { enabled: boolean }) {
  const [riotId, setRiotId] = useState("");
  const [target, setTarget] = useState(20);
  const [confirmed, setConfirmed] = useState(false);
  const [running, setRunning] = useState(false);
  const [message, setMessage] = useState("");
  const [totals, setTotals] = useState({ processed: 0, fetched: 0, reused: 0, failed: 0, aggregated: 0, skipped: 0 });
  const stopped = useRef(false);
  useEffect(() => () => { stopped.current = true; }, []);

  async function collect() {
    if (running || !confirmed || !Number.isInteger(target) || target < 1 || target > 100) return;
    stopped.current = false;
    setRunning(true);
    setMessage("수집 중");
    const sum = { processed: 0, fetched: 0, reused: 0, failed: 0, aggregated: 0, skipped: 0 };
    setTotals({ ...sum });
    let offset = 0;
    try {
      while (!stopped.current && sum.processed < target) {
        const response = await fetch("/api/admin/lol/collect", {
          method: "POST", cache: "no-store", headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ riotId, count: target - sum.processed, startOffset: offset, confirm: true }),
        });
        const payload: LolCollectionResult & { error?: string } = await response.json();
        if (typeof payload.processed === "number") {
          for (const key of Object.keys(sum) as Array<keyof typeof sum>) sum[key] += payload[key];
          setTotals({ ...sum });
        }
        if (!response.ok) {
          if (payload.retryAfter) throw new Error(`${payload.stopped === "rate_limited" ? "Riot 429로 중단" : "수집 중단"} · ${payload.retryAfter}초 후 다시 시도해 주세요.`);
          throw new Error(payload.error || "수집을 중단했습니다. 운영 상태를 확인해 주세요.");
        }
        if (payload.nextOffset <= offset && payload.hasMore) throw new Error("수집이 진행되지 않아 중단했습니다.");
        offset = payload.nextOffset;
        if (!payload.hasMore) break;
      }
      setMessage(stopped.current ? "중지됨" : "수집 완료");
    } catch (cause) { setMessage(cause instanceof Error ? cause.message : "수집 요청에 실패했습니다."); }
    finally { setRunning(false); }
  }

  return <fieldset className="min-w-0 space-y-2 border-t border-zinc-800 pt-3" aria-label="경기 수집">
    <legend className="pt-3 text-zinc-300">경기 수집</legend>
    <p>목표 최대 100경기, 요청당 상세 최대 20경기입니다. 중지하면 현재 요청 저장 후 다음 요청을 보내지 않습니다.</p>
    <label className="block">수집할 Riot ID
      <input aria-label="수집할 Riot ID" value={riotId} maxLength={81} disabled={running}
        onChange={(event) => setRiotId(event.target.value)} placeholder="이름#태그"
        className="mt-1 block min-h-11 w-full rounded border border-zinc-700 bg-zinc-950 px-2" />
    </label>
    <label className="block">목표 경기 수
      <input aria-label="목표 경기 수" type="number" min={1} max={100} value={target} disabled={running}
        onChange={(event) => setTarget(event.target.valueAsNumber)}
        className="mt-1 block min-h-11 w-full rounded border border-zinc-700 bg-zinc-950 px-2" />
    </label>
    <label className="flex min-h-11 items-center gap-2">
      <input type="checkbox" aria-label="경기 수집 실행 확인" checked={confirmed} disabled={running} onChange={(event) => setConfirmed(event.target.checked)} />
      Riot API 호출과 경기 저장 실행을 확인했습니다.
    </label>
    <div className="flex flex-wrap gap-2">
      <button onClick={() => void collect()} disabled={running || !enabled || !confirmed || !riotId.trim() || !Number.isInteger(target) || target < 1 || target > 100}
        className="min-h-11 rounded border border-zinc-700 px-3 disabled:opacity-50">수집 시작</button>
      <button onClick={() => { stopped.current = true; setMessage("중지 요청됨 · 현재 요청 저장을 기다립니다."); }} disabled={!running}
        className="min-h-11 rounded border border-zinc-700 px-3 disabled:opacity-50">수집 중지</button>
    </div>
    <progress aria-label="경기 수집 진행" value={totals.processed} max={target || 20} className="block w-full" />
    <div aria-live="polite" className="break-words">
      <p>{message} · 처리 {totals.processed}/{target || 20}</p>
      <p>Riot 호출 {totals.fetched}회 · 원문 재사용 {totals.reused}경기 · 실패 {totals.failed}경기</p>
      <p>신규 집계 {totals.aggregated}경기 · 제외 {totals.skipped}경기</p>
    </div>
  </fieldset>;
}
