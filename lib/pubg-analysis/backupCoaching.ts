import { sanitizeAiCoachingLanguageText } from "./aiCoachingQuality";

export type BackupCoachingTier = "S" | "A" | "B" | "C";

export interface BackupCoachingInput {
  avgBackupLatency: string;
  totalTradeKills?: number;
  totalRevCount?: number;
  totalSmokeRescues?: number;
  totalTeamWipes?: number;
  totalTeammateKnocks?: number;
  benchmarkTradeLatency?: number;
}

export interface BackupCoachingContext {
  measured: boolean;
  latencySeconds: number | null;
  label: string;
  tier: BackupCoachingTier;
  promptLine: string;
  shouldAvoidSlowBackupBlame: boolean;
}

export function parseBackupLatencySeconds(value: string): number | null {
  const parsed = Number.parseFloat(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function getBaselineTier(seconds: number): BackupCoachingTier {
  if (seconds < 10) return "S";
  if (seconds < 14) return "A";
  if (seconds < 18) return "B";
  return "C";
}

export function buildBackupCoachingContext(input: BackupCoachingInput): BackupCoachingContext {
  const seconds = parseBackupLatencySeconds(input.avgBackupLatency);
  if (seconds === null) {
    return {
      measured: false,
      latencySeconds: null,
      label: "측정 불가",
      tier: "C",
      shouldAvoidSlowBackupBlame: true,
      promptLine: "백업 속도 샘플이 없으므로 느린 백업 또는 빠른 백업으로 추론하지 말 것",
    };
  }

  const tradeKills = input.totalTradeKills || 0;
  const revives = input.totalRevCount || 0;
  const smokeRescues = input.totalSmokeRescues || 0;
  const teamWipes = input.totalTeamWipes || 0;
  const teammateKnocks = input.totalTeammateKnocks || 0;
  // A missing benchmark must not turn into an invented comparison value in
  // the coaching prompt.  Keep the historical 12s threshold only for the
  // internal tiering decision; the emitted text explicitly says when the
  // comparison sample is unavailable.
  const benchmark = Number.isFinite(input.benchmarkTradeLatency)
    ? Number(input.benchmarkTradeLatency)
    : null;
  const hasSuccessfulRecovery = revives > 0 || smokeRescues > 0;
  const hasFightResolution = tradeKills > 0 || teamWipes > 0;
  const slowByTime = seconds > Math.max(18, (benchmark ?? 12) + 4);
  const outcomeSucceeded = slowByTime && hasSuccessfulRecovery && hasFightResolution;

  if (outcomeSucceeded) {
    return {
      measured: true,
      latencySeconds: seconds,
      label: "교전 정리 후 복구 성공",
      tier: seconds < 24 ? "B" : "C",
      shouldAvoidSlowBackupBlame: true,
      promptLine: `${input.avgBackupLatency}로 시간만 보면 느리지만, 적 제압 ${tradeKills}회/전멸 기여 ${teamWipes}회와 소생 ${revives}회/연막 구출 ${smokeRescues}회가 함께 있으므로 느린 백업이라고 단정하지 말 것. 교전 정리 후 복구 성공으로 평가하되, 다음에는 복구 시간을 줄이는 보완점만 제시할 것`,
    };
  }

  if (slowByTime) {
    return {
      measured: true,
      latencySeconds: seconds,
      label: "백업 지연 위험",
      tier: "C",
      shouldAvoidSlowBackupBlame: false,
      promptLine: benchmark === null
        ? `${input.avgBackupLatency} 백업 속도는 측정됐지만 비교 표본이 없어 기준 대비 우열을 판단하지 말 것. 적 제압/소생 성공 맥락이 부족하므로 백업 지연 위험으로 평가할 것`
        : `${input.avgBackupLatency}로 비교 표본 평균 ${benchmark}s보다 늦고, 적 제압/소생 성공 맥락이 부족하므로 백업 지연 위험으로 평가할 것`,
    };
  }

  const baselineTier = getBaselineTier(seconds);
  const recoveryText = teammateKnocks > 0
    ? `아군 기절 ${teammateKnocks}회 중 소생 ${revives}회, 적 제압 ${tradeKills}회`
    : `소생 ${revives}회, 적 제압 ${tradeKills}회`;

  return {
    measured: true,
    latencySeconds: seconds,
    label: baselineTier === "S" || baselineTier === "A" ? "신속한 백업" : "개선 여지 있는 백업",
    tier: baselineTier,
    shouldAvoidSlowBackupBlame: false,
    promptLine: `${input.avgBackupLatency} 백업 속도와 ${recoveryText}를 함께 평가할 것`,
  };
}

// Keep the existing call contract, but never turn blame into a new causal
// story from aggregate recovery counts. Context belongs in the prompt;
// unsupported output is withheld by the shared prose policy.
export const sanitizeBackupCoachingText: (text: string, context: BackupCoachingContext) => string = sanitizeAiCoachingLanguageText;
