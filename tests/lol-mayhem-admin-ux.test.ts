// @vitest-environment jsdom
import { createElement } from "react";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import MayhemDatasetReviewPanel from "@/app/admin/lol/mayhem-datasets/MayhemDatasetReviewPanel";

afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

it("shows one dataset family at a time and only loads its admin API when selected", async () => {
  const fetchMock = vi.fn(async (url: string) => {
    if (url.includes("mayhem-champion-datasets")) return Response.json({ releases: [], publications: [], sync: [], readiness: { apiKeyConfigured: false, reuseConfirmed: false, enabled: false, persistenceEnabled: false } });
    if (url.includes("mayhem-references")) return Response.json({ enabled: true, releases: [], publications: [], sync: [] });
    return Response.json({ releases: [], publications: [], mappings: [], augments: [], sync: [] });
  });
  vi.stubGlobal("fetch", fetchMock);
  render(createElement(MayhemDatasetReviewPanel));

  expect(await screen.findByRole("heading", { name: "챔피언 증강 통계" })).toBeTruthy();
  await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
  expect(fetchMock.mock.calls[0][0]).toContain("mayhem-champion-datasets");
  expect(screen.queryByRole("heading", { name: "티어·아이템·패치 순위" })).toBeNull();

  fireEvent.click(screen.getByRole("tab", { name: "티어·아이템·패치 순위" }));
  expect(await screen.findByText("참고 자료를 확인하고 검수·공개 상태를 관리합니다. 공개와 사용자 화면 적용은 별도입니다.")).toBeTruthy();
  await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
  expect(fetchMock.mock.calls[1][0]).toContain("mayhem-references");

  fireEvent.click(screen.getByRole("tab", { name: "증강 조합·매핑" }));
  expect(await screen.findByText("아직 실행 기록이 없습니다.")).toBeTruthy();
  await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(3));
  expect(fetchMock.mock.calls[2][0]).toContain("mayhem-datasets");
});
