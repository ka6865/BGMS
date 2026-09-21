// @vitest-environment jsdom
import React, { createElement, type ReactNode } from "react";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ push: vi.fn(), toastInfo: vi.fn() }));
let authState: { user: { id: string } | null; loading: boolean } = { user: { id: "user-1" }, loading: false };
const notifications = [
  { id: "n-support", user_id: "user-1", sender_name: "관리자", type: "support_reply", post_id: null, support_ticket_id: "ticket-1", is_read: false, created_at: "2026-09-21T00:00:00.000Z" },
  { id: "n-board", user_id: "user-1", sender_name: "댓글러", type: "comment", post_id: 123, support_ticket_id: null, is_read: false, created_at: "2026-09-21T00:00:00.000Z" },
];

vi.mock("next/navigation", () => ({ usePathname: () => "/board", useRouter: () => ({ push: mocks.push }) }));
vi.mock("next/link", () => ({ default: ({ children, href, ...props }: { children: ReactNode; href: string }) => createElement("a", { href, ...props }, children) }));
vi.mock("@/components/AuthProvider", () => ({ useAuth: () => authState }));
vi.mock("@/hooks/useRealtimeToast", () => ({ useRealtimeToast: vi.fn() }));
vi.mock("sonner", () => ({ toast: { info: mocks.toastInfo } }));
vi.mock("@/components/map/NotificationDropdown", () => ({
  default: ({ isOpen, notifications: rows, onNotificationClick }: { isOpen: boolean; notifications: typeof notifications; onNotificationClick: (value: typeof notifications[number]) => void }) => isOpen
    ? createElement("div", null, rows.map((row) => createElement("button", { key: row.id, onClick: () => onNotificationClick(row) }, row.type === "support_reply" ? "고객센터 답변" : "게시글 댓글")))
    : null,
}));
vi.mock("@/lib/supabase", () => ({
  supabase: {
    from: (table: string) => table === "profiles"
      ? { select: () => ({ eq: () => ({ single: async () => ({ data: { id: "user-1", nickname: "사용자", role: "user" }, error: null }) }) }) }
      : { select: () => ({ eq: () => ({ order: async () => ({ data: notifications, error: null }) }) }), update: () => ({ eq: async () => ({ data: null, error: null }) }) },
    channel: () => ({ on() { return this; }, subscribe() { return this; } }),
    removeChannel: vi.fn(),
  },
}));

import GlobalHeader from "@/components/common/GlobalHeader";

beforeEach(() => { vi.clearAllMocks(); authState = { user: { id: "user-1" }, loading: false }; });
afterEach(() => cleanup());

describe("GlobalHeader support notifications", () => {
  it("routes support replies to the private ticket and keeps board notifications on the board", async () => {
    render(React.createElement(GlobalHeader));
    await waitFor(() => expect(screen.getByRole("button", { name: "알림" })).toBeInTheDocument());
    fireEvent.click(screen.getByRole("button", { name: "알림" }));
    fireEvent.click(screen.getByRole("button", { name: "고객센터 답변" }));
    await waitFor(() => expect(mocks.push).toHaveBeenCalledWith("/support/ticket-1"));
    fireEvent.click(screen.getByRole("button", { name: "알림" }));
    fireEvent.click(screen.getByRole("button", { name: "게시글 댓글" }));
    await waitFor(() => expect(mocks.push).toHaveBeenCalledWith("/board/123"));
  });
});
