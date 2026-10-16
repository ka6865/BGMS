"use client";

import type { RecentSessionOverview } from "@/lib/stats/recentSessionOverview";

export interface StatsSessionOverviewCardProps {
  session: RecentSessionOverview | null;
}

const timeFormat = new Intl.DateTimeFormat("ko-KR", { timeZone: "Asia/Seoul", month: "numeric", day: "numeric", hour: "numeric", minute: "2-digit" });
const clockFormat = new Intl.DateTimeFormat("ko-KR", { timeZone: "Asia/Seoul", hour: "numeric", minute: "2-digit" });

export function StatsSessionOverviewCard({ session }: StatsSessionOverviewCardProps) {
  if (!session) return null;
  const maxKills = Math.max(1, ...session.killsByMatch);
  const started = new Date(session.startedAt);
  const last = new Date(session.lastStartedAt);
  return (
    <section className="hidden rounded-2xl border border-white/10 bg-[#161616] p-5 lg:block lg:w-[320px] lg:shrink-0" aria-label="최근 세션">
      <h2 className="text-base font-black text-white">최근 세션</h2>
      <p className="mt-1 text-[11px] leading-5 text-white/50">
        1시간 넘게 쉬기 전까지 이어서 한 경기 묶음입니다. 최근 20경기 중 {session.sessionCount}개 세션.
      </p>
      <p className="mt-3 text-xs font-bold text-white/80">
        {timeFormat.format(started)}
        {session.games > 1 ? ` ~ ${clockFormat.format(last)} 시작` : ""} · {session.games}경기
      </p>
      <dl className="mt-3 grid grid-cols-4 gap-2 border-t border-white/10 pt-3 text-center">
        <div><dt className="text-[10px] font-bold text-white/50">우승</dt><dd className="text-sm font-black text-white">{session.wins}</dd></div>
        <div><dt className="text-[10px] font-bold text-white/50">킬</dt><dd className="text-sm font-black text-white">{session.kills}</dd></div>
        <div><dt className="text-[10px] font-bold text-white/50">평균 피해</dt><dd className="text-sm font-black text-white">{session.averageDamage}</dd></div>
        <div><dt className="text-[10px] font-bold text-white/50">최고 순위</dt><dd className="text-sm font-black text-white">{session.bestRank ? `#${session.bestRank}` : "—"}</dd></div>
      </dl>
      {session.killsByMatch.length > 1 && (
        <div className="mt-3">
          <p className="text-[10px] font-bold text-white/50">경기별 킬 (왼쪽이 첫 경기)</p>
          <div className="mt-1 flex h-10 items-end gap-1" role="img" aria-label={`경기별 킬 ${session.killsByMatch.join(", ")}`}>
            {session.killsByMatch.map((kills, index) => (
              <div
                key={index}
                data-testid="session-kill-bar"
                className="flex-1 rounded-sm bg-[#F2A900]/70"
                style={{ height: `${Math.max(8, (kills / maxKills) * 100)}%` }}
                title={`${index + 1}번째 경기 ${kills}킬`}
              />
            ))}
          </div>
        </div>
      )}
      {session.teammates.length > 0 && (
        <p className="mt-3 border-t border-white/10 pt-3 text-[11px] text-white/60">
          함께한 팀원 · {session.teammates.map((row) => `${row.name}(${row.games}판)`).join(", ")}
        </p>
      )}
    </section>
  );
}
