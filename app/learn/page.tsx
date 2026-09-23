import type { Metadata } from "next";
import Link from "next/link";
import { ArrowUpRight, BookOpen, CalendarDays, MapPinned } from "lucide-react";
import { formatLessonTime, rankerLessons, rankerReplayHref } from "@/lib/learn/lessons";

export const metadata: Metadata = {
  title: "랭커의 한 판 | BGMS",
  description: "스팀 경쟁전 솔로와 스쿼드의 실제 착지, 자기장 이동, 교전을 지도에서 따라보세요.",
};

export default function LearnPage() {
  return (
    <main className="mx-auto max-w-5xl px-4 py-8 pb-28 text-zinc-100 sm:px-8">
      <p className="text-sm font-semibold text-emerald-300">실제 경기로 배우는 전술 · 샘플 2편</p>
      <h1 className="mt-3 text-3xl font-bold tracking-tight sm:text-4xl">랭커의 한 판</h1>
      <p className="mt-3 max-w-2xl text-sm leading-7 text-zinc-400">
        어디에 내렸고, 언제 이동했고, 교전은 어떻게 이어졌을까요?
        장면을 선택해 실제 지도와 해설을 함께 보세요.
      </p>
      <Link href="/learn/daily" className="mt-6 flex min-h-16 min-w-0 items-center gap-4 rounded-2xl border border-emerald-400/40 bg-emerald-400/10 p-4 hover:border-emerald-300 sm:p-5">
        <span className="grid size-11 shrink-0 place-items-center rounded-xl bg-emerald-300 text-zinc-950"><CalendarDays size={20} /></span>
        <span className="min-w-0 flex-1">
          <span className="block font-bold text-zinc-100">전날 우승 경기 분석</span>
          <span className="mt-1 block text-xs leading-5 text-zinc-400">매일 한 경기씩, 기록과 근거로 치킨을 만든 흐름을 읽어보세요.</span>
        </span>
        <ArrowUpRight size={18} className="shrink-0 text-emerald-300" />
      </Link>
      <div className="mt-8 grid gap-6 md:grid-cols-2">
        {rankerLessons.map((lesson) => (
          <article key={lesson.id} className="min-w-0 rounded-2xl border border-zinc-800 bg-zinc-900/50 p-5 sm:p-6">
            <p className="text-sm text-emerald-300">스팀 경쟁전 {lesson.gameMode === "solo" ? "솔로" : "스쿼드"} · {lesson.mapLabel} · TPP</p>
            <h2 className="mt-3 text-xl font-bold leading-8">{lesson.title}</h2>
            <p className="mt-3 break-all text-sm text-zinc-300">{lesson.nickname}</p>
            <p className="mt-1 text-xs leading-6 text-zinc-400">2026.09.22 경기 · 1위 · 개인 {lesson.kills}킬 · {lesson.damage.toLocaleString("ko-KR")} 대미지</p>
            <p className="text-xs leading-6 text-zinc-500">2026.09.23 조회한 AS 리더보드 {lesson.rank}위 · 모드별 순위 아님</p>
            <div className="mt-5 grid gap-2 sm:grid-cols-2">
              {lesson.id === "2026-09-22-solo" ? (
                <Link href={`/learn/${lesson.id}`} className="flex min-h-11 items-center justify-center gap-2 rounded-xl bg-emerald-300 px-4 py-3 text-sm font-bold text-zinc-950 hover:bg-emerald-200">
                  <BookOpen size={17} /> 1분 전술 브리핑
                </Link>
              ) : null}
              <Link href={rankerReplayHref(lesson)} prefetch={false} className="flex min-h-11 items-center justify-center gap-2 rounded-xl border border-zinc-700 px-4 py-3 text-sm font-semibold text-zinc-100 hover:border-emerald-400">
                <MapPinned size={17} /> 지도 리플레이
              </Link>
            </div>
            <ol className="mt-5 divide-y divide-zinc-800">
              {lesson.scenes.map((scene) => (
                <li key={scene.id}>
                  <Link href={lesson.id === "2026-09-22-solo" ? `/learn/${lesson.id}#${scene.id}` : rankerReplayHref(lesson, scene)} prefetch={false} className="flex min-h-12 items-center gap-3 py-3 text-sm text-zinc-300 hover:text-emerald-300">
                    <span className="shrink-0 font-mono text-xs text-zinc-500">{formatLessonTime(scene.anchorSeconds)}</span>
                    <span className="min-w-0 flex-1 break-keep">{scene.title}</span><ArrowUpRight size={15} className="shrink-0" />
                  </Link>
                </li>
              ))}
            </ol>
          </article>
        ))}
      </div>
      <p className="mt-6 text-xs leading-6 text-zinc-500">해설은 기록에서 확인한 사실과 해석의 한계를 구분합니다. 위치는 약 10초 간격으로 관측됐으며, 두 우승 사례만으로 특정 운영의 우월성을 판단하지 않습니다.</p>
    </main>
  );
}
