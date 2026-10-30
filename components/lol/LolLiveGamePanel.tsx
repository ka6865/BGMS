"use client";

import { useEffect, useRef, useState } from "react";
import { LOL_STAT_DEFAULT_TIER_FILTER, LOL_STAT_MIN_GAMES, LOL_STAT_TIER_FILTERS, LOL_STAT_TIER_LABELS, type LolStatTierFilterId } from "@/lib/lol/championStats";
import {
  LOL_LIVE_NOTICE, type LolLiveChampionStat, type LolLiveFailureKind, type LolLiveGameView, type LolLiveParticipantView, type LolLiveRank,
} from "@/lib/lol/liveGame";
import { LOL_KEY_RENEWAL_ENGLISH, LOL_KEY_RENEWAL_MESSAGE } from "@/lib/lol/keyNotice";

type PanelError = { message: string; renewal: boolean; retryAfterSeconds?: number };

const FAILURE_LABEL: Record<LolLiveFailureKind, string> = {
  rate_limited: "요청 제한", key_or_permission: "키 갱신 필요", congested: "혼잡", timeout: "응답 지연", upstream: "Riot 응답 오류",
};
const TEAM_LABEL: Record<number, string> = { 100: "블루 팀", 200: "레드 팀" };
const TIER_LABEL = LOL_STAT_TIER_LABELS as Record<string, string>;

const pct = (value: number | null | undefined) => value === null || value === undefined ? "-" : `${(value * 100).toFixed(1)}%`;
const clock = (seconds: number | null) => {
  if (seconds === null || seconds < 0) return null;
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;
};

function hideBrokenImage(event: React.SyntheticEvent<HTMLImageElement>) {
  event.currentTarget.hidden = true;
}

function Icon({ src, label, size }: { src: string | null; label: string; size: number }) {
  if (!src) return <span aria-hidden="true" style={{ width: size, height: size }} className="inline-block shrink-0 rounded bg-zinc-800" />;
  return <img src={src} alt={label} width={size} height={size} loading="lazy" referrerPolicy="no-referrer" onError={hideBrokenImage}
    className="shrink-0 rounded" style={{ width: size, height: size }} />;
}

function rankText(rank: LolLiveRank): { text: string; tone: "normal" | "muted" | "warn" } {
  switch (rank.status) {
    case "ranked": {
      const tier = `${TIER_LABEL[rank.tier] ?? rank.tier}${rank.rank ? ` ${rank.rank}` : ""}`;
      return { text: `${tier} · ${rank.leaguePoints} LP · ${rank.wins}승 ${rank.losses}패 · 승률 ${pct(rank.winRate)}`, tone: "normal" };
    }
    case "unranked": return { text: "언랭크", tone: "muted" };
    case "hidden": return { text: "랭크 조회 대상 아님", tone: "muted" };
    case "failed": return { text: `불러오지 못함 (${FAILURE_LABEL[rank.reason]})`, tone: "warn" };
  }
}

function championText(stat: LolLiveChampionStat): string {
  switch (stat.status) {
    case "ok": return `승률 ${pct(stat.winRate)} · 픽률 ${pct(stat.pickRate)} · 밴율 ${pct(stat.banRate)}`;
    case "small_sample": return `표본 부족 (${stat.games}판) · 픽률 ${pct(stat.pickRate)} · 밴율 ${pct(stat.banRate)}`;
    case "none": return "통계 없음";
    case "unavailable": return "통계를 불러오지 못함";
    case "not_applicable": return "솔로 랭크 통계 대상 아님";
  }
}

function ParticipantRow({ item }: { item: LolLiveParticipantView }) {
  const rank = rankText(item.rank);
  const name = item.identity.status === "visible" ? item.identity.riotId : item.identity.status === "bot" ? "봇" : "비공개 참가자";
  return (
    <li className="flex min-w-0 items-center gap-3 border-t border-zinc-800 py-3 first:border-t-0">
      <Icon src={item.championIconUrl} label={item.championName ?? "챔피언"} size={44} />
      <div className="min-w-0 flex-1">
        <p className="truncate text-sm font-semibold">{item.championName ?? `챔피언 #${item.championId}`}</p>
        <p className="break-all text-xs text-zinc-300">{name}</p>
        <p className={`text-xs ${rank.tone === "warn" ? "text-amber-300" : rank.tone === "muted" ? "text-zinc-500" : "text-zinc-400"}`}>
          {rank.text}
        </p>
        <p className="text-xs text-zinc-500">{championText(item.champion)}</p>
      </div>
      <div className="flex shrink-0 flex-col items-center gap-1">
        <div className="flex gap-1">
          {item.spells.map((spell, index) => <Icon key={index} src={spell.iconUrl} label={spell.name ?? "소환사 주문"} size={22} />)}
        </div>
        <Icon src={item.keystone?.iconUrl ?? null} label={item.keystone?.name ?? "핵심 룬"} size={22} />
      </div>
    </li>
  );
}

export default function LolLiveGamePanel({ apiBase, backHref, initialRiotId, initialError, publicView = false }: {
  apiBase: string;
  backHref: string;
  initialRiotId?: string;
  initialError?: string;
  publicView?: boolean;
}) {
  const [view, setView] = useState<LolLiveGameView | null>(null);
  const [error, setError] = useState<PanelError | null>(initialError ? { message: initialError, renewal: false } : null);
  const [loading, setLoading] = useState(false);
  const [tier, setTier] = useState<LolStatTierFilterId>(LOL_STAT_DEFAULT_TIER_FILTER);
  const [refreshKey, setRefreshKey] = useState(0);
  // 늦게 도착한 응답이 새 조회를 덮지 않도록 조회마다 번호를 올리고, 이전 요청은 취소한다.
  const requestId = useRef(0);
  const controller = useRef<AbortController | null>(null);

  useEffect(() => {
    if (!initialRiotId) return;
    const id = ++requestId.current;
    controller.current?.abort();
    const current = new AbortController();
    controller.current = current;
    setLoading(true);
    setError(null);
    setView(null);
    (async () => {
      try {
        const response = await fetch(`${apiBase}/live`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          cache: "no-store",
          signal: current.signal,
          body: JSON.stringify({ riotId: initialRiotId, tier }),
        });
        const payload = await response.json().catch(() => null);
        if (id !== requestId.current) return;
        if (!response.ok) {
          const seconds = Number(response.headers.get("Retry-After"));
          const renewal = payload?.reasonCode === "riot_key_renewal";
          setError({
            message: renewal ? LOL_KEY_RENEWAL_MESSAGE : typeof payload?.error === "string" ? payload.error : "진행 중인 게임을 불러오지 못했습니다.",
            renewal,
            ...(seconds > 0 ? { retryAfterSeconds: Math.ceil(seconds) } : {}),
          });
          return;
        }
        setView(payload as LolLiveGameView);
      } catch {
        if (id !== requestId.current || current.signal.aborted) return;
        setError({ message: "진행 중인 게임을 불러오지 못했습니다. 잠시 후 다시 시도해 주세요.", renewal: false });
      } finally {
        if (id === requestId.current) setLoading(false);
      }
    })();
    return () => {
      requestId.current += 1;
      current.abort();
    };
  }, [apiBase, initialRiotId, tier, refreshKey]);

  const ready = view?.status === "ready" ? view : null;
  const failedNames = ready ? ready.participants.filter(item => item.rank.status === "failed") : [];
  const keyFailure = failedNames.some(item => item.rank.status === "failed" && item.rank.reason === "key_or_permission");
  const elapsed = ready ? clock(ready.gameLengthSeconds) : null;
  const shownId = view?.riotId ?? initialRiotId ?? null;

  return (
    <main className="h-full min-h-0 overflow-y-auto bg-zinc-950 px-4 py-5 text-zinc-100 sm:px-6">
      <div className="mx-auto w-full max-w-5xl pb-8">
        <a href={backHref} className="inline-flex min-h-11 items-center text-sm text-zinc-400 underline-offset-4 hover:text-zinc-200 hover:underline">
          ← 전적으로 돌아가기
        </a>
        <header className="mb-4">
          <p className="text-xs font-semibold uppercase tracking-[0.18em] text-amber-400">{publicView ? "BGMS · KR" : "관리자 전용 · KR"}</p>
          <h1 className="mt-1 text-xl font-bold sm:text-2xl">진행 중인 게임</h1>
          {shownId && <p className="mt-1 break-all text-sm text-zinc-400">{shownId}</p>}
        </header>

        {initialRiotId && (
          <div className="mb-4 flex flex-wrap items-center gap-2">
            <label className="flex min-h-11 items-center gap-2 text-xs text-zinc-400">
              <span>챔피언 통계 티어</span>
              <select value={tier} onChange={event => setTier(event.target.value as LolStatTierFilterId)}
                className="min-h-11 rounded-lg border border-zinc-700 bg-zinc-950 px-2 text-sm text-zinc-100">
                {LOL_STAT_TIER_FILTERS.map(item => <option key={item.id} value={item.id}>{item.label}</option>)}
              </select>
            </label>
            <button type="button" disabled={loading} onClick={() => setRefreshKey(current => current + 1)}
              className="min-h-11 rounded-lg border border-zinc-700 px-4 text-sm font-semibold text-zinc-200 disabled:opacity-50">
              {loading ? "확인 중…" : "다시 조회"}
            </button>
          </div>
        )}

        {loading && <p role="status" className="rounded-xl border border-zinc-800 bg-zinc-900 p-4 text-sm text-zinc-300">진행 중인 게임을 확인하는 중입니다.</p>}

        {error && !loading && (
          <div role={error.renewal ? "status" : "alert"} className={`rounded-xl border p-4 text-sm ${error.renewal
            ? "border-amber-900 bg-zinc-900 text-amber-200" : "border-red-900 bg-red-950/50 text-red-200"}`}>
            <p>{error.message}</p>
            {error.renewal && <p lang="en" className="mt-1 text-xs">{LOL_KEY_RENEWAL_ENGLISH}</p>}
            {error.retryAfterSeconds && <p className="mt-1 text-xs">{error.retryAfterSeconds}초 후 다시 시도해 주세요.</p>}
          </div>
        )}

        {view?.status === "not_in_game" && !loading && (
          <section aria-label="진행 상태" className="rounded-xl border border-zinc-800 bg-zinc-900 p-4 text-sm text-zinc-300">
            <p className="font-semibold">지금 진행 중인 게임이 없습니다.</p>
            <p className="mt-1 text-xs text-zinc-500">조회 시점 기준입니다. 경기 시작 직후에는 잠시 뒤 다시 조회해 주세요.</p>
          </section>
        )}

        {view?.status === "unsupported_mode" && !loading && (
          <section aria-label="진행 상태" className="rounded-xl border border-zinc-800 bg-zinc-900 p-4 text-sm text-zinc-300">
            <p className="font-semibold">이 경기 유형은 표시하지 않습니다.</p>
            <p className="mt-1 text-xs text-zinc-500">커스텀 게임은 참가자 정보를 보여 주지 않습니다.</p>
          </section>
        )}

        {ready && !loading && (
          <section aria-label="진행 중인 경기" className="space-y-4">
            <div className="flex flex-wrap items-center gap-x-4 gap-y-1 rounded-xl border border-zinc-800 bg-zinc-900 p-4 text-sm">
              <p className="font-semibold">{ready.queue.label ?? `큐 ${ready.queue.id}`}</p>
              {elapsed && <p className="text-zinc-400">조회 시점 경과 {elapsed}</p>}
              <p className="text-xs text-zinc-500">챔피언 통계: {ready.championStats.status === "ok"
                ? `${ready.championStats.patch} 패치 · ${ready.championStats.tierLabel} · 솔로 랭크 ${ready.championStats.matches.toLocaleString()}경기 표본`
                : ready.championStats.status === "unavailable" ? "불러오지 못함"
                  : "솔로 랭크 경기만 집계"}</p>
            </div>

            {keyFailure && <p role="status" className="rounded-lg border border-amber-900 bg-zinc-900 p-3 text-sm text-amber-200">
              {LOL_KEY_RENEWAL_MESSAGE}<span lang="en" className="mt-1 block text-xs">{LOL_KEY_RENEWAL_ENGLISH}</span>
            </p>}
            {ready.rankFailureCount > 0 && <p role="status" className="rounded-lg border border-amber-900 bg-amber-950/40 p-3 text-xs text-amber-200">
              일부 참가자의 랭크를 불러오지 못했습니다. 해당 칸만 표시하며 나머지 정보는 그대로 보입니다.
            </p>}
            {ready.championStats.status === "ok" && <p className="text-xs text-zinc-500">
              {ready.championStats.tierLabel} 기준 BGMS 익명 집계입니다. {LOL_STAT_MIN_GAMES}판 미만 챔피언은 승률 대신 표본 부족으로 표시합니다.
            </p>}

            {ready.bans.length > 0 && (
              <section aria-label="밴" className="rounded-xl border border-zinc-800 bg-zinc-900 p-4">
                <h2 className="text-sm font-semibold">밴</h2>
                <ul className="mt-2 flex flex-wrap gap-2">
                  {ready.bans.map((ban, index) => (
                    <li key={`${ban.teamId}-${ban.championId}-${index}`} className="flex min-h-11 items-center gap-2 rounded-lg bg-zinc-950 px-2 text-xs text-zinc-300">
                      <Icon src={ban.championIconUrl} label={ban.championName ?? "밴 챔피언"} size={24} />
                      <span>{TEAM_LABEL[ban.teamId] ?? "팀"} · {ban.championName ?? `챔피언 #${ban.championId}`}</span>
                    </li>
                  ))}
                </ul>
              </section>
            )}

            <div className="grid gap-4 md:grid-cols-2">
              {[100, 200].map(teamId => {
                const members = ready.participants.filter(item => item.teamId === teamId);
                return (
                  <section key={teamId} aria-label={TEAM_LABEL[teamId]} className="min-w-0 rounded-xl border border-zinc-800 bg-zinc-900 p-4">
                    <h2 className="text-sm font-semibold">{TEAM_LABEL[teamId]}</h2>
                    <ul className="mt-2">
                      {members.map((item, index) => <ParticipantRow key={`${teamId}-${item.championId}-${index}`} item={item} />)}
                    </ul>
                  </section>
                );
              })}
            </div>
          </section>
        )}

        <p className="mt-6 border-t border-zinc-800 pt-3 text-xs text-zinc-500">{LOL_LIVE_NOTICE}</p>
      </div>
    </main>
  );
}
