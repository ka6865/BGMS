// @vitest-environment jsdom
import React, { createElement, type ReactNode } from "react";
import { cleanup, render, screen } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const router = { push: vi.fn() };
vi.mock("next/navigation", () => ({ useRouter: () => router }));
vi.mock("next/link", () => ({ default: ({ children, href, ...props }: { children: ReactNode; href: string }) => createElement("a", { href, ...props }, children) }));
vi.mock("@/components/AuthProvider", () => ({ useAuth: () => ({ user: null, loading: false }) }));
vi.mock("vaul", () => { const Passthrough = ({ children }: { children?: ReactNode }) => children; return { Drawer: { Root: Passthrough, Portal: Passthrough, Overlay: (props: React.ComponentProps<"div">) => createElement("div", props), Content: (props: React.ComponentProps<"div">) => createElement("div", props), Title: Passthrough, Description: (props: React.ComponentProps<"p">) => createElement("p", props) } }; });
vi.mock("@/lib/supabase", () => ({ supabase: { from: () => ({ select: () => ({ eq: () => ({ single: async () => ({ data: null, error: null }) }) }) }) } }));

import Footer from "@/components/common/Footer";
import GlobalMobileMenu from "@/components/common/GlobalMobileMenu";
import MyPage from "@/components/mypage/MyPage";
import PrivacyPage from "@/app/privacy/page";

afterEach(() => cleanup());
beforeEach(() => {
  vi.clearAllMocks();
  const values = new Map<string, string>();
  vi.stubGlobal("localStorage", {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => values.set(key, value),
    removeItem: (key: string) => values.delete(key),
    clear: () => values.clear(),
  });
});

describe("support navigation", () => {
  it("exposes customer center links in footer, mobile menu, mypage, and privacy policy", () => {
    render(createElement(Footer));
    expect(screen.getByRole("link", { name: "고객센터" })).toHaveAttribute("href", "/support");
    cleanup();

    render(createElement(GlobalMobileMenu, { isOpen: true, setIsOpen: vi.fn(), activeMapId: "Erangel", isAdmin: false }));
    expect(screen.getByRole("link", { name: /1:1 문의\/FAQ/ })).toHaveAttribute("href", "/support");
    cleanup();

    render(createElement(MyPage, { initialCurrentUser: { id: "user-1", email: "user@example.com" } as any, initialUserProfile: { nickname: "사용자" }, initialActivityStats: { postCount: 0, commentCount: 0, likeCount: 0 } }));
    expect(screen.getByRole("button", { name: "고객센터" })).toBeInTheDocument();
    cleanup();

    render(createElement(PrivacyPage));
    expect(screen.getByRole("link", { name: /고객센터 1:1 문의/ })).toHaveAttribute("href", "/support");
    expect(screen.getByText(/스크린샷 증빙/)).toBeInTheDocument();
  });
});
