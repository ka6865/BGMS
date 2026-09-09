// @vitest-environment jsdom
import React from "react";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  push: vi.fn(),
  replace: vi.fn(),
  getSession: vi.fn(),
  signInWithOAuth: vi.fn(),
  exchangeCodeForSession: vi.fn(),
}));

vi.mock("next/navigation", () => ({ useRouter: () => ({ push: mocks.push, replace: mocks.replace }) }));
vi.mock("sonner", () => ({ toast: { error: vi.fn() } }));
vi.mock("@/components/admin/CommunityAgentPanel", () => ({ default: () => React.createElement("div") }));
vi.mock("@/components/admin/AdminAgentChat", () => ({ default: () => React.createElement("div") }));
vi.mock("@/lib/supabase", () => ({
  supabase: {
    auth: { getSession: mocks.getSession, signInWithOAuth: mocks.signInWithOAuth },
    from: () => ({ select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: { role: "admin" } }) }) }) }),
  },
}));
vi.mock("@/utils/supabase/server", () => ({
  createClient: async () => ({ auth: { exchangeCodeForSession: mocks.exchangeCodeForSession } }),
}));

import AdminBotPage from "../app/admin/bot/page";
import { GET as AuthCallback } from "../app/auth/callback/route";
import Login from "../app/login/page";
import { DEFAULT_NEXT_PATH, safeNextPath } from "../lib/auth/safeNextPath";

const REVIEW_ID = "11111111-1111-4111-8111-111111111111";
const REVIEW_PATH = `/admin/bot?tab=community&review=${REVIEW_ID}`;

beforeEach(() => {
  mocks.getSession.mockResolvedValue({ data: { session: null } });
  mocks.signInWithOAuth.mockResolvedValue({ error: null });
  mocks.exchangeCodeForSession.mockResolvedValue({ error: null });
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  window.history.replaceState({}, "", "/");
});

describe("safeNextPath", () => {
  it.each([
    ["https://evil.test/review", DEFAULT_NEXT_PATH],
    ["//evil.test/review", DEFAULT_NEXT_PATH],
    ["/\\evil.test/review", DEFAULT_NEXT_PATH],
    ["/admin/bot\u0000?tab=community", DEFAULT_NEXT_PATH],
    [" admin/bot", DEFAULT_NEXT_PATH],
    [REVIEW_PATH, REVIEW_PATH],
  ])("keeps %s on the expected internal path", (value, expected) => {
    expect(safeNextPath(value)).toBe(expected);
  });
});

it("sends a signed-out Discord review link through login with only the valid review path", async () => {
  window.history.replaceState({}, "", REVIEW_PATH);
  render(React.createElement(AdminBotPage));

  await waitFor(() => expect(mocks.push).toHaveBeenCalledWith(`/login?next=${encodeURIComponent(REVIEW_PATH)}`));
});

it("drops an invalid review id while preserving the community tab return", async () => {
  window.history.replaceState({}, "", "/admin/bot?tab=community&review=//evil.test");
  render(React.createElement(AdminBotPage));

  await waitFor(() => expect(mocks.push).toHaveBeenCalledWith(`/login?next=${encodeURIComponent("/admin/bot?tab=community")}`));
});

it("passes the validated review path through the OAuth callback URL", async () => {
  window.history.replaceState({}, "", `/login?next=${encodeURIComponent(REVIEW_PATH)}`);
  render(React.createElement(Login));
  fireEvent.click(screen.getByRole("button", { name: "카카오 로그인" }));

  await waitFor(() => expect(mocks.signInWithOAuth).toHaveBeenCalledTimes(1));
  const redirectTo = mocks.signInWithOAuth.mock.calls[0][0].options.redirectTo as string;
  const callback = new URL(redirectTo);
  expect(callback.pathname).toBe("/auth/callback");
  expect(callback.searchParams.get("next")).toBe(REVIEW_PATH);
});

it.each([
  [REVIEW_PATH, REVIEW_PATH],
  ["https://evil.test/review", DEFAULT_NEXT_PATH],
  ["//evil.test/review", DEFAULT_NEXT_PATH],
  ["/\\evil.test/review", DEFAULT_NEXT_PATH],
  ["/admin/bot\u0000?tab=community", DEFAULT_NEXT_PATH],
])("callback redirects next=%s to %s", async (next, expected) => {
  const request = new Request(`https://bgms.test/auth/callback?code=valid&next=${encodeURIComponent(next)}`);
  const response = await AuthCallback(request);

  expect(response.headers.get("location")).toBe(`https://bgms.test${expected}`);
  expect(mocks.exchangeCodeForSession).toHaveBeenCalledWith("valid");
});
