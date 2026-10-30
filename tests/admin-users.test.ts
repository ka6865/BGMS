import { describe, it, expect, vi, beforeEach } from "vitest";

const {
  mockAdminClient,
  mockDeleteUser,
  mockListUsers,
  mockProfileMaybeSingle,
  mockProfileDeleteEq,
  mockProfilesRange,
  mockSaveProfile,
  mockAiUsageLimit,
  mockAdminCount,
  mockAuditInsert
} = vi.hoisted(() => {
  const mockDeleteUser = vi.fn().mockResolvedValue({ error: null });
  const mockListUsers = vi.fn().mockResolvedValue({
    data: { users: [{ id: "target-user" }] },
    error: null
  });
  const mockProfileMaybeSingle = vi.fn().mockResolvedValue({ data: { id: "target-user", role: "user" }, error: null });
  const mockProfileDeleteEq = vi.fn().mockResolvedValue({ data: null, error: null });
  const mockProfilesRange = vi.fn().mockResolvedValue({ data: [], error: null });
  const mockAiUsageLimit = vi.fn().mockResolvedValue({ data: [], error: null });
  // 관리자 수 count(head) 조회 결과
  const mockAdminCount = vi.fn().mockReturnValue({ count: 2, error: null });
  const mockAuditInsert = vi.fn().mockResolvedValue({ data: null, error: null });
  const aiUsageChain = { select: vi.fn().mockReturnThis(), gte: vi.fn().mockReturnThis(), order: vi.fn().mockReturnThis(), limit: mockAiUsageLimit };
  const mockSaveProfile = vi.fn().mockResolvedValue({ data: null, error: null });
  const adminProfileSelectChain: any = {
    maybeSingle: mockProfileMaybeSingle,
    range: mockProfilesRange,
    then: (resolve: (value: unknown) => unknown, reject?: (reason: unknown) => unknown) =>
      Promise.resolve(mockAdminCount()).then(resolve, reject)
  };
  adminProfileSelectChain.select = vi.fn(() => adminProfileSelectChain);
  adminProfileSelectChain.eq = vi.fn(() => adminProfileSelectChain);
  const adminProfileDeleteChain = {
    eq: mockProfileDeleteEq
  };
  const adminProfilesTable = {
    select: vi.fn(() => adminProfileSelectChain),
    delete: vi.fn(() => adminProfileDeleteChain)
  };
  const auditTable = { insert: mockAuditInsert };
  const mockAdminClient = {
    rpc: mockSaveProfile,
    auth: {
      admin: {
        listUsers: mockListUsers,
        deleteUser: mockDeleteUser
      }
    },
    from: vi.fn((table: string) => table === "ai_usage_logs"
      ? aiUsageChain
      : table === "admin_audit_events" ? auditTable : adminProfilesTable)
  };

  return {
    mockAdminClient,
    mockDeleteUser,
    mockListUsers,
    mockProfileMaybeSingle,
    mockProfileDeleteEq,
    mockProfilesRange,
    mockSaveProfile,
    mockAiUsageLimit,
    mockAdminCount,
    mockAuditInsert
  };
});

vi.mock("@/lib/server/adminGuard", () => ({
  requireAdmin: vi.fn(async () => ({
    ok: true,
    user: { id: "admin-user" },
    supabaseAdmin: mockAdminClient,
    nickname: "관리자"
  }))
}));

import { DELETE, GET, POST } from "../app/api/admin/users/route";

describe("admin users API", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockAiUsageLimit.mockResolvedValue({ data: [], error: null });
    process.env.NEXT_PUBLIC_SUPABASE_URL = "https://example.supabase.co";
    process.env.SUPABASE_SERVICE_ROLE_KEY = "service-role-key";
    mockListUsers.mockResolvedValue({
      data: { users: [{ id: "target-user" }] },
      error: null
    });
    mockDeleteUser.mockResolvedValue({ error: null });
    mockProfileMaybeSingle.mockResolvedValue({ data: { id: "target-user", role: "user" }, error: null });
    mockAdminCount.mockReturnValue({ count: 2, error: null });
    mockAuditInsert.mockResolvedValue({ data: null, error: null });
    mockProfileDeleteEq.mockResolvedValue({ data: null, error: null });
    mockProfilesRange.mockResolvedValue({ data: [], error: null });
    mockSaveProfile.mockResolvedValue({ data: null, error: null });
  });

  it("회원 상세에서도 부분 완료 건수와 검증 탈락 사유를 유지한다", async () => {
    mockAiUsageLimit.mockResolvedValue({ data: [{ user_id: "target-user", status: "partial", error_code: "validation", error_message: "utility:conclusion", created_at: new Date().toISOString() }], error: null });
    const response = await GET(new Request("http://localhost/api/admin/users"));
    const body = await response.json();
    expect(response.status).toBe(200);
    expect(body.users.find((user: { id: string }) => user.id === "target-user").activity7d).toMatchObject({
      aiRequests: 1, aiSuccessCount: 1, aiPartialCount: 1, aiFailedCount: 0, aiSuccessRate: 100,
      aiErrors: [{ code: "validation", count: 1 }],
      aiRecentErrors: [{ status: "partial", code: "validation", message: "utility:conclusion" }],
    });
  });

  it("회원 상세의 취소 요청은 비용을 유지하고 실패에서 제외한다", async () => {
    mockAiUsageLimit.mockResolvedValue({ data: [{ user_id: "target-user", status: "cancelled", error_code: "cancelled", cost_usd: 0.01, created_at: new Date().toISOString() }], error: null });
    const response = await GET(new Request("http://localhost/api/admin/users"));
    const body = await response.json();
    expect(body.users.find((user: { id: string }) => user.id === "target-user").activity7d).toMatchObject({
      aiRequests: 1, aiSuccessCount: 0, aiPartialCount: 0, aiCancelledCount: 1, aiFailedCount: 0, aiCostUsd: 0.01, aiErrors: [], aiRecentErrors: [],
    });
  });

  it("회원 프로필 저장을 역할과 선택 필드가 보존되는 단일 RPC로 처리한다", async () => {
    const response = await POST(new Request("http://localhost/api/admin/users", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        id: "target-user",
        role: "admin",
        pubg_nickname: "Player",
        pubg_platform: "steam"
      })
    }));

    expect(response.status).toBe(200);
    expect(mockSaveProfile).toHaveBeenCalledWith("save_admin_profile", {
      p_user_id: "target-user",
      p_profile: { role: "admin", pubg_nickname: "Player", pubg_platform: "steam" }
    });
  });

  it("잘못된 역할은 DB 호출 전에 거부한다", async () => {
    const response = await POST(new Request("http://localhost/api/admin/users", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id: "target-user", role: "owner" })
    }));

    expect(response.status).toBe(400);
    expect(mockSaveProfile).not.toHaveBeenCalled();
  });

  it("Auth 유저 삭제 후 profiles 행도 명시적으로 삭제한다", async () => {
    const response = await DELETE(new Request("http://localhost/api/admin/users?id=target-user", { method: "DELETE" }));
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(mockDeleteUser).toHaveBeenCalledWith("target-user");
    expect(mockProfileDeleteEq).toHaveBeenCalledWith("id", "target-user");
    expect(body).toEqual({
      success: true,
      deletedAuthUser: true,
      deletedProfile: true
    });
  });

  it("Auth가 없는 유령 프로필도 profiles에서 정리할 수 있다", async () => {
    mockListUsers.mockResolvedValueOnce({ data: { users: [] }, error: null });

    const response = await DELETE(new Request("http://localhost/api/admin/users?id=orphan-profile", { method: "DELETE" }));
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(mockDeleteUser).not.toHaveBeenCalled();
    expect(mockProfileDeleteEq).toHaveBeenCalledWith("id", "orphan-profile");
    expect(body.deletedAuthUser).toBe(false);
    expect(body.deletedProfile).toBe(true);
  });

  it("현재 로그인한 관리자 본인 계정 삭제는 막는다", async () => {
    const response = await DELETE(new Request("http://localhost/api/admin/users?id=admin-user", { method: "DELETE" }));
    const body = await response.json();

    expect(response.status).toBe(400);
    expect(body.error).toContain("현재 로그인한 관리자 계정");
    expect(mockDeleteUser).not.toHaveBeenCalled();
    expect(mockProfileDeleteEq).not.toHaveBeenCalled();
  });

  it("삭제 대상 Auth 유저가 첫 페이지 뒤에 있어도 찾아서 삭제한다", async () => {
    mockListUsers
      .mockResolvedValueOnce({
        data: { users: Array.from({ length: 1000 }, (_, index) => ({ id: `page-1-user-${index}` })) },
        error: null
      })
      .mockResolvedValueOnce({
        data: { users: [{ id: "target-user" }] },
        error: null
      });

    const response = await DELETE(new Request("http://localhost/api/admin/users?id=target-user", { method: "DELETE" }));
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(mockListUsers).toHaveBeenNthCalledWith(1, { page: 1, perPage: 1000 });
    expect(mockListUsers).toHaveBeenNthCalledWith(2, { page: 2, perPage: 1000 });
    expect(mockDeleteUser).toHaveBeenCalledWith("target-user");
    expect(body.deletedAuthUser).toBe(true);
  });

  it("관리자 목록 조회 시 profiles도 페이지네이션으로 전체 조회한다", async () => {
    mockProfilesRange
      .mockResolvedValueOnce({
        data: Array.from({ length: 1000 }, (_, index) => ({
          id: `profile-${index}`,
          nickname: `Profile ${index}`,
          role: "user"
        })),
        error: null
      })
      .mockResolvedValueOnce({
        data: [{ id: "target-user", nickname: "Target", role: "user" }],
        error: null
      });

    const response = await GET(new Request("http://localhost/api/admin/users"));

    expect(response.status).toBe(200);
    expect(mockProfilesRange).toHaveBeenNthCalledWith(1, 0, 999);
    expect(mockProfilesRange).toHaveBeenNthCalledWith(2, 1000, 1999);
  });

  it("관리자 역할 계정은 강등 전에는 삭제하지 않는다", async () => {
    mockProfileMaybeSingle.mockResolvedValueOnce({ data: { id: "other-admin", role: "admin" }, error: null });

    const response = await DELETE(new Request("http://localhost/api/admin/users?id=other-admin", { method: "DELETE" }));
    const body = await response.json();

    expect(response.status).toBe(400);
    expect(body.error).toContain("관리자 계정은 삭제할 수 없습니다");
    expect(mockDeleteUser).not.toHaveBeenCalled();
    expect(mockProfileDeleteEq).not.toHaveBeenCalled();
  });

  it("회원 삭제는 실행 전후로 감사 로그를 남긴다", async () => {
    const response = await DELETE(new Request("http://localhost/api/admin/users?id=target-user", { method: "DELETE" }));

    expect(response.status).toBe(200);
    const phases = mockAuditInsert.mock.calls.map(([row]) => row.detail.phase);
    expect(phases).toEqual(["requested", "succeeded"]);
    expect(mockAuditInsert.mock.calls[0][0]).toMatchObject({ actor_id: "admin-user", action: "users.delete", target_type: "user", target_id: "target-user" });
  });

  it("삭제 실패 응답에 DB 원문 오류를 노출하지 않는다", async () => {
    mockDeleteUser.mockResolvedValueOnce({ error: { message: "internal auth detail" } });

    const response = await DELETE(new Request("http://localhost/api/admin/users?id=target-user", { method: "DELETE" }));
    const body = await response.json();

    expect(response.status).toBe(500);
    expect(body.error).not.toContain("internal auth detail");
    expect(mockAuditInsert.mock.calls.map(([row]) => row.detail.phase)).toEqual(["requested", "failed"]);
  });

  it("현재 로그인한 관리자 본인의 강등은 막는다", async () => {
    mockProfileMaybeSingle.mockResolvedValueOnce({ data: { id: "admin-user", role: "admin" }, error: null });

    const response = await POST(new Request("http://localhost/api/admin/users", {
      method: "POST",
      body: JSON.stringify({ id: "admin-user", role: "user" })
    }));
    const body = await response.json();

    expect(response.status).toBe(400);
    expect(body.error).toContain("직접 낮출 수 없습니다");
    expect(mockSaveProfile).not.toHaveBeenCalled();
  });

  it("마지막 관리자는 강등하지 않는다", async () => {
    mockProfileMaybeSingle.mockResolvedValueOnce({ data: { id: "other-admin", role: "admin" }, error: null });
    mockAdminCount.mockReturnValue({ count: 1, error: null });

    const response = await POST(new Request("http://localhost/api/admin/users", {
      method: "POST",
      body: JSON.stringify({ id: "other-admin", role: "user" })
    }));
    const body = await response.json();

    expect(response.status).toBe(400);
    expect(body.error).toContain("마지막 관리자");
    expect(mockSaveProfile).not.toHaveBeenCalled();
  });

  it("다른 관리자가 남아 있으면 강등하고 역할 변경을 감사 로그에 남긴다", async () => {
    mockProfileMaybeSingle.mockResolvedValueOnce({ data: { id: "other-admin", role: "admin" }, error: null });
    mockAdminCount.mockReturnValue({ count: 2, error: null });

    const response = await POST(new Request("http://localhost/api/admin/users", {
      method: "POST",
      body: JSON.stringify({ id: "other-admin", role: "user" })
    }));

    expect(response.status).toBe(200);
    expect(mockSaveProfile).toHaveBeenCalledWith("save_admin_profile", { p_user_id: "other-admin", p_profile: { role: "user" } });
    expect(mockAuditInsert).toHaveBeenCalledWith(expect.objectContaining({
      action: "users.role_change",
      target_id: "other-admin",
      detail: expect.objectContaining({ from: "admin", to: "user", phase: "succeeded" })
    }));
  });
});
