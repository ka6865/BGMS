import type { LolInsight, LolMatchInsights, LolRecentTrends } from "@/lib/lol/insights";
import { LOL_CHALLENGE_LEVELS, type LolChallengeProfile } from "@/lib/lol/challengeProfile";

function MetricList({ metrics }: { metrics: LolInsight[] }) {
  return <dl className="space-y-3 text-xs">
    {metrics.map(metric => <div key={metric.label} className="grid min-w-0 grid-cols-[minmax(0,1fr)_auto] items-baseline gap-x-3 gap-y-1">
      <dt className="text-zinc-400">{metric.label}</dt>
      <dd className="font-semibold tabular-nums text-zinc-100">{metric.value}</dd>
      <dd className="col-span-2 break-words text-[11px] leading-relaxed text-zinc-400">
        {metric.description}{metric.sampleSize !== undefined && ` (${metric.sampleSize}경기)`}
      </dd>
    </div>)}
  </dl>;
}

export function LolMatchInsightSection({ insights }: { insights?: LolMatchInsights }) {
  if (!insights || !insights.laning.length && !insights.contribution.length) return null;
  return <section data-testid="lol-match-insights" aria-label="라인전·기여" className="min-w-0 border-b border-zinc-800 pb-3">
    <h3 className="mb-3 text-sm font-bold">라인전·기여</h3>
    <div className="grid min-w-0 gap-4 sm:grid-cols-2">
      {([["라인전", insights.laning], ["기여", insights.contribution]] as const).map(([label, metrics]) => metrics.length > 0
        && <section key={label} aria-label={label} className="min-w-0">
          <h4 className="mb-2 text-xs font-semibold text-amber-300">{label}</h4>
          <MetricList metrics={metrics} />
        </section>)}
    </div>
  </section>;
}

export function LolRecentTrendsCard({ trends }: { trends?: LolRecentTrends }) {
  if (!trends) return null;
  return <section data-testid="lol-recent-trends" aria-label="최근 경기 경향" className="min-w-0 rounded-xl border border-zinc-800 bg-zinc-900/70 p-4">
    <h3 className="text-sm font-bold">최근 경기 경향</h3>
    <p className="mb-4 mt-1 text-[11px] text-zinc-400">BGMS에 저장된 최근 {trends.sampleSize}경기 기준 · 큐 전체</p>
    <MetricList metrics={trends.metrics} />
  </section>;
}

const top = (value: number) => value > 0 && value * 100 < 0.001 ? "상위 0.001% 미만"
  : `상위 ${(value * 100).toLocaleString("ko-KR", { maximumFractionDigits: 3 })}%`;

export function LolChallengesCard({ profile, admin = false }: { profile?: LolChallengeProfile; admin?: boolean }) {
  if (!profile) return null;
  return <section data-testid="lol-challenge-profile" aria-label="도전과제" className="min-w-0 rounded-xl border border-zinc-800 bg-zinc-900/70 p-4">
    <h3 className="text-sm font-bold">도전과제</h3>
    {profile.status === "failed" ? <p className="mt-2 text-xs text-zinc-400">도전과제 정보를 불러오지 못했습니다.</p> : <>
      {admin && profile.titleMappingUnverified && <p className="mt-2 text-[11px] text-zinc-400">칭호 매핑 미확인</p>}
      {profile.total && <p className="mt-3 break-words text-sm text-amber-300">
        {LOL_CHALLENGE_LEVELS[profile.total.level]} · {profile.total.current.toLocaleString("ko-KR")}점
        {profile.total.percentile !== null && <span className="mt-1 block text-xs text-zinc-300">{top(profile.total.percentile)}</span>}
      </p>}
      <h4 className="mb-2 mt-4 text-xs font-semibold">가장 희귀한 도전과제 {profile.rarest.length > 0 && `${profile.rarest.length}개`}</h4>
      {profile.rarest.length > 0 ? <ul className="space-y-3 text-xs">
        {profile.rarest.map(item => <li key={item.id} className="min-w-0 break-words">
          <p className="font-semibold text-zinc-200">{item.name}</p>
          <p className="mt-1 text-amber-300">{LOL_CHALLENGE_LEVELS[item.level]} · {top(item.percentile)}</p>
          <p className="mt-1 text-[11px] leading-relaxed text-zinc-400">{item.description}</p>
          {item.threshold !== null && <p className="mt-1 text-[11px] text-zinc-400">해당 등급 기준 {item.threshold.toLocaleString("ko-KR")}</p>}
        </li>)}
      </ul> : <p className="text-xs text-zinc-400">{profile.distributionStatus === "unavailable" ? "분포 정보를 확인할 수 없습니다." : "표시할 도전과제가 없습니다."}</p>}
      {profile.categories.length > 0 && <dl className="mt-4 space-y-2 border-t border-zinc-800 pt-3 text-xs">
        {profile.categories.map(category => <div key={category.name} className="flex flex-wrap justify-between gap-2">
          <dt className="text-zinc-400">{category.name}</dt>
          <dd className="text-zinc-200">{LOL_CHALLENGE_LEVELS[category.level]} · {category.current.toLocaleString("ko-KR")}점</dd>
        </div>)}
      </dl>}
      <p className="mt-3 text-[10px] leading-relaxed text-zinc-400">상위 비율은 Riot 공식 분포 수치입니다. 설정·분포는 하루 동안 캐시됩니다.</p>
    </>}
  </section>;
}
