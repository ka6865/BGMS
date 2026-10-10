import { beforeEach, describe, expect, it, vi } from "vitest";

const { mockVerifyAdminRole, mockGuard, mockDelete, mockStorageRemove } = vi.hoisted(() => {
  const mockVerifyAdminRole = vi.fn().mockResolvedValue(null);
  const mockDelete = vi.fn();
  const mockStorageRemove = vi.fn();
  const supabaseAdmin = {
    from: vi.fn(() => ({
      delete: vi.fn(() => ({
        eq: (...args: unknown[]) => mockDelete(...args)
      }))
    })),
    storage: { from: vi.fn(() => ({ remove: mockStorageRemove })) }
  };
  const mockGuard = vi.fn().mockResolvedValue({
    user: { id: "admin-user" },
    supabaseAdmin
  });
  return { mockVerifyAdminRole, mockGuard, mockDelete, mockStorageRemove };
});

vi.mock("@/lib/admin-agent/logging", () => ({ verifyAdminRole: mockVerifyAdminRole }));
vi.mock("@/utils/supabase/guard", () => ({ withAuthGuard: mockGuard }));

import { POST } from "../app/api/admin/system/route";

describe("admin system cache flush", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockVerifyAdminRole.mockResolvedValue(null);
    mockDelete.mockResolvedValue({ count: 1, error: null });
    mockStorageRemove.mockResolvedValue({ error: null });
  });

  const request = () => new Request("http://localhost/api/admin/system", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ action: "flush_match_cache", matchId: "match-1" })
  });

  it("DB 삭제 실패 시 Storage 삭제를 호출하지 않고 실패를 반환한다", async () => {
    mockDelete.mockResolvedValueOnce({ count: null, error: new Error("database unavailable") });

    const response = await POST(request());

    expect(response.status).toBe(500);
    expect(mockStorageRemove).not.toHaveBeenCalled();
  });

  it("Storage 실패를 부분 완료로 반환해 클라이언트가 재시도할 수 있게 한다", async () => {
    mockStorageRemove.mockResolvedValueOnce({ error: new Error("storage unavailable") });

    const response = await POST(request());
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body).toMatchObject({ success: true, storageCleared: false, partial: true, retryable: true });
    expect(body.message).toContain("Storage");
  });

  it("DB와 Storage 삭제가 완료되면 기존 성공 계약을 유지한다", async () => {
    const response = await POST(request());
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body).toMatchObject({ success: true, storageCleared: true });
    expect(mockStorageRemove).toHaveBeenCalledWith(["match-1.json"]);
  });
});
