import type { RankerScene } from "@/lib/learn/lessons";
import { formatLessonDistance, formatLessonTime } from "@/lib/learn/lessons";

type Analysis = NonNullable<RankerScene["zoneAnalysis"]>;

export default function ZoneResponse({ analysis }: { analysis: Analysis }) {
  return (
    <section aria-label="자기장 대응 기록" className="mt-4 rounded-xl border border-sky-900/70 bg-sky-950/20 p-3 sm:p-4">
      <h4 className="text-sm font-bold text-sky-100">자기장 대응</h4>
      {analysis.rounds.map((round) => (
        <div key={round.label} className="mt-3 border-t border-sky-900/60 pt-3 first:border-0 first:pt-0">
          <p className="text-xs font-semibold text-sky-200">{round.label}</p>
          <dl className="mt-2 grid grid-cols-2 gap-x-3 gap-y-2 text-xs sm:grid-cols-4">
            {[
              ["새 원 공개", round.revealedSeconds],
              ["줄기 시작 관측", round.shrinkSeconds],
              ["100m 이상 위치 변화", round.movedSeconds],
              ["원 안 첫 관측", round.enteredSeconds],
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
      {analysis.routeSummary && <p className="mt-3 border-t border-sky-900/60 pt-3 text-xs leading-5 text-zinc-300"><span className="font-semibold text-sky-200">관측된 진입 방향 · </span>{analysis.routeSummary}</p>}
      {!!analysis.nearbyOpponents?.length && (
        <div className="mt-3 border-t border-sky-900/60 pt-3 text-xs leading-5 text-zinc-300">
          <p className="font-semibold text-sky-200">이동 중 근처에서 관측된 상대</p>
          <ul className="mt-1 space-y-1">
            {analysis.nearbyOpponents.map((opponent) => (
              <li key={`${opponent.timeSeconds}-${opponent.name}`}>
                {formatLessonTime(opponent.timeSeconds)} {opponent.name} · 약 {formatLessonDistance(opponent.distanceMeters)}m{opponent.note ? ` · ${opponent.note}` : ""}
              </li>
            ))}
          </ul>
        </div>
      )}
      <p className="mt-3 text-[11px] leading-5 text-zinc-500">위치와 자기장 변화는 약 10초 간격으로 관측됩니다. 100m 변화는 공개 때의 위치와 비교한 첫 관측 시각이며 출발 시각이 아닙니다. 적 위치는 같은 시간대 표본으로, 시야·조우·회피 의도는 알 수 없습니다.</p>
    </section>
  );
}
