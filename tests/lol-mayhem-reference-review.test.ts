// @vitest-environment jsdom
import { createElement } from "react";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import type { ReferencePublication, ReferenceRelease } from "@/lib/lol/mayhemReference";
import LolMayhemReferenceReview from "@/components/lol/LolMayhemReferenceReview";

const release = (id: number, kind: ReferenceRelease["kind"], status: ReferenceRelease["status"] = "pending"): ReferenceRelease => ({
  id, kind, source: kind === "champion_tiers" ? "aramgg" : kind === "item_ratings" ? "iesdev" : "arammayhem",
  client_patch: "16.21", champion_id: 63, upstream_version: "1.2.3", source_data_date: "2026-11-01",
  raw_hash: "a".repeat(64), normalized_hash: "b".repeat(64), raw_path: "raw.json", normalized_path: "normalized.json",
  raw_bytes: 10, normalized_bytes: 20, attribution: "출처 표기", rights_basis: "사용 허가", status,
  fetched_at: "2026-11-02T00:00:00Z", reviewed_at: null,
});
const base = { enabled: true, publicEnabled: false, champions: [{ id: 63, name: "트위치" }], releases: [release(1, "champion_tiers"), release(2, "item_ratings"), release(3, "augment_rankings", "approved")], publications: [] as ReferencePublication[], sync: [] };
const load = (data = base) => vi.fn().mockResolvedValue(Response.json(data));
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

it("filters candidates by kind and labels external sources without implying champion archives", async () => {
  vi.stubGlobal("fetch", load());
  render(createElement(LolMayhemReferenceReview));
  expect(await screen.findByText(/ARAMGG 티어 참고 자료/)).toBeTruthy();
  expect((screen.getByLabelText("검토 후보") as HTMLSelectElement).options).toHaveLength(1);
  fireEvent.change(screen.getByLabelText("자료 종류"), { target: { value: "augment_rankings" } });
  expect(await screen.findByText(/전체 증강 순위이며 챔피언별 자료가 아닙니다/)).toBeTruthy();
  expect((screen.getByLabelText("검토 후보") as HTMLSelectElement).value).toBe("3");
});

it("lists every returned candidate and lets admins filter older candidates", async () => {
  vi.stubGlobal("fetch", load({ ...base, releases: Array.from({ length: 174 }, (_, index) => release(index + 1, "champion_tiers")) }));
  render(createElement(LolMayhemReferenceReview));
  expect((await screen.findByLabelText("검토 후보") as HTMLSelectElement).options).toHaveLength(174);
  fireEvent.change(screen.getByLabelText("후보 검색"), { target: { value: "16.21 2026-11-01" } });
  expect((screen.getByLabelText("검토 후보") as HTMLSelectElement).options).toHaveLength(174);
  fireEvent.change(screen.getByLabelText("후보 검색"), { target: { value: "174" } });
  expect((screen.getByLabelText("검토 후보") as HTMLSelectElement).options).toHaveLength(1);
  expect(screen.getByText("1개 표시 · 전체 174개")).toBeTruthy();
  expect(screen.getByLabelText("검토 후보").textContent).toContain("트위치");
  fireEvent.change(screen.getByLabelText("후보 검색"), { target: { value: "트위치" } });
  expect((screen.getByLabelText("검토 후보") as HTMLSelectElement).options).toHaveLength(174);
  expect(screen.getByText("저장된 자료의 사용자 화면 적용은 대기 중입니다.")).toBeTruthy();
});

it("keeps a 174-candidate batch target list collapsed but inspectable", async () => {
  const releases = Array.from({ length: 174 }, (_, index) => ({ ...release(index + 1, "champion_tiers"), champion_id: index + 1 }));
  vi.stubGlobal("fetch", load({ ...base, releases }));
  render(createElement(LolMayhemReferenceReview));
  expect(await screen.findByRole("button", { name: "이 패치 174개 검수 승인" })).toBeTruthy();
  const targetList = screen.getByText("검수 대상 174개 목록").closest("details") as HTMLDetailsElement;
  expect(targetList.open).toBe(false);
  fireEvent.click(screen.getByText("검수 대상 174개 목록"));
  expect(targetList.open).toBe(true);
  expect(targetList.querySelectorAll("li")).toHaveLength(174);
  expect(targetList.querySelector("ul")?.className).toContain("max-h-64");
});

it("requires confirmation and sends the expected publication when approving a pending release", async () => {
  const current = { kind: "champion_tiers" as const, client_patch: "16.21", champion_id: 63, release_id: 9, previous_release_id: null, published_at: "2026-11-01T00:00:00Z" };
  const fetchMock = vi.fn().mockResolvedValueOnce(Response.json({ ...base, publications: [current] })).mockResolvedValueOnce(Response.json({ ok: true })).mockResolvedValueOnce(Response.json({ ...base, publications: [current] }));
  vi.stubGlobal("fetch", fetchMock);
  render(createElement(LolMayhemReferenceReview));
  const approve = await screen.findByRole("button", { name: "검수 승인" });
  expect((approve as HTMLButtonElement).disabled).toBe(true);
  fireEvent.click(screen.getByLabelText(/출처·사용 권한/));
  fireEvent.click(approve);
  await screen.findByText("참조 자료 상태를 저장했습니다.");
  expect(JSON.parse(fetchMock.mock.calls[1][1].body)).toEqual({ action: "approve", id: 1, expectedPublication: 9, confirm: true, reason: null });
});

it("enforces rejection reason and limits rollback to the currently published release", async () => {
  const current = { kind: "champion_tiers" as const, client_patch: "16.21", champion_id: 63, release_id: 1, previous_release_id: 8, published_at: "2026-11-01T00:00:00Z" };
  vi.stubGlobal("fetch", load({ ...base, publications: [current] }));
  render(createElement(LolMayhemReferenceReview));
  const reject = await screen.findByRole("button", { name: "후보 제외" });
  fireEvent.click(screen.getByLabelText(/출처·사용 권한/));
  fireEvent.change(screen.getByLabelText("후보 제외 사유"), { target: { value: "짧음" } });
  expect((reject as HTMLButtonElement).disabled).toBe(true);
  fireEvent.change(screen.getByLabelText("후보 제외 사유"), { target: { value: "출처의 이용 조건을 확인할 수 없음" } });
  expect((reject as HTMLButtonElement).disabled).toBe(false);
  expect((screen.getByRole("button", { name: "이전 공개본으로 복구" }) as HTMLButtonElement).disabled).toBe(false);
  fireEvent.change(screen.getByLabelText("자료 종류"), { target: { value: "item_ratings" } });
  expect((screen.getByRole("button", { name: "이전 공개본으로 복구" }) as HTMLButtonElement).disabled).toBe(true);
});

it("keeps writes disabled when the rollout flag is off and offers retry after a failed GET", async () => {
  const fetchMock = vi.fn().mockResolvedValueOnce(Response.json({ ...base, enabled: false }, { status: 503 })).mockResolvedValueOnce(Response.json({ ...base, enabled: false }));
  vi.stubGlobal("fetch", fetchMock);
  render(createElement(LolMayhemReferenceReview));
  expect(await screen.findByRole("alert")).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "다시 시도" }));
  expect(await screen.findByText("기능이 비활성화되어 자료 변경을 할 수 없습니다.")).toBeTruthy();
  expect((screen.getByRole("button", { name: "검수 승인" }) as HTMLButtonElement).disabled).toBe(true);
});

it("aborts the pending initial request on unmount", async () => {
  let signal: AbortSignal | undefined;
  vi.stubGlobal("fetch", vi.fn((_url, options) => { signal = options.signal; return new Promise(() => {}); }));
  const view = render(createElement(LolMayhemReferenceReview));
  view.unmount();
  expect(signal?.aborted).toBe(true);
});

it("batch-approves only the newest candidate per champion and keeps phases separately confirmed", async () => {
  const newest = { ...release(20, "champion_tiers"), source_data_date: "2026-11-02" };
  const older = { ...release(10, "champion_tiers"), source_data_date: "2026-10-31" };
  const otherPending = { ...release(19, "champion_tiers"), champion_id: 64 };
  const otherChampion = [65, 66].map(id => ({ ...release(id, "champion_tiers"), champion_id: id, status: "approved" as const }));
  const fetchMock = vi.fn()
    .mockResolvedValueOnce(Response.json({ ...base, releases: [newest, older, otherPending, ...otherChampion] }))
    .mockResolvedValueOnce(Response.json({ ok: true }))
    .mockResolvedValueOnce(Response.json({ ok: true }))
    .mockResolvedValueOnce(Response.json({ ...base, releases: [{ ...newest, status: "approved" }, older, { ...otherPending, status: "approved" }, ...otherChampion] }));
  vi.stubGlobal("fetch", fetchMock);
  render(createElement(LolMayhemReferenceReview));

  const approveBatch = await screen.findByRole("button", { name: "이 패치 2개 검수 승인" });
  expect(screen.getByLabelText("검토 후보").textContent).toContain("2026-10-31");
  const approveConfirm = screen.getByLabelText(/검수 대기 2개를 모두 승인/);
  const publishConfirm = screen.getByLabelText(/승인된 미공개 후보 2개를 모두 공개/);
  fireEvent.click(approveConfirm);
  expect((publishConfirm as HTMLInputElement).checked).toBe(false);
  expect((screen.getByRole("button", { name: "이 패치 2개 공개" }) as HTMLButtonElement).disabled).toBe(true);
  fireEvent.click(approveBatch);

  expect(await screen.findByText("2개 후보 검수 승인을 완료했습니다.")).toBeTruthy();
  expect(fetchMock).toHaveBeenCalledTimes(4);
  expect(fetchMock.mock.calls.slice(1, 3).map(call => JSON.parse(call[1].body).id)).toEqual([20, 19]);
  expect(fetchMock.mock.calls.slice(1, 3).every(call => JSON.parse(call[1].body).action === "approve")).toBe(true);
});

it("stops a publish batch on its first CAS conflict and refreshes once", async () => {
  const releases = [1, 2, 3].map((id, index) => ({ ...release(id, "champion_tiers", "approved"), champion_id: 63 + index }));
  const published = { kind: "champion_tiers" as const, client_patch: "16.21", champion_id: 63, release_id: 1, previous_release_id: null, published_at: "2026-11-02T00:00:00Z" };
  const fetchMock = vi.fn()
    .mockResolvedValueOnce(Response.json({ ...base, releases }))
    .mockResolvedValueOnce(Response.json({ ok: true }))
    .mockResolvedValueOnce(Response.json({ error: "공개 상태가 변경되었습니다." }, { status: 409 }))
    .mockResolvedValueOnce(Response.json({ ...base, releases, publications: [published] }));
  vi.stubGlobal("fetch", fetchMock);
  render(createElement(LolMayhemReferenceReview));
  fireEvent.click(await screen.findByLabelText(/승인된 미공개 후보 3개를 모두 공개/));
  fireEvent.click(screen.getByRole("button", { name: "이 패치 3개 공개" }));

  expect(await screen.findByText(/1\/3개 처리 후 중단했습니다/)).toBeTruthy();
  expect(screen.getByText("공개 진행 1/3")).toBeTruthy();
  expect(fetchMock).toHaveBeenCalledTimes(4);
  for (const call of fetchMock.mock.calls.slice(1, 3)) {
    expect(JSON.parse(call[1].body)).toMatchObject({ action: "publish", expectedPublication: null, confirm: true });
  }
  expect((screen.getByLabelText(/승인된 미공개 후보 2개를 모두 공개/) as HTMLInputElement).checked).toBe(false);
});
