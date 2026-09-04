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

export function sanitizeBackupCoachingText(text: string, context: BackupCoachingContext): string {
  if (!context.shouldAvoidSlowBackupBlame || context.label !== "교전 정리 후 복구 성공") {
    return text;
  }

  return text
    .replace(/교전 정리 후 복구 성공이라기엔 너무나 느린 방관입니다\./g, "시간은 길었지만 적을 정리하고 소생까지 완료한 성공 복구입니다.")
    .replace(/교전 정리 후 복구 성공이라기엔 너무 느린 방관입니다\./g, "시간은 길었지만 적을 정리하고 소생까지 완료한 성공 복구입니다.")
    .replace(/느린 백업/g, "복구 시간 단축 과제")
    .replace(/느린 방관/g, "복구 시간 단축 과제")
    .replace(/교전 종료 후 소생에 ([0-9.]+초)를 소비하는 것은 치명적이며/g, "교전 정리와 소생까지 $1가 걸린 것은 개선 여지가 있으나 성공 복구였으며")
    .replace(/([0-9.]+초)의 백업 속도는 교전 정리 후 복구 성공이라기엔 너무나 느린/g, "$1의 백업 속도는 교전 정리와 소생까지 완료한 성공 복구지만 더 줄여야 할")
    .replace(/백업 효율 개선/g, "복구 시간 단축")
    .replace(/팀원을 방패로 세운 채/g, "팀 교전 분담이 부족한 상태에서")
    .replace(/팀원을 들러리로 세운/g, "팀 교전 분담이 부족했던")
    .replace(/팀원을 방치하며/g, "팀 교전 분담이 부족한 상태로")
    .replace(/팀원 등쳐먹는/g, "교전 분담 보완이 필요한")
    .replace(/팀원은 당신의 들러리가 아닙니다/g, "강한 캐리력에 협업 지표 보완이 더해져야 합니다")
    .replace(/이기적 독식/g, "교전 독점")
    .replace(/방관/g, "후속 복구");
}
