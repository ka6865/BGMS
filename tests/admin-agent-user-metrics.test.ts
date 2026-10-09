import { describe, expect, it, vi } from "vitest";
import { buildUserMetricsSummary, renderUserMetricsSummaryText } from "@/lib/admin-agent/user-metrics";

describe("admin agent user metrics", () => {
  it("analytics 조회 실패를 정상적인 0건으로 보고하지 않는다", async () => {
    const summary = await buildUserMetricsSummary(createSupabaseMock({
      authUsers: [], profiles: [], analyticsRows: [], analyticsError: { message: "analytics unavailable" }
    }));
    expect(summary.status).toBe("unavailable");
    expect(renderUserMetricsSummaryText(summary)).toContain("조회할 수 없습니다");
    expect(renderUserMetricsSummaryText(summary)).not.toContain("수집 세션 0개");
  });

  it("조회에 성공한 빈 집계는 정상적인 0건이다", async () => {
    const summary = await buildUserMetricsSummary(createSupabaseMock({ authUsers: [], profiles: [], analyticsRows: [] }));
    expect(summary.status).toBe("ready");
    expect(renderUserMetricsSummaryText(summary)).toContain("수집 세션 0개");
  });

  it("서버가 요청 상한보다 적은 행을 반환해도 전체 건수와 비교해 부분 집계를 표시한다", async () => {
    const summary = await buildUserMetricsSummary(createSupabaseMock({
      authUsers: [], profiles: [], analyticsRows: [{ event_name: "page_view", session_id: "session-1", user_id: null,
        page_path: "/", params: {}, created_at: new Date().toISOString() }], analyticsCount: 1001
    }));
    expect(summary.status).toBe("partial");
    expect(summary.activity.analyticsEvents).toBe(1);
    expect(renderUserMetricsSummaryText(summary)).toContain("부분 집계");
  });

  it("전체 profile 건수를 알 수 없으면 누락이나 고아 계정을 확정하지 않는다", async () => {
    const summary = await buildUserMetricsSummary(createSupabaseMock({
      authUsers: [{ id: "missing-profile" }],
      profiles: [{ id: "missing-auth", nickname: "회원", role: "user", pubg_nickname: null, last_active_at: null, updated_at: null }],
      analyticsRows: [], profileCount: null
    }));
    expect(summary.status).toBe("partial");
    expect(summary.notes.join(" ")).not.toMatch(/profiles 누락|Auth에 없는 profiles/);
    expect(renderUserMetricsSummaryText(summary)).toMatch(/^부분 집계입니다/);
  });

  it("Auth 조회가 20페이지 상한에 걸리면 전체 가입자 수로 보고하지 않는다", async () => {
    const supabase = createSupabaseMock({ authUsers: Array.from({ length: 20001 }, (_, index) => ({ id: `auth-${index}` })), profiles: [], analyticsRows: [] });
    const summary = await buildUserMetricsSummary(supabase);
    expect(supabase.auth.admin.listUsers).toHaveBeenCalledTimes(20);
    expect(summary.status).toBe("partial");
    expect(summary.accounts.authUsers).toBe(20000);
    expect(summary.notes.join(" ")).not.toContain("profiles 누락");
  });

  it("부분 프로필에서 역할을 확인하지 못한 관리자를 회원 활동에 넣지 않는다", async () => {
    const now = new Date().toISOString();
    const summary = await buildUserMetricsSummary(createSupabaseMock({
      authUsers: ["known-member", "known-admin", "unreturned-admin"].map((id) => ({ id, last_sign_in_at: now })),
      profiles: [{ id: "known-member", role: "user" }, { id: "known-admin", role: "admin" }], profileCount: 3,
      analyticsRows: ["known-member", "known-admin", "unreturned-admin", null].map((user_id, index) => ({ event_name: "page_view", session_id: `session-${index}`, user_id, page_path: "/", params: {}, created_at: now }))
    }));
    expect(summary.status).toBe("partial");
    expect(summary.activity).toMatchObject({ authSignedInUsers: 1, analyticsEvents: 2, analyticsLoggedInUsers: 1, analyticsMemberSessions: 1, analyticsGuestSessions: 1 });
    expect(summary.notes.join(" ")).toContain("역할을 확인하지 못한 회원 이벤트와 로그인 기록");
  });

  it.each(["Auth", "profiles"])("%s 조회 오류는 조회 불가로 보고한다", async (source) => {
    const supabase = createSupabaseMock({ authUsers: [], profiles: [], analyticsRows: [], profileError: source === "profiles" ? { message: "profiles failed" } : undefined });
    if (source === "Auth") supabase.auth.admin.listUsers.mockResolvedValue({ data: { users: [] }, error: { message: "auth failed" } } as any);
    const summary = await buildUserMetricsSummary(supabase);
    expect(summary.status).toBe("unavailable");
    expect(renderUserMetricsSummaryText(summary)).not.toContain("수집 세션 0개");
  });

  it("전적 검색 대상 닉네임과 로그인 활동 회원을 분리한다", async () => {
    const supabase = createSupabaseMock({
      authUsers: [
        { id: "user-1", email: "user@example.com", created_at: new Date().toISOString(), last_sign_in_at: null }
      ],
      profiles: [
        {
          id: "user-1",
          nickname: "갱얼둥",
          role: "user",
          pubg_nickname: "KangHeeSung_",
          last_active_at: null,
          updated_at: null
        }
      ],
      analyticsRows: [
        {
          event_name: "page_view",
          session_id: "guest-session",
          user_id: null,
          page_path: "/stats/steam/KangHeeSung_",
          params: {},
          created_at: new Date().toISOString()
        },
        {
          event_name: "stats_searched",
          session_id: "guest-session",
          user_id: null,
          page_path: "/stats",
          params: { nickname: "KangHeeSung_", platform: "steam" },
          created_at: new Date().toISOString()
        }
      ]
    });

    const summary = await buildUserMetricsSummary(supabase, 24);
    const text = renderUserMetricsSummaryText(summary);

    expect(summary.activity.analyticsLoggedInUsers).toBe(0);
    expect(summary.topSearchedTargets[0]).toMatchObject({
      nickname: "KangHeeSung_",
      platform: "steam",
      count: 2,
      matchingProfileLabels: ["갱얼둥"]
    });
    expect(text).toContain("이 값은 조회 대상 닉네임이며 해당 회원의 로그인 활동으로 해석하지 않습니다.");
  });
});

function createSupabaseMock(input: {
  authUsers: any[];
  profiles: any[];
  analyticsRows: any[];
  analyticsError?: { message: string };
  analyticsCount?: number;
  profileCount?: number | null;
  profileError?: { message: string };
}) {
  return {
    auth: {
      admin: {
        listUsers: vi.fn(async ({ page, perPage }: { page: number; perPage: number }) => ({ data: { users: input.authUsers.slice((page - 1) * perPage, page * perPage) }, error: null as any }))
      }
    },
    from(table: string) {
      const chain: any = {
        select: vi.fn(() => chain),
        gte: vi.fn(() => chain),
        order: vi.fn(() => chain),
        range: vi.fn(async () => ({ data: table === "profiles" ? input.profiles : [], error: input.profileError || null,
          count: input.profileCount === undefined ? input.profiles.length : input.profileCount })),
        limit: vi.fn(async () => ({ data: table === "analytics_events" ? input.analyticsRows : [],
          error: input.analyticsError || null, count: input.analyticsCount ?? input.analyticsRows.length }))
      };
      return chain;
    }
  };
}
