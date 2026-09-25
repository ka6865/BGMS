import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { ArrowLeft, ArrowUpRight, Clock3, Crosshair, Gauge } from "lucide-react";
import BriefingMapShell from "@/components/learn/BriefingMapShell";
import CombatTimeline from "@/components/learn/CombatTimeline";
import WinSummary from "@/components/learn/WinSummary";
import ZoneResponse from "@/components/learn/ZoneResponse";
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
  const isObservedWinner = lesson.placement === 1;
  const firstMappedScene = lesson.scenes.find((scene) => scene.mapSnapshot);

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
        {firstMappedScene && <a href={`#${firstMappedScene.id}-map`} className="mt-4 inline-flex min-h-11 items-center rounded-lg border border-emerald-700/70 bg-emerald-950/30 px-3 text-sm font-semibold text-emerald-200 hover:bg-emerald-900/40">첫 장면 지도 바로 보기 ↓</a>}
      </header>

      {lesson.winSummary && <WinSummary summary={lesson.winSummary} />}

      {!isSolo && (
        <section aria-labelledby="squad-summary-heading" className="mt-6 rounded-2xl border border-emerald-900/70 bg-emerald-950/20 p-4 sm:p-5">
          <p className="text-xs font-semibold uppercase tracking-[0.14em] text-emerald-300">경기 요약</p>
          <h2 id="squad-summary-heading" className="mt-1 text-xl font-bold">팀 {lesson.teamTotalKills}킬 · 개인 {lesson.kills}킬 우승 흐름</h2>
          <p className="mt-3 text-sm leading-6 text-zinc-300">{lesson.nickname}의 팀은 조지오폴 북서쪽에 내려 초반 교전을 치렀습니다. 팀원과 함께 세 상대를 쓰러뜨린 뒤 원 안쪽으로 이동했습니다. 이후 거의 같은 위치에서 Mk12로 먼 적 둘을 쓰러뜨리고 한 명을 처치했습니다. 마지막에는 팀원이 쓰러진 뒤 Mk12와 AUG 처치 기록을 남겨 우승했습니다.</p>
          <p className="mt-2 text-xs leading-5 text-zinc-400">초반 세 상대의 사망 기록에는 {lesson.nickname}가 마지막 타격자로 남아 있습니다. 실제 개인 킬은 그중 UMP45로 먼저 쓰러뜨린 한 명입니다.</p>
          {lesson.personalKills && <div className="mt-5">
            <h3 className="text-sm font-semibold text-zinc-200">분석 대상 개인 {lesson.personalKills.length}킬 · 사용 무기</h3>
            <ol className="mt-2 grid gap-2 sm:grid-cols-2">
              {lesson.personalKills.map((kill) => <li key={`${kill.timeSeconds}-${kill.victim}`} className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1 rounded-lg bg-zinc-900/70 px-3 py-2 text-xs leading-5 text-zinc-300">
                <time className="shrink-0 font-mono tabular-nums text-emerald-300">{formatLessonTime(kill.timeSeconds)}</time>
                <span className="min-w-0 break-all">{kill.victim}</span>
                <span className="font-semibold text-sky-200">{kill.weapon}</span>
              </li>)}
            </ol>
          </div>}
          <h3 className="mt-5 text-sm font-semibold text-zinc-200">주요 시점</h3>
          <ol className="mt-2 space-y-2">
            {lesson.scenes.map((scene) => (
              <li key={scene.id} className="grid min-w-0 grid-cols-[3rem_minmax(0,1fr)] gap-2 text-sm leading-6">
                <time className="font-mono tabular-nums text-emerald-300">{formatLessonTime(scene.anchorSeconds)}</time>
                <span className="min-w-0 break-words text-zinc-300">{scene.title}</span>
              </li>
            ))}
          </ol>
          <p className="mt-4 text-xs leading-5 text-zinc-500">개인 처치 무기는 원본 처치 기록으로 확인했습니다. 기절과 사망 사이의 모든 사격 장면, 보급 무기의 획득 경로와 팀원 간 소통은 확인되지 않습니다.</p>
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
                {scene.zoneAnalysis && <ZoneResponse analysis={scene.zoneAnalysis} />}
                {scene.combatEvents && <CombatTimeline events={scene.combatEvents} squad={!isSolo} />}
                <details className="mt-3 text-xs leading-6 text-zinc-500">
                  <summary className="min-h-11 cursor-pointer py-2 text-zinc-400">이 기록으로 알 수 없는 점</summary>
                  <p className="pb-2">{scene.limitation}</p>
                </details>
                <Link href={rankerReplayHref(lesson, scene)} prefetch={false} className="mt-2 inline-flex min-h-11 max-w-full flex-wrap items-center gap-2 rounded-lg border border-zinc-700 px-3 py-2 text-sm font-medium text-zinc-200 hover:border-emerald-400 hover:text-emerald-200">
                  장면 리플레이 보기 <span className="text-xs text-zinc-400">({formatLessonTime(scene.startSeconds)}부터)</span> <ArrowUpRight size={15} />
                </Link>
              </div>
              {scene.mapSnapshot && (
                <figure id={`${scene.id}-map`} className="min-w-0 scroll-mt-20">
                  <BriefingMapShell snapshot={scene.mapSnapshot} mapId={lesson.mapId} />
                  <figcaption className="mt-2 text-xs leading-5 text-zinc-500">{scene.mapSnapshot.path.some((point) => point.x !== scene.mapSnapshot?.path[0].x || point.y !== scene.mapSnapshot?.path[0].y) ? "초록 원에서 보라 원으로 위치 표본을 시간순으로 이었습니다. 긴 구간의 화살표는 관측 순서이며 점선은 실제 주행·보행 경로가 아닙니다." : "기록된 한 지점의 위치를 표시했습니다."} 빨간 점은 상대의 사망 위치입니다.</figcaption>
                  {(scene.mapSnapshot.marks?.length || scene.mapSnapshot.kills?.some((kill) => kill.label)) && (
                    <div className="mt-3 rounded-lg border border-zinc-800 bg-zinc-900/50 p-3 text-xs leading-5 text-zinc-300">
                      <p className="font-semibold text-zinc-200">지도 속 인물과 기록</p>
                      <ul className="mt-2 space-y-1.5">
                        {scene.mapSnapshot.marks?.map((mark, markIndex) => (
                          <li key={`${mark.label}-${markIndex}`} className="flex items-start gap-2"><span className={`mt-1.5 size-2 shrink-0 rounded-full ${mark.kind === "teammate" ? "bg-cyan-400" : mark.kind === "throw" ? "bg-orange-400" : "bg-blue-400"}`} /><span>{mark.kind === "teammate" ? "우리 팀" : mark.kind === "throw" ? "투척" : "상대"} · {mark.label}</span></li>
                        ))}
                        {scene.mapSnapshot.kills?.filter((kill) => kill.label).map((kill, killIndex) => (
                          <li key={`${kill.label}-${killIndex}`} className="flex items-start gap-2"><span className="mt-1.5 size-2 shrink-0 rounded-full bg-rose-400" /><span>사망한 상대 · {kill.label}</span></li>
                        ))}
                      </ul>
                    </div>
                  )}
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
