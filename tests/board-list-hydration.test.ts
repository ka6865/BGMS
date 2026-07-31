// @vitest-environment jsdom

import { act, createElement } from "react";
import { hydrateRoot } from "react-dom/client";
import { renderToString } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import BoardListClient from "@/components/board/BoardListClient";
import type { Post } from "@/types/board";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), refresh: vi.fn() }),
}));

vi.mock("@/components/AuthProvider", () => ({
  useAuth: () => ({ user: null }),
}));

vi.mock("@/lib/analytics", () => ({
  trackEvent: vi.fn(),
}));

vi.mock("@/lib/supabase", () => ({
  supabase: {
    from: () => ({
      select: () => ({
        eq: () => ({ single: async () => ({ data: null, error: null }) }),
      }),
    }),
  },
}));

vi.mock("@/components/ads/AdfitBanner", () => ({ default: () => null }));
vi.mock("@/components/ads/AdSenseBanner", () => ({ default: () => null }));

const originalTimeZone = process.env.TZ;

afterEach(() => {
  process.env.TZ = originalTimeZone;
  document.body.replaceChildren();
});

describe("게시판 목록 하이드레이션", () => {
  it("UTC와 KST에서 날짜가 달라지는 게시글도 텍스트 불일치가 발생하지 않는다", async () => {
    const post: Post = {
      id: 1,
      title: "시간대 경계 게시글",
      content: "본문",
      author: "작성자",
      user_id: null,
      category: "자유",
      image_url: "",
      is_notice: false,
      created_at: "2026-07-28T15:13:12.253Z",
      views: 0,
      likes: 0,
      revision: 1,
      parent_id: null,
    };
    const props = {
      posts: [post],
      totalPosts: 1,
      currentPage: 1,
      currentFilter: "전체",
    };

    process.env.TZ = "UTC";
    const markup = renderToString(createElement(BoardListClient, props));
    const container = document.createElement("div");
    container.innerHTML = markup;
    document.body.append(container);

    process.env.TZ = "Asia/Seoul";
    const recoverableErrors: unknown[] = [];

    await act(async () => {
      hydrateRoot(container, createElement(BoardListClient, props), {
        onRecoverableError: (error) => recoverableErrors.push(error),
      });
      await new Promise((resolve) => setTimeout(resolve, 0));
    });

    expect(recoverableErrors).toHaveLength(0);
    expect(container.textContent).toContain("2026. 7. 29.");
  });
});
