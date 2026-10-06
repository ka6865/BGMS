import type { MatchSummaryData } from "@/lib/pubg-analysis/matchSummary";
import type { MatchData } from "@/types/stat";
import { getTranslatedWeaponName } from "@/lib/pubg-analysis/constants";
import { MatchPerformancePanel } from "./MatchPerformancePanel";

type RetainedMatchData = MatchSummaryData & {
  performance?: Partial<MatchData>;
  performanceDetails?: Partial<MatchData>;
  killContribution?: { solo?: number; assist?: number; cleanup?: number } | null;
};

function retainedPerformance(summary: MatchSummaryData): MatchData {
  const retained = summary as RetainedMatchData;
  const details = retained.performanceDetails || retained.performance || {};
  return {
    ...summary,
    ...details,
    stats: { ...summary.stats, ...details.stats },
    benchmark: details.benchmark || summary.benchmark,
    teamImpact: details.teamImpact || summary.teamImpact,
    badges: details.badges || summary.badges,
    tradeStats: details.tradeStats || summary.tradeStats,
    duelStats: details.duelStats || summary.duelStats,
    itemUseSummary: details.itemUseSummary || summary.itemUseSummary,
    itemUseStats: details.itemUseStats || summary.itemUseStats,
    weaponStats: details.weaponStats || summary.weaponStats,
  } as MatchData;
}

function display(value: number | null | undefined, suffix = ""): string {
  return typeof value === "number" && Number.isFinite(value) ? `${value}${suffix}` : "기록 없음";
}

export function MatchDetailExpiredNotice({
  summary,
  expiresAt,
}: {
  summary: MatchSummaryData | MatchData | null;
  expiresAt: string | null;
}) {
  if (!summary) {
    return (
      <section role="status" aria-label="상세 분석 만료" className="rounded-b-2xl border border-t-0 border-sky-500/20 bg-sky-500/5 p-4">
        <p className="text-sm font-bold text-sky-100">상세 분석과 리플레이 제공 기간이 만료되었습니다.</p>
        <p className="mt-1 text-xs text-white/60">기본 전적과 저장된 성과는 계속 확인할 수 있습니다.</p>
      </section>
    );
  }

  const performance = retainedPerformance(summary as MatchSummaryData);
  const expirationLabel = expiresAt && Number.isFinite(Date.parse(expiresAt))
    ? new Intl.DateTimeFormat("ko-KR", { dateStyle: "medium", timeZone: "Asia/Seoul" }).format(new Date(expiresAt))
    : null;
  const weapons = Object.entries(performance.weaponStats || {}).slice(0, 5);
  const itemUses = performance.itemUseStats || performance.itemUseSummary;
  const killContribution = (summary as RetainedMatchData).killContribution;
  const duelWins = (performance.duelStats as (typeof performance.duelStats & { duelWins?: number }) | undefined)?.duelWins
    ?? performance.duelStats?.wins;
  const hasSavedExtras = Boolean(weapons.length || performance.tradeStats || performance.duelStats || itemUses || killContribution);

  return (
    <section data-testid="match-detail-expired" role="status" aria-label="상세 분석 만료" className="space-y-4 rounded-b-2xl border border-t-0 border-sky-500/20 bg-[#141414] p-4">
      <div className="rounded-xl border border-sky-500/20 bg-sky-500/10 p-3">
        <p className="text-sm font-bold leading-relaxed text-sky-100">상세 분석과 리플레이 제공 기간이 만료되었습니다.</p>
        <p className="mt-1 text-xs leading-relaxed text-white/60">
          {expirationLabel ? `${expirationLabel}부터 상세 분석과 리플레이를 제공하지 않습니다. ` : ""}
          기본 전적과 저장된 성과는 계속 확인할 수 있습니다.
        </p>
        {(summary as MatchSummaryData).performanceHistorical && (
          <p className="mt-2 text-xs leading-relaxed text-amber-200/80">저장된 경기 성과는 이전 계산 기준으로 산출된 결과입니다.</p>
        )}
      </div>

      <section aria-label="기본 경기 기록" className="rounded-xl border border-white/10 bg-white/[0.02] p-3">
        <h3 className="text-xs font-black text-white/70">기본 경기 기록</h3>
        <dl className="mt-3 grid grid-cols-2 gap-3 sm:grid-cols-4">
          {[
            ["순위", display(performance.stats.winPlace, "위")],
            ["킬", display(performance.stats.kills)],
            ["피해량", display(performance.stats.damageDealt)],
            ["어시스트", display(
              (summary as MatchSummaryData).summarySource === "pubg_player_matches" && (summary as MatchSummaryData).isSummary !== false
                ? null
                : performance.stats.assists,
            )],
          ].map(([label, value]) => (
            <div key={label} className="min-w-0">
              <dt className="text-[11px] text-white/50">{label}</dt>
              <dd className="mt-1 break-words text-base font-bold text-white">{value}</dd>
            </div>
          ))}
        </dl>
      </section>

      <MatchPerformancePanel
        matchData={performance}
        isMobile={false}
        showTierDetails={true}
        onToggleTierDetails={() => undefined}
      />

      {hasSavedExtras && (
        <section aria-label="저장된 경기 성과" className="space-y-3 rounded-xl border border-white/10 bg-white/[0.02] p-3">
          <h3 className="text-xs font-black text-white/70">저장된 경기 성과</h3>
          {weapons.length > 0 && (
            <div className="space-y-2">
              <h4 className="text-[11px] font-bold text-white/60">무기 기록</h4>
              {weapons.map(([weapon, stats]) => (
                <div key={weapon} className="flex flex-wrap justify-between gap-x-3 gap-y-1 text-xs text-white/70">
                  <span className="break-words">{getTranslatedWeaponName(weapon)}</span>
                  <span>킬 {display(stats.kills)} · 피해량 {display(stats.damage)} · 명중 {display(stats.hits)}</span>
                </div>
              ))}
            </div>
          )}
          {performance.tradeStats && (
            <p className="text-xs leading-relaxed text-white/70">
              팀 기여 · 트레이드 {display(performance.tradeStats.tradeKills)}회 · 지원 {display(performance.tradeStats.suppCount)}회 · 소생 {display(performance.tradeStats.revCount)}회
            </p>
          )}
          {killContribution && (
            <p className="text-xs leading-relaxed text-white/70">
              킬 기여 · 단독 {display(killContribution.solo)} · 지원 {display(killContribution.assist)} · 마무리 {display(killContribution.cleanup)}
            </p>
          )}
          {performance.duelStats && (
            <p className="text-xs leading-relaxed text-white/70">
              1:1 교전 · 승 {display(duelWins)} / {display(performance.duelStats.totalDuels)}회 · 승률 {display(performance.duelStats.duelWinRate, "%")}
            </p>
          )}
          {itemUses && (
            <p className="text-xs leading-relaxed text-white/70">
              아이템 · 회복 {display("heals" in itemUses ? itemUses.heals : undefined)} · 부스트 {display("boosts" in itemUses ? itemUses.boosts : undefined)} · 연막 {display("smokes" in itemUses ? itemUses.smokes : undefined)}
            </p>
          )}
        </section>
      )}
    </section>
  );
}
