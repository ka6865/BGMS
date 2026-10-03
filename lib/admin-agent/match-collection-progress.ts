export type MatchCollectionProgressInput = {
  waitingCount: number;
  runningCount: number;
  readyCount: number;
  oldestQueuedAt: string | null;
  lastSavedAt: string | null;
  lastProgressAt: string | null;
  lastRetryScheduledAt: string | null;
  nowMs?: number;
};

export function buildMatchCollectionProgress(input: MatchCollectionProgressInput) {
  const waitingCount = Math.max(0, input.waitingCount);
  const runningCount = Math.max(0, input.runningCount);
  const nowMs = input.nowMs ?? Date.now();
  const staleCutoff = nowMs - 60 * 60 * 1000;
  const oldestQueuedMs = input.oldestQueuedAt ? Date.parse(input.oldestQueuedAt) : NaN;
  const lastProgressMs = input.lastProgressAt ? Date.parse(input.lastProgressAt) : NaN;
  const stalled = input.readyCount > 0
    && runningCount === 0
    && Number.isFinite(oldestQueuedMs)
    && oldestQueuedMs <= staleCutoff
    && (!Number.isFinite(lastProgressMs) || lastProgressMs <= staleCutoff);

  return {
    available: true as const,
    status: stalled ? "stalled" as const : runningCount > 0 ? "processing" as const : waitingCount > 0 ? "queued" as const : "clear" as const,
    waitingCount,
    runningCount,
    readyCount: input.readyCount,
    oldestQueuedAt: input.oldestQueuedAt,
    lastSavedAt: input.lastSavedAt,
    lastProgressAt: input.lastProgressAt,
    lastRetryScheduledAt: input.lastRetryScheduledAt,
    stalled
  };
}
