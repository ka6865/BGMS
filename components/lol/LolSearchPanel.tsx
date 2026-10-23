"use client";

import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode, type FormEvent } from "react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import type { LolSearchResult } from "@/lib/lol/types";
import { LOL_ARAM_QUEUE_IDS, summarizeRecentMatches } from "@/lib/lol/summary";
import { LOL_RIOT_ID_ERROR, lolRiotIdPath } from "@/lib/lol/riotId";
import LolMatchCard from "./LolMatchCard";
import LolSummary, { LolSidebarStats } from "./LolSummary";
import LolRankCards from "./LolRankCards";
import LolLegalNotice from "./LolLegalNotice";

type QueueFilter = "all" | "solo" | "flex" | "aram";

const DATA_DRAGON_VERSION = "16.21.1";

function hideBrokenImage(event: React.SyntheticEvent<HTMLImageElement>) {
  event.currentTarget.hidden = true;
}

export default function LolSearchPanel({ initialRiotId, initialError, publicView = false, adminTools }: {
  publicView?: boolean;
  adminTools?: ReactNode;
  initialRiotId?: string;
  initialError?: string;
} = {}) {
  const apiBase = publicView ? "/api/lol" : "/api/admin/lol";
  const pageBase = publicView ? "/lol/kr" : "/admin/lol/kr";
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const queue = searchParams.get("queue");
  const filter: QueueFilter = queue === "solo" || queue === "flex" || queue === "aram" ? queue : "all";
  const [riotId, setRiotId] = useState(initialRiotId ?? "");
  const [result, setResult] = useState<LolSearchResult | null>(null);
  const [error, setError] = useState<string | null>(initialError ?? null);
  const [loading, setLoading] = useState(false);
  const [openMatchId, setOpenMatchId] = useState<string | null>(null);
  const [busyAccount, setBusyAccount] = useState<string | null>(null);
  const [busyActionKind, setBusyActionKind] = useState<"more" | "refresh" | null>(null);
  const [refreshAvailableAt, setRefreshAvailableAt] = useState(0);
  const [now, setNow] = useState(0);
  const [moreError, setMoreError] = useState<string | null>(null);
  const [failedAction, setFailedAction] = useState<{ action: "more" | "refresh"; retryId?: string } | null>(null);
  // 갱신으로 ID가 늘어나도 원래 페이지의 추가 조회 가능성을 유지한다.
  const [hasNextPage, setHasNextPage] = useState(false);
  const requestId = useRef(0);
  const activeSearch = useRef<string | null>(null);
  const busyAction = useRef<string | null>(null);
  const mainRef = useRef<HTMLElement>(null);

  useEffect(() => {
    setNow(Date.now());
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, []);

  const search = useCallback(async (targetRiotId: string) => {
    if (
      !targetRiotId.trim() ||
      activeSearch.current?.toLocaleLowerCase() ===
        targetRiotId.toLocaleLowerCase()
    ) {
      return;
    }

    const currentRequest = ++requestId.current;
    activeSearch.current = targetRiotId;
    setRiotId(targetRiotId);
    setLoading(true);
    setError(null);
    setResult(null);
    setOpenMatchId(null);
    setMoreError(null);
    setFailedAction(null);

    try {
      const response = await fetch(`${apiBase}/search`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        cache: "no-store",
        body: JSON.stringify({ riotId: targetRiotId }),
      });
      const payload = await response.json();
      if (!response.ok) {
        throw new Error(
          typeof payload?.error === "string"
            ? payload.error
            : "검색에 실패했습니다.",
        );
      }
      if (currentRequest === requestId.current) {
        const updatedAt = Date.now();
        setResult(payload as LolSearchResult);
        setHasNextPage(payload.matchIds?.length === 20);
        setRefreshAvailableAt(updatedAt + (payload.refreshRemainSeconds ?? 0) * 1000);
        setNow(updatedAt);
      }
    } catch (cause) {
      if (currentRequest === requestId.current) {
        setError(
          cause instanceof Error
            ? cause.message
            : "검색 중 오류가 발생했습니다.",
        );
      }
    } finally {
      if (currentRequest === requestId.current) {
        activeSearch.current = null;
        setLoading(false);
      }
    }
  }, [apiBase]);

  useEffect(() => {
    let active = true;
    if (initialRiotId) queueMicrotask(() => { if (active) void search(initialRiotId); });
    else {
      setResult(null);
      setRiotId("");
      setError(initialError ?? null);
      setLoading(false);
    }
    return () => {
      active = false;
      requestId.current += 1;
      activeSearch.current = null;
    };
  }, [initialRiotId, initialError, search]);

  function navigateTo(target: string) {
    const path = lolRiotIdPath(target, pageBase);
    if (!path) {
      setError(LOL_RIOT_ID_ERROR);
      return;
    }
    const query = searchParams.has("queue") ? `?queue=${filter}` : "";
    if (path !== pathname) {
      requestId.current += 1;
      activeSearch.current = null;
      setResult(null);
      setError(null);
      setLoading(true);
    }
    router.push(`${path}${query}`, { scroll: false });
    if (path === pathname) void search(target);
  }

  function submitSearch(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    navigateTo(riotId);
  }

  function searchParticipant(target: string, ref?: string) {
    if (target === "Riot ID 미제공") return;
    if (ref) router.push(`${pageBase}/by-ref/${encodeURIComponent(ref)}`, { scroll: false });
    else navigateTo(target);
    mainRef.current?.scrollTo({ top: 0 });
  }

  async function runAccountAction(action: "more" | "refresh", retryId?: string) {
    if (!result || busyAction.current) return;
    const accountId = `${result.account.gameName}#${result.account.tagLine}`;
    if (busyAccount === accountId || (action === "refresh" && remainingCooldown > 0)) return;
    const request = requestId.current;
    const nextIds = result.matchIds?.slice(result.loadedCount, result.loadedCount + 5) ?? [];
    busyAction.current = accountId;
    setBusyAccount(accountId);
    setBusyActionKind(action);
    setMoreError(null);
    setFailedAction(null);
    try {
      const response = await fetch(
        action === "more" ? `${apiBase}/matches/more` : `${apiBase}/search`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          cache: "no-store",
          body: JSON.stringify(
            action === "more"
              ? {
                  riotId: accountId,
                  offset: result.loadedCount,
                  ...(retryId ? { matchIds: [retryId] } : nextIds.length ? { matchIds: nextIds } : {}),
                }
              : { riotId: accountId, refresh: true },
          ),
        },
      );
      const payload = await response.json();
      if (!response.ok) {
        const seconds = Number(response.headers.get("Retry-After"));
        const message = payload?.error ?? "요청에 실패했습니다.";
        throw new Error(response.status === 429 && seconds > 0
          ? `${message} 잠시 후 다시 시도 (${Math.ceil(seconds)}초)`
          : message);
      }
      if (request !== requestId.current || busyAction.current !== accountId) return;
      if (action === "refresh" && payload.status === "cooldown") {
        const updatedAt = Date.now();
        setRefreshAvailableAt(updatedAt + (payload.remainSeconds ?? 0) * 1000);
        setNow(updatedAt);
        setResult((current) => current ? { ...current, lastUpdatedAt: payload.lastUpdatedAt } : current);
        return;
      }
      if (action === "refresh") {
        const updatedAt = Date.now();
        const refreshed = payload as LolSearchResult;
        setHasNextPage((current) => current || refreshed.matchIds.length === 20);
        setResult((current) => {
          if (!current) return refreshed;
          const existing = new Set(current.matches.map((match) => match.matchId));
          const matches = [...refreshed.matches.filter((match) => !existing.has(match.matchId)), ...current.matches];
          const matchIds = [...new Set([...refreshed.matchIds, ...current.matchIds])];
          const processed = new Set([
            ...current.matchIds.slice(0, current.loadedCount), ...refreshed.matchIds.slice(0, refreshed.loadedCount),
          ]);
          const pending = matchIds.findIndex((id) => !processed.has(id));
          const loadedCount = pending < 0 ? matchIds.length : pending;
          const failures = new Map([...current.matchFailures, ...refreshed.matchFailures].map((failure) => [failure.matchId, failure]));
          for (const match of matches) failures.delete(match.matchId);
          return {
            ...refreshed, matches, matchIds, loadedCount,
            hasMore: matchIds.length > loadedCount || hasNextPage || refreshed.matchIds.length === 20,
            matchFailures: [...failures.values()], summaries: summarizeRecentMatches(matches, accountId),
            matchStatus: failures.size ? (matches.length ? "partial" : "failed") : matches.length ? "ready" : "empty",
          };
        });
        setRefreshAvailableAt(updatedAt + (payload.refreshRemainSeconds ?? 120) * 1000);
        setNow(updatedAt);
        setOpenMatchId(null);
      } else {
        const incoming = payload.matches ?? [];
        const morePages = nextIds.length || retryId ? hasNextPage : payload.matchIds?.length === 20;
        if (!retryId) setHasNextPage(morePages);
        setResult((current) => {
          if (!current) return current;
          const byId = new Map(current.matches.map((match) => [match.matchId, match]));
          for (const match of incoming) byId.set(match.matchId, match);
          const failures = new Map((current.matchFailures ?? []).map((failure) => [failure.matchId, failure]));
          for (const failure of payload.matchFailures ?? []) failures.set(failure.matchId, failure);
          for (const match of incoming) failures.delete(match.matchId);
          if (retryId && !payload.matchFailures?.some((failure: { matchId: string }) => failure.matchId === retryId)) failures.delete(retryId);
          const matchIds = [...new Set([...(current.matchIds ?? []), ...(payload.matchIds ?? [])])];
          const loadedCount = retryId ? current.loadedCount : payload.loadedCount ?? current.loadedCount;
          return {
            ...current,
            matches: [...byId.values()],
            matchIds,
            loadedCount,
            hasMore: retryId ? current.hasMore : matchIds.length > loadedCount
              || morePages,
            matchFailures: [...failures.values()],
            summaries: summarizeRecentMatches([...byId.values()], accountId),
            matchStatus: failures.size ? (byId.size ? "partial" : "failed") : byId.size ? "ready" : "empty",
          };
        });
      }
    } catch (cause) {
      if (request === requestId.current) {
        setMoreError(cause instanceof Error ? cause.message : "경기 정보를 불러오지 못했습니다.");
        setFailedAction({ action, retryId });
      }
    } finally {
      if (busyAction.current === accountId) {
        busyAction.current = null;
        setBusyAccount(null);
        setBusyActionKind(null);
      }
    }
  }

  const matches =
    result?.matches.filter((match) => {
      if (filter === "solo") return match.queueId === 420;
      if (filter === "flex") return match.queueId === 440;
      if (filter === "aram") return LOL_ARAM_QUEUE_IDS.has(match.queueId);
      return true;
    }) ?? [];
  const ownRiotId = result
    ? `${result.account.gameName}#${result.account.tagLine}`
    : "";
  const summaries = useMemo(
    () => result ? summarizeRecentMatches(result.matches, ownRiotId) : null,
    [result, ownRiotId],
  );
  const summary = summaries?.[filter];
  const remainingCooldown = Math.max(Math.ceil((refreshAvailableAt - now) / 1000), 0);
  const lastUpdatedSeconds = result?.lastUpdatedAt
    ? Math.max(0, Math.floor((now - Date.parse(result.lastUpdatedAt)) / 1000))
    : null;

  return (
    <main
      ref={mainRef}
      className="h-full min-h-0 overflow-y-auto bg-zinc-950 px-4 py-5 text-zinc-100 sm:px-6"
    >
      <div className="mx-auto w-full max-w-7xl pb-8">
        <header className="mb-5">
          <p className="text-xs font-semibold uppercase tracking-[0.18em] text-amber-400">
            {publicView ? "BGMS · KR" : "관리자 전용 · KR"}
          </p>
          <h1 className="mt-1 text-xl font-bold sm:text-2xl">LoL 전적 검색</h1>
        </header>

        {adminTools}
        <form
          onSubmit={submitSearch}
          className="flex flex-col gap-2 rounded-xl border border-zinc-800 bg-zinc-900 p-3 sm:flex-row"
        >
          <label className="sr-only" htmlFor="lol-riot-id">
            Riot ID
          </label>
          <input
            id="lol-riot-id"
            value={riotId}
            onChange={(event) => setRiotId(event.target.value)}
            placeholder="게임 이름#태그"
            autoComplete="off"
            maxLength={140}
            className="min-h-11 min-w-0 flex-1 rounded-lg border border-zinc-700 bg-zinc-950 px-3 text-sm outline-none placeholder:text-zinc-600 focus:border-amber-400"
          />
          <button
            type="submit"
            disabled={!riotId.trim()}
            className="min-h-11 rounded-lg bg-amber-400 px-5 text-sm font-bold text-zinc-950 disabled:opacity-50"
          >
            {loading ? "검색 중…" : "검색"}
          </button>
        </form>
        <p className="mt-2 text-xs text-zinc-500">
          한국 서버 전적을 조회합니다. Riot ID와 태그를 입력하세요.
        </p>

        {loading && (
          <p role="status" className="mt-5 rounded-lg bg-zinc-900 p-4 text-sm">
            Riot 전적을 불러오는 중입니다. 첫 조회는 잠시 걸릴 수 있습니다.
          </p>
        )}
        {error && (
          <p
            role="alert"
            className="mt-5 rounded-lg border border-red-900 bg-red-950/50 p-4 text-sm text-red-200"
          >
            {error}
          </p>
        )}

        {result && (
          <section aria-label="검색 결과" className="mt-5 space-y-4">
            <div className="flex items-center gap-3 rounded-xl border border-zinc-800 bg-zinc-900 p-4">
              <img
                src={`https://ddragon.leagueoflegends.com/cdn/${DATA_DRAGON_VERSION}/img/profileicon/${result.profile.profileIconId}.png`}
                alt="프로필 아이콘"
                width={64}
                height={64}
                onError={hideBrokenImage}
                className="h-14 w-14 rounded-xl sm:h-16 sm:w-16"
              />
              <div className="min-w-0">
                <h2 className="break-all text-lg font-bold">
                  {result.account.gameName}
                  <span className="text-zinc-500">
                    #{result.account.tagLine}
                  </span>
                </h2>
                <p className="mt-1 text-sm text-zinc-400">
                  레벨 {result.profile.summonerLevel} · KR
                </p>
              </div>
              <div className="ml-auto flex shrink-0 flex-col items-end gap-1">
                {lastUpdatedSeconds !== null && (
                  <span className="text-[11px] text-zinc-500">
                    최근 갱신 {lastUpdatedSeconds < 60
                      ? `${lastUpdatedSeconds}초 전`
                      : `${Math.floor(lastUpdatedSeconds / 60)}분 전`}
                  </span>
                )}
                <button
                  type="button"
                  disabled={busyAccount === ownRiotId || remainingCooldown > 0}
                  onClick={() => void runAccountAction("refresh")}
                  className="min-h-10 rounded-lg border border-zinc-700 px-3 text-xs font-semibold text-zinc-200 disabled:opacity-50"
                >
                  {busyAccount === ownRiotId
                    ? "BGMS 데이터 처리 중…"
                    : remainingCooldown > 0
                      ? `${remainingCooldown}초 후 갱신 가능`
                      : "전적 갱신"}
                </button>
              </div>
            </div>

            <div
              data-testid="lol-results-grid"
              className="grid min-w-0 gap-4 lg:grid-cols-[320px_minmax(0,1fr)] lg:grid-rows-[auto_1fr] lg:items-start"
            >
              <LolRankCards ranked={result.ranked} rankedHistory={result.rankedHistory} />
              <section
                aria-label="최근 경기"
                data-testid="lol-history"
                className="@container/history min-w-0 space-y-3 lg:col-start-2 lg:row-span-2 lg:row-start-1"
              >
                <LolSummary summary={summary}>
                  <label className="flex items-center gap-2 text-xs text-zinc-400">
                    큐 필터
                    <select
                      aria-label="큐 필터"
                      value={filter}
                      onChange={(event) => {
                        const params = new URLSearchParams(searchParams.toString());
                        params.set("queue", event.target.value);
                        router.replace(`${pathname}?${params}`, { scroll: false });
                      }}
                      className="min-h-10 rounded-lg border border-zinc-700 bg-zinc-950 px-2 text-zinc-100"
                    >
                      <option value="all">전체</option>
                      <option value="solo">솔로</option>
                      <option value="flex">자유</option>
                      <option value="aram">ARAM</option>
                    </select>
                  </label>
                </LolSummary>
                {result.matchStatus === "partial" && (
                  <p className="mb-2 rounded-lg border border-amber-900 bg-amber-950/40 p-3 text-xs text-amber-200">
                    일부 경기 정보를 불러오지 못했습니다. 확인된 경기만
                    표시합니다.
                  </p>
                )}
                {result.matchStatus === "failed" && (
                  <p
                    role="alert"
                    className="rounded-xl border border-red-900 bg-red-950/50 p-4 text-sm text-red-200"
                  >
                    최근 경기 정보를 가져오지 못했습니다. 잠시 후 다시 검색해
                    주세요.
                  </p>
                )}
                {result.matchStatus === "empty" && (
                  <p className="rounded-xl border border-zinc-800 bg-zinc-900 p-4 text-sm text-zinc-500">
                    표시할 최근 경기가 없습니다.
                  </p>
                )}
                {moreError && (
                  <div role="alert" className="rounded-lg border border-red-900 bg-red-950/50 p-3 text-sm text-red-200">
                    <p>{moreError}</p>
                    {failedAction && <button type="button" disabled={busyAccount === ownRiotId}
                      onClick={() => void runAccountAction(failedAction.action, failedAction.retryId)}
                      className="mt-2 min-h-10 rounded-lg border border-red-800 px-3 text-xs font-semibold disabled:opacity-50">
                      잠시 후 다시 시도
                    </button>}
                  </div>
                )}
                <div className="space-y-3">
                  {matches.map((match) => (
                    <LolMatchCard
                      key={match.matchId}
                      match={match}
                      ownRiotId={ownRiotId}
                      expanded={openMatchId === match.matchId}
                      onToggle={() =>
                        setOpenMatchId(
                          openMatchId === match.matchId ? null : match.matchId,
                        )
                      }
                      onSearch={searchParticipant}
                    />
                  ))}
                  {(result.matchFailures ?? []).map((failure) => {
                    const rateLimited = failure.kind.toLocaleLowerCase().includes("rate") || failure.kind.includes("429");
                    const busy = failure.kind.toLocaleLowerCase().includes("busy");
                    return (
                      <article key={failure.matchId} data-testid="lol-match-failure" className="rounded-xl border border-amber-900 bg-zinc-900 p-4">
                        <p className="break-all text-sm font-semibold">{failure.matchId}</p>
                        <p className="mt-1 text-xs text-zinc-400">
                          {rateLimited
                            ? `Riot 요청 제한으로 불러오지 못했습니다.${failure.retryAfterSeconds ? ` ${failure.retryAfterSeconds}초 후 다시 시도해 주세요.` : " 잠시 후 다시 시도해 주세요."}`
                            : busy
                              ? "BGMS에서 경기 정보를 처리 중입니다. 잠시 후 다시 시도해 주세요."
                              : "불러오기 실패 · 경기 정보를 불러오지 못했습니다."}
                        </p>
                        <button
                          type="button"
                          disabled={busyAccount === ownRiotId}
                          onClick={() => void runAccountAction("more", failure.matchId)}
                          className="mt-3 min-h-10 rounded-lg border border-zinc-700 px-3 text-xs font-semibold disabled:opacity-50"
                        >
                          {busyAccount === ownRiotId && busyActionKind === "more" ? "불러오는 중…" : "다시 시도"}
                        </button>
                      </article>
                    );
                  })}
                </div>
                {result.hasMore && (
                  <button
                    type="button"
                    disabled={busyAccount === ownRiotId}
                    onClick={() => void runAccountAction("more")}
                    className="min-h-11 w-full rounded-lg border border-zinc-700 bg-zinc-900 px-4 text-sm font-semibold disabled:opacity-50"
                  >
                    {busyAccount === ownRiotId && busyActionKind === "more" ? "BGMS 데이터 처리 중…" : "경기 더 불러오기"}
                  </button>
                )}
              </section>
              <aside data-testid="lol-sidebar-stats" className="min-w-0 space-y-3 lg:col-start-1 lg:row-start-2">
                <LolSidebarStats summary={summary} onSearch={searchParticipant} />
              </aside>
            </div>
          </section>
        )}

        <LolLegalNotice />
      </div>
    </main>
  );
}
