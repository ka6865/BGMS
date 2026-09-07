import { describe, expect, it } from "vitest";
import { buildMembershipTimeline, getMembershipWindowStart, kstDateKey } from "@/lib/admin-agent/membership-timeline";

describe("admin membership timeline", () => {
  it("retains first-day observed events while marking the period partial", () => {
    const timeline = buildMembershipTimeline([], {
      windowDays: 7, status: "ready", currentMembers: 10,
      collectionStartedAt: "2026-09-07T01:00:00Z",
      now: new Date("2026-09-07T03:00:00Z"),
      dailyRows: [{ event_date: "2026-09-07", signups: 3, deletions: 1 }],
    });
    expect(timeline.periodCoverage).toBe("partial");
    expect(timeline.periodSignups).toBe(3);
    expect(timeline.periodDeletions).toBe(1);
    expect(timeline.points.at(-1)).toMatchObject({ signups: 3, deletions: 1, net: 2 });
    expect(timeline.points[0].signups).toBeNull();
    expect(timeline.notes.join(" ")).toContain("시각 이후 관측분만 포함");
  });

  it("aggregates signup and deletion events by KST date without reconstructing a member curve", () => {
    const timeline = buildMembershipTimeline([
      { event_type: "signup", occurred_at: "2026-09-06T15:10:00.000Z" }, // Sep 7 KST
      { event_type: "deletion", occurred_at: "2026-09-06T16:10:00.000Z" },
      { event_type: "signup", occurred_at: "2026-09-05T15:10:00.000Z" }, // Sep 6 KST
    ], {
      windowDays: 7,
      currentMembers: 12,
      status: "ready",
      collectionStartedAt: "2026-08-31T15:00:00.000Z",
      now: new Date("2026-09-07T03:00:00.000Z")
    });

    expect(timeline.currentMembers).toBe(12);
    expect(timeline.periodSignups).toBe(2);
    expect(timeline.periodDeletions).toBe(1);
    expect(timeline.netChange).toBe(1);
    expect(timeline.periodCoverage).toBe("complete");
    expect(timeline.points.find((point) => point.date === "2026-09-07")).toMatchObject({ signups: 1, deletions: 1, net: 0 });
    expect(timeline.points.find((point) => point.date === "2026-09-06")).toMatchObject({ signups: 1, deletions: 0, net: 1 });
    expect(timeline.notes.join(" ")).toContain("재구성하지 않습니다");
  });

  it("marks missing lifecycle storage unavailable and leaves historical totals unknown", () => {
    const timeline = buildMembershipTimeline([], { windowDays: 30, currentMembers: 5, status: "unavailable", now: new Date("2026-09-07T03:00:00.000Z") });
    expect(timeline.periodSignups).toBeNull();
    expect(timeline.periodDeletions).toBeNull();
    expect(timeline.netChange).toBeNull();
    expect(timeline.deletionHistoryAvailable).toBe(false);
    expect(timeline.periodCoverage).toBe("none");
    expect(timeline.notes.join(" ")).toContain("추정하지 않습니다");
  });

  it("leaves dates before the capture start as unknown instead of zero", () => {
    const timeline = buildMembershipTimeline([
      { event_type: "signup", occurred_at: "2026-09-06T15:10:00.000Z" },
    ], {
      windowDays: 7,
      status: "ready",
      collectionStartedAt: "2026-09-05T15:00:00.000Z",
      now: new Date("2026-09-07T03:00:00.000Z")
    });
    expect(timeline.periodCoverage).toBe("partial");
    expect(timeline.points.find((point) => point.date === "2026-09-05")).toMatchObject({ signups: null, deletions: null, net: null });
    expect(timeline.notes.join(" ")).toContain("미수집(null)");
  });

  it("accepts DB daily aggregates without rebuilding a member-count curve", () => {
    const timeline = buildMembershipTimeline([], {
      windowDays: 7,
      status: "ready",
      collectionStartedAt: "2026-08-31T15:00:00.000Z",
      dailyRows: [{ event_date: "2026-09-07", signups: 4, deletions: 2 }],
      currentMembers: 20,
      now: new Date("2026-09-07T03:00:00.000Z")
    });
    expect(timeline.periodSignups).toBe(4);
    expect(timeline.periodDeletions).toBe(2);
    expect(timeline.points.find((point) => point.date === "2026-09-07")).toMatchObject({ signups: 4, deletions: 2, net: 2 });
    expect(timeline.currentMembers).toBe(20);
  });

  it("uses KST date boundaries for the selected window", () => {
    const now = new Date("2026-09-07T03:00:00.000Z");
    const start = getMembershipWindowStart(now, 7);
    expect(kstDateKey(start)).toBe("2026-09-01");
    expect(kstDateKey(new Date(start.getTime() + 6 * 24 * 60 * 60 * 1000))).toBe("2026-09-07");
  });
});
