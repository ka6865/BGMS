"use client";

import { ChevronDown, Flame } from "lucide-react";
import { BgmsIcon } from "@/components/common/BgmsIcon";
import { getNextTierInfo } from "@/lib/pubg-analysis/benchmarkScore";
import type { MatchData } from "@/types/stat";

const ScoreBar = ({ label, score, max, color, compact = false }: { label: string, score: number, max: number, color: string, compact?: boolean }) => (
  <div className={`flex flex-col ${compact ? "gap-1" : "gap-1.5"}`}>
    <div className={`flex justify-between items-center ${compact ? "text-[10px]" : "text-[11px]"}`}>
      <span className="text-gray-400 font-bold tracking-tight">{label}</span>
      <span className="text-white font-black">{score} <span className="text-white/20 font-medium">/ {max}</span></span>
    </div>
    <div
      role="progressbar"
      aria-label={`${label} 점수`}
      aria-valuemin={0}
      aria-valuemax={max}
      aria-valuenow={score}
      className={`w-full ${compact ? "h-1.5" : "h-2"} bg-white/5 rounded-full overflow-hidden border border-white/10 relative`}
    >
      <div
        className={`h-full ${color} transition-all duration-1000 ease-out shadow-[0_0_12px_rgba(255,255,255,0.15)] relative z-10`}
        style={{ width: `${Math.min(100, (score / max) * 100)}%` }}
      />
      {/* 배경 가이드라인 */}
      <div className="absolute inset-0 flex justify-between px-1 pointer-events-none opacity-10">
        <div className="w-px h-full bg-white" />
        <div className="w-px h-full bg-white" />
        <div className="w-px h-full bg-white" />
      </div>
    </div>
  </div>
);

interface TierEvidenceItem {
  label: string;
  value: string;
  note?: string;
}

interface TierEvidenceSummaryItem {
  label: string;
  value: string;
  accent: string;
}

interface TierEvidenceSection {
  title: string;
  accent: string;
  items: TierEvidenceItem[];
}

const isFiniteNumber = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value);

const formatPercent = (value: number, digits = 0) => `${Number(value.toFixed(digits))}%`;

const formatSeconds = (ms?: number) => {
  if (!isFiniteNumber(ms) || ms <= 0) return "측정 불가";
  return `${(ms / 1000).toFixed(2)}초`;
};

const getImpactGradeLabel = (grade?: string) => {
  if (grade === "LEGEND") return "레전드";
  if (grade === "HARD_CARRY") return "하드캐리";
  if (grade === "CARRY") return "캐리";
  if (grade === "GOOD") return "좋은 판";
  return "일반";
};

const isDisplayValueAvailable = (value: string) => value !== "응답 필드 없음" && value !== "측정 불가";

const joinEvidenceSummary = (parts: Array<string | false | undefined>, fallback = "측정 불가") => {
  const cleanParts = parts.filter((part): part is string => Boolean(part));
  return cleanParts.length > 0 ? cleanParts.join(", ") : fallback;
};

const getOpportunityRate = (success?: number, total?: number) => {
  if (!isFiniteNumber(total)) {
    return { value: "응답 필드 없음", note: "아군 기절 샘플 필드 없음", isOpportunityMissing: false, isFieldMissing: true };
  }
  if (total <= 0) {
    return { value: "기회 없음 보정", note: "아군 기절 샘플 없음", isOpportunityMissing: true, isFieldMissing: false };
  }
  const safeSuccess = isFiniteNumber(success) ? success : 0;
  const cappedSuccess = Math.min(safeSuccess, total);
  const cappedNote = safeSuccess > total ? `점수 반영 ${cappedSuccess} / ${total}회, 실제 ${safeSuccess}회` : `${safeSuccess} / ${total}회`;
  return {
    value: formatPercent((cappedSuccess / total) * 100),
    note: cappedNote,
    isOpportunityMissing: false,
    isFieldMissing: false
  };
};

const buildTierEvidence = (matchData: MatchData) => {
  const stats = matchData.stats;
  const tradeStats = matchData.tradeStats;
  const totalTeammateKnocks = tradeStats?.teammateKnocks;
  const nextTier = getNextTierInfo(matchData.benchmark?.score || 0);
  const damageRankPct = matchData.matchInfo?.rankPct;
  const survivalBase = matchData.totalTeams || matchData.totalPlayers;
  const survivalRankPct = survivalBase && survivalBase > 0 ? stats.winPlace / survivalBase : null;
  const isActualDeath = Boolean(stats.deathType && stats.deathType !== "alive");
  const isEarlyDeath = (stats.timeSurvived || 0) < 600 || (isActualDeath && (matchData.deathPhase ?? 99) <= 3);
  const isHardEarlyDeath = (stats.timeSurvived || 0) < 300;
  const smokeRate = getOpportunityRate(tradeStats?.smokeRescues, totalTeammateKnocks);
  const reviveRate = getOpportunityRate(tradeStats?.revCount, totalTeammateKnocks);
  const tradeRate = getOpportunityRate(tradeStats?.tradeKills, totalTeammateKnocks);
  const initiativeSamples = matchData.initiativeSampleCount;
  const initiativeValue = isFiniteNumber(initiativeSamples) && initiativeSamples <= 0
    ? "측정 불가"
    : isFiniteNumber(matchData.initiative_rate)
      ? formatPercent(matchData.initiative_rate)
      : "응답 필드 없음";
  const damageValue = isFiniteNumber(damageRankPct)
    ? `상위 ${formatPercent(Math.min(1, Math.max(0, damageRankPct)) * 100)}`
    : matchData.myRank?.damageRank
      ? `#${matchData.myRank.damageRank}`
      : "응답 필드 없음";
  const reactionSpeedValue = formatSeconds(tradeStats?.reactionLatencyMs);
  const pressureValue = isFiniteNumber(matchData.combatPressure?.pressureIndex)
    ? matchData.combatPressure.pressureIndex.toFixed(2)
    : "응답 필드 없음";
  const supportValue = isFiniteNumber(tradeStats?.suppCount) ? `${tradeStats.suppCount}회` : "응답 필드 없음";
  const supportNote = isFiniteNumber(tradeStats?.suppRate)
    ? `지원율 ${formatPercent(tradeStats.suppRate)}`
    : totalTeammateKnocks && totalTeammateKnocks > 0
      ? `아군 기절 ${totalTeammateKnocks}회 기준`
      : undefined;
  const teamWipeValue = isFiniteNumber(tradeStats?.enemyTeamWipes) ? `${tradeStats.enemyTeamWipes}회` : "응답 필드 없음";
  const reversalValue = isFiniteNumber(matchData.duelStats?.reversalRate)
    ? formatPercent(matchData.duelStats.reversalRate)
    : "응답 필드 없음";
  const reversalNote = isFiniteNumber(matchData.duelStats?.reversals) && isFiniteNumber(matchData.duelStats?.reversalAttempts)
    ? `${matchData.duelStats.reversals} / ${matchData.duelStats.reversalAttempts}회`
    : undefined;
  const survivalRankValue = survivalBase ? `#${stats.winPlace} / ${survivalBase}` : `#${stats.winPlace}`;
  const survivalRankNote = survivalRankPct !== null
    ? `순위 비율 ${formatPercent(Math.min(1, Math.max(0, survivalRankPct)) * 100)}`
    : undefined;
  const allTeamOpportunityMissing = smokeRate.isOpportunityMissing && reviveRate.isOpportunityMissing && tradeRate.isOpportunityMissing;
  const allTeamOpportunityFieldMissing = smokeRate.isFieldMissing && reviveRate.isFieldMissing && tradeRate.isFieldMissing;
  const tacticalOpportunityItems: TierEvidenceItem[] = allTeamOpportunityFieldMissing
    ? [
        {
          label: "팀 구출 지표",
          value: "응답 필드 없음",
          note: "아군 기절/구출/트레이드 입력값 없음"
        }
      ]
    : allTeamOpportunityMissing
    ? [
        {
          label: "팀 구출 기회",
          value: "기회 없음 보정",
          note: "연막/소생/트레이드 샘플 없음"
        }
      ]
    : [
        {
          label: "연막 구출률",
          value: smokeRate.value,
          note: smokeRate.note
        },
        {
          label: "소생률",
          value: reviveRate.value,
          note: reviveRate.note
        },
        {
          label: "트레이드 성공률",
          value: tradeRate.value,
          note: tradeRate.note
        }
      ];
  const tacticalOpportunitySummary = allTeamOpportunityMissing
    ? "팀 구출 기회 없음 보정"
    : allTeamOpportunityFieldMissing
      ? undefined
      : joinEvidenceSummary([
        !smokeRate.isOpportunityMissing && `구출 ${smokeRate.value}`,
        !reviveRate.isOpportunityMissing && `소생 ${reviveRate.value}`,
        !tradeRate.isOpportunityMissing && `트레이드 ${tradeRate.value}`
      ]);
  const summaryItems: TierEvidenceSummaryItem[] = [
    {
      label: "전투",
      accent: "bg-red-500",
      value: joinEvidenceSummary([
        isDisplayValueAvailable(damageValue) && `딜량 ${damageValue}`,
        isDisplayValueAvailable(initiativeValue)
          ? `선공 ${initiativeValue}`
          : isDisplayValueAvailable(reactionSpeedValue) && `반응 ${reactionSpeedValue}`
      ], "전투 샘플 측정 불가")
    },
    {
      label: "전술",
      accent: "bg-indigo-500",
      value: joinEvidenceSummary([
        isDisplayValueAvailable(pressureValue) && `압박 ${pressureValue}`,
        tacticalOpportunitySummary
      ], "전술 샘플 측정 불가")
    },
    {
      label: "생존",
      accent: "bg-emerald-500",
      value: joinEvidenceSummary([
        `순위 ${survivalRankValue}`,
        isHardEarlyDeath ? "5분 미만 0점 룰" : isEarlyDeath ? "조기 탈락 보정" : "보정 없음"
      ], "생존 샘플 측정 불가")
    }
  ];

  const sections: TierEvidenceSection[] = [
    {
      title: "전투 근거",
      accent: "bg-red-500",
      items: [
        {
          label: "딜량 순위",
          value: damageValue
        },
        {
          label: "선제공격률",
          value: initiativeValue,
          note: isFiniteNumber(initiativeSamples) ? `샘플 ${initiativeSamples}회` : undefined
        },
        {
          label: "대응 사격 속도",
          value: reactionSpeedValue,
          note: !tradeStats?.reactionLatencyMs ? "피격 후 반격 샘플 없음" : undefined
        }
      ]
    },
    {
      title: "전술 근거",
      accent: "bg-indigo-500",
      items: [
        {
          label: "압박 지수",
          value: pressureValue
        },
        ...tacticalOpportunityItems,
        {
          label: "견제 지원",
          value: supportValue,
          note: supportNote
        },
        {
          label: "적 팀 전멸 기여",
          value: teamWipeValue
        },
        {
          label: "역전 승률",
          value: reversalValue,
          note: reversalNote
        },
        {
          label: "고립 페널티",
          value: (matchData.isolationData?.isolationIndex ?? 0) >= 3.5 ? "적용 가능" : "미적용",
          note: isFiniteNumber(matchData.isolationData?.isolationIndex)
            ? `고립 지수 ${matchData.isolationData.isolationIndex.toFixed(1)}`
            : "응답 필드 없음"
        }
      ]
    },
    {
      title: "생존 근거",
      accent: "bg-emerald-500",
      items: [
        {
          label: "생존 순위",
          value: survivalRankValue,
          note: survivalRankNote
        },
        {
          label: "기절 후 생존 관리력",
          value: "응답 필드 없음",
          note: "현재 매치 응답에 피기절 횟수 미포함"
        },
        {
          label: "조기 탈락 보정",
          value: isEarlyDeath ? "적용" : "미적용",
          note: isEarlyDeath ? "10분 미만 또는 3페이즈 이하 사망" : "정상 생존 구간"
        },
        {
          label: "5분 미만 0점 룰",
          value: isHardEarlyDeath ? "적용" : "미적용",
          note: `${Math.floor((stats.timeSurvived || 0) / 60)}분 생존`
        }
      ]
    }
  ];

  return {
    summaryItems,
    sections,
    nextTierText: nextTier ? `다음 ${nextTier.tier} 티어까지 ${nextTier.needed}점` : "최고 티어",
    nextTierNote: nextTier ? "현재 산식 기준" : "S+ 구간 도달"
  };
};

const TierEvidenceSummary = ({ items }: { items: TierEvidenceSummaryItem[] }) => (
  <div className="mt-3 border-t border-white/10 pt-3 md:mt-4 md:pt-4">
    <div className="mb-1.5 text-[10px] font-black text-white/70 md:mb-2">핵심 근거</div>
    <div className="space-y-1 md:space-y-1.5">
      {items.map((item) => (
        <div key={item.label} className="flex items-start gap-2 text-[10px] leading-snug">
          <span className={`mt-1 h-2 w-2 shrink-0 rounded-full ${item.accent}`} />
          <span className="w-8 shrink-0 font-black text-white/80">{item.label}</span>
          <span className="min-w-0 flex-1 text-right font-bold text-white">{item.value}</span>
        </div>
      ))}
    </div>
  </div>
);

const TierEvidenceList = ({ section }: { section: TierEvidenceSection }) => (
  <section aria-label={section.title} className="space-y-2">
    <div className="flex items-center gap-2">
      <span className={`h-3 w-1 rounded-full ${section.accent}`} />
      <span className="text-[10px] font-black text-white/80">{section.title}</span>
    </div>
    <div className="space-y-1.5">
      {section.items.map((item) => (
        <div key={`${section.title}-${item.label}`} className="flex items-start justify-between gap-3 text-[10px] leading-snug">
          <span className="text-gray-500 font-bold shrink-0">{item.label}</span>
          <span className="text-right">
            <span className="block text-white font-black">{item.value}</span>
            {item.note && <span className="block text-[9px] text-gray-500 font-medium mt-0.5">{item.note}</span>}
          </span>
        </div>
      ))}
    </div>
  </section>
);

export const MatchPerformancePanel = ({
  matchData,
  isMobile,
  showTierDetails,
  onToggleTierDetails,
}: {
  matchData: MatchData;
  isMobile: boolean;
  showTierDetails: boolean;
  onToggleTierDetails: () => void;
}) => {
  const benchmark = matchData.benchmark;
  const mode = (matchData.gameMode || "").toLowerCase();
  const mapName = (matchData.mapName || "").toLowerCase();
  const isTdmMatch = mode.includes("tdm")
    || mapName.includes("tdm")
    || matchData.mapName === "PillarCompound_Main"
    || matchData.mapName === "Italy_TDM_Main";
  const scoreMax = !isTdmMatch && mode.includes("solo")
    ? { combat: 50, tactical: 15, survival: 35 }
    : { combat: 40, tactical: 35, survival: 25 };
  const tierEvidence = isTdmMatch ? null : buildTierEvidence(matchData);
  const teamDamageShare = Number(matchData.teamImpact?.teamDamageShare || 0);
  const badges = matchData.badges || [];
  const nextTier = benchmark ? getNextTierInfo(benchmark.score || 0) : null;
  const nextTierTarget = nextTier && benchmark ? benchmark.score + nextTier.needed : 100;

  if (!benchmark && teamDamageShare <= 0 && badges.length === 0) return null;

  return (
    <section aria-label="매치 성과 및 티어 근거" className="rounded-2xl border border-indigo-500/20 bg-indigo-500/5 p-4">
      {(teamDamageShare > 0 || badges.length > 0) && (
        <div className="mb-4 flex flex-wrap items-center gap-2 border-b border-white/10 pb-4">
          {teamDamageShare > 0 && (
            <div className="flex items-center gap-1.5 rounded-full border border-orange-500/20 bg-orange-500/10 px-2.5 py-1 text-[11px] font-black text-orange-400">
              <Flame size={12} aria-hidden="true" />
              <span>팀 {teamDamageShare.toFixed(1)}%</span>
            </div>
          )}
          {badges.map((badge) => (
            <div key={badge.id} className="flex items-center gap-1.5 rounded-full border border-white/10 bg-white/5 px-2.5 py-1 text-[11px] font-bold text-white/70">
              <BgmsIcon name={badge.id === "damage_carry" ? "flame" : "award"} size={13} />
              <span>{badge.name}</span>
            </div>
          ))}
        </div>
      )}

      {benchmark && tierEvidence && (
        <>
          <div className="flex items-center justify-between gap-3">
            <h4 className="text-sm font-black text-indigo-200">티어 산정 근거</h4>
            <span className="rounded-full bg-indigo-500 px-2 py-0.5 text-[10px] font-black text-white">
              안정도 {benchmark.score} / 100
            </span>
          </div>

          <div className="mt-4 grid gap-3 md:grid-cols-3">
            <ScoreBar label="전투" score={benchmark.breakdown.combat} max={scoreMax.combat} color="bg-gradient-to-r from-red-600 to-red-400" />
            <ScoreBar label="전술" score={benchmark.breakdown.tactical} max={scoreMax.tactical} color="bg-gradient-to-r from-indigo-600 to-indigo-400" />
            <ScoreBar label="생존" score={benchmark.breakdown.survival} max={scoreMax.survival} color="bg-gradient-to-r from-emerald-600 to-emerald-400" />
          </div>

          {isFiniteNumber(benchmark.impactScore) && (
            <div className="mt-4 rounded-xl border border-yellow-400/20 bg-yellow-400/10 p-3">
              <div className="flex items-center justify-between gap-3">
                <span className="text-[10px] font-black text-yellow-200">매치 임팩트</span>
                <span className="text-[11px] font-black text-yellow-100 tabular-nums">
                  {benchmark.impactScore} · {getImpactGradeLabel(benchmark.impactGrade)} ({benchmark.impactGrade})
                </span>
              </div>
              {benchmark.impactReasons && benchmark.impactReasons.length > 0 && (
                <p className="mt-1 text-[9px] font-semibold leading-relaxed text-yellow-100/60">
                  {benchmark.impactReasons.slice(0, 3).join(", ")}
                </p>
              )}
            </div>
          )}

          <TierEvidenceSummary items={tierEvidence.summaryItems} />

          <div className="mt-4 rounded-xl border border-amber-500/20 bg-amber-500/10 p-3">
            <div className="flex items-center justify-between gap-3">
              <div className="flex flex-col">
                <span className="text-[9px] font-black text-amber-300/70">다음 티어</span>
                <span className="text-[11px] font-black text-amber-200">{tierEvidence.nextTierText}</span>
              </div>
              <span className="text-right text-[9px] font-bold text-amber-200/50">{tierEvidence.nextTierNote}</span>
            </div>
            {nextTier && (
              <div
                role="progressbar"
                aria-label={`다음 ${nextTier.tier} 티어 진행도`}
                aria-valuemin={0}
                aria-valuemax={nextTierTarget}
                aria-valuenow={benchmark.score}
                className="mt-2 h-1.5 overflow-hidden rounded-full border border-white/10 bg-white/5"
              >
                <div
                  className="h-full bg-gradient-to-r from-amber-600 to-amber-300"
                  style={{ width: `${Math.min(100, (benchmark.score / nextTierTarget) * 100)}%` }}
                />
              </div>
            )}
          </div>

          {isMobile && (
            <button
              type="button"
              aria-expanded={showTierDetails}
              onClick={onToggleTierDetails}
              className="mt-4 flex min-h-11 w-full items-center justify-between rounded-xl border border-white/10 bg-white/5 px-3 py-2 text-[10px] font-black text-white/75 active:scale-[0.99]"
            >
              <span>{showTierDetails ? "상세 근거 접기" : "상세 근거 보기"}</span>
              <ChevronDown size={14} className={`transition-transform ${showTierDetails ? "rotate-180" : ""}`} />
            </button>
          )}

          {(!isMobile || showTierDetails) && (
            <div className="mt-4 space-y-4 border-t border-white/10 pt-4">
              {tierEvidence.sections.map((section) => (
                <TierEvidenceList key={section.title} section={section} />
              ))}
            </div>
          )}
        </>
      )}
    </section>
  );
};

