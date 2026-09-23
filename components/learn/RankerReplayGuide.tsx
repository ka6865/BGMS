"use client";

import Link from "next/link";
import { X, Play, ArrowLeft } from "lucide-react";
import { formatLessonTime, type RankerLesson, type RankerScene } from "@/lib/learn/lessons";

type Props = {
  lesson: RankerLesson;
  selectedSceneId: string | null;
  loading: boolean;
  error: string | null;
  onSelect: (scene: RankerScene) => void;
  onClose: () => void;
  onRetry: () => void;
};

export default function RankerReplayGuide({ lesson, selectedSceneId, loading, error, onSelect, onClose, onRetry }: Props) {
  return (
    <aside aria-label="랭커 전술 해설" className="flex h-full w-[min(340px,100vw)] flex-col border-l border-zinc-700 bg-zinc-950 text-zinc-100">
      <div className="shrink-0 border-b border-zinc-800 p-4">
        <div className="flex items-center justify-between gap-2">
          <Link href="/learn" className="inline-flex min-h-11 items-center gap-1 text-xs text-emerald-300"><ArrowLeft size={15} /> 다른 경기 보기</Link>
          <button type="button" onClick={onClose} aria-label="해설 닫기" className="flex h-11 w-11 items-center justify-center rounded-lg hover:bg-zinc-800 md:hidden"><X size={18} /></button>
        </div>
        <h2 className="text-lg font-bold leading-7">{lesson.title}</h2>
        <p className="mt-2 break-all text-xs leading-5 text-zinc-400">{lesson.nickname} · {lesson.mapLabel} · {lesson.gameMode === "solo" ? "솔로" : "스쿼드"}</p>
        <p className="text-xs leading-5 text-zinc-500">2026.09.23 조회한 AS 리더보드 {lesson.rank}위 · 모드별 순위 아님</p>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain p-4 pb-24 md:pb-6">
        {loading && <p role="status" className="mb-4 text-sm text-emerald-300">보관된 경기 리플레이를 불러오는 중입니다.</p>}
        {error && <div role="alert" className="mb-4 text-sm text-amber-200"><p>리플레이를 불러오지 못했습니다. 해설은 계속 읽을 수 있습니다.</p><button type="button" onClick={onRetry} className="mt-2 min-h-11 underline">다시 불러오기</button></div>}
        <p className="mb-4 text-xs leading-5 text-zinc-500">장면을 누르면 약 20초 전으로 이동해 일시정지합니다. 지도 하단의 재생 버튼으로 이어서 볼 수 있습니다.</p>
        <ol className="space-y-6">
          {lesson.scenes.map((scene) => (
            <li key={scene.id} className="border-b border-zinc-800 pb-5 last:border-0">
              <button type="button" disabled={loading || !!error} onClick={() => onSelect(scene)} aria-current={selectedSceneId === scene.id ? "step" : undefined} className="flex min-h-11 w-full items-start gap-2 text-left text-sm font-bold leading-6 text-emerald-300 disabled:opacity-50 aria-[current=step]:text-amber-300">
                <Play size={15} className="mt-1 shrink-0" /><span><span className="mr-2 font-mono text-xs">{formatLessonTime(scene.anchorSeconds)}</span>{scene.title}</span>
              </button>
              <p className="mt-2 text-sm leading-7 text-zinc-300">{scene.fact}</p>
              <details className="mt-2 text-xs leading-6 text-zinc-500">
                <summary className="min-h-11 cursor-pointer py-2 text-zinc-400">해석 범위</summary>{scene.limitation}
              </details>
            </li>
          ))}
        </ol>
      </div>
    </aside>
  );
}
