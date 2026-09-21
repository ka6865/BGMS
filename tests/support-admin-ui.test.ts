// @vitest-environment jsdom
import React from "react";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ toast: { error: vi.fn(), success: vi.fn() } }));
vi.mock("sonner", () => ({ toast: mocks.toast }));

import SupportInbox from "@/components/admin/SupportInbox";
import SupportTicketDetail from "@/components/admin/SupportTicketDetail";

const ticketId = "11111111-1111-4111-8111-111111111111";
const ticket = {
  id: ticketId,
  requester_id: "user-1",
  requester_nickname: "전적요청자",
  category: "privacy",
  subject: "전적 비공개 요청",
  body: "제 계정 전적을 숨겨 주세요.",
  status: "in_progress",
  verification_status: "pending",
  target_platform: "steam",
  target_nickname: "PlayerOne",
  target_account_id: "account-1",
  created_at: "2026-09-21T00:00:00.000Z",
  updated_at: "2026-09-21T00:00:00.000Z",
  messages: [{ id: "m-1", sender_type: "user", body: "제 계정 전적을 숨겨 주세요.", created_at: "2026-09-21T00:00:00.000Z" }],
  attachments: [{ id: "a-1", original_name: "proof.png", signedUrl: "https://signed.example/proof.png", status: "ready" }],
};

function response(body: unknown, ok = true, status = 200) {
  return Promise.resolve(new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } }));
}

afterEach(() => cleanup());
beforeEach(() => {
  vi.clearAllMocks();
  vi.stubGlobal("fetch", vi.fn());
});

describe("support admin UI", () => {
  it("filters the oldest-first inbox and emits a selected ticket", async () => {
    const onSelect = vi.fn();
    const fetchMock = vi.mocked(fetch);
    fetchMock.mockImplementation(() => response({ tickets: [ticket] }));
    render(React.createElement(SupportInbox, { onSelect }));

    expect(await screen.findByText("전적 비공개 요청")).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText("문의 상태"), { target: { value: "in_progress" } });
    fireEvent.change(screen.getByLabelText("문의 유형"), { target: { value: "privacy" } });
    fireEvent.change(screen.getByLabelText("문의 검색"), { target: { value: "PlayerOne" } });
    await waitFor(() => expect(fetchMock).toHaveBeenLastCalledWith(expect.stringContaining("status=in_progress")));
    expect(fetchMock.mock.lastCall?.[0]).toContain("category=privacy");
    expect(fetchMock.mock.lastCall?.[0]).toContain("q=PlayerOne");
    fireEvent.click(screen.getByRole("button", { name: /전적 비공개 요청/ }));
    expect(onSelect).toHaveBeenCalledWith(ticketId);
  });

  it("keeps privacy action disabled until verification is saved, then replies and applies it", async () => {
    const fetchMock = vi.mocked(fetch);
    fetchMock
      .mockImplementationOnce(() => response({ ticket }))
      .mockImplementationOnce(() => response({ ticket: { ...ticket, verification_status: "verified" } }))
      .mockImplementationOnce(() => response({ message: { id: "m-2" } }, true, 201))
      .mockImplementationOnce(() => response({ ticket: { ...ticket, verification_status: "verified" } }))
      .mockImplementationOnce(() => response({ ok: true }));
    render(React.createElement(SupportTicketDetail, { ticketId }));

    expect(await screen.findByText("전적요청자")).toBeInTheDocument();
    const privacyButton = screen.getByRole("button", { name: "비공개 목록에 등록" });
    expect(privacyButton).toBeDisabled();
    fireEvent.change(screen.getByLabelText("본인 계정 확인"), { target: { value: "verified" } });
    await waitFor(() => expect(fetchMock).toHaveBeenCalledWith(`/api/admin/support/tickets/${ticketId}`, expect.objectContaining({ method: "PATCH" })));
    expect(await screen.findByRole("button", { name: "비공개 목록에 등록" })).toBeEnabled();
    fireEvent.change(screen.getByLabelText("관리자 답변"), { target: { value: "확인 후 처리했습니다." } });
    fireEvent.click(screen.getByRole("button", { name: "답변 보내기" }));
    await waitFor(() => expect(fetchMock).toHaveBeenCalledWith(`/api/admin/support/tickets/${ticketId}/messages`, expect.objectContaining({ method: "POST" })));
    fireEvent.click(screen.getByRole("button", { name: "비공개 목록에 등록" }));
    await waitFor(() => expect(fetchMock).toHaveBeenCalledWith(`/api/admin/support/tickets/${ticketId}/privacy-action`, expect.objectContaining({ method: "POST" })));
    expect(mocks.toast.success).toHaveBeenCalled();
  });
});
