"use client";

import { useState } from "react";
import { ArrowLeft, ArrowRight, MapPin } from "lucide-react";
import type { DailyScene } from "@/lib/learn/dailyScenes";
import type { DailyWalkthroughChapter } from "@/lib/learn/dailyWalkthrough";
import { formatLessonTime } from "@/lib/learn/lessons";
import BriefingMapShell from "./BriefingMapShell";

const SCENE_KIND: Record<DailyScene["kind"], string> = {
  opening: "시작", movement: "이동", combat: "교전", recovery: "회복·복귀", finish: "마지막",
};
type SceneSnapshot = NonNullable<DailyScene["mapSnapshot"]> & { blueZone?: {
  observedSeconds: number; status: "waiting" | "shrinking" | "complete" | "unknown"; countdownSeconds?: number;
} };

export default function DailySceneViewer({ scenes: chapters, highlights, combatScenes, mapId, overview }: { scenes: DailyWalkthroughChapter[]; highlights?: DailyWalkthroughChapter[]; combatScenes?: DailyWalkthroughChapter[]; mapId: string; overview?: DailyScene["mapSnapshot"] }) {
  const [view, setView] = useState<"highlights" | "all" | "combat">(highlights?.length ? "highlights" : "all");
  const hasHighlights = Boolean(highlights?.length);
  const hasCombat = Boolean(combatScenes?.length);
  const showingHighlights = hasHighlights && view === "highlights";
  const showingCombat = hasCombat && view === "combat";
  const scenes = showingCombat ? combatScenes! : showingHighlights ? highlights! : chapters;
  const [index, setIndex] = useState(0);
  const [showOverview, setShowOverview] = useState(false);
  const scene = scenes[index];
  const operatingPoint = scene?.operatingPoint;
  const select = (next: number) => { setIndex(Math.max(0, Math.min(scenes.length - 1, next))); setShowOverview(false); };

  if (!scene) return <p className="rounded-xl border border-zinc-800 p-5 text-sm text-zinc-400">공개된 장면이 없습니다.</p>;
  const movement = scene.movement;
  const rawSnapshot = (showOverview ? overview : scene.mapSnapshot) as SceneSnapshot | undefined;
  const selectedSnapshot = showOverview && rawSnapshot?.blueZone ? { ...rawSnapshot, blueZone: undefined } : rawSnapshot;
  const snapshot = !showOverview && selectedSnapshot && movement?.landing
    && selectedSnapshot.pathStartSeconds === movement.landing.timeSeconds
    ? { ...selectedSnapshot, playerLabel: "랭커 착지" } : selectedSnapshot;
  const blueZone = !showOverview ? snapshot?.blueZone : undefined;
  const blueZoneStatus = blueZone?.status === "waiting" ? `축소 대기${typeof blueZone.countdownSeconds === "number" && Number.isFinite(blueZone.countdownSeconds) && blueZone.countdownSeconds >= 0 ? ` · 관측된 축소 시작까지 ${formatLessonTime(blueZone.countdownSeconds)}` : ""}`
    : blueZone?.status === "shrinking" ? "축소 중" : blueZone?.status === "complete" ? "축소 완료/다음 원 대기" : "상태 확인 불가";
  const combatZone = scene.combatZone;
  const combatPhase = snapshot?.zone && typeof snapshot.zoneObservedSeconds === "number"
    ? combatZone?.observedSeconds === snapshot.zoneObservedSeconds ? combatZone.phase
      : movement?.revealedSeconds === snapshot.zoneObservedSeconds ? movement.phase : undefined
    : undefined;
  const movementTimes = [
    { label: `착지${movement?.landing?.place ? ` · ${movement.landing.place}` : ""}`, seconds: movement?.landing?.timeSeconds },
    { label: "원 공개", seconds: movement?.revealedSeconds },
    { label: "축소 확인", seconds: movement?.shrinkObservedSeconds },
    { label: "원 안 확인", seconds: movement?.insideObservedSeconds },
  ].filter((item): item is { label: string; seconds: number } => typeof item.seconds === "number" && Number.isFinite(item.seconds) && item.seconds >= 0)
    .sort((a, b) => a.seconds - b.seconds);

  return <section aria-label="장면 복기" tabIndex={0}
    onKeyDown={(event) => {
      const control = event.target instanceof HTMLElement && event.target.closest<HTMLButtonElement>("button[data-scene-index]");
      if (event.target !== event.currentTarget && !control) return;
      if (event.altKey || event.ctrlKey || event.metaKey) return;
      if (event.key === "ArrowLeft" || event.key === "ArrowRight") {
        event.preventDefault();
        const next = index + (event.key === "ArrowLeft" ? -1 : 1);
        select(next);
        if (control) event.currentTarget.querySelector<HTMLButtonElement>(`button[data-scene-index="${Math.max(0, Math.min(scenes.length - 1, next))}"]`)?.focus();
      }
    }} className="outline-none focus-visible:ring-2 focus-visible:ring-emerald-400">
    {(hasHighlights || hasCombat) && <div role="group" aria-label="경기 보기 선택" className="mb-3 flex flex-wrap gap-2">
      {([
        ...(hasHighlights ? [{ id: "highlights" as const, label: `핵심 장면 ${highlights!.length}개` }] : []),
        { id: "all" as const, label: "전체 흐름" },
        ...(hasCombat ? [{ id: "combat" as const, label: `교전 기록 ${combatScenes!.length}건` }] : []),
      ]).map((option) => <button key={option.id} type="button" aria-pressed={view === option.id}
        onClick={() => { setView(option.id); setIndex(0); setShowOverview(false); }}
        className="min-h-11 max-w-full rounded-lg border border-zinc-700 px-3 text-sm font-semibold whitespace-normal text-zinc-300 hover:border-emerald-400 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-emerald-400 aria-pressed:border-emerald-400 aria-pressed:bg-emerald-400/10 aria-pressed:text-emerald-200">{option.label}</button>)}
    </div>}
    {showingCombat && <p className="mb-2 text-xs leading-5 text-zinc-400">한 교전에서 여러 킬이 나올 수 있습니다.</p>}
    <ol aria-label="장면 선택" className="-mx-4 mb-4 flex gap-2 overflow-x-auto px-4 pb-2 sm:mx-0 sm:px-0">
      {scenes.map((item, itemIndex) => <li key={item.id} className="shrink-0">
        <button type="button" data-scene-index={itemIndex} aria-label={`${itemIndex + 1}장 ${item.title}`} aria-current={itemIndex === index ? "step" : undefined} aria-pressed={itemIndex === index} onClick={() => select(itemIndex)} className="flex min-h-11 w-44 items-center gap-2 rounded-lg border border-zinc-800 px-3 text-left text-zinc-400 hover:border-zinc-500 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-emerald-400 aria-[current=step]:border-emerald-400 aria-[current=step]:bg-emerald-400/10 aria-[current=step]:text-emerald-200">
          <span className="font-mono text-xs">{String(itemIndex + 1).padStart(2, "0")}</span>
          <span className="min-w-0"><span className="block font-mono text-[10px]">{formatLessonTime(item.startSeconds)}–{formatLessonTime(item.endSeconds)}</span><span className="block truncate text-sm font-semibold">{item.title}</span></span>
        </button>
      </li>)}
    </ol>
    <div className="grid min-w-0 gap-5 lg:grid-cols-[minmax(0,1.05fr)_minmax(20rem,0.95fr)] lg:items-start">
      <article className="min-w-0 rounded-2xl border border-zinc-800 bg-zinc-900/50 p-5 sm:p-6 lg:col-start-2 lg:row-start-1" aria-live="polite">
        <p className="text-xs font-semibold text-emerald-300">{index + 1} / {scenes.length} · {SCENE_KIND[scene.kind]} · {formatLessonTime(scene.startSeconds)}–{formatLessonTime(scene.endSeconds)}</p>
        <h2 className="mt-2 break-words text-2xl font-bold leading-tight">{scene.title}</h2>
        {scene.brief ? <dl className="mt-4 space-y-2 text-sm leading-6">
          <div className="grid grid-cols-[2rem_minmax(0,1fr)] gap-3"><dt className="font-semibold text-zinc-400">상황</dt><dd className="break-words text-zinc-200">{scene.brief.situation}</dd></div>
          <div className="grid grid-cols-[2rem_minmax(0,1fr)] gap-3"><dt className="font-semibold text-zinc-400">행동</dt><dd className="break-words text-zinc-200">{scene.brief.action}</dd></div>
          <div className="grid grid-cols-[2rem_minmax(0,1fr)] gap-3"><dt className="font-semibold text-zinc-400">결과</dt><dd className="break-words text-zinc-200">{scene.brief.outcome}</dd></div>
        </dl> : <dl className="mt-5 space-y-4">
          <div><dt className="text-xs font-semibold text-zinc-400">어떤 상황이었나</dt><dd className="mt-1 break-words text-sm leading-7 text-zinc-200">{scene.situation}</dd></div>
          <div><dt className="text-xs font-semibold text-zinc-400">어떻게 풀어갔나</dt><dd className="mt-1 whitespace-pre-line break-words text-sm leading-7 text-zinc-200">{scene.action}</dd></div>
          <div><dt className="text-xs font-semibold text-zinc-400">그 뒤 어떻게 됐나</dt><dd className="mt-1 break-words text-sm leading-7 text-zinc-200">{scene.outcome}</dd></div>
          {scene.lesson && <div className="rounded-lg border border-emerald-400/25 bg-emerald-400/5 p-3"><dt className="text-xs font-semibold text-emerald-300">이 장면의 핵심</dt><dd className="mt-1 break-words text-sm leading-6 text-zinc-100">{scene.lesson}</dd></div>}
        </dl>}
        {operatingPoint && <section aria-label="운영 포인트" className="mt-4 rounded-lg border border-emerald-400/25 bg-emerald-400/5 p-3">
          <h3 className="text-xs font-semibold text-emerald-300">운영 포인트</h3>
          <p className="mt-1 break-words text-sm leading-6 text-zinc-100">{operatingPoint.point}</p>
        </section>}
        <div className="mt-6 flex items-center justify-between gap-3 border-t border-zinc-800 pt-4">
          <button type="button" aria-label="이전 장면" disabled={index === 0} onClick={() => select(index - 1)} className="inline-flex min-h-11 items-center gap-2 rounded-lg border border-zinc-700 px-3 text-sm font-semibold text-zinc-200 hover:border-emerald-400 disabled:cursor-not-allowed disabled:opacity-40"><ArrowLeft size={16} />이전</button>
          <p className="text-xs tabular-nums text-zinc-400" aria-live="polite">{index + 1} / {scenes.length}</p>
          <button type="button" aria-label="다음 장면" disabled={index === scenes.length - 1} onClick={() => select(index + 1)} className="inline-flex min-h-11 items-center gap-2 rounded-lg bg-emerald-300 px-3 text-sm font-bold text-zinc-950 hover:bg-emerald-200 disabled:cursor-not-allowed disabled:opacity-40">다음<ArrowRight size={16} /></button>
        </div>
        {(scene.brief || operatingPoint) && <details key={`${view}-${scene.id}`} className="mt-3 border-t border-zinc-800 text-sm">
          <summary className="flex min-h-11 cursor-pointer items-center font-semibold text-zinc-300">이 장면 자세히 보기</summary>
          <dl className="space-y-4 pb-3">
            {scene.brief && <>
              <div><dt className="text-xs font-semibold text-zinc-400">상황</dt><dd className="mt-1 whitespace-pre-line break-words leading-7 text-zinc-200">{scene.situation}</dd></div>
              <div><dt className="text-xs font-semibold text-zinc-400">행동</dt><dd className="mt-1 whitespace-pre-line break-words leading-7 text-zinc-200">{scene.action}</dd></div>
              <div><dt className="text-xs font-semibold text-zinc-400">결과</dt><dd className="mt-1 whitespace-pre-line break-words leading-7 text-zinc-200">{scene.outcome}</dd></div>
              {scene.lesson && <div className="rounded-lg border border-emerald-400/25 bg-emerald-400/5 p-3"><dt className="text-xs font-semibold text-emerald-300">이 장면의 핵심</dt><dd className="mt-1 break-words leading-6 text-zinc-100">{scene.lesson}</dd></div>}
            </>}
            {operatingPoint && <div><dt className="text-xs font-semibold text-zinc-400">당시 조건</dt><dd className="mt-1 whitespace-pre-line break-words leading-7 text-zinc-200">{operatingPoint.conditions}</dd></div>}
          </dl>
        </details>}
        {scenes[index + 1] && <p className="mt-3 break-words text-xs leading-5 text-zinc-400">이어서 · {scenes[index + 1].title}</p>}
      </article>
      <div className="min-w-0 lg:col-start-1 lg:row-start-1">
        {overview && <div className="mb-2 flex min-h-11 flex-wrap items-center justify-between gap-2 text-xs text-zinc-400"><span>{showOverview ? "경기 전체의 기록된 위치" : "선택한 구간의 위치"}</span><button type="button" aria-pressed={showOverview} onClick={() => setShowOverview(!showOverview)} className="min-h-11 rounded-lg border border-zinc-700 px-3 text-zinc-200 hover:border-emerald-400">{showOverview ? "이 구간 보기" : "전체 동선 보기"}</button></div>}
        {blueZone && <p className="mb-2 text-xs leading-5 text-sky-200">파란 현재 안전구역 · {formatLessonTime(blueZone.observedSeconds)} 관측 · {blueZoneStatus}<span className="block text-zinc-400">약 10초 간격 기록{blueZone.status === "waiting" && blueZone.countdownSeconds !== undefined ? " · 남은 시간은 첫 축소 관측 기준" : ""}</span></p>}
        {showingCombat && <p className="mb-2 text-xs font-medium text-zinc-300">교전 시각 {formatLessonTime(scene.anchorSeconds)} / {snapshot?.zone && typeof snapshot.zoneObservedSeconds === "number" && Number.isFinite(snapshot.zoneObservedSeconds)
          ? `${combatPhase !== undefined ? `${combatPhase}단계 · ` : ""}${snapshot.zoneObservedSeconds <= scene.anchorSeconds ? "교전 전에 마지막으로 공개된 안전구역" : "교전 뒤에 공개된 안전구역"} · ${formatLessonTime(snapshot.zoneObservedSeconds)}${scene.anchorSeconds - snapshot.zoneObservedSeconds >= 60 ? ` · ${formatLessonTime(scene.anchorSeconds - snapshot.zoneObservedSeconds)} 전` : ""}`
          : "표시할 안전구역 기록 없음"}</p>}
        {!showOverview && movementTimes.length > 0 && <div className="mb-3 text-xs leading-5 text-zinc-300">
          {movement?.phase !== undefined && <p className="font-semibold text-emerald-300">{movement.phase}단계 원(안전구역)</p>}
          <ol aria-label="착지와 원의 기록 시각" className="flex flex-wrap gap-x-2 gap-y-1">
            {movementTimes.map((item, itemIndex) => <li key={item.label}>{itemIndex > 0 && <span aria-hidden="true" className="mr-2 text-zinc-500">→</span>}{item.label} <time className="font-mono tabular-nums">{formatLessonTime(item.seconds)}</time></li>)}
          </ol>
          {typeof movement?.outsideMeters === "number" && Number.isFinite(movement.outsideMeters) && movement.outsideMeters >= 0 && <p className="text-zinc-400">{movement.outsideMeters > 0 ? `공개 때 원 밖 약 ${Math.round(movement.outsideMeters)}m` : "공개 때 원 안"}</p>}
          {movementTimes.some((item) => item.label === "원 안 확인") && <p className="text-zinc-500">원 안 확인은 첫 위치 기록이며, 정확한 진입 시각은 아닙니다.</p>}
        </div>}
        {!showingCombat && snapshot?.zoneObservedSeconds !== undefined && <p className="mb-2 text-xs font-medium text-zinc-300">표시한 원(안전구역) · {formatLessonTime(snapshot.zoneObservedSeconds)} 공개</p>}
        {snapshot && mapId ? <>
          <BriefingMapShell key={`${view}-${scene.id}-${showOverview}`} snapshot={snapshot} mapId={mapId} />
          <p className="mt-2 flex items-center gap-2 text-xs leading-5 text-zinc-400"><MapPin size={14} className="shrink-0 text-emerald-300" />점선은 랭커의 위치 기록을 이은 선입니다. 실제 이동 경로와 다를 수 있습니다.</p>
          {(snapshot.observations?.length || snapshot.marks?.length) ? <details key={`observations-${view}-${scene.id}-${showOverview}`} className="mt-1 text-xs leading-5 text-zinc-500"><summary className="min-h-11 w-fit cursor-pointer py-3">위치가 기록된 시각과 선수 보기</summary>
            {snapshot.observations?.length ? <ul aria-label="기록된 위치" className="space-y-1">{snapshot.observations.map((observation, observationIndex) => <li key={`${observation.evidenceId}-${observation.timeSeconds}-${observationIndex}`}>{formatLessonTime(observation.timeSeconds)} · {observation.label}</li>)}</ul> : null}
            {snapshot.marks?.length ? <ul aria-label="지도 표식" className="mt-2 space-y-1">{snapshot.marks.map((mark, markIndex) => <li key={`${mark.label}-${markIndex}`}>{mark.kind === "teammate" ? "팀원" : mark.kind === "opponent" ? "상대" : "투척 기록"} · {mark.label}</li>)}</ul> : null}
          </details> : null}
        </> : <p className="rounded-xl border border-zinc-800 bg-zinc-900/50 p-5 text-sm leading-6 text-zinc-400">기록된 위치가 없어 지도를 표시할 수 없습니다. 장면 해설은 계속 읽을 수 있습니다.</p>}
      </div>
    </div>
  </section>;
}
