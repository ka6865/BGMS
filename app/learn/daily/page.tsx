import type { Metadata } from "next";
import Link from "next/link";
import { ArrowLeft } from "lucide-react";
import { listDailyRankerStories, listDailyRankerStoriesForDay } from "@/lib/learn/dailyStories";
import { ArchivedDailyStories, DailyModeCards, getKstYesterday } from "@/components/learn/DailyStoryList";

export const metadata: Metadata = {
  title: "날짜·모드별 우승 경기 | BGMS",
  description: "듀오·스쿼드 우승 경기를 날짜별로 살펴보고, 공개된 솔로 경기는 지난 경기에서 찾아보세요.",
};
export const dynamic = "force-dynamic";

export default async function DailyRankerStoriesPage() {
  const yesterday = getKstYesterday();
  const [stories, archive] = await Promise.all([
    listDailyRankerStoriesForDay(yesterday),
    listDailyRankerStories(100),
  ]);

  return <main className="mx-auto max-w-5xl px-4 py-6 pb-28 text-zinc-100 sm:px-8 sm:py-10">
    <Link href="/learn" className="inline-flex min-h-11 items-center gap-2 text-sm font-medium text-emerald-300"><ArrowLeft size={17} /> 랭커의 한 판으로 돌아가기</Link>
    <header className="mt-5 border-b border-zinc-800 pb-7">
      <p className="text-sm font-semibold text-emerald-300">날짜·모드별 공개 경기</p>
      <h1 className="mt-2 text-3xl font-bold tracking-tight sm:text-4xl">날짜·모드별 우승 경기</h1>
      <p className="mt-3 max-w-2xl text-sm leading-7 text-zinc-400">전날 공개된 듀오·스쿼드 경기를 확인하고, 공개된 솔로 경기를 포함한 지난 경기는 아래에서 날짜별로 골라보세요.</p>
    </header>
    <DailyModeCards day={yesterday} stories={stories} />
    <ArchivedDailyStories stories={archive} currentDay={yesterday} />
  </main>;
}
