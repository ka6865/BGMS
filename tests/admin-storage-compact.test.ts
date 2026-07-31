import { beforeEach, describe, expect, it, vi } from "vitest";
import { POST as compactPOST } from "../app/api/admin/storage/compact/route";
import { withAuthGuard } from "../utils/supabase/guard";

vi.mock("../utils/supabase/guard", () => ({
  withAuthGuard: vi.fn(),
}));

type RpcHandler = (name: string, args: Record<string, unknown>) => { data: unknown; error: unknown };

function mockAdmin(options: {
  role?: string;
  rpc?: RpcHandler;
} = {}) {
  const calls: Array<{ name: string; args: Record<string, unknown> }> = [];
  const rpc = vi.fn(async (name: string, args: Record<string, unknown>) => {
    calls.push({ name, args });
    if (options.rpc) return options.rpc(name, args);
    return { data: null, error: null };
  });

  const supabaseAdmin = {
    from: vi.fn(() => ({
      select: vi.fn(() => ({
        eq: vi.fn(() => ({
          maybeSingle: vi.fn(async () => ({
            data: { role: options.role ?? "admin" },
            error: null,
          })),
        })),
      })),
    })),
    rpc,
  };

  vi.mocked(withAuthGuard).mockResolvedValue({
    user: { id: "admin-user" },
    supabaseAdmin,
  } as never);

  return { calls, rpc };
}

function request(body: unknown) {
  return new Request("http://localhost/api/admin/storage/compact", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

function compactionRow(overrides: Record<string, unknown> = {}) {
  return {
    data: {
      candidate_count: 12_000,
      deleted_count: 0,
      remaining_count: 12_000,
      total_count: 429_947,
      dry_run: true,
      ...overrides,
    },
    error: null,
  };
}

describe("데이터 정리 API", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("관리자가 아니면 거부한다", async () => {
    mockAdmin({ role: "user" });

    const response = await compactPOST(request({ target: "match_stats_raw" }));

    expect(response.status).toBe(403);
  });

  it("지원하지 않는 대상은 거부한다", async () => {
    mockAdmin();

    const response = await compactPOST(request({ target: "profiles" }));

    expect(response.status).toBe(400);
  });

  it("apply 없이 호출하면 삭제하지 않고 대상만 센다", async () => {
    const { calls } = mockAdmin({ rpc: () => compactionRow() });

    const response = await compactPOST(request({ target: "match_stats_raw" }));
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.dryRun).toBe(true);
    expect(body.candidateCount).toBe(12_000);
    expect(body.deletedCount).toBe(0);
    // RPC 는 한 번만 호출되고 p_apply 는 false 여야 한다.
    expect(calls).toHaveLength(1);
    expect(calls[0]?.args.p_apply).toBe(false);
  });

  it("apply 가 문자열이면 삭제하지 않는다", async () => {
    const { calls } = mockAdmin({ rpc: () => compactionRow() });

    const response = await compactPOST(request({ target: "match_stats_raw", apply: "true" }));
    const body = await response.json();

    expect(body.dryRun).toBe(true);
    expect(calls.every((call) => call.args.p_apply === false)).toBe(true);
  });

  it("apply: true 면 배치를 반복해 삭제한다", async () => {
    let applied = 0;
    const { calls } = mockAdmin({
      rpc: (_name, args) => {
        if (args.p_apply !== true) return compactionRow();
        applied += 1;
        const remaining = Math.max(0, 3_000 - applied * 1_000);
        return compactionRow({
          deleted_count: 1_000,
          remaining_count: remaining,
          dry_run: false,
        });
      },
    });

    const response = await compactPOST(request({ target: "match_stats_raw", apply: true }));
    const body = await response.json();

    expect(body.dryRun).toBe(false);
    expect(body.deletedCount).toBe(3_000);
    expect(body.hasRemaining).toBe(false);
    // 첫 호출은 dry-run 미리보기, 이후가 실제 삭제다.
    expect(calls[0]?.args.p_apply).toBe(false);
    expect(calls.filter((call) => call.args.p_apply === true)).toHaveLength(3);
  });

  it("한 요청에서 삭제 규모에 상한을 둔다", async () => {
    // 잔여가 계속 남아도 요청당 배치 상한에서 멈춘다.
    const { calls } = mockAdmin({
      rpc: (_name, args) => compactionRow(
        args.p_apply === true
          ? { deleted_count: 1_000, remaining_count: 500_000, dry_run: false }
          : { candidate_count: 500_000, remaining_count: 500_000 },
      ),
    });

    const response = await compactPOST(request({ target: "match_stats_raw", apply: true }));
    const body = await response.json();

    const applyCalls = calls.filter((call) => call.args.p_apply === true);
    expect(applyCalls.length).toBeLessThanOrEqual(20);
    expect(body.hasRemaining).toBe(true);
    expect(body.message).toContain("다시 실행");
  });

  it("배치 크기가 타임아웃 한계보다 작다", async () => {
    // 2026-08-01 일일 작업이 batch=5,000 으로 statement timeout 에 걸려 실패했다.
    const { calls } = mockAdmin({ rpc: () => compactionRow() });

    await compactPOST(request({ target: "pubg_player_cache" }));

    expect(Number(calls[0]?.args.p_batch_limit)).toBeLessThanOrEqual(2_000);
  });

  it("삭제가 진행되지 않으면 반복하지 않는다", async () => {
    const { calls } = mockAdmin({
      rpc: (_name, args) => compactionRow(
        args.p_apply === true
          ? { deleted_count: 0, remaining_count: 12_000, dry_run: false }
          : {},
      ),
    });

    await compactPOST(request({ target: "match_stats_raw", apply: true }));

    expect(calls.filter((call) => call.args.p_apply === true)).toHaveLength(1);
  });

  it("플레이어 캐시는 보존 기간과 상한을 함께 넘긴다", async () => {
    const { calls } = mockAdmin({ rpc: () => compactionRow() });

    await compactPOST(request({ target: "pubg_player_cache" }));

    // 상한을 빼면 활동 신호 없는 행 전부가 대상이 되므로 반드시 포함해야 한다.
    expect(calls[0]?.args.p_keep_recent).toBe(150_000);
    expect(calls[0]?.args.p_retention_days).toBe(90);
  });

  it("형식이 어긋난 RPC 응답을 성공으로 처리하지 않는다", async () => {
    mockAdmin({ rpc: () => ({ data: { candidate_count: "many" }, error: null }) });

    const response = await compactPOST(request({ target: "match_stats_raw" }));

    expect(response.status).toBe(500);
  });

  it("RPC 오류를 전파한다", async () => {
    mockAdmin({ rpc: () => ({ data: null, error: { message: "rpc down" } }) });

    const response = await compactPOST(request({ target: "match_stats_raw" }));
    const body = await response.json();

    expect(response.status).toBe(500);
    expect(body.error).toContain("rpc down");
  });
});
