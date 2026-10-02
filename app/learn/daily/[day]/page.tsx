import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { ArrowLeft, ArrowUpRight, CalendarDays } from "lucide-react";
import { listDailyRankerStoriesForDay } from "@/lib/learn/dailyStories";

export const dynamic = "force-dynamic";
type Props = { params: Promise<{ day: string }> };
function formatDate(value: string) {
  const [year, month, day] = value.split("-");
  return `${year}.${month}.${day}`;
}

export default async function DailyDayPage({ params }: Props) {
  const { day } = await params;
  const stories = await listDailyRankerStoriesForDay(day);
  if (stories.length === 0) notFound();
  if (stories.length === 1) redirect(`/learn/daily/${day}/${stories[0].mode}`);

  return <main className="mx-auto max-w-4xl px-4 py-6 pb-28 text-zinc-100 sm:px-8 sm:py-10">
    <Link href="/learn/daily" className="inline-flex min-h-11 items-center gap-2 text-sm text-emerald-300"><ArrowLeft size={17} /> 날짜·모드별 경기 목록</Link>
    <header className="mt-5 border-b border-zinc-800 pb-6">
      <p className="inline-flex items-center gap-2 text-sm font-semibold text-emerald-300"><CalendarDays size={15} />{formatDate(day)} 경기 (한국 시간)</p>
      <h1 className="mt-2 text-2xl font-bold">살펴볼 경기 모드를 선택하세요</h1>
    </header>
    <ul className="mt-5 divide-y divide-zinc-800 rounded-xl border border-zinc-800 px-4">
      {stories.map((story) => <li key={`${story.dayKst}-${story.mode}`}>
        <Link href={`/learn/daily/${story.dayKst}/${story.mode}`} className="flex min-h-16 min-w-0 items-center gap-3 py-3">
          <span className="w-16 shrink-0 text-xs font-semibold text-emerald-300">{story.mode === "solo" ? "솔로" : story.mode === "duo" ? "듀오" : "스쿼드"}</span>
          <span className="min-w-0 flex-1"><span className="block break-words text-sm font-bold">{story.headline}</span><span className="mt-1 block text-xs text-zinc-400">{story.mapName} · {story.nickname}</span></span>
          <ArrowUpRight size={16} className="shrink-0 text-emerald-300" />
        </Link>
      </li>)}
    </ul>
  </main>;
}
