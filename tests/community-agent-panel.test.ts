// @vitest-environment jsdom
import React from "react";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";
import { afterEach, describe, expect, it, vi } from "vitest";
import CommunityAgentPanel from "../components/admin/CommunityAgentPanel";
import type { CommunityAgentStatus } from "../lib/community-agent/types";

function status(overrides: Partial<CommunityAgentStatus> = {}): CommunityAgentStatus {
  return {
    generatedAt: "2026-09-09T00:00:00.000Z",
    policy: {
      enabled: true,
      publishingEnabled: false,
      botUserId: "11111111-1111-4111-8111-111111111111",
      categories: ["배그 소식", "자유"],
      dailyPostLimit: 1,
      sourceEnabled: { dc: true, naver: true, youtube: false },
    },
    sources: [
      { id: "dc", state: "ok", reason: null, lastSuccessAt: "2026-09-09T00:00:00.000Z", updatedAt: "2026-09-09T00:00:00.000Z", channel: null },
      { id: "naver", state: "needs_setup", reason: "missing_credentials", lastSuccessAt: null, updatedAt: "2026-09-09T00:00:00.000Z", channel: null },
      { id: "youtube", state: "disabled", reason: null, lastSuccessAt: null, updatedAt: "2026-09-09T00:00:00.000Z", channel: null },
    ],
    runs: [],
    usage: { promptTokens: 12, completionTokens: 8, totalTokens: 20 },
    missingEnv: [],
    ...overrides,
  };
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("CommunityAgentPanel", () => {
  it("조회 실패를 정상 0건으로 보여주지 않는다", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("", { status: 503 })));

    render(React.createElement(CommunityAgentPanel));

    expect(await screen.findByRole("alert")).toHaveTextContent("운영 상태를 불러오지 못했습니다");
    expect(screen.queryByText("오늘 발행 0건")).not.toBeInTheDocument();
  });

  it("중지 설정이 실패하면 상태와 토글을 되돌리고 오류를 알린다", async () => {
    const active = status();
    active.policy.publishingEnabled = true;
    const fetch = vi.fn()
      .mockResolvedValueOnce(Response.json({ status: active }))
      .mockResolvedValueOnce(Response.json({ code: "storage_unavailable" }, { status: 503 }));
    vi.stubGlobal("fetch", fetch);

    render(React.createElement(CommunityAgentPanel));

    const pause = await screen.findByRole("button", { name: "일시 중지" });
    fireEvent.click(pause);

    expect(await screen.findByRole("alert")).toHaveTextContent("설정을 저장하지 못했습니다");
    expect(screen.getByRole("button", { name: "일시 중지" })).toBeEnabled();
    await waitFor(() => expect(fetch).toHaveBeenLastCalledWith(
      "/api/admin/agent/community",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({ action: "configure", patch: { enabled: false, publishingEnabled: false } }),
      }),
    ));
  });

  it("승인된 출처 링크와 한국어 수집 상태를 표시한다", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(Response.json({ status: status() })));

    render(React.createElement(CommunityAgentPanel));

    expect(await screen.findByRole("link", { name: /디시인사이드 배틀그라운드/ })).toHaveAttribute("href", "https://gall.dcinside.com/board/lists/?id=battlegrounds");
    expect(screen.getByRole("link", { name: /PUBG: BATTLEGROUNDS Korea/ })).toHaveAttribute("href", "https://www.youtube.com/@PUBG_KR");
    expect(screen.getByText(/상태: 중지됨/)).toBeInTheDocument();
  });

  it("시험 실행이 보류된 실행에서 발행이나 다음 단계를 호출하지 않는다", async () => {
    const deferred: CommunityAgentStatus["runs"][number] = {
      id: "11111111-1111-4111-8111-111111111111",
      day: "2026-09-09",
      status: "deferred",
      stages: {}, modelCalls: 0, reports: [], topic: null, draft: null, validation: null, dryRun: false, postId: null, reason: "no_usable_evidence",
    };
    const fetch = vi.fn()
      .mockResolvedValueOnce(Response.json({ status: status() }))
      .mockResolvedValueOnce(Response.json({ result: deferred }))
      .mockResolvedValueOnce(Response.json({ status: status({ runs: [deferred] }) }));
    vi.stubGlobal("fetch", fetch);

    render(React.createElement(CommunityAgentPanel));
    fireEvent.click(await screen.findByRole("button", { name: "관리자 시험 실행" }));

    await waitFor(() => expect(screen.getByText(/최근 실행: 보류/)).toBeInTheDocument());
    const bodies = fetch.mock.calls.map(([, init]) => String((init as RequestInit | undefined)?.body));
    expect(bodies).toContain(JSON.stringify({ action: "start", dryRun: true }));
    expect(bodies.some((body) => body.includes('"action":"step"') || body.includes('"action":"publish"'))).toBe(false);
  });

  it("시험 실행 실패 뒤에도 오류를 보인다", async () => {
    const fetch = vi.fn()
      .mockResolvedValueOnce(Response.json({ status: status() }))
      .mockResolvedValueOnce(Response.json({ code: "storage_unavailable" }, { status: 503 }))
      .mockResolvedValueOnce(Response.json({ status: status() }));
    vi.stubGlobal("fetch", fetch);

    render(React.createElement(CommunityAgentPanel));
    fireEvent.click(await screen.findByRole("button", { name: "관리자 시험 실행" }));

    expect(await screen.findByRole("alert")).toHaveTextContent("시험 실행을 완료하지 못했습니다");
  });
});
