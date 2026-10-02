import type { Metadata } from "next";
import Link from "next/link";
import { ArrowUpRight } from "lucide-react";
import { listDailyRankerStories, listDailyRankerStoriesForDay } from "@/lib/learn/dailyStories";
import { ArchivedDailyStories, DailyModeCards, getKstYesterday } from "@/components/learn/DailyStoryList";

export const metadata: Metadata = {
  title: "랭커의 한 판 | BGMS",
  description: "스팀 경쟁전 듀오·스쿼드 우승 경기를 지도와 해설로 살펴보고, 공개된 솔로 경기는 이력에서 찾아보세요.",
};
export const dynamic = "force-dynamic";

export default async function LearnPage() {
  const yesterday = getKstYesterday();
  const [dailyStories, archive] = await Promise.all([
    listDailyRankerStoriesForDay(yesterday),
    listDailyRankerStories(100),
  ]);
  return (
    <main className="mx-auto max-w-5xl px-4 py-8 pb-28 text-zinc-100 sm:px-8">
      <p className="text-sm font-semibold text-emerald-300">실제 경기로 배우는 전술</p>
      <h1 className="mt-3 text-3xl font-bold tracking-tight sm:text-4xl">랭커의 한 판</h1>
      <p className="mt-3 max-w-2xl text-sm leading-7 text-zinc-400">
        전날 공개된 듀오·스쿼드 우승 경기를 골라보세요. 공개된 솔로 경기는 지난 경기에서 확인할 수 있습니다.
      </p>
      <DailyModeCards day={yesterday} stories={dailyStories} />
      <ArchivedDailyStories stories={archive} currentDay={yesterday} />
      <Link href="/learn/daily" className="mt-4 inline-flex min-h-11 items-center gap-2 text-sm font-semibold text-emerald-300">날짜·모드별 경기 목록 보기 <ArrowUpRight size={15} /></Link>
    </main>
  );
}
