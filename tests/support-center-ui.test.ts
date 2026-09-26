// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import React from "react";

const mocks = vi.hoisted(() => ({
  routerPush: vi.fn(),
  auth: vi.fn(),
  uploadToSignedUrl: vi.fn(),
}));

vi.mock("next/navigation", () => ({ useRouter: () => ({ push: mocks.routerPush, refresh: vi.fn() }), useSearchParams: () => new URLSearchParams(window.location.search) }));
vi.mock("@/components/AuthProvider", () => ({ useAuth: mocks.auth }));
vi.mock("@/lib/supabase", () => ({
  supabase: { storage: { from: vi.fn(() => ({ uploadToSignedUrl: mocks.uploadToSignedUrl })) } },
}));

import SupportCenter from "@/components/support/SupportCenter";
import TicketForm from "@/components/support/TicketForm";
import TicketThread from "@/components/support/TicketThread";

const faq = { id: "faq-1", category: "stats", question: "비공개 요청은?", answer: "고객센터에서 요청해 주세요." };
const ticket = {
  id: "11111111-1111-4111-8111-111111111111",
  subject: "문의",
  status: "answered",
  verification_status: "not_required",
  messages: [
    { id: "m-1", sender_type: "admin", body: "확인했습니다.", created_at: "2026-09-21T00:00:00.000Z" },
  ],
  attachments: [],
};

function response(body: unknown, status = 200) {
  return Promise.resolve(new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  }));
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.auth.mockReturnValue({ user: null, loading: false });
  mocks.uploadToSignedUrl.mockResolvedValue({ error: null });
  vi.stubGlobal("fetch", vi.fn());
});

describe("support center UI", () => {
  it("shows public FAQ and login action without exposing the ticket form to anonymous users", () => {
    render(React.createElement(SupportCenter, { faqs: [faq], isAuthenticated: false }));
    expect(screen.getByText("비공개 요청은?")).toBeTruthy();
    expect(screen.getByRole("link", { name: /로그인 후 1:1 문의/i }).getAttribute("href")).toBe("/login?next=/support/new");
    expect(screen.queryByLabelText("문의 유형")).toBeNull();
  });

  it("loads the authenticated user's private ticket list on the my tab", async () => {
    window.history.replaceState({}, "", "/support?tab=my");
    mocks.auth.mockReturnValue({ user: { id: "user-1" }, loading: false });
    vi.mocked(fetch).mockImplementationOnce(() => response({ tickets: [{ id: ticket.id, subject: "내 문의", status: "answered", verification_status: "not_required", updated_at: "2026-09-21T00:00:00.000Z" }] }));
    render(React.createElement(SupportCenter, { faqs: [faq], isAuthenticated: true }));
    expect(await screen.findByRole("region", { name: "내 문의" })).toBeTruthy();
    expect(screen.getAllByRole("link").some((link) => link.getAttribute("href") === `/support/${ticket.id}`)).toBe(true);
    window.history.replaceState({}, "", "/");
  });

  it("reveals the privacy target and screenshot requirement, keeping submit disabled without evidence", () => {
    render(React.createElement(TicketForm, {}));
    fireEvent.change(screen.getByLabelText("문의 유형"), { target: { value: "privacy" } });
    expect(screen.getByText("스크린샷 필수 · PNG/JPEG/WebP · 파일당 3MiB 이하")).toBeTruthy();
    expect(screen.getByRole("button", { name: "문의 제출" }).hasAttribute("disabled")).toBe(true);
  });

  it("navigates after a successful general inquiry and leaves an attachment error retryable", async () => {
    const fetchMock = vi.mocked(fetch);
    fetchMock.mockImplementationOnce(() => response({ ticket: { id: ticket.id } }, 201));
    render(React.createElement(TicketForm, {}));
    fireEvent.change(screen.getByLabelText("제목"), { target: { value: "로그인 문의" } });
    fireEvent.change(screen.getByLabelText("문의 내용"), { target: { value: "확인 부탁드립니다." } });
    fireEvent.click(screen.getByRole("button", { name: "문의 제출" }));
    await waitFor(() => expect(mocks.routerPush).toHaveBeenCalledWith(`/support/${ticket.id}`));

    cleanup();
    fetchMock.mockReset();
    fetchMock.mockImplementationOnce(() => response({ error: "업로드 실패" }, 503));
    render(React.createElement(TicketForm, {}));
    fireEvent.change(screen.getByLabelText("제목"), { target: { value: "첨부 문의" } });
    fireEvent.change(screen.getByLabelText("문의 내용"), { target: { value: "재시도 부탁드립니다." } });
    fireEvent.change(screen.getByLabelText("첨부파일"), {
      target: { files: [new File(["proof"], "proof.png", { type: "image/png" })] },
    });
    await waitFor(() => expect(screen.getByRole("alert")).toHaveTextContent("proof.png: 업로드 실패"));
    expect(screen.getByRole("button", { name: "문의 제출" }).hasAttribute("disabled")).toBe(false);
  });

  it("uploads a selected image and keeps it when a later upload fails", async () => {
    const fetchMock = vi.mocked(fetch);
    fetchMock
      .mockImplementationOnce(() => response({ attachmentId: "image-1", bucketId: "support-evidence", storageKey: "attachments/image-1", token: "token-1" }))
      .mockImplementationOnce(() => response({ attachmentId: "image-1", status: "ready" }))
      .mockImplementationOnce(() => response({ error: "첨부파일 업로드를 준비하지 못했습니다." }, 503));
    render(React.createElement(TicketForm, {}));
    const input = screen.getByLabelText("첨부파일");
    fireEvent.change(input, { target: { files: [new File(["proof"], "proof.png", { type: "image/png" })] } });
    await waitFor(() => expect(screen.getByText("첨부파일 1개 준비 완료")).toBeTruthy());
    expect(mocks.uploadToSignedUrl).toHaveBeenCalledWith(
      "attachments/image-1", "token-1", expect.any(File), { contentType: "image/png", upsert: false },
    );
    expect(input).toHaveValue("");

    fireEvent.change(input, { target: { files: [new File(["second"], "second.png", { type: "image/png" })] } });
    await waitFor(() => expect(screen.getByRole("alert")).toHaveTextContent("second.png: 첨부파일 업로드를 준비하지 못했습니다."));
    expect(screen.getByText("첨부파일 1개 준비 완료")).toBeTruthy();
  });

  it("renders an admin reply and posts a new user message", async () => {
    const fetchMock = vi.mocked(fetch);
    fetchMock
      .mockImplementationOnce(() => response({ ticket }))
      .mockImplementationOnce(() => response({ message: { id: "m-2" } }, 201))
      .mockImplementationOnce(() => response({ ticket }));
    render(React.createElement(TicketThread, { ticketId: ticket.id }));
    expect(await screen.findByText("확인했습니다.")).toBeTruthy();
    fireEvent.change(screen.getByLabelText("답변"), { target: { value: "추가 정보를 보냅니다." } });
    fireEvent.click(screen.getByRole("button", { name: "답변 보내기" }));
    await waitFor(() => expect(fetchMock).toHaveBeenCalledWith(`/api/support/tickets/${ticket.id}/messages`, expect.objectContaining({ method: "POST" })));
    expect(fetchMock.mock.calls[1]?.[1]).toEqual(expect.objectContaining({
      headers: expect.objectContaining({ "Idempotency-Key": expect.stringMatching(/^[0-9a-f-]{36}$/) }),
    }));
  });

  it("disables the reply while sending so the same request key can be retried safely", async () => {
    const fetchMock = vi.mocked(fetch);
    let resolveSend!: (value: Response) => void;
    const pendingSend = new Promise<Response>((resolve) => { resolveSend = resolve; });
    fetchMock
      .mockImplementationOnce(() => response({ ticket }))
      .mockImplementationOnce(() => pendingSend)
      .mockImplementationOnce(() => response({ ticket }));
    render(React.createElement(TicketThread, { ticketId: ticket.id }));
    expect(await screen.findByText("확인했습니다.")).toBeTruthy();
    fireEvent.change(screen.getByLabelText("답변"), { target: { value: "중복 없이 보냅니다." } });
    const submit = screen.getByRole("button", { name: "답변 보내기" });
    fireEvent.click(submit);
    await waitFor(() => expect(submit).toBeDisabled());
    expect(fetchMock.mock.calls[1]?.[1]).toEqual(expect.objectContaining({
      headers: expect.objectContaining({ "Idempotency-Key": expect.stringMatching(/^[0-9a-f-]{36}$/) }),
    }));
    resolveSend(new Response(JSON.stringify({ message: { id: "m-2" } }), { status: 201 }));
    await waitFor(() => expect(screen.getByLabelText("답변")).not.toBeDisabled());
  });
});
