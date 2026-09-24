import type { RankerLesson } from "@/lib/learn/lessons";
import { formatLessonDistance, formatLessonTime } from "@/lib/learn/lessons";

type WinSummaryData = NonNullable<RankerLesson["winSummary"]>;

export default function WinSummary({ summary }: { summary: WinSummaryData }) {
  return (
    <section aria-labelledby="win-summary-heading" className="mt-6 rounded-2xl border border-emerald-900/70 bg-emerald-950/20 p-4 sm:p-5">
      <div>
        <p className="text-xs font-semibold uppercase tracking-[0.14em] text-emerald-300">경기 요약</p>
        <h2 id="win-summary-heading" className="mt-1 text-xl font-bold text-zinc-100">{summary.kills.length}킬 우승 흐름</h2>
        <p className="mt-3 break-words text-sm leading-6 text-zinc-300">{summary.intro}</p>
      </div>

      <div className="mt-5">
        <h3 className="text-sm font-semibold text-zinc-200">주요 시점</h3>
        <ol className="mt-2 space-y-2">
          {summary.milestones.map((milestone, index) => (
            <li key={`${milestone.timeSeconds}-${index}`} className="grid min-w-0 grid-cols-[3rem_minmax(0,1fr)] gap-2 text-sm leading-6">
              <time className="font-mono tabular-nums text-emerald-300">{formatLessonTime(milestone.timeSeconds)}</time>
              <span className="min-w-0 break-words text-zinc-300">{milestone.text}</span>
            </li>
          ))}
        </ol>
      </div>

      <div className="mt-5">
        <h3 className="text-sm font-semibold text-zinc-200">무기별 처치 수</h3>
        <ul className="mt-2 grid grid-cols-2 gap-2 sm:grid-cols-3">
          {summary.weapons.map((weapon) => (
            <li key={weapon.name} className="flex min-w-0 items-center justify-between gap-2 rounded-lg bg-zinc-900/70 px-3 py-2 text-sm">
              <span className="min-w-0 break-words text-zinc-300">{weapon.name}</span>
              <span className="shrink-0 font-semibold tabular-nums text-zinc-100">{weapon.kills}킬</span>
            </li>
          ))}
        </ul>
      </div>

      <details className="mt-4 border-t border-emerald-900/70 pt-2">
        <summary className="flex min-h-11 cursor-pointer items-center gap-2 text-sm font-semibold text-zinc-200 marker:text-emerald-300">
          시간순 {summary.kills.length}킬 기록
          <span className="text-xs font-normal text-zinc-500">펼쳐서 보기</span>
        </summary>
        <ol className="mt-1 divide-y divide-zinc-800/80">
          {summary.kills.map((kill, index) => (
            <li key={`${kill.timeSeconds}-${kill.victim}-${index}`} className="grid min-w-0 grid-cols-[3rem_minmax(0,1fr)] gap-2 py-2.5 text-sm">
              <time className="pt-0.5 font-mono tabular-nums text-zinc-500">{formatLessonTime(kill.timeSeconds)}</time>
              <div className="flex min-w-0 flex-wrap items-baseline gap-x-2 gap-y-1">
                <span className="min-w-0 break-all text-zinc-200">{kill.victim}</span>
                <span className="break-words text-xs text-zinc-400">{kill.weapon}</span>
                {kill.distanceMeters !== undefined && <span className="text-xs tabular-nums text-sky-200">약 {formatLessonDistance(kill.distanceMeters)}m</span>}
              </div>
            </li>
          ))}
        </ol>
      </details>

      <p className="mt-3 text-xs leading-5 text-zinc-500">
        거리는 처치 순간 두 선수의 위치를 이은 직선 거리입니다. 무기는 처치 기록 기준이며, 이동 의도와 실제 시야는 기록만으로 알 수 없습니다.
      </p>
    </section>
  );
}
