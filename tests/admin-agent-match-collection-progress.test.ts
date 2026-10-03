import { describe, expect, it } from "vitest";
import { buildMatchCollectionProgress } from "@/lib/admin-agent/match-collection-progress";

describe("admin agent match collection progress", () => {
  const nowMs = Date.parse("2026-10-04T00:00:00.000Z");

  it("reports old queued work as stalled only when there is no recent worker progress", () => {
    const progress = buildMatchCollectionProgress({
      waitingCount: 12,
      runningCount: 0,
      readyCount: 12,
      oldestQueuedAt: "2026-10-03T20:00:00.000Z",
      lastSavedAt: "2026-10-03T21:00:00.000Z",
      lastProgressAt: "2026-10-03T21:00:00.000Z",
      lastRetryScheduledAt: null,
      nowMs
    });

    expect(progress.status).toBe("stalled");
    expect(progress.stalled).toBe(true);
  });

  it("counts recent unavailable settlement and retry scheduling as progress", () => {
    const progress = buildMatchCollectionProgress({
      waitingCount: 12,
      runningCount: 0,
      readyCount: 12,
      oldestQueuedAt: "2026-10-03T20:00:00.000Z",
      lastSavedAt: "2026-10-03T19:00:00.000Z",
      lastProgressAt: "2026-10-03T23:30:00.000Z",
      lastRetryScheduledAt: "2026-10-04T03:00:00.000Z",
      nowMs
    });

    expect(progress.status).toBe("queued");
    expect(progress.stalled).toBe(false);
  });

  it("reports a running worker as processing without a stall warning", () => {
    const progress = buildMatchCollectionProgress({
      waitingCount: 12,
      runningCount: 2,
      readyCount: 12,
      oldestQueuedAt: "2026-10-03T18:00:00.000Z",
      lastSavedAt: null,
      lastProgressAt: null,
      lastRetryScheduledAt: null,
      nowMs
    });

    expect(progress.status).toBe("processing");
    expect(progress.stalled).toBe(false);
  });

  it("does not treat a future retry reservation as progress for other due work", () => {
    expect(buildMatchCollectionProgress({ waitingCount: 12, runningCount: 0, readyCount: 1,
      oldestQueuedAt: "2026-10-03T18:00:00.000Z", lastSavedAt: null, lastProgressAt: null,
      lastRetryScheduledAt: "2026-10-04T06:00:00.000Z", nowMs }).stalled).toBe(true);
  });

  it("allows scheduled backoff when no collection job is ready yet", () => {
    expect(buildMatchCollectionProgress({ waitingCount: 12, runningCount: 0, readyCount: 0,
      oldestQueuedAt: "2026-10-03T18:00:00.000Z", lastSavedAt: null, lastProgressAt: null,
      lastRetryScheduledAt: "2026-10-04T06:00:00.000Z", nowMs }).status).toBe("queued");
  });
});
