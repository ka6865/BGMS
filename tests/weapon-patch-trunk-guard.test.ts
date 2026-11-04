import { beforeEach, describe, expect, it, vi } from "vitest";
import { decideProposalChanges } from "@/lib/patch-notes/weaponProposalQuery";

const mocks = vi.hoisted(() => ({ requireAdmin: vi.fn(), recordAdminAudit: vi.fn() }));
vi.mock("@/lib/server/adminGuard", () => ({ requireAdmin: mocks.requireAdmin }));
vi.mock("@/lib/server/adminAudit", () => ({ recordAdminAudit: mocks.recordAdminAudit }));
import { POST } from "@/app/api/admin/weapon-patch/apply/route";

const bad = { id: "change-1", validation_state: "ok", target_table: "vehicles", column_name: "trunk_capacity", new_value: 1000, evidence_quote: "쿠페 RB 체력 900 → 1,000" };

describe("기존 트렁크 제안 보호", () => {
  beforeEach(() => vi.clearAllMocks());
  it("이전에 검증 통과한 잘못된 제안의 승인을 막는다", async () => {
    const db = { from: () => ({ select: () => ({ eq: () => ({ in: async () => ({ data: [bad], error: null }) }) }) }) };
    const result = await decideProposalChanges(db as never, "proposal-1", [bad.id], "accepted", "admin");
    expect(result.ok).toBe(false);
  });
  it("이미 승인된 잘못된 제안의 반영을 막는다", async () => {
    const rpc = vi.fn();
    const query = { select: () => query, eq: () => query, then: (resolve: (value: unknown) => void) => resolve({ data: [bad], error: null }) };
    mocks.requireAdmin.mockResolvedValue({ ok: true, user: { id: "admin" }, supabaseAdmin: { from: () => query, rpc } });
    const response = await POST(new Request("http://localhost", { method: "POST", body: JSON.stringify({ proposalId: "proposal-1" }) }));
    expect(response.status).toBe(400);
    expect(rpc).not.toHaveBeenCalled();
  });
});
