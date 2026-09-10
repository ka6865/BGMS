// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import React from "react";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { AdminUserCommandCenter } from "@/components/admin/AdminUserCommandCenter";
import { buildAiObservability } from "@/lib/admin-agent/ai-observability";

vi.mock("@/components/admin/AdminPrivatePlayersSection", () => ({ AdminPrivatePlayersSection: () => null }));
afterEach(cleanup);

describe("AdminUserCommandCenter UI Component", () => {
  it("exports AdminUserCommandCenter component", async () => {
    const mod = await import("@/components/admin/AdminUserCommandCenter");
    expect(mod.AdminUserCommandCenter).toBeDefined();
  });

  it("기간을 바꾸면 해당 기간의 상위 AI 사용자로 바뀐다", () => {
    const now = Date.parse("2026-09-10T12:00:00Z");
    const { windows, pubgApi } = buildAiObservability([
      { user_id: "today", created_at: "2026-09-10T11:00:00Z" },
      { user_id: "week", created_at: "2026-09-08T11:00:00Z" },
      { user_id: "week", created_at: "2026-09-08T12:00:00Z" },
    ], [], now);
    for (const window of Object.values(windows)) {
      window.topUsers = window.topUsers.map((user) => ({ ...user, nickname: user.userId }));
    }
    render(React.createElement(AdminUserCommandCenter, { users: [], metrics: {
      active7dUsers: 2, topSearchUsers: [], topPages: [], providers: {},
      ai24h: windows.hours24, ai7d: windows.days7, pubgApi24h: pubgApi.hours24, pubgApi7d: pubgApi.days7,
    } }));
    expect(screen.getByText(/상위 AI 사용자:/).textContent).toBe("상위 AI 사용자: today 1회");
    fireEvent.change(screen.getByLabelText("AI 관제 기간"), { target: { value: "ai7d" } });
    expect(screen.getByText(/상위 AI 사용자:/).textContent).toBe("상위 AI 사용자: week 2회 · today 1회");
    expect(screen.getByLabelText("회원 가입 및 탈퇴 타임라인")).toBeTruthy();
  });

  it("PUBG 오류만 있을 때 AI 필터는 빈 상태를 안내한다", () => {
    const { windows, pubgApi } = buildAiObservability([], [
      { id: "limit", status: 429, route: "/api/pubg/player", created_at: "2026-09-10T11:00:00Z" },
    ], Date.parse("2026-09-10T12:00:00Z"));
    render(React.createElement(AdminUserCommandCenter, { users: [], metrics: {
      active7dUsers: 0, topSearchUsers: [], topPages: [], providers: {},
      ai24h: windows.hours24, pubgApi24h: pubgApi.hours24,
    } }));
    const panel = within(screen.getByLabelText("AI 및 API 오류 관제"));
    expect(panel.getByText("429 · PUBG 호출 제한 (429)")).toBeTruthy();
    fireEvent.change(panel.getByLabelText("오류 종류"), { target: { value: "ai" } });
    expect(within(panel.getByText("최근 오류 사례").parentElement!).getByText("선택 기간 오류 없음")).toBeTruthy();
    expect(panel.queryByText("429 · PUBG 호출 제한 (429)")).toBeNull();
  });
});
