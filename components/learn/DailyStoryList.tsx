import Link from "next/link";
import { ArrowUpRight, CalendarDays, Trophy } from "lucide-react";
import type { DailyMode, DailyStorySummary } from "@/lib/learn/dailyStories";

const MODES: { id: DailyMode; name: string; team: string }[] = [
  { id: "duo", name: "듀오", team: "2인 팀" },
  { id: "squad", name: "스쿼드", team: "4인 팀" },
];

export function getKstYesterday(now = new Date()) {
  const today = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Seoul", year: "numeric", month: "2-digit", day: "2-digit" }).format(now);
  const previous = new Date(`${today}T00:00:00Z`);
  previous.setUTCDate(previous.getUTCDate() - 1);
  return previous.toISOString().slice(0, 10);
}

function formatDate(day: string) {
  const [year, month, date] = day.split("-");
  return `${year}.${month}.${date}`;
}

export function formatObservedAt(value: string) {
  return new Intl.DateTimeFormat("ko-KR", {
    timeZone: "Asia/Seoul", year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", hour12: false,
  }).format(new Date(value));
}

function RankDetails({ story }: { story: DailyStorySummary }) {
  return <span className="inline-flex items-center gap-1"><Trophy size={13} className="text-amber-300" />AS {story.leaderboardRank}위
    {story.leaderboardObservedAt ? ` · ${formatObservedAt(story.leaderboardObservedAt)} 조회` : " · 조회 날짜 기록 없음"}</span>;
}

export function DailyModeCards({ day, stories }: { day: string; stories: DailyStorySummary[] }) {
  return <section aria-labelledby="yesterday-heading" className="mt-7">
    <div className="flex flex-wrap items-end justify-between gap-2 border-b border-zinc-800 pb-3">
      <div><p className="text-xs font-semibold text-emerald-300">전날 경기일 · 한국 시간</p><h2 id="yesterday-heading" className="mt-1 text-xl font-bold">{formatDate(day)} 모드별 우승 경기</h2></div>
    </div>
    <div className="mt-4 grid gap-3 md:grid-cols-2">
      {MODES.map((mode) => {
        const story = stories.find((item) => item.mode === mode.id);
        return <article key={`${day}-${mode.id}`} className="flex min-w-0 flex-col rounded-xl border border-zinc-800 bg-zinc-900/40 p-4 sm:p-5">
          <p className="text-xs font-semibold text-emerald-300">{mode.name} · {mode.team}</p>
          {story ? <>
            <h3 className="mt-2 break-words text-lg font-bold leading-6">{story.headline}</h3>
            <p className="mt-2 text-xs leading-5 text-zinc-400">{story.mapName} · {story.nickname}</p>
            <p className="mt-1 text-xs leading-5 text-zinc-400"><RankDetails story={story} /></p>
            <p className="mt-1 text-xs leading-5 text-zinc-500">착지부터 우승까지</p>
            <Link href={`/learn/daily/${day}/${mode.id}`} className="mt-4 inline-flex min-h-11 items-center justify-center gap-2 rounded-lg bg-emerald-300 px-3 text-sm font-bold text-zinc-950 hover:bg-emerald-200">{mode.name} 경기 해설 보기 <ArrowUpRight size={15} /></Link>
          </> : <div className="mt-3 flex flex-1 items-center rounded-lg bg-zinc-950/50 px-3 py-4 text-sm leading-6 text-zinc-400">새 경기 해설이 공개되면 여기서 볼 수 있어요.</div>}
        </article>;
      })}
    </div>
  </section>;
}

export function ArchivedDailyStories({ stories, currentDay }: { stories: DailyStorySummary[]; currentDay: string }) {
  const prior = stories.filter((story) => story.dayKst < currentDay || story.mode === "solo" && story.dayKst === currentDay)
    .sort((a, b) => b.dayKst.localeCompare(a.dayKst) || a.mode.localeCompare(b.mode));
  if (!prior.length) return null;
  const groups = [...new Set(prior.map((story) => story.dayKst))];
  return <section className="mt-9" aria-labelledby="archive-heading">
    <h2 id="archive-heading" className="text-lg font-bold">공개된 지난 경기</h2>
    <ul className="mt-3 divide-y divide-zinc-800 rounded-xl border border-zinc-800 px-4">
      {groups.map((day) => <li key={day} className="py-3">
        <p className="mb-2 inline-flex items-center gap-2 text-xs font-semibold text-zinc-400"><CalendarDays size={14} />{formatDate(day)} 경기</p>
        <ul className="flex flex-wrap gap-2">{prior.filter((story) => story.dayKst === day).map((story) => <li key={`${story.dayKst}-${story.mode}`}>
          <Link href={`/learn/daily/${story.dayKst}/${story.mode}`} className="inline-flex min-h-11 max-w-full items-center gap-2 rounded-lg border border-zinc-700 px-3 text-left text-sm text-zinc-200 hover:border-emerald-400"><span className="shrink-0">{story.mode === "solo" ? "솔로" : story.mode === "duo" ? "듀오" : "스쿼드"}</span><span className="max-w-56 truncate text-zinc-400">{story.headline}</span><ArrowUpRight size={14} className="shrink-0 text-emerald-300" /></Link>
        </li>)}</ul>
      </li>)}
    </ul>
  </section>;
}
