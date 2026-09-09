// @vitest-environment jsdom
import React from "react";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";
import { afterEach, describe, expect, it, vi } from "vitest";

const pageMocks = vi.hoisted(() => ({
  push: vi.fn(),
  replace: vi.fn(),
  getSession: vi.fn(async () => ({ data: { session: { user: { id: "admin" } } } })),
}));

vi.mock("next/navigation", () => ({ useRouter: () => ({ push: pageMocks.push, replace: pageMocks.replace }) }));
vi.mock("next/link", () => ({ default: ({ href, children, ...props }: React.AnchorHTMLAttributes<HTMLAnchorElement>) => React.createElement("a", { href, ...props }, children) }));
vi.mock("sonner", () => ({ toast: { error: vi.fn() } }));
vi.mock("@/components/admin/CommunityAgentPanel", () => ({ default: () => React.createElement("div", { "data-testid": "community-agent-panel" }) }));
vi.mock("@/components/admin/AdminAgentChat", () => ({ default: () => React.createElement("div", { "data-testid": "admin-agent-chat" }) }));
vi.mock("@/lib/supabase", () => ({
  supabase: {
    auth: { getSession: pageMocks.getSession },
    from: () => ({ select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: { role: "admin" } }) }) }) }),
  },
}));

import CommunityReviewQueue from "../components/admin/CommunityReviewQueue";
import AdminBotPage from "../app/admin/bot/page";

const REVIEW_ID = "11111111-1111-4111-8111-111111111111";

function review(overrides: Record<string, unknown> = {}) {
  return {
    id: REVIEW_ID,
    kind: "post",
    status: "pending",
    title: "43.1 패치 핵심 정리",
    body: "<p>안전한 본문</p><script>steal()</script>",
    category: "배그 소식",
    target_post_id: 42,
    target_comment_id: null,
    target_comment_content: null,
    target_comment_author: null,
    reason: null,
    result_post_id: null,
    result_comment_id: null,
    notification_error: null,
    discord_message_id: null,
    created_at: "2026-09-09T00:00:00.000Z",
    expires_at: "2026-09-16T00:00:00.000Z",
    ...overrides,
  };
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.clearAllMocks();
  window.history.replaceState({}, "", "/");
});

describe("CommunityReviewQueue", () => {
  it("sanitizes post HTML and explains link-only Discord review honestly", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(Response.json({ reviews: [review()], discordMode: "review_link" })));
    const { container } = render(React.createElement(CommunityReviewQueue));

    expect(await screen.findByRole("heading", { name: "43.1 패치 핵심 정리" })).toBeInTheDocument();
    expect(screen.getByText("안전한 본문")).toBeInTheDocument();
    expect(container.querySelector("script")).toBeNull();
    expect(screen.queryByText("steal()")).not.toBeInTheDocument();
    expect(screen.getByText(/실제 Discord 승인·거절 버튼은 봇 설정을 마친 뒤/)).toBeInTheDocument();
    expect(screen.getByText(/작성자 BGMS AI/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "승인 후 발행" })).toBeEnabled();
  });

  it("renders reply drafts as plain text with the original comment and post link", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(Response.json({
      reviews: [review({
        kind: "reply",
        title: "질문이 달린 게시글",
        body: "<b>태그도 답글 글자입니다</b>",
        target_comment_id: 7,
        target_comment_content: "반동 수치가 그대로인가요?",
        target_comment_author: "플레이어",
      })],
      discordMode: "buttons",
    })));
    const { container } = render(React.createElement(CommunityReviewQueue));

    expect(await screen.findByText("<b>태그도 답글 글자입니다</b>")).toBeInTheDocument();
    expect(container.querySelector("b")).toBeNull();
    expect(screen.getByText("반동 수치가 그대로인가요?")).toBeInTheDocument();
    expect(screen.getByText(/원래 댓글 · 플레이어/)).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "게시글 열기" })).toHaveAttribute("href", "/board/42");
    expect(screen.getByText(/Discord 봇 버튼과 이 관리자 화면/)).toBeInTheDocument();
  });

  it("submits an exact approval action and does not claim publication when the target changed", async () => {
    const fetch = vi.fn(async (_url: string, init?: RequestInit) => {
      if (init?.method === "POST") return Response.json({ result: { code: "target_changed" } });
      return Response.json({ reviews: [review()], discordMode: "buttons" });
    });
    vi.stubGlobal("fetch", fetch);
    render(React.createElement(CommunityReviewQueue));

    fireEvent.click(await screen.findByRole("button", { name: "승인 후 발행" }));

    expect(await screen.findByRole("status")).toHaveTextContent("원본 글이나 댓글이 변경되어 발행하지 않았습니다");
    expect(screen.getByRole("status")).toHaveTextContent("거절하고 변경된 내용을 직접 확인");
    const post = fetch.mock.calls.find(([, init]) => init?.method === "POST");
    expect(post?.[0]).toBe("/api/admin/agent/community/reviews");
    expect(JSON.parse(String(post?.[1]?.body))).toEqual({ action: "approve", id: REVIEW_ID });
  });

  it("shows decision buttons only for pending reviews", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(Response.json({
      reviews: [review({ status: "published", result_post_id: 77 })],
      discordMode: "buttons",
    })));
    render(React.createElement(CommunityReviewQueue));

    expect(await screen.findByText("발행됨")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "승인 후 발행" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "거절" })).not.toBeInTheDocument();
    expect(screen.getByRole("link", { name: "게시글 열기" })).toHaveAttribute("href", "/board/77");
  });

  it("focuses a Discord deep link and refreshes when the parent draft key changes", async () => {
    window.history.replaceState({}, "", `/admin/bot?tab=community&review=${REVIEW_ID}`);
    const fetch = vi.fn().mockResolvedValue(Response.json({ reviews: [review()], discordMode: "review_link" }));
    vi.stubGlobal("fetch", fetch);
    const rendered = render(React.createElement(CommunityReviewQueue, { refreshKey: 0 }));

    await waitFor(() => expect(fetch).toHaveBeenCalledWith(`/api/admin/agent/community/reviews?id=${REVIEW_ID}`, expect.anything()));
    rendered.rerender(React.createElement(CommunityReviewQueue, { refreshKey: 1 }));
    await waitFor(() => expect(fetch).toHaveBeenCalledTimes(2));
  });
});

it("opens the community tab for a review deep link without useSearchParams", async () => {
  window.history.replaceState({}, "", `/admin/bot?tab=community&review=${REVIEW_ID}`);
  render(React.createElement(AdminBotPage));

  expect(await screen.findByTestId("community-agent-panel")).toBeInTheDocument();
  expect(screen.queryByTestId("admin-agent-chat")).not.toBeInTheDocument();
});
