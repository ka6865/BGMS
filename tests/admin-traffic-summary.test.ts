import { describe, expect, it, vi } from "vitest";
import {
  buildTrafficSummary,
  buildUnavailableTrafficSummary,
  renderTrafficSummaryText,
  TRAFFIC_EVENT_ROW_LIMIT
} from "@/lib/admin-agent/traffic-summary";

function createSupabaseMock(rows: any[], profiles: any[] = []) {
  const analyticsLimit = vi.fn(async (filteredRows: any[], limit?: number) => ({ data: filteredRows.slice(0, limit ?? filteredRows.length), error: null }));
  return {
    analyticsLimit,
    client: {
      from(table: string) {
        if (table === "profiles") {
          const chain: any = {
            select: vi.fn(() => chain),
            in: vi.fn(async () => ({ data: profiles, error: null }))
          };
          return chain;
        }
        // DB 처럼 eq("is_internal", ...) 조건으로 행을 거르고, head 조회는 건수만 돌려준다.
        const state: { internal?: boolean; head: boolean } = { head: false };
        const filtered = () => rows.filter((row) =>
          state.internal === undefined ? true : (row.is_internal === true) === state.internal);
        const chain: any = {
          select: vi.fn((_columns?: string, options?: { head?: boolean }) => { state.head = Boolean(options?.head); return chain; }),
          eq: vi.fn((column: string, value: unknown) => { if (column === "is_internal") state.internal = value === true; return chain; }),
          gte: vi.fn(() => chain),
          order: vi.fn(() => chain),
          limit: vi.fn((limit: number) => analyticsLimit(filtered(), limit)),
          then: (resolve: (value: unknown) => unknown, reject?: (reason: unknown) => unknown) =>
            Promise.resolve(state.head ? { count: filtered().length, error: null } : { data: [], error: null }).then(resolve, reject)
        };
        return chain;
      }
    }
  };
}

function event(overrides: Record<string, unknown> = {}) {
  return {
    event_name: "page_view",
    session_id: "session-1",
    user_id: null,
    page_path: "/",
    params: {},
    created_at: new Date().toISOString(),
    is_internal: false,
    ...overrides
  };
}

describe("admin traffic summary", () => {
  it("내부(is_internal=true) 이벤트를 운영 지표에서 빼고 제외 건수를 따로 보고한다", async () => {
    const { client } = createSupabaseMock([
      event({ session_id: "prod-1" }),
      event({ session_id: "prod-2", is_internal: null }),
      event({ session_id: "local-1", is_internal: true, page_path: "/maps" }),
      event({ session_id: "local-1", is_internal: true, event_name: "stats_searched" })
    ]);

    const summary = await buildTrafficSummary(client, 24);
    const text = renderTrafficSummaryText(summary);

    expect(summary.status).toBe("ready");
    expect(summary.current.totalEvents).toBe(2);
    expect(summary.current.uniqueSessions).toBe(2);
    expect(summary.current.statsSearches).toBe(0);
    expect(summary.current.topPages).toEqual([{ label: "/", count: 2 }]);
    expect(summary.internalEventsExcluded).toBe(2);
    expect(summary.truncated).toBe(false);
    expect(summary.highlights.join(" ")).toContain("내부(로컬/개발) 이벤트 2건");
    expect(text).toContain("내부(로컬/개발) 이벤트 2건은 운영 지표에서 제외했습니다.");
  });

  it("내부 이벤트만 있으면 empty 로 보고하되 제외 건수를 남긴다", async () => {
    const { client } = createSupabaseMock([event({ is_internal: true })]);

    const summary = await buildTrafficSummary(client, 24);

    expect(summary.status).toBe("empty");
    expect(summary.internalEventsExcluded).toBe(1);
    expect(renderTrafficSummaryText(summary)).toContain("내부(로컬/개발) 이벤트 1건");
  });

  it("조회 상한에 도달하면 truncated 로 표시하고 최소값으로 해석하라고 안내한다", async () => {
    const rows = Array.from({ length: TRAFFIC_EVENT_ROW_LIMIT }, (_, index) => event({ session_id: `s-${index % 50}` }));
    const { client, analyticsLimit } = createSupabaseMock(rows);

    const summary = await buildTrafficSummary(client, 24);

    expect(analyticsLimit).toHaveBeenCalledWith(expect.any(Array), TRAFFIC_EVENT_ROW_LIMIT);
    expect(summary.truncated).toBe(true);
    expect(renderTrafficSummaryText(summary)).toContain("최소값");
  });

  it("조회 불가 결과는 같은 모양을 유지한다", () => {
    const summary = buildUnavailableTrafficSummary(168, "실패");

    expect(summary).toMatchObject({ status: "unavailable", windowHours: 168, truncated: false, internalEventsExcluded: 0, error: "실패" });
    expect(summary.current.totalEvents).toBe(0);
  });
});
