import type { RankerScene } from "@/lib/learn/lessons";
import { formatLessonDistance, formatLessonTime } from "@/lib/learn/lessons";

type Analysis = NonNullable<RankerScene["zoneAnalysis"]>;

export default function ZoneResponse({ analysis }: { analysis: Analysis }) {
  return (
    <section aria-label="원(안전구역) 이동 기록" className="mt-4 rounded-xl border border-sky-900/70 bg-sky-950/20 p-3 sm:p-4">
      <h4 className="text-sm font-bold text-sky-100">원(안전구역) 이동</h4>
      {analysis.rounds.map((round) => (
        <div key={round.label} className="mt-3 border-t border-sky-900/60 pt-3 first:border-0 first:pt-0">
          <p className="text-xs font-semibold text-sky-200">{round.label}</p>
          <dl className="mt-2 grid grid-cols-2 gap-x-3 gap-y-2 text-xs sm:grid-cols-4">
            {[
              ["새 원 공개", round.revealedSeconds],
              ["줄어들기 시작한 첫 기록", round.shrinkSeconds],
              ["처음 위치와 100m 이상 차이", round.movedSeconds],
              ["원 안에서 처음 확인", round.enteredSeconds],
            ].map(([label, seconds]) => (
              <div key={label} className="min-w-0">
                <dt className="text-zinc-500">{label}</dt>
                <dd className="mt-0.5 font-mono tabular-nums text-zinc-200">{formatLessonTime(seconds as number)}</dd>
              </div>
            ))}
          </dl>
          <p className="mt-2 text-xs leading-5 text-zinc-300">{round.note}</p>
        </div>
      ))}
      {analysis.routeSummary && <p className="mt-3 border-t border-sky-900/60 pt-3 text-xs leading-5 text-zinc-300"><span className="font-semibold text-sky-200">기록으로 본 진입 방향 · </span>{analysis.routeSummary}</p>}
      {!!analysis.nearbyOpponents?.length && (
        <div className="mt-3 border-t border-sky-900/60 pt-3 text-xs leading-5 text-zinc-300">
          <p className="font-semibold text-sky-200">이동 중 근처에 기록된 상대</p>
          <ul className="mt-1 space-y-1">
            {analysis.nearbyOpponents.map((opponent) => (
              <li key={`${opponent.timeSeconds}-${opponent.name}`}>
                {formatLessonTime(opponent.timeSeconds)} {opponent.name} · 약 {formatLessonDistance(opponent.distanceMeters)}m{opponent.note ? ` · ${opponent.note}` : ""}
              </li>
            ))}
          </ul>
        </div>
      )}
      <p className="mt-3 text-[11px] leading-5 text-zinc-500">위치와 자기장 변화는 약 10초 간격으로 기록됩니다. 100m 차이는 새 원이 공개됐을 때의 위치에서 100m 이상 떨어진 첫 기록이며, 출발 시각은 아닙니다. 원 안에서 처음 확인된 시각도 실제 진입 시각과 다를 수 있습니다. 근처 상대의 위치가 기록됐어도 서로 봤거나 일부러 피했는지는 알 수 없습니다.</p>
    </section>
  );
}
