import type { RankerScene } from "@/lib/learn/lessons";
import { formatLessonDistance, formatLessonTime } from "@/lib/learn/lessons";

const labels = {
  shot: "사격",
  damage: "피해 줌",
  received: "피해 받음",
  kill: "처치",
  throw: "투척",
} as const;

export default function CombatTimeline({ events }: { events: NonNullable<RankerScene["combatEvents"]> }) {
  return (
    <section aria-label="전투 기록" className="mt-4 rounded-xl border border-zinc-800 bg-zinc-900/70 p-3 sm:p-4">
      <div className="mb-2 flex flex-wrap items-baseline justify-between gap-2">
        <h4 className="text-sm font-bold text-zinc-100">전투 기록</h4>
        <span className="text-[11px] text-zinc-500">사격·피해·투척·처치 순서</span>
      </div>
      <ol className="divide-y divide-zinc-800/90">
        {events.map((event, index) => (
          <li key={`${event.timeSeconds}-${event.kind}-${index}`} className="grid grid-cols-[48px_minmax(0,1fr)] gap-2 py-2.5 text-xs sm:grid-cols-[54px_minmax(0,1fr)]">
            <time className="pt-0.5 font-mono tabular-nums text-zinc-500">{formatLessonTime(event.timeSeconds)}</time>
            <div className="min-w-0">
              <p className="flex flex-wrap items-center gap-x-1.5 gap-y-1 leading-5">
                <span className={`font-semibold ${event.kind === "received" ? "text-rose-300" : event.kind === "kill" ? "text-amber-200" : event.kind === "throw" ? "text-orange-200" : "text-emerald-200"}`}>
                  {labels[event.kind]}
                </span>
                <span className="break-all text-zinc-200">{event.actor}</span>
                {event.weapon && <span className="rounded bg-zinc-800 px-1.5 py-0.5 text-zinc-300">{event.weapon}</span>}
                {event.target && <span className="break-all text-zinc-400">→ {event.target}</span>}
                {event.distanceMeters !== undefined && <span className="font-medium tabular-nums text-sky-200">약 {formatLessonDistance(event.distanceMeters)}m</span>}
                {event.damage !== undefined && <span className="font-medium tabular-nums text-zinc-300">피해 {Math.round(event.damage)}</span>}
              </p>
              {event.note && <p className="mt-0.5 break-words leading-5 text-zinc-500">{event.note}</p>}
            </div>
          </li>
        ))}
      </ol>
      <p className="mt-2 text-[11px] leading-5 text-zinc-500">표시된 거리는 두 선수의 위치 사이 직선 거리입니다. 수류탄이 날아간 거리는 아닙니다.</p>
    </section>
  );
}
