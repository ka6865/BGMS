import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { cleanupPubgApiErrors } from "../scripts/cleanup_pubg_api_errors";

function client(result: { count: number | null; error: unknown }) {
  const lt = vi.fn().mockResolvedValue(result);
  const del = vi.fn().mockReturnValue({ lt });
  const from = vi.fn().mockReturnValue({ delete: del });
  return { from, del, lt };
}

describe("PUBG API error cleanup", () => {
  it("30일 지난 오류 로그만 삭제하고 삭제 수를 반환한다", async () => {
    const mock = client({ count: 7, error: null });

    await expect(cleanupPubgApiErrors(
      { from: mock.from } as never,
      new Date("2026-10-15T12:00:00.000Z"),
    )).resolves.toEqual({ cutoff: "2026-09-15T12:00:00.000Z", deletedRows: 7 });
    expect(mock.from).toHaveBeenCalledWith("pubg_api_errors");
    expect(mock.del).toHaveBeenCalledWith({ count: "exact" });
    expect(mock.lt).toHaveBeenCalledWith("created_at", "2026-09-15T12:00:00.000Z");
  });

  it("삭제 오류를 실패로 올린다", async () => {
    const mock = client({ count: null, error: { message: "denied" } });

    await expect(cleanupPubgApiErrors({ from: mock.from } as never))
      .rejects.toThrow("pubg-api-errors-cleanup-failed");
  });

  it("daily 정비가 정리 스크립트를 실행한다", () => {
    const workflow = readFileSync(resolve(".github/workflows/daily-tasks.yml"), "utf8");
    expect(workflow).toContain("npx tsx scripts/cleanup_pubg_api_errors.ts");
  });
});
