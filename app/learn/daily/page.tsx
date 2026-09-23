import type { Metadata } from "next";
import Link from "next/link";
import { ArrowLeft, ArrowUpRight, CalendarDays, Trophy } from "lucide-react";
import { listDailyRankerStories } from "@/lib/learn/dailyStories";

export const metadata: Metadata = {
  title: "전날 우승 경기 분석 | BGMS",
  description: "매일 한 경기씩, 전날 우승한 플레이어의 경기 흐름을 확인된 기록과 근거로 살펴봅니다.",
};

export const dynamic = "force-dynamic";

function formatDate(date: string) {
  const [year, month, day] = date.split("-");
  return year && month && day ? `${year}.${month}.${day}` : date;
}

export default async function DailyRankerStoriesPage() {
  const stories = await listDailyRankerStories();

  return (
    <main className="mx-auto max-w-4xl px-4 py-6 pb-28 text-zinc-100 sm:px-8 sm:py-10">
      <Link href="/learn" className="inline-flex min-h-11 items-center gap-2 text-sm font-medium text-emerald-300 hover:text-emerald-200">
        <ArrowLeft size={17} /> 랭커의 한 판
      </Link>
      <header className="mt-5 border-b border-zinc-800 pb-7">
        <p className="text-sm font-semibold text-emerald-300">매일 한 경기 · 전날의 치킨</p>
        <h1 className="mt-2 text-3xl font-bold tracking-tight sm:text-4xl">전날 우승 경기 분석</h1>
        <p className="mt-3 max-w-2xl text-sm leading-7 text-zinc-400">우승 경기에서 어떤 사건이 기록됐는지 경기별로 정리합니다. 분석 결론에는 확인에 사용한 기록을 연결해 두었습니다.</p>
      </header>

      {stories.length === 0 ? (
        <section className="mt-8 rounded-2xl border border-zinc-800 bg-zinc-900/50 p-6 sm:p-8" aria-labelledby="empty-heading">
          <CalendarDays size={24} className="text-emerald-300" />
          <h2 id="empty-heading" className="mt-4 text-lg font-bold">아직 공개된 경기가 없습니다</h2>
          <p className="mt-2 text-sm leading-7 text-zinc-400">새 분석이 공개되면 이곳에서 전날 우승 경기를 확인할 수 있어요.</p>
        </section>
      ) : (
        <ol className="mt-6 space-y-4">
          {stories.map((story) => (
            <li key={story.dayKst}>
              <Link href={`/learn/daily/${story.dayKst}`} className="block min-w-0 rounded-2xl border border-zinc-800 bg-zinc-900/50 p-5 transition hover:border-emerald-400/60 sm:p-6">
                <div className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-2 text-xs text-zinc-400">
                  <span className="inline-flex items-center gap-1.5 font-semibold text-emerald-300"><CalendarDays size={14} /> {formatDate(story.dayKst)} 경기 (KST)</span>
                </div>
                <h2 className="mt-3 break-words text-xl font-bold leading-7">{story.headline}</h2>
                <p className="mt-2 line-clamp-3 break-words text-sm leading-7 text-zinc-300">{story.conclusion}</p>
                <div className="mt-4 flex min-w-0 flex-wrap gap-x-4 gap-y-2 text-xs text-zinc-400">
                  <span className="break-all">{story.nickname}</span>
                  <span>{story.mode === "solo" ? "솔로" : "스쿼드"} · {story.mapName}</span>
                  <span className="inline-flex items-center gap-1"><Trophy size={13} className="text-amber-300" /> AS 리더보드 {story.leaderboardRank}위</span>
                  <span>{story.kills}킬 · {story.damage.toLocaleString("ko-KR")} 대미지</span>
                </div>
                <p className="mt-3 text-xs leading-5 text-zinc-500">AS 리더보드 조회 순위이며, 모드별 순위로 확인된 값은 아닙니다.</p>
                <span className="mt-4 inline-flex min-h-10 items-center gap-2 text-sm font-semibold text-emerald-300">분석과 근거 보기 <ArrowUpRight size={16} /></span>
              </Link>
            </li>
          ))}
        </ol>
      )}
    </main>
  );
}
