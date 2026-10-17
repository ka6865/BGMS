// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "fs";
import { resolve } from "path";
import React from "react";
import { act, cleanup, render, screen } from "@testing-library/react";
import type { Post } from "@/types/board";

const mocks = vi.hoisted(() => ({ rpc: vi.fn() }));

vi.mock("react-quill-new/dist/quill.snow.css", () => ({}));
vi.mock("next/navigation", () => ({ useRouter: () => ({ push: vi.fn(), refresh: vi.fn(), back: vi.fn() }) }));
vi.mock("next/image", () => ({ default: () => null }));
vi.mock("@/components/AuthProvider", () => ({ useAuth: () => ({ user: null }) }));
vi.mock("@/lib/supabase", () => ({ supabase: { rpc: mocks.rpc, from: vi.fn() } }));
vi.mock("@/lib/analytics", () => ({ trackEvent: vi.fn() }));
vi.mock("sonner", () => ({ toast: { error: vi.fn(), success: vi.fn() } }));
vi.mock("@/components/CommentSection", () => ({ default: () => null }));
vi.mock("@/components/board/TurnstileWidget", () => ({ default: () => null }));
vi.mock("@/components/ads/AdSenseBanner", () => ({ default: () => null }));

import BoardDetailClient from "@/components/board/BoardDetailClient";

const post: Post = {
  id: 7,
  title: "조회수 테스트",
  content: "<p>본문</p>",
  author: "작성자",
  user_id: null,
  category: "자유",
  image_url: "",
  is_notice: false,
  created_at: "2026-10-15T00:00:00.000Z",
  views: 10,
  likes: 0,
  revision: 1,
  parent_id: null,
};

async function renderDetail() {
  render(React.createElement(BoardDetailClient, {
    initialPost: post,
    initialComments: [],
    promoteExpectedParentRevision: null,
  }));
  // fetch → json → setPost 체인이 끝날 때까지 microtask를 비운다
  for (let index = 0; index < 5; index += 1) await act(async () => { await Promise.resolve(); });
}

beforeEach(() => {
  sessionStorage.clear();
  mocks.rpc.mockReset();
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("BoardDetailClient migration to views API route", () => {
  it("should not call increment_views RPC directly", () => {
    const content = readFileSync(resolve(process.cwd(), "components/board/BoardDetailClient.tsx"), "utf-8");

    expect(content).not.toMatch(/\.rpc\s*\(\s*["']increment_views["']/);
  });

  it("상세 화면 진입 시 views route를 POST로 호출하고 응답 조회수를 표시한다", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({ views: 11 }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    await renderDetail();

    expect(fetchMock).toHaveBeenCalledOnce();
    expect(fetchMock).toHaveBeenCalledWith("/api/board/posts/7/views", { method: "POST" });
    expect(mocks.rpc).not.toHaveBeenCalled();
    expect(screen.getByText("조회: 11")).toBeTruthy();
    expect(sessionStorage.getItem("viewed_post_7")).toBe("true");
  });

  it("같은 세션에서 이미 조회한 글은 views route를 다시 호출하지 않는다", async () => {
    sessionStorage.setItem("viewed_post_7", "true");
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    await renderDetail();

    expect(fetchMock).not.toHaveBeenCalled();
    expect(screen.getByText("조회: 10")).toBeTruthy();
  });

  it.each([
    ["네트워크 실패", () => Promise.reject(new TypeError("network down"))],
    ["서버 오류 응답", () => Promise.resolve(new Response("{}", { status: 500 }))],
    ["JSON이 아닌 응답", () => Promise.resolve(new Response("not-json", { status: 200 }))],
    ["조회수가 정수가 아닌 응답", () => Promise.resolve(new Response(JSON.stringify({ views: "11" }), { status: 200 }))],
  ])("%s는 화면을 유지하고 조회 기록을 남기지 않는다", async (_label, respond) => {
    vi.stubGlobal("fetch", vi.fn(respond));

    await renderDetail();

    expect(screen.getByText("조회수 테스트")).toBeTruthy();
    expect(screen.getByText("조회: 10")).toBeTruthy();
    expect(sessionStorage.getItem("viewed_post_7")).toBeNull();
  });
});
