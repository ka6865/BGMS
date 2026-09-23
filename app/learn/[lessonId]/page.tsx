import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { ArrowLeft, ArrowUpRight, Clock3, Crosshair, Gauge } from "lucide-react";
import BriefingMap from "@/components/learn/BriefingMap";
import CombatTimeline from "@/components/learn/CombatTimeline";
import WinSummary from "@/components/learn/WinSummary";
import { formatLessonTime, getRankerLesson, rankerLessons, rankerReplayHref } from "@/lib/learn/lessons";

type LessonPageProps = { params: Promise<{ lessonId: string }> };

export function generateStaticParams() {
  return rankerLessons.filter((lesson) => lesson.id === "2026-09-22-solo").map((lesson) => ({ lessonId: lesson.id }));
}

export async function generateMetadata({ params }: LessonPageProps): Promise<Metadata> {
  const { lessonId } = await params;
  const lesson = getRankerLesson(lessonId);
  return lesson ? {
    title: `${lesson.title} | 1분 전술 브리핑 | BGMS`,
    description: `스팀 경쟁전 ${lesson.mapLabel} 솔로 우승 경기의 착지, 자기장 이동, 교전을 1분 브리핑으로 살펴봅니다.`,
  } : { title: "전술 브리핑 | BGMS" };
}

export default async function RankerBriefingPage({ params }: LessonPageProps) {
  const { lessonId } = await params;
  const lesson = getRankerLesson(lessonId);
  if (!lesson || lesson.id !== "2026-09-22-solo") notFound();

  return (
    <main className="mx-auto max-w-4xl px-4 py-6 pb-28 text-zinc-100 sm:px-8 sm:py-10">
      <Link href="/learn" className="inline-flex min-h-11 items-center gap-2 text-sm font-medium text-emerald-300 hover:text-emerald-200">
        <ArrowLeft size={17} /> 경기 목록
      </Link>

      <header className="mt-5 border-b border-zinc-800 pb-7">
        <p className="text-sm font-semibold text-emerald-300">1분 전술 브리핑 · 스팀 경쟁전 솔로</p>
        <h1 className="mt-2 text-3xl font-bold leading-tight tracking-tight sm:text-4xl">{lesson.title}</h1>
        <p className="mt-3 text-sm text-zinc-400">{lesson.nickname} · {lesson.mapLabel} · 2026.09.22 경기</p>
        <div className="mt-5 flex flex-wrap gap-x-5 gap-y-2 text-sm text-zinc-300">
          <span className="inline-flex items-center gap-2"><Crosshair size={16} className="text-emerald-300" />1위 · {lesson.kills}킬</span>
          <span className="inline-flex items-center gap-2"><Gauge size={16} className="text-emerald-300" />{lesson.damage.toLocaleString("ko-KR")} 대미지</span>
          <span className="inline-flex items-center gap-2"><Clock3 size={16} className="text-emerald-300" />{Math.round(lesson.durationSeconds / 60)}분 경기</span>
        </div>
        {!lesson.winSummary && lesson.briefing ? (
          <p className="mt-4 max-w-3xl text-sm leading-7 text-zinc-300">{lesson.briefing}</p>
        ) : null}
        <p className="mt-2 text-xs leading-5 text-zinc-500">2026.09.23 조회한 AS 리더보드 {lesson.rank}위 · 모드별 순위 아님</p>
      </header>

      {lesson.winSummary && <WinSummary summary={lesson.winSummary} />}

      <section aria-labelledby="match-flow-heading" className="pt-7">
        <div className="mb-5 flex flex-wrap items-end justify-between gap-2">
          <div>
            <p className="text-xs font-semibold uppercase tracking-[0.16em] text-emerald-300">경기 흐름</p>
            <h2 id="match-flow-heading" className="mt-1 text-xl font-bold">장면별로 읽기</h2>
          </div>
          <p className="text-xs text-zinc-500">재생 없이 정지 지도로 볼 수 있어요</p>
        </div>

        <ol className="divide-y divide-zinc-800">
          {lesson.scenes.map((scene, index) => (
            <li key={scene.id} id={scene.id} className="grid scroll-mt-24 gap-4 py-6 sm:grid-cols-[minmax(0,1fr)_minmax(240px,0.88fr)] sm:gap-6 sm:py-8">
              <div className="min-w-0">
                <p className="text-xs font-semibold text-emerald-300">{String(index + 1).padStart(2, "0")} · {formatLessonTime(scene.anchorSeconds)}</p>
                <h3 className="mt-1 text-lg font-bold leading-7">{scene.title}</h3>
                <p className="mt-3 text-sm leading-7 text-zinc-300">{scene.fact}</p>
                {scene.combatEvents && <CombatTimeline events={scene.combatEvents} />}
                <details className="mt-3 text-xs leading-6 text-zinc-500">
                  <summary className="min-h-11 cursor-pointer py-2 text-zinc-400">이 기록으로 알 수 없는 점</summary>
                  <p className="pb-2">{scene.limitation}</p>
                </details>
                <Link href={rankerReplayHref(lesson, scene)} prefetch={false} className="mt-2 inline-flex min-h-11 items-center gap-2 rounded-lg border border-zinc-700 px-3 text-sm font-medium text-zinc-200 hover:border-emerald-400 hover:text-emerald-200">
                  이 장면 리플레이 보기 <ArrowUpRight size={15} />
                </Link>
              </div>
              {scene.mapSnapshot && (
                <figure className="min-w-0">
                  <BriefingMap snapshot={scene.mapSnapshot} mapId={lesson.mapId} />
                  <figcaption className="mt-2 text-xs leading-5 text-zinc-500">보관 기록에서 관측한 위치와 원을 표시했습니다. 원형 표식은 처치 이벤트 위치입니다.</figcaption>
                </figure>
              )}
            </li>
          ))}
        </ol>
      </section>

      <p className="mt-4 rounded-xl border border-zinc-800 bg-zinc-900/60 p-4 text-xs leading-6 text-zinc-400">
        위치는 대체로 10초 간격 관측값입니다. 원 안으로 들어간 정확한 경로와 선수의 의도는 기록만으로 확정할 수 없습니다. 이 한 경기만으로 특정 운영 방식의 우월성을 판단하지 않습니다.
      </p>
      <Link href={rankerReplayHref(lesson)} prefetch={false} className="mt-5 flex min-h-12 items-center justify-center gap-2 rounded-xl bg-emerald-300 px-4 py-3 text-sm font-bold text-zinc-950 hover:bg-emerald-200">
        전체 지도 리플레이 열기 <ArrowUpRight size={16} />
      </Link>
    </main>
  );
}
