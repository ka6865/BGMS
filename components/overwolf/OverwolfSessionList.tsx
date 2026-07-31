"use client";

/**
 * Overwolf Companion 세션 요약 목록/상세 화면.
 *
 * GEP 데이터는 공식 API 사후 분석을 대체하지 않는 보조 신호이므로
 * 화면에서도 참고값으로 표기하고, 확정 분석은 전적 분석 화면으로 넘긴다.
 */

import React, { useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import {
  Activity,
  ArrowRight,
  Crosshair,
  HeartPulse,
  Map as MapIcon,
  Search,
  Skull,
  Swords,
  Target,
  Trophy,
  UserPlus,
} from "lucide-react";
import { buildAnalysisPath, type SessionSummaryView, type TimelineKind } from "@/lib/overwolf/session-view";

const PLATFORMS = [
  { value: "steam", label: "Steam" },
  { value: "kakao", label: "Kakao" },
] as const;

const TIMELINE_META: Record<
  TimelineKind,
  { label: string; icon: React.ComponentType<{ className?: string }>; tone: string }
> = {
  kill: { label: "처치", icon: Swords, tone: "text-[#F2A900]" },
  death: { label: "사망", icon: Skull, tone: "text-red-400" },
  knockedout: { label: "기절", icon: HeartPulse, tone: "text-orange-300" },
  revived: { label: "부활", icon: UserPlus, tone: "text-emerald-300" },
  killer: { label: "가해자", icon: Target, tone: "text-red-300" },
};

function formatDuration(seconds: number | null): string {
  if (seconds === null) return "-";
  const minutes = Math.floor(seconds / 60);
  const rest = seconds % 60;
  return `${minutes}분 ${String(rest).padStart(2, "0")}초`;
}

function formatMapName(mapName: string | null): string {
  if (!mapName) return "맵 정보 없음";
  // GEP 는 Erangel_Main 처럼 내부 코드로 준다. 표시용으로만 다듬는다.
  return mapName.replace(/_Main$/i, "").replace(/_/g, " ");
}

function formatDistance(value: number | null): string {
  if (value === null) return "-";
  return `${Math.round(value)}m`;
}

function formatCreatedAt(iso: string): string {
  const parsed = Date.parse(iso);
  if (!Number.isFinite(parsed)) return "-";
  return new Date(parsed).toLocaleString("ko-KR", {
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  });
}

const StatCell = ({
  label,
  value,
  accent = false,
}: {
  label: string;
  value: string;
  accent?: boolean;
}) => (
  <div className="flex flex-col gap-0.5 min-w-0">
    <span className="text-[10px] font-bold uppercase tracking-wide text-white/40">{label}</span>
    <span
      className={`truncate text-sm font-black tabular-nums ${
        accent ? "text-[#F2A900]" : "text-white"
      }`}
    >
      {value}
    </span>
  </div>
);

/** 사후 리뷰 타임라인. 좌표는 담기지 않으므로 시점과 종류만 보여준다. */
const SessionTimeline = ({ session }: { session: SessionSummaryView }) => {
  if (session.timeline.length === 0) {
    return (
      <p className="text-xs leading-relaxed text-white/40">
        이 세션에는 기록된 교전 시점이 없습니다. 앱이 매치 도중에 켜졌거나 이벤트가 도착하지 않은
        경우입니다.
      </p>
    );
  }

  return (
    <ol className="flex flex-col gap-1.5">
      {session.timeline.map((entry, index) => {
        const meta = TIMELINE_META[entry.kind];
        const Icon = meta.icon;

        return (
          <li
            key={`${entry.kind}-${index}-${entry.elapsedSeconds ?? "na"}`}
            className="flex items-center gap-2.5 text-xs"
          >
            <span className="w-12 shrink-0 text-right font-bold tabular-nums text-white/50">
              {entry.clock || "--:--"}
            </span>
            <Icon className={`h-3.5 w-3.5 shrink-0 ${meta.tone}`} aria-hidden="true" />
            <span className="font-bold text-white/80">{meta.label}</span>
            {entry.detail ? (
              <span className="truncate text-white/50">{entry.detail}</span>
            ) : null}
          </li>
        );
      })}
    </ol>
  );
};

const SessionCard = ({ session }: { session: SessionSummaryView }) => {
  const [expanded, setExpanded] = useState(false);
  const analysisPath = buildAnalysisPath(session);
  const hasRank = session.rankPlace !== null;

  return (
    <article className="rounded-lg border border-white/10 bg-[#161616] p-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <MapIcon className="h-4 w-4 shrink-0 text-white/30" aria-hidden="true" />
            <h3 className="truncate text-base font-black text-white">
              {formatMapName(session.mapName)}
            </h3>
            {session.matchMode ? (
              <span className="rounded border border-white/10 px-1.5 py-0.5 text-[10px] font-bold uppercase text-white/50">
                {session.matchMode}
              </span>
            ) : null}
          </div>
          <p className="mt-1 text-xs text-white/40">
            {formatCreatedAt(session.createdAt)} · 진행 {formatDuration(session.durationSeconds)}
          </p>
        </div>

        {hasRank ? (
          <div className="flex items-center gap-1.5 rounded border border-[#F2A900]/30 bg-[#F2A900]/10 px-2 py-1">
            <Trophy className="h-3.5 w-3.5 text-[#F2A900]" aria-hidden="true" />
            <span className="text-sm font-black tabular-nums text-[#F2A900]">
              #{session.rankPlace}
              {session.rankTotal ? (
                <span className="text-xs font-bold text-[#F2A900]/60"> / {session.rankTotal}</span>
              ) : null}
            </span>
          </div>
        ) : null}
      </div>

      <div className="mt-4 grid grid-cols-3 gap-3 sm:grid-cols-6">
        <StatCell label="처치" value={String(session.kills)} accent={session.kills > 0} />
        <StatCell label="헤드샷" value={String(session.headshots)} />
        <StatCell label="최장 킬" value={formatDistance(session.maxKillDistance)} />
        <StatCell label="사망" value={String(session.deaths)} />
        <StatCell label="기절" value={String(session.knockdowns)} />
        <StatCell label="부활" value={String(session.revives)} />
      </div>

      {session.lastKillerName ? (
        <p className="mt-3 flex items-center gap-1.5 text-xs text-white/50">
          <Target className="h-3.5 w-3.5 text-red-300" aria-hidden="true" />
          마지막 가해자 <span className="font-bold text-white/80">{session.lastKillerName}</span>
        </p>
      ) : null}

      <div className="mt-4 flex flex-wrap items-center gap-2 border-t border-white/5 pt-3">
        <button
          type="button"
          onClick={() => setExpanded((prev) => !prev)}
          aria-expanded={expanded}
          className="flex items-center gap-1.5 rounded border border-white/10 px-2.5 py-1.5 text-xs font-bold text-white/70 transition-colors hover:border-white/25 hover:text-white"
        >
          <Activity className="h-3.5 w-3.5" aria-hidden="true" />
          교전 시점 {session.timeline.length > 0 ? `${session.timeline.length}건` : "없음"}
        </button>

        {analysisPath ? (
          <Link
            href={analysisPath}
            className="flex items-center gap-1.5 rounded border border-[#F2A900]/40 bg-[#F2A900]/10 px-2.5 py-1.5 text-xs font-bold text-[#F2A900] transition-colors hover:bg-[#F2A900]/20"
          >
            <Crosshair className="h-3.5 w-3.5" aria-hidden="true" />
            공식 전적 분석 열기
            <ArrowRight className="h-3.5 w-3.5" aria-hidden="true" />
          </Link>
        ) : (
          <span
            className="text-xs text-white/35"
            title="Overwolf 가 생성한 임시 식별자만 수신된 세션입니다. 공식 API 조회 키가 아니라 분석으로 연결할 수 없습니다."
          >
            공식 매치 ID 미수신
          </span>
        )}
      </div>

      {expanded ? (
        <div className="mt-3 rounded border border-white/5 bg-black/20 p-3">
          <SessionTimeline session={session} />
          {session.displayMatchId ? (
            <p className="mt-3 break-all border-t border-white/5 pt-2 font-mono text-[10px] text-white/25">
              {session.displayMatchId}
            </p>
          ) : null}
        </div>
      ) : null}
    </article>
  );
};

export default function OverwolfSessionList() {
  const router = useRouter();
  const searchParams = useSearchParams();

  const initialPlayer = searchParams.get("player") || "";
  const initialPlatform = searchParams.get("platform") || "steam";

  const [player, setPlayer] = useState(initialPlayer);
  const [platform, setPlatform] = useState(initialPlatform);
  const [sessions, setSessions] = useState<SessionSummaryView[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async (nickname: string, targetPlatform: string) => {
    const trimmed = nickname.trim();
    if (trimmed.length < 3) {
      setError("닉네임을 3자 이상 입력해주세요.");
      setSessions(null);
      return;
    }

    setLoading(true);
    setError(null);

    try {
      const params = new URLSearchParams({ player: trimmed, platform: targetPlatform });
      const response = await fetch(`/api/overwolf/sessions?${params.toString()}`);
      const payload = await response.json();

      if (!response.ok) {
        setError(typeof payload?.error === "string" ? payload.error : "세션을 불러오지 못했습니다.");
        setSessions(null);
        return;
      }

      setSessions(Array.isArray(payload.sessions) ? payload.sessions : []);
    } catch {
      setError("세션을 불러오지 못했습니다. 잠시 후 다시 시도해주세요.");
      setSessions(null);
    } finally {
      setLoading(false);
    }
  }, []);

  // 주소에 닉네임이 있으면 첫 진입에 바로 조회한다. 앱에서 보낸 링크가 이 경로로 들어온다.
  useEffect(() => {
    if (initialPlayer.trim().length >= 3) {
      void load(initialPlayer, initialPlatform);
    }
  }, [initialPlayer, initialPlatform, load]);

  const handleSubmit = (event: React.FormEvent) => {
    event.preventDefault();

    const params = new URLSearchParams({ player: player.trim(), platform });
    router.replace(`/overwolf/sessions?${params.toString()}`);
    void load(player, platform);
  };

  const totals = useMemo(() => {
    if (!sessions || sessions.length === 0) return null;

    return sessions.reduce(
      (acc, session) => ({
        kills: acc.kills + session.kills,
        headshots: acc.headshots + session.headshots,
        deaths: acc.deaths + session.deaths,
        linkable: acc.linkable + (session.canOpenAnalysis ? 1 : 0),
      }),
      { kills: 0, headshots: 0, deaths: 0, linkable: 0 }
    );
  }, [sessions]);

  return (
    <div className="flex w-full flex-col gap-5 px-4 py-6 sm:px-6">
      <header className="flex flex-col gap-1.5">
        <h1 className="text-xl font-black text-white sm:text-2xl">Companion 세션 기록</h1>
        <p className="max-w-2xl text-xs leading-relaxed text-white/50 sm:text-sm">
          BGMS Companion(Overwolf 앱)이 매치 종료 후 보낸 요약입니다. 실시간 보조 신호이므로 참고용
          이며, 확정 분석은 공식 API 기반 전적 분석 화면에서 확인합니다.
        </p>
      </header>

      <form
        onSubmit={handleSubmit}
        className="flex flex-wrap items-end gap-2 rounded-lg border border-white/10 bg-[#161616] p-3"
      >
        <label className="flex min-w-[200px] flex-1 flex-col gap-1.5">
          <span className="text-[10px] font-bold uppercase tracking-wide text-white/40">
            앱에 입력한 닉네임
          </span>
          <input
            type="text"
            value={player}
            onChange={(event) => setPlayer(event.target.value)}
            placeholder="PUBG 닉네임"
            autoComplete="off"
            spellCheck={false}
            className="rounded border border-white/10 bg-black/30 px-3 py-2 text-sm text-white outline-none placeholder:text-white/25 focus-visible:border-[#F2A900]"
          />
        </label>

        <div className="flex flex-col gap-1.5">
          <span className="text-[10px] font-bold uppercase tracking-wide text-white/40">플랫폼</span>
          <div className="flex gap-1.5" role="group" aria-label="플랫폼">
            {PLATFORMS.map((item) => (
              <button
                key={item.value}
                type="button"
                onClick={() => setPlatform(item.value)}
                aria-pressed={platform === item.value}
                className={`rounded border px-3 py-2 text-xs font-bold transition-colors ${
                  platform === item.value
                    ? "border-[#F2A900]/50 bg-[#F2A900]/10 text-[#F2A900]"
                    : "border-white/10 text-white/60 hover:border-white/25"
                }`}
              >
                {item.label}
              </button>
            ))}
          </div>
        </div>

        <button
          type="submit"
          disabled={loading}
          className="flex items-center gap-1.5 rounded border border-[#F2A900]/50 bg-[#F2A900]/15 px-4 py-2 text-xs font-bold text-[#F2A900] transition-colors hover:bg-[#F2A900]/25 disabled:opacity-50"
        >
          <Search className="h-3.5 w-3.5" aria-hidden="true" />
          {loading ? "조회 중" : "조회"}
        </button>
      </form>

      {error ? (
        <p className="rounded border border-red-500/30 bg-red-500/10 px-3 py-2 text-xs text-red-300">
          {error}
        </p>
      ) : null}

      {totals ? (
        <div className="grid grid-cols-2 gap-3 rounded-lg border border-white/10 bg-[#161616] p-3 sm:grid-cols-4">
          <StatCell label="세션" value={String(sessions?.length ?? 0)} />
          <StatCell label="누적 처치" value={String(totals.kills)} accent={totals.kills > 0} />
          <StatCell label="누적 헤드샷" value={String(totals.headshots)} />
          <StatCell label="분석 연결 가능" value={`${totals.linkable}건`} />
        </div>
      ) : null}

      {sessions && sessions.length === 0 && !loading ? (
        <div className="rounded-lg border border-white/10 bg-[#161616] p-6">
          <p className="text-sm font-bold text-white">아직 도착한 세션이 없습니다.</p>
          <p className="mt-1.5 text-xs leading-relaxed text-white/50">
            BGMS Companion 데스크탑 창에서 전송을 켜고 같은 닉네임을 입력했는지 확인해주세요. 전송은
            매치가 끝난 뒤 1회 발생합니다.
          </p>
        </div>
      ) : null}

      {sessions && sessions.length > 0 ? (
        <div className="flex flex-col gap-3">
          {sessions.map((session) => (
            <SessionCard key={session.sessionId} session={session} />
          ))}
        </div>
      ) : null}
    </div>
  );
}
