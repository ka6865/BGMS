import { beforeEach, describe, expect, it, vi } from "vitest";

const { insert } = vi.hoisted(() => ({ insert: vi.fn() }));
vi.mock("@supabase/supabase-js", () => ({
  createClient: () => ({ from: () => ({ insert }) }),
}));
import { trackAiFailure, trackAiUsage } from "../lib/pubg-analysis/aiUsageTracker";

describe("AI usage persistence", () => {
  beforeEach(() => { insert.mockReset().mockResolvedValue({ error: null }); });

  it("반환 Promise는 insert가 완료될 때까지 대기하며 실패 생성의 사용량도 보존한다", async () => {
    let complete!: (result: { error: null }) => void;
    insert.mockReturnValue(new Promise((resolve) => { complete = resolve; }));
    let settled = false;
    const task = trackAiFailure("u1", "summary", new Error("AI response schema invalid: debate_issues_count"), {
      modelName: "test-model", promptTokens: 100, completionTokens: 25, requestId: "r1",
    }).then(() => { settled = true; });
    await Promise.resolve();
    expect(settled).toBe(false);
    expect(insert).toHaveBeenCalledWith(expect.objectContaining({
      status: "error", error_code: "schema", model_name: "test-model",
      prompt_tokens: 100, completion_tokens: 25, cost_usd: 0.000015, request_id: "r1",
    }));
    complete({ error: null });
    await task;
    expect(settled).toBe(true);
  });

  it("부분 완료 상태와 정제된 탈락 사유를 저장한다", async () => {
    await trackAiUsage("u1", "test-model", 100, 25, "summary", {
      status: "partial", errorCode: "validation", errorMessage: "utility:neutral Bearer secret-token",
    });
    expect(insert).toHaveBeenCalledWith(expect.objectContaining({
      status: "partial", error_code: "validation", error_message: "utility:neutral Bearer [redacted]",
    }));
  });

  it("취소 상태에도 확정된 사용량과 비용을 보존한다", async () => {
    await trackAiUsage("u1", "test-model", 100, 25, "summary", { status: "cancelled", errorCode: "cancelled", requestId: "cancel-1" });
    expect(insert).toHaveBeenCalledWith(expect.objectContaining({ status: "cancelled", error_code: "cancelled", prompt_tokens: 100, completion_tokens: 25, cost_usd: 0.000015, request_id: "cancel-1" }));
  });

  it("insert 거절은 처리된 Promise로 끝나 응답 스트림에 전파하지 않는다", async () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    try {
      insert.mockRejectedValue(new Error("database unavailable"));
      await expect(trackAiUsage("u1", "test-model", 0, 0, "summary")).resolves.toBeUndefined();
      expect(spy).toHaveBeenCalled();
    } finally { spy.mockRestore(); }
  });
});
