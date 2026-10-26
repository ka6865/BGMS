import type { LolInsight, LolMatchInsights, LolRecentTrends } from "@/lib/lol/insights";
import { LOL_CHALLENGE_LEVELS, type LolChallengeListItem, type LolChallengeProfile } from "@/lib/lol/challengeProfile";

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

function FlagBadge({ metric }: { metric: LolInsight }) {
  const style = metric.achieved ? "border-sky-400/40 bg-sky-400/10 text-sky-200" : "border-zinc-700 bg-zinc-800/60 text-zinc-400";
  return <span title={metric.description} className={`inline-flex items-center gap-1.5 rounded-md border px-2 py-1 text-[11px] font-semibold ${style}`}>
    <span aria-hidden>{metric.achieved ? "✓" : "–"}</span>{metric.label === "초반 골드·경험치" ? "초반" : "라인전"} 우위{metric.achieved ? "" : " 아님"}
  </span>;
}

function CompareBar({ metric }: { metric: LolInsight }) {
  const mine = metric.mine ?? 0;
  const theirs = metric.theirs;
  const max = Math.max(mine, theirs ?? 0, 1);
  const ahead = theirs === undefined || mine >= theirs;
  const label = metric.label === "시야 점수 격차" ? "시야 점수" : metric.label;
  return <div title={metric.description} className="min-w-0">
    <div className="flex items-baseline justify-between gap-2 text-[11px]">
      <span className="text-zinc-400">{label}</span>
      {theirs !== undefined && <span className={`font-semibold tabular-nums ${mine > theirs ? "text-sky-300" : mine < theirs ? "text-rose-300" : "text-zinc-300"}`}>
        {mine - theirs > 0 ? "+" : ""}{(mine - theirs).toLocaleString("ko-KR", { maximumFractionDigits: 1 })}
      </span>}
    </div>
    <div className="mt-1 grid grid-cols-[2.5rem_minmax(0,1fr)] items-center gap-x-2 gap-y-1 text-[11px] tabular-nums">
      <span className="text-right font-semibold text-zinc-100">{mine.toLocaleString("ko-KR", { maximumFractionDigits: 1 })}</span>
      <div className="h-1.5 overflow-hidden rounded bg-zinc-800"><div className={`h-full rounded ${ahead ? "bg-sky-400" : "bg-sky-400/60"}`} style={{ width: `${mine / max * 100}%` }} /></div>
      {theirs !== undefined && <>
        <span className="text-right text-zinc-500">{theirs.toLocaleString("ko-KR", { maximumFractionDigits: 1 })}</span>
        <div className="h-1.5 overflow-hidden rounded bg-zinc-800"><div className="h-full rounded bg-rose-400/70" style={{ width: `${theirs / max * 100}%` }} /></div>
      </>}
    </div>
  </div>;
}

function ShareTile({ metric }: { metric: LolInsight }) {
  const pct = Math.round((metric.ratio ?? 0) * 1000) / 10;
  return <div title={metric.description} className="min-w-0 rounded-lg bg-zinc-800/50 px-3 py-2">
    <p className="truncate text-[11px] text-zinc-400">{metric.label}</p>
    <p className="mt-0.5 text-lg font-bold leading-6 tabular-nums text-zinc-100">{metric.value}</p>
    <div className="mt-1.5 h-1 overflow-hidden rounded bg-zinc-700/60"><div className="h-full rounded bg-amber-400" style={{ width: `${Math.min(100, pct)}%` }} /></div>
  </div>;
}

function CountChip({ metric }: { metric: LolInsight }) {
  const zero = metric.amount === 0;
  return <span title={metric.description} className={`inline-flex items-baseline gap-1 rounded-md px-2 py-1 text-[11px] ${zero ? "bg-zinc-800/40 text-zinc-600" : "bg-zinc-800 text-zinc-300"}`}>
    {metric.label}<b className={`tabular-nums ${zero ? "font-medium" : "text-zinc-100"}`}>{metric.kind === "lead" && !zero ? "+" : ""}{metric.value}</b>
  </span>;
}

export function LolMatchInsightSection({ insights }: { insights?: LolMatchInsights }) {
  if (!insights || !insights.laning.length && !insights.contribution.length) return null;
  const structured = [...insights.laning, ...insights.contribution].every(metric => metric.kind);
  if (!structured) return <section data-testid="lol-match-insights" aria-label="라인전·기여" className="min-w-0">
    <h3 className="mb-3 text-sm font-bold">라인전·기여</h3>
    <div className="grid min-w-0 gap-4 sm:grid-cols-2">
      {([["라인전", insights.laning], ["기여", insights.contribution]] as const).map(([label, metrics]) => metrics.length > 0
        && <section key={label} aria-label={label} className="min-w-0">
          <h4 className="mb-2 text-xs font-semibold text-amber-300">{label}</h4>
          <MetricList metrics={metrics} />
        </section>)}
    </div>
  </section>;
  const flags = insights.laning.filter(metric => metric.kind === "flag");
  const compares = insights.laning.filter(metric => metric.kind === "compare");
  const leads = insights.laning.filter(metric => metric.kind === "lead");
  const shares = insights.contribution.filter(metric => metric.kind === "share");
  const counts = insights.contribution.filter(metric => metric.kind === "count");
  return <section data-testid="lol-match-insights" aria-label="라인전·기여" className="min-w-0">
    <h3 className="mb-3 text-sm font-bold">라인전·기여</h3>
    <div className="grid min-w-0 gap-5 sm:grid-cols-2">
      {insights.laning.length > 0 && <section aria-label="라인전" className="min-w-0 space-y-3">
        <div className="flex items-baseline justify-between gap-2">
          <h4 className="text-xs font-semibold text-amber-300">라인전</h4>
          {compares.some(metric => metric.theirs !== undefined) && <span className="flex gap-2 text-[10px] text-zinc-500">
            <span><i className="mr-1 inline-block h-1.5 w-2.5 rounded-sm bg-sky-400 align-middle" />나</span>
            <span><i className="mr-1 inline-block h-1.5 w-2.5 rounded-sm bg-rose-400/70 align-middle" />{insights.opponentLabel ?? "맞라이너"}</span>
          </span>}
        </div>
        {flags.length > 0 && <div className="flex flex-wrap gap-1.5">{flags.map(metric => <FlagBadge key={metric.label} metric={metric} />)}</div>}
        {compares.map(metric => <CompareBar key={metric.label} metric={metric} />)}
        {leads.length > 0 && <div className="flex flex-wrap gap-1.5">{leads.map(metric => <CountChip key={metric.label} metric={metric} />)}</div>}
      </section>}
      {insights.contribution.length > 0 && <section aria-label="기여" className="min-w-0 space-y-3">
        <h4 className="text-xs font-semibold text-amber-300">기여</h4>
        {shares.length > 0 && <div className="grid grid-cols-3 gap-2">{shares.map(metric => <ShareTile key={metric.label} metric={metric} />)}</div>}
        {counts.length > 0 && <div className="flex flex-wrap gap-1.5">{counts.map(metric => <CountChip key={metric.label} metric={metric} />)}</div>}
      </section>}
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

// Riot 비율은 0.1% 단위로 반올림되어 오므로 0은 0%가 아니라 0.1% 미만으로 표시한다.
const top = (value: number) => value === 0 ? "상위 0.1% 미만" : value * 100 < 0.001 ? "상위 0.001% 미만"
  : `상위 ${(value * 100).toLocaleString("ko-KR", { maximumFractionDigits: 3 })}%`;
const rank = (item: LolChallengeListItem) => item.position === undefined ? null
  : `등급 내 ${item.position.toLocaleString("ko-KR")}위 / ${item.playersInLevel?.toLocaleString("ko-KR")}명`;

const LEVEL_TEXT: Record<string, string> = {
  IRON: "text-stone-400", BRONZE: "text-orange-400", SILVER: "text-slate-300", GOLD: "text-amber-300", PLATINUM: "text-teal-300",
  DIAMOND: "text-sky-300", MASTER: "text-fuchsia-300", GRANDMASTER: "text-rose-300", CHALLENGER: "text-yellow-200",
};

function LevelGem({ level, small = false }: { level: string; small?: boolean }) {
  return <span aria-hidden className={`grid ${small ? "h-8 w-8" : "h-11 w-11"} shrink-0 place-items-center rounded-lg bg-zinc-800/60 ${LEVEL_TEXT[level] ?? "text-amber-300"}`}>
    <i className="h-5 w-5 rotate-45 rounded-[3px] border-2 border-current bg-current/20" />
  </span>;
}

// 공식 도전과제 토큰 이미지는 버전 없는 경로로 제공되며, 없으면 등급 배지가 대신 보인다.
function ChallengeIcon({ id, level, small = false }: { id: number; level: string; small?: boolean }) {
  return <span className={`relative shrink-0 ${small ? "h-8 w-8" : "h-11 w-11"}`}>
    <LevelGem level={level} small={small} />
    <img src={`https://ddragon.leagueoflegends.com/cdn/img/challenges-images/${id}-${level}.png`} alt="" width={44} height={44} loading="lazy"
      onError={(event) => { event.currentTarget.style.visibility = "hidden"; }}
      className="absolute inset-0 h-full w-full rounded-lg bg-zinc-800 object-contain p-0.5" />
  </span>;
}

export function LolChallengesCard({ profile, admin = false }: { profile?: LolChallengeProfile; admin?: boolean }) {
  if (!profile) return null;
  return <section data-testid="lol-challenge-profile" aria-label="도전과제" className="min-w-0 rounded-xl border border-zinc-800 bg-zinc-900/70 p-4">
    <h3 className="text-sm font-bold">도전과제</h3>
    {profile.status === "failed" ? <p className="mt-2 text-xs text-zinc-400">도전과제 정보를 불러오지 못했습니다.</p> : <>
      {admin && profile.titleMappingUnverified && <p className="mt-2 text-[11px] text-zinc-400">칭호 매핑 미확인</p>}
      {profile.total && <div className="mt-3 flex min-w-0 items-center gap-3">
        <LevelGem level={profile.total.level} />
        <p className={`min-w-0 break-words text-sm ${LEVEL_TEXT[profile.total.level] ?? "text-amber-300"}`}>
          {LOL_CHALLENGE_LEVELS[profile.total.level]} · {profile.total.current.toLocaleString("ko-KR")}점
          {profile.total.percentile !== null && <span className="mt-1 block text-xs text-zinc-300">{top(profile.total.percentile)}</span>}
        </p>
      </div>}
      <h4 className="mb-2 mt-4 text-xs font-semibold">가장 희귀한 도전과제 {profile.rarest.length > 0 && `${profile.rarest.length}개`}</h4>
      {profile.rarest.length > 0 ? <ul className="space-y-3 text-xs">
        {profile.rarest.map(item => <li key={item.id} className="flex min-w-0 gap-3 break-words">
          <ChallengeIcon id={item.id} level={item.level} />
          <div className="min-w-0">
            <p className="font-semibold text-zinc-200">{item.name}</p>
            <p className={`mt-1 ${LEVEL_TEXT[item.level] ?? "text-amber-300"}`}>{LOL_CHALLENGE_LEVELS[item.level]} · {top(item.percentile)}</p>
            {rank(item) && <p className="mt-0.5 text-[11px] font-semibold text-zinc-200 tabular-nums">{rank(item)}</p>}
            <p className="mt-1 text-[11px] leading-relaxed text-zinc-400">{item.description}</p>
            {item.threshold !== null && <p className="mt-1 text-[11px] text-zinc-400">해당 등급 기준 {item.threshold.toLocaleString("ko-KR")}</p>}
          </div>
        </li>)}
      </ul> : <p className="text-xs text-zinc-400">{profile.distributionStatus === "unavailable" ? "분포 정보를 확인할 수 없습니다." : "표시할 도전과제가 없습니다."}</p>}
      {profile.achieved && profile.achieved.length > profile.rarest.length && <details className="group mt-3 rounded-lg border border-zinc-800">
        <summary className="flex cursor-pointer list-none items-center justify-between px-3 py-2 text-xs text-zinc-300 hover:text-white">
          <span>달성한 도전과제 전체 보기 <span className="text-zinc-500 tabular-nums">{profile.achieved.length}개</span></span>
          <span className="transition group-open:rotate-90">›</span>
        </summary>
        <ul data-testid="lol-challenge-all" className="max-h-96 divide-y divide-zinc-800/70 overflow-y-auto border-t border-zinc-800 px-3">
          {profile.achieved.map(item => <li key={item.id} className="flex min-w-0 items-center gap-2.5 py-2">
            <ChallengeIcon id={item.id} level={item.level} small />
            <div className="min-w-0 flex-1">
              <p className="truncate text-xs font-semibold text-zinc-200">{item.name}</p>
              <p className="truncate text-[11px] tabular-nums">
                <span className={LEVEL_TEXT[item.level] ?? "text-amber-300"}>{LOL_CHALLENGE_LEVELS[item.level]}</span>
                <span className="text-zinc-400"> · {rank(item) ?? top(item.percentile)}</span>
              </p>
            </div>
          </li>)}
        </ul>
      </details>}
      {profile.categories.length > 0 && <dl className="mt-4 space-y-2 border-t border-zinc-800 pt-3 text-xs">
        {profile.categories.map(category => <div key={category.name} className="flex flex-wrap justify-between gap-2">
          <dt className="text-zinc-400">{category.name}</dt>
          <dd className="text-zinc-200">{LOL_CHALLENGE_LEVELS[category.level]} · {category.current.toLocaleString("ko-KR")}점</dd>
        </div>)}
      </dl>}
      <p className="mt-3 text-[10px] leading-relaxed text-zinc-400">상위 비율·순위는 Riot 공식 분포 수치이며 0.1% 단위로 제공됩니다. 설정·분포는 하루 동안 캐시됩니다.</p>
    </>}
  </section>;
}
