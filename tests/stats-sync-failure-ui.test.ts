// @vitest-environment jsdom
import { createElement } from "react";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { StatsPageStates } from "@/components/stat/layout/StatsPageStates";

afterEach(cleanup);
describe("stats sync failure notice", () => {
  it("explains persistence and missing matches when a successful HTTP response is incomplete", () => {
    render(createElement(StatsPageStates, {
      status: "partial", error: null, suggestedPlayers: [], hasResult: true,
      partialReasons: ["stats_save_failed", "history_discovery_failed"],
      retryDisabled: false, onRetry: vi.fn(), onSuggestedPlayer: vi.fn(),
    }));
    expect(screen.getByRole("status").textContent).toContain("불러온 전적을 저장하지 못했습니다");
    expect(screen.getByRole("status").textContent).toContain("새로고침하면 이전 기록이 보일 수");
    expect(screen.getByRole("status").textContent).toContain("일부 경기가 빠질 수");
  });
});
