// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { createElement } from "react";
import { describe, expect, it, vi } from "vitest";
import { BanWatchPanel } from "@/components/stat/BanWatchPanel";

const routerPush = vi.fn();
const authState = { user: { id: "user-1" }, loading: false };
vi.mock("@/components/AuthProvider", () => ({ useAuth: () => authState }));
vi.mock("next/navigation", () => ({ useRouter: () => ({ push: routerPush }) }));

const encounter = {
  matchId: "match-1",
  platform: "steam" as const,
  subjectAccountId: "account.subject",
  targetAccountId: "account.enemy",
  eventAt: "2026-08-27T00:00:05.000Z",
  role: "killer" as const,
  nicknameAtMatch: "Enemy",
  weapon: null,
};
const item = {
  id: "watch-1",
  userId: "user-1",
  platform: "steam" as const,
  subjectAccountId: "account.subject",
  targetAccountId: "account.enemy",
  matchId: "match-old",
  eventAt: "2026-08-26T00:00:05.000Z",
  role: "killer" as const,
  nicknameAtMatch: "OldEnemy",
  mapName: null,
  weapon: null,
  note: null,
  createdAt: "2026-08-26T00:00:06.000Z",
  activeUntil: "2026-09-26T00:00:06.000Z",
  baselineStatus: "none" as const,
  baselineCheckedAt: "2026-08-26T00:00:06.000Z",
  lastViewedAt: null,
};

function jsonResponse(value: unknown, status = 200) {
  return new Response(JSON.stringify(value), { status, headers: { "Content-Type": "application/json" } });
}

describe("BanWatchPanel", () => {
  it("shows a login entry for signed-out visitors without calling private APIs", async () => {
    authState.user = null as never;
    const fetch = vi.fn();
    vi.stubGlobal("fetch", fetch);
    render(createElement(BanWatchPanel));
    expect(await screen.findByTestId("ban-watch-login")).toBeInTheDocument();
    expect(fetch).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "로그인" }));
    expect(routerPush).toHaveBeenCalledWith("/login");
    authState.user = { id: "user-1" };
  });

  it("loads candidates and registers the server-verified subject account", async () => {
    authState.user = { id: "user-1" };
    const fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith("/encounters")) return jsonResponse({ encounters: [encounter], source: { kind: "r2", verifiedSubjectAccountId: encounter.subjectAccountId } });
      if (init?.method === "POST") return jsonResponse({ item: { ...item, id: "watch-new", targetAccountId: encounter.targetAccountId, eventAt: encounter.eventAt, nicknameAtMatch: encounter.nicknameAtMatch }, created: true, scheduled: true }, 201);
      return jsonResponse({ items: [], statuses: [], events: [] });
    });
    vi.stubGlobal("fetch", fetch);
    render(createElement(BanWatchPanel, { platform: "steam", matchId: "match-1", nickname: "Me", match: { mapName: "에란겔", createdAt: "2026-08-27T00:00:00.000Z" } }));
    expect(await screen.findByText("Enemy")).toBeInTheDocument();
    expect(screen.getByText("정보 없음")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "추적 등록" }));
    await waitFor(() => expect(fetch).toHaveBeenCalledWith("/api/pubg/ban-watch", expect.objectContaining({ method: "POST" })));
    const request = fetch.mock.calls.find(([input, init]) => String(input).endsWith("/api/pubg/ban-watch") && init?.method === "POST");
    expect(JSON.parse(String(request?.[1]?.body))).toMatchObject({ subjectAccountId: "account.subject", targetAccountId: "account.enemy", role: "killer" });
  });

  it("renders prior status on a failed refresh and exposes deletion", async () => {
    authState.user = { id: "user-1" };
    const fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      if (init?.method === "PATCH") return jsonResponse({ error: "temporary", code: "store_failed" }, 503);
      if (init?.method === "DELETE") return jsonResponse({ success: true });
      return jsonResponse({ items: [item], statuses: [{ platform: "steam", accountId: "account.enemy", status: "none", rawType: "Innocent", checkedAt: "2026-08-27T00:00:00.000Z", lastError: null }], events: [] });
    });
    vi.stubGlobal("fetch", fetch);
    render(createElement(BanWatchPanel));
    expect(await screen.findByText("현재 제재 표시 없음")).toBeInTheDocument();
    fireEvent.click(screen.getByTestId("ban-watch-refresh"));
    expect(await screen.findByText("temporary")).toBeInTheDocument();
    expect(screen.getByText("현재 제재 표시 없음")).toBeInTheDocument();
    fireEvent.click(screen.getByTestId("ban-watch-delete"));
    await waitFor(() => expect(fetch).toHaveBeenCalledWith("/api/pubg/ban-watch?id=watch-1", expect.objectContaining({ method: "DELETE" })));
  });
});
