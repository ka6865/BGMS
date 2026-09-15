// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";
import { render, screen } from "@testing-library/react";
import { createElement } from "react";
import { describe, expect, it, vi } from "vitest";

vi.mock("@/components/AuthProvider", () => ({
  useAuth: () => ({ user: null, loading: false }),
}));
vi.mock("@/components/stat/BanWatchPanel", () => ({ BanWatchPanel: () => null }));

import EncountersClient from "@/app/stats/[platform]/[nickname]/encounters/EncountersClient";

describe("EncountersClient", () => {
  it("로그아웃 상태에서도 상대 목록 탭과 로그인 안내를 함께 보여준다", () => {
    render(createElement(EncountersClient, { platform: "steam", nickname: "Zucchini__" }));

    expect(screen.getByRole("tab", { name: "나를 처치한 상대" })).toBeInTheDocument();
    expect(screen.getByRole("tab", { name: "나를 기절시킨 상대" })).toBeInTheDocument();
    expect(screen.getByText("상대 기록과 개인 관심 목록은 로그인 후 확인할 수 있습니다.")).toBeInTheDocument();
  });
});
