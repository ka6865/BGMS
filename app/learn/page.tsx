import type { Metadata } from "next";
import Link from "next/link";
import { ArrowUpRight } from "lucide-react";
import { listDailyRankerStories, listDailyRankerStoriesForDay } from "@/lib/learn/dailyStories";
import { ArchivedDailyStories, DailyModeCards, getKstYesterday, pickFeaturedDay } from "@/components/learn/DailyStoryList";

export const metadata: Metadata = {
  title: "랭커의 한 판",
  description: "스팀 경쟁전 듀오·스쿼드 우승 경기를 지도와 장면 해설로 살펴보세요.",
};
export const dynamic = "force-dynamic";

export default async function LearnPage() {
  const yesterday = getKstYesterday();
  const [dailyStories, archive] = await Promise.all([
    listDailyRankerStoriesForDay(yesterday),
    listDailyRankerStories(100),
  ]);
  const featured = pickFeaturedDay(yesterday, dailyStories, archive);
  return (
    <main className="mx-auto max-w-5xl px-4 py-8 pb-28 text-zinc-100 sm:px-8">
      <p className="text-sm font-semibold text-emerald-300">실제 경기로 배우는 전술</p>
      <h1 className="mt-3 text-3xl font-bold tracking-tight sm:text-4xl">랭커의 한 판</h1>
      <p className="mt-3 max-w-2xl text-sm leading-7 text-zinc-400">
        전날 스팀 경쟁전 듀오·스쿼드 우승 경기를 골라보세요. 경쟁전에는 솔로 큐가 없어 듀오·스쿼드만 다룹니다.
      </p>
      <DailyModeCards day={featured.day} stories={featured.stories} isYesterday={featured.day === yesterday} />
      <ArchivedDailyStories stories={archive} currentDay={featured.day} />
      <Link href="/learn/daily" className="mt-4 inline-flex min-h-11 items-center gap-2 text-sm font-semibold text-emerald-300">날짜·모드별 경기 목록 보기 <ArrowUpRight size={15} /></Link>
    </main>
  );
}
