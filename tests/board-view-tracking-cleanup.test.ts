import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { cleanupBoardPostViewTracking } from "../scripts/cleanup_board_post_view_tracking";

function client(result: { count: number | null; error: unknown }) {
  const lt = vi.fn().mockResolvedValue(result);
  const del = vi.fn().mockReturnValue({ lt });
  const from = vi.fn().mockReturnValue({ delete: del });
  return { from, del, lt };
}

describe("board view tracking cleanup", () => {
  it("하루 지난 조회 기록만 삭제하고 삭제 수를 반환한다", async () => {
    const mock = client({ count: 4, error: null });

    await expect(cleanupBoardPostViewTracking(
      { from: mock.from } as never,
      new Date("2026-10-14T12:00:00.000Z"),
    )).resolves.toEqual({ cutoff: "2026-10-13T12:00:00.000Z", deletedRows: 4 });
    expect(mock.from).toHaveBeenCalledWith("board_post_view_tracking");
    expect(mock.del).toHaveBeenCalledWith({ count: "exact" });
    expect(mock.lt).toHaveBeenCalledWith("last_viewed_at", "2026-10-13T12:00:00.000Z");
  });

  it("삭제 오류를 실패로 올린다", async () => {
    const mock = client({ count: null, error: { message: "denied" } });

    await expect(cleanupBoardPostViewTracking({ from: mock.from } as never))
      .rejects.toThrow("board-view-tracking-cleanup-failed");
  });

  it("daily 정비가 정리 스크립트를 실행한다", () => {
    const workflow = readFileSync(resolve(".github/workflows/daily-tasks.yml"), "utf8");
    expect(workflow).toContain("npx tsx scripts/cleanup_board_post_view_tracking.ts");
  });
});
