import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { ArrowLeft, ArrowUpRight, Clock3, Crosshair, Gauge } from "lucide-react";
import BriefingMapShell from "@/components/learn/BriefingMapShell";
import CombatTimeline from "@/components/learn/CombatTimeline";
import WinSummary from "@/components/learn/WinSummary";
import { formatLessonTime, getRankerLesson, rankerLessons, rankerReplayHref } from "@/lib/learn/lessons";

type LessonPageProps = { params: Promise<{ lessonId: string }> };

export function generateStaticParams() {
  return rankerLessons.map((lesson) => ({ lessonId: lesson.id }));
}

export async function generateMetadata({ params }: LessonPageProps): Promise<Metadata> {
  const { lessonId } = await params;
  const lesson = getRankerLesson(lessonId);
  return lesson ? {
    title: `${lesson.title} | 경기 장면 해설 | BGMS`,
    description: `스팀 경쟁전 ${lesson.mapLabel} ${lesson.gameMode === "solo" ? "솔로" : "스쿼드"} 경기의 기록된 장면과 해설을 살펴봅니다.`,
  } : { title: "전술 브리핑 | BGMS" };
}

export default async function RankerBriefingPage({ params }: LessonPageProps) {
  const { lessonId } = await params;
  const lesson = getRankerLesson(lessonId);
  if (!lesson) notFound();
  const isSolo = lesson.gameMode === "solo";
  const isObservedWinner = lesson.winSummary !== undefined || lesson.scenes.some(({ fact }) => fact.includes("팀은 1위"));

  return (
    <main className="mx-auto max-w-4xl px-4 py-6 pb-28 text-zinc-100 sm:px-8 sm:py-10">
      <Link href="/learn" className="inline-flex min-h-11 items-center gap-2 text-sm font-medium text-emerald-300 hover:text-emerald-200">
        <ArrowLeft size={17} /> 경기 목록
      </Link>

      <header className="mt-5 border-b border-zinc-800 pb-7">
        <p className="text-sm font-semibold text-emerald-300">경기 해설 · 스팀 경쟁전 {isSolo ? "솔로" : "스쿼드"}</p>
        <h1 className="mt-2 text-3xl font-bold leading-tight tracking-tight sm:text-4xl">{lesson.title}</h1>
        <p className="mt-3 text-sm text-zinc-400">{lesson.nickname} · {lesson.mapLabel} · 2026.09.22 경기</p>
        <div className="mt-5 flex flex-wrap gap-x-5 gap-y-2 text-sm text-zinc-300">
          <span className="inline-flex items-center gap-2"><Crosshair size={16} className="text-emerald-300" />개인 {lesson.kills}킬{lesson.winSummary ? " · 우승" : isObservedWinner ? " · 팀 1위" : ""}</span>
          {lesson.teamTotalKills !== undefined && <span className="inline-flex items-center gap-2"><Crosshair size={16} className="text-sky-300" />팀 합계 {lesson.teamTotalKills}킬</span>}
          <span className="inline-flex items-center gap-2"><Gauge size={16} className="text-emerald-300" />{lesson.damage.toLocaleString("ko-KR")} 대미지</span>
          <span className="inline-flex items-center gap-2"><Clock3 size={16} className="text-emerald-300" />{Math.round(lesson.durationSeconds / 60)}분 경기</span>
        </div>
        {!lesson.winSummary && lesson.briefing ? (
          <p className="mt-4 max-w-3xl text-sm leading-7 text-zinc-300">{lesson.briefing}</p>
        ) : null}
        <p className="mt-2 text-xs leading-5 text-zinc-500">2026.09.23 조회한 AS 리더보드 {lesson.rank}위 · 모드별 순위 아님</p>
      </header>

      {lesson.winSummary && <WinSummary summary={lesson.winSummary} />}

      {!isSolo && (
        <section aria-labelledby="squad-summary-heading" className="mt-6 rounded-2xl border border-emerald-900/70 bg-emerald-950/20 p-4 sm:p-5">
          <p className="text-xs font-semibold uppercase tracking-[0.14em] text-emerald-300">경기 요약</p>
          <h2 id="squad-summary-heading" className="mt-1 text-xl font-bold">팀 {lesson.teamTotalKills}킬 우승 흐름</h2>
          <p className="mt-3 text-sm leading-6 text-zinc-300">{lesson.nickname}의 개인 기록은 {lesson.kills}킬입니다. 초반 착지 교전 뒤 원으로 이동했고, 팀원이 소생한 뒤 마지막 두 상대를 Mk12와 AUG로 처치하며 팀이 우승했습니다.</p>
          <h3 className="mt-5 text-sm font-semibold text-zinc-200">주요 시점</h3>
          <ol className="mt-2 space-y-2">
            {lesson.scenes.map((scene) => (
              <li key={scene.id} className="grid min-w-0 grid-cols-[3rem_minmax(0,1fr)] gap-2 text-sm leading-6">
                <time className="font-mono tabular-nums text-emerald-300">{formatLessonTime(scene.anchorSeconds)}</time>
                <span className="min-w-0 break-words text-zinc-300">{scene.title}</span>
              </li>
            ))}
          </ol>
          <p className="mt-4 text-xs leading-5 text-zinc-500">마지막 두 처치의 무기는 확인됐습니다. 다른 처치의 무기와 보급 경로는 이 요약만으로 확정하지 않습니다.</p>
        </section>
      )}

      <nav aria-label="장면 바로가기" className="mt-6 rounded-2xl border border-zinc-800 bg-zinc-900/40 p-4 sm:p-5">
        <h2 className="text-sm font-bold text-zinc-100">장면 바로가기</h2>
        <ol className="mt-3 grid grid-cols-2 gap-2 sm:grid-cols-3">
          {lesson.scenes.map((scene, index) => (
            <li key={scene.id} className="min-w-0">
              <a href={`#${scene.id}`} className="flex h-full min-h-14 min-w-0 items-start gap-2 rounded-lg border border-zinc-800 px-2.5 py-2 text-xs text-zinc-300 hover:border-emerald-500/60 hover:text-emerald-200 sm:px-3">
                <span className="shrink-0 font-mono tabular-nums text-zinc-500">{formatLessonTime(scene.anchorSeconds)}</span>
                <span className="min-w-0 break-words">{String(index + 1).padStart(2, "0")} · {scene.title}</span>
              </a>
            </li>
          ))}
        </ol>
      </nav>

      <section aria-labelledby="match-flow-heading" className="pt-7">
        <div className="mb-5 flex flex-wrap items-end justify-between gap-2">
          <div>
            <p className="text-xs font-semibold uppercase tracking-[0.16em] text-emerald-300">경기 흐름</p>
            <h2 id="match-flow-heading" className="mt-1 text-xl font-bold">장면별로 읽기</h2>
          </div>
          <p className="text-xs text-zinc-500">기록한 위치와 원을 정지 지도로 볼 수 있어요</p>
        </div>

        <ol className="divide-y divide-zinc-800">
          {lesson.scenes.map((scene, index) => (
            <li key={scene.id} id={scene.id} className="grid scroll-mt-24 gap-4 py-6 sm:grid-cols-[minmax(0,1fr)_minmax(240px,0.88fr)] sm:gap-6 sm:py-8">
              <div className="min-w-0">
                <p className="text-xs font-semibold text-emerald-300">{String(index + 1).padStart(2, "0")} · {formatLessonTime(scene.anchorSeconds)}</p>
                <h3 className="mt-1 text-lg font-bold leading-7">{scene.title}</h3>
                <p className="mt-3 text-xs font-semibold text-zinc-500">기록에서 확인되는 점</p>
                <p className="mt-3 text-sm leading-7 text-zinc-300">{scene.fact}</p>
                {scene.context && <div className="mt-3 border-l-2 border-sky-500/70 pl-3"><p className="text-xs font-semibold text-sky-200">당시 상황</p><p className="mt-1 text-sm leading-6 text-zinc-300">{scene.context}</p></div>}
                {scene.combatEvents && <CombatTimeline events={scene.combatEvents} />}
                <details className="mt-3 text-xs leading-6 text-zinc-500">
                  <summary className="min-h-11 cursor-pointer py-2 text-zinc-400">이 기록으로 알 수 없는 점</summary>
                  <p className="pb-2">{scene.limitation}</p>
                </details>
                <Link href={rankerReplayHref(lesson, scene)} prefetch={false} className="mt-2 inline-flex min-h-11 max-w-full flex-wrap items-center gap-2 rounded-lg border border-zinc-700 px-3 py-2 text-sm font-medium text-zinc-200 hover:border-emerald-400 hover:text-emerald-200">
                  장면 리플레이 보기 <span className="text-xs text-zinc-400">({formatLessonTime(scene.startSeconds)}부터)</span> <ArrowUpRight size={15} />
                </Link>
              </div>
              {scene.mapSnapshot && (
                <figure className="min-w-0">
                  <BriefingMapShell snapshot={scene.mapSnapshot} mapId={lesson.mapId} />
                  <figcaption className="mt-2 text-xs leading-5 text-zinc-500">기록된 위치를 표시했습니다. 점선은 위치 표본을 이은 선이며 실제 이동 경로를 뜻하지 않습니다. 빨간 점은 처치된 상대의 위치입니다.</figcaption>
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
