// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createElement } from "react";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import ReportForm from "../components/map/ReportForm";

const mocks = vi.hoisted(() => ({ getSession: vi.fn(), success: vi.fn(), warning: vi.fn(), error: vi.fn() }));
vi.mock("../lib/supabase", () => ({ supabase: { auth: { getSession: mocks.getSession } } }));
vi.mock("sonner", () => ({ toast: { success: mocks.success, warning: mocks.warning, error: mocks.error } }));
vi.mock("../hooks/useMapSettings", () => ({
  useMapSettings: () => ({ activeCategories: ["Garage"], categoryInfoMap: { Garage: { label: "차고지" } } }),
}));

let fetchMock: ReturnType<typeof vi.fn>;
let timers: ReturnType<typeof vi.spyOn>;
beforeEach(() => {
  vi.clearAllMocks();
  mocks.getSession.mockResolvedValue({ data: { session: { access_token: "verified-session" } } });
  fetchMock = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ success: true, nearby: false }) });
  vi.stubGlobal("fetch", fetchMock);
  timers = vi.spyOn(globalThis, "setTimeout");
  sessionStorage.clear();
});
afterEach(() => {
  for (const result of timers.mock.results) if (result.type === "return") clearTimeout(result.value);
  cleanup(); vi.restoreAllMocks(); vi.unstubAllGlobals();
});
function show() {
  const onClose = vi.fn();
  render(createElement(ReportForm, { location: { lng: 300, lat: 400 } as any, activeMapId: "Erangel", icons: {}, currentUser: { id: "ui-user" }, onClose }));
  fireEvent.click(screen.getByRole("button", { name: "차고지" }));
  return onClose;
}
describe("제보 창 저장 동작", () => {
  it("로그인 토큰과 위치만 서버에 보내며 연속 클릭은 한 번만 저장한다", async () => {
    const onClose = show(); const submit = screen.getByRole("button", { name: "이 차량으로 제보하기" });
    fireEvent.click(submit); fireEvent.click(submit);
    await waitFor(() => expect(onClose).toHaveBeenCalledOnce());
    expect(fetchMock).toHaveBeenCalledOnce();
    const [url, options] = fetchMock.mock.calls[0];
    expect(url).toBe("/api/report");
    expect(options.headers.Authorization).toBe("Bearer verified-session");
    expect(JSON.parse(options.body)).toEqual({ mapName: "Erangel", markerType: "Garage", x: 300, y: 400 });
    expect(mocks.success).toHaveBeenCalledOnce();
    expect(sessionStorage.getItem("showPendingReports")).toBe("true");
  });
  it("근접 제보는 경고하고 새로 접수됐다고 알리지 않는다", async () => {
    fetchMock.mockResolvedValue({ ok: true, json: async () => ({ success: true, nearby: true }) });
    const onClose = show(); fireEvent.click(screen.getByRole("button", { name: "이 차량으로 제보하기" }));
    await waitFor(() => expect(onClose).toHaveBeenCalledOnce());
    expect(mocks.warning).toHaveBeenCalledWith(expect.stringContaining("20m"), { duration: 5000 });
    expect(mocks.success).not.toHaveBeenCalled();
  });
  it("저장 실패 후 선택한 종류를 유지하고 다시 시도할 수 있다", async () => {
    fetchMock.mockResolvedValueOnce({ ok: false, json: async () => ({ error: "offline" }) });
    const onClose = show(); fireEvent.click(screen.getByRole("button", { name: "이 차량으로 제보하기" }));
    await waitFor(() => expect(mocks.error).toHaveBeenCalledOnce());
    expect(onClose).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "이 차량으로 제보하기" }));
    await waitFor(() => expect(onClose).toHaveBeenCalledOnce());
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});
