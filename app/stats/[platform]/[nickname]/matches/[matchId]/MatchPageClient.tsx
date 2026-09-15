"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import { MatchCard } from "@/components/stat/MatchCard";
import { buildBasicMatchSummary, type MatchSummaryData } from "@/lib/pubg-analysis/matchSummary";

const PERFORMANCE_POLL_INTERVAL_MS = 10_000;
const PERFORMANCE_MAX_POLLS = 6;
const PERFORMANCE_PENDING_STATES = new Set(["pending", "running", "retry", "done"]);

type MatchHistoryResponse = {
  matches?: Array<Record<string, unknown>>;
  performances?: Record<string, MatchSummaryData["benchmark"]>;
  performanceStates?: Record<string, MatchSummaryData["performanceState"]>;
};

function hasPendingPerformance(data: MatchHistoryResponse, matchId: string): boolean {
  return !data.performances?.[matchId]
    && PERFORMANCE_PENDING_STATES.has(data.performanceStates?.[matchId] ?? "");
}

export default function MatchPageClient({
  platform,
  nickname,
  matchId,
}: {
  platform: "steam" | "kakao";
  nickname: string;
  matchId: string;
}) {
  const [summary, setSummary] = useState<MatchSummaryData | null>(null);
  const [error, setError] = useState("");
  const [mobile, setMobile] = useState(true);
  const [isVisible, setIsVisible] = useState(() => (
    typeof document === "undefined" || document.visibilityState !== "hidden"
  ));
  const [pollTick, setPollTick] = useState(0);
  const pollTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pollAttemptsRef = useRef(0);
  const pollControllerRef = useRef<AbortController | null>(null);

  useEffect(() => {
    const media = window.matchMedia("(max-width: 767px)");
    const update = () => setMobile(media.matches);
    update();
    media.addEventListener("change", update);
    return () => media.removeEventListener("change", update);
  }, []);

  useEffect(() => {
    const update = () => setIsVisible(document.visibilityState !== "hidden");
    document.addEventListener("visibilitychange", update);
    return () => document.removeEventListener("visibilitychange", update);
  }, []);

  const fetchSummary = useCallback(async (signal: AbortSignal) => {
    const q = new URLSearchParams({ platform, nickname, matchId });
    const response = await fetch(`/api/pubg/player/matches?${q}`, {
      cache: "no-store",
      signal,
    });
    const data = await response.json() as MatchHistoryResponse & { error?: string };
    if (!response.ok) throw new Error(data.error || "경기를 불러오지 못했습니다.");
    const record = data.matches?.find((row) => row.match_id === matchId);
    if (!record) throw new Error("저장된 경기 기록이 없습니다.");
    const benchmark = data.performances?.[matchId];
    return {
      summary: {
        ...buildBasicMatchSummary(record as Parameters<typeof buildBasicMatchSummary>[0]),
        ...(benchmark ? { benchmark, performanceOnly: true } : {}),
        performanceState: data.performanceStates?.[matchId],
      } as MatchSummaryData,
      pending: hasPendingPerformance(data, matchId),
    };
  }, [matchId, nickname, platform]);

  useEffect(() => {
    const controller = new AbortController();
    pollAttemptsRef.current = 0;
    setPollTick(0);
    setSummary(null);
    setError("");
    void fetchSummary(controller.signal)
      .then(({ summary: nextSummary }) => {
        if (!controller.signal.aborted) setSummary(nextSummary);
      })
      .catch((caught) => {
        if (!controller.signal.aborted) {
          setError(caught instanceof Error ? caught.message : "경기 조회 실패");
        }
      });
    return () => controller.abort();
  }, [fetchSummary]);

  useEffect(() => {
    let active = true;
    const shouldPoll = Boolean(
      summary
      && !summary.benchmark
      && PERFORMANCE_PENDING_STATES.has(summary.performanceState ?? ""),
    );
    if (!shouldPoll || !isVisible || pollAttemptsRef.current >= PERFORMANCE_MAX_POLLS) {
      if (!shouldPoll || !isVisible) {
        if (pollTimerRef.current) clearTimeout(pollTimerRef.current);
        pollTimerRef.current = null;
      }
      return;
    }
    if (pollTimerRef.current) return;

    const timeout = setTimeout(async () => {
      if (pollTimerRef.current !== timeout || document.visibilityState === "hidden") return;
      pollTimerRef.current = null;
      pollAttemptsRef.current += 1;
      const controller = new AbortController();
      pollControllerRef.current = controller;
      try {
        const next = await fetchSummary(controller.signal);
        if (active && !controller.signal.aborted) setSummary(next.summary);
      } catch {
        // Keep the last known summary. The bounded effect retry will try again.
      } finally {
        if (pollControllerRef.current === controller) pollControllerRef.current = null;
        if (active) setPollTick((current) => current + 1);
      }
    }, PERFORMANCE_POLL_INTERVAL_MS);
    pollTimerRef.current = timeout;

    return () => {
      active = false;
      pollControllerRef.current?.abort();
      pollControllerRef.current = null;
      if (pollTimerRef.current !== timeout) return;
      clearTimeout(timeout);
      pollTimerRef.current = null;
    };
  }, [fetchSummary, isVisible, pollTick, summary]);

  return (
    <main className="mx-auto min-h-screen max-w-5xl px-4 pb-32 pt-6 text-white">
      <Link
        className="inline-flex min-h-11 items-center text-sm text-white/70"
        href={`/stats/${platform}/${encodeURIComponent(nickname)}/encounters?matchId=${encodeURIComponent(matchId)}`}
      >
        ← 이 경기의 만난 상대
      </Link>
      <h1 className="my-5 break-all text-xl font-bold">{nickname}의 경기 기록</h1>
      {error ? (
        <p role="alert" className="py-8 text-sm text-amber-200">{error}</p>
      ) : summary ? (
        <MatchCard
          key={`${platform}:${nickname}:${matchId}`}
          matchId={matchId}
          nickname={nickname}
          platform={platform}
          isMobile={mobile}
          initialMatchData={summary}
          initiallyExpanded
        />
      ) : (
        <p role="status" className="py-8 text-sm text-white/50">경기 기록 확인 중…</p>
      )}
    </main>
  );
}
