// @vitest-environment jsdom
import { createElement } from "react";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import MayhemDatasetReviewPanel from "@/app/admin/lol/mayhem-datasets/MayhemDatasetReviewPanel";
import { referenceUpdateGroup, type ReferenceAdminData } from "@/lib/lol/mayhemAdminUpdates";
import type { ReferenceRelease } from "@/lib/lol/mayhemReference";

const release = (id: number, overrides: Partial<ReferenceRelease> = {}): ReferenceRelease => ({
  id, kind: "item_ratings", source: "iesdev", client_patch: "16.22", champion_id: 29, upstream_version: "16.22.1",
  source_data_date: "2026-11-04", fetched_at: `2026-11-05T00:00:${String(id).padStart(2, "0")}Z`, status: "pending",
  raw_hash: "a".repeat(64), normalized_hash: "b".repeat(64), raw_path: "raw.json", normalized_path: "normalized.json",
  raw_bytes: 1, normalized_bytes: 1, attribution: "출처", rights_basis: "검토된 사용 조건", reviewed_at: null, ...overrides,
});
const fixture = (): ReferenceAdminData => ({ enabled: true, publicEnabled: true, itemsEnabled: true, champions: [{ id: 29, name: "트위치" }],
  releases: [release(2), release(1, { status: "approved", source_data_date: "2026-11-01" })],
  publications: [{ kind: "item_ratings", client_patch: "16.22", champion_id: 29, release_id: 1, previous_release_id: null, published_at: "2026-11-01T00:00:00Z" }], sync: [],
});
function mockApi(data = fixture()) {
  const mock = vi.fn(async (url: string, options?: RequestInit) => {
    if (options?.method === "POST") return Response.json({ ok: true });
    if (url.endsWith("mayhem-references")) return Response.json(data);
    if (url.endsWith("mayhem-champion-datasets")) return Response.json({ releases: [], publications: [], sync: [], readiness: { apiKeyConfigured: true, reuseConfirmed: true, enabled: true, persistenceEnabled: true } });
    return Response.json({ releases: [], publications: [], mappings: [], augments: [], sync: [] });
  });
  vi.stubGlobal("fetch", mock); return mock;
}
const writes = (mock: ReturnType<typeof mockApi>) => mock.mock.calls.filter(call => call[1]?.method === "POST").map(call => JSON.parse(call[1]!.body as string));
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

it("shows collected data and its user-facing effect in Korean, without the old technical tabs", async () => {
  const mock = mockApi(); render(createElement(MayhemDatasetReviewPanel));
  const item = await screen.findByRole("article", { name: "아이템·신발" });
  expect(item.textContent).toContain("26.22 패치 · 1명 수집했습니다.");
  expect(item.textContent).toContain("챔피언별 아이템·신발 탭의 평가 순위가 바뀝니다.");
  expect(screen.getAllByRole("article")).toHaveLength(5);
  expect(screen.queryByRole("tablist")).toBeNull();
  expect(screen.queryByLabelText("검토 후보")).toBeNull();
  expect(writes(mock)).toEqual([]);
  fireEvent.click(screen.getByText("증강 이름 연결"));
  expect(await screen.findByText("아직 수집한 조합 자료가 없습니다.")).toBeTruthy();
  expect(screen.queryByRole("tablist")).toBeNull();
  expect(screen.queryByLabelText("외부 증강 ID")).toBeNull();
});

it("selects the newest capture per scope and never downgrades item patches", () => {
  const data = fixture();
  data.releases.push(release(3, { client_patch: "16.21" }), release(4, { champion_id: 30, client_patch: "16.21" }));
  data.publications.push({ ...data.publications[0], champion_id: 30, release_id: 9 });
  expect(referenceUpdateGroup(data, "item_ratings").targets.map(row => row.id)).toEqual([2]);
  const upgrade = { ...data, releases: [release(6, { client_patch: "16.23" })] };
  expect(referenceUpdateGroup(upgrade, "item_ratings").targets[0]).toMatchObject({ previousPatch: "16.22", patch: "16.23", expectedPublication: null });
  data.releases.push(release(5, { status: "rejected" }));
  expect(referenceUpdateGroup(data, "item_ratings").targets).toEqual([]);
});

it("writes only after explicit apply confirmation, keeps CAS and records approve then publish", async () => {
  const data = fixture(); const mock = mockApi(data); render(createElement(MayhemDatasetReviewPanel));
  const item = await screen.findByRole("article", { name: "아이템·신발" });
  fireEvent.click(within(item).getByRole("button", { name: "적용 내용 확인" }));
  expect(writes(mock)).toEqual([]);
  expect(within(item).getByText(/새로 수집한 1개 자료로 사용자 화면을 갱신/)).toBeTruthy();
  const confirm = within(item).getByRole("button", { name: "확인하고 적용" });
  fireEvent.click(confirm); fireEvent.click(confirm);
  await screen.findByText("아이템·신발 자료 1개를 적용했습니다. 사용자 화면에 순차적으로 반영됩니다.");
  expect(writes(mock)).toEqual([
    { action: "approve", id: 2, expectedPublication: 1, confirm: true, reason: null },
    { action: "publish", id: 2, expectedPublication: 1, confirm: true, reason: null },
  ]);
  data.releases[0].status = "approved"; data.publications[0].release_id = 2;
  fireEvent.click(screen.getByRole("button", { name: "새로고침" }));
  await waitFor(() => expect(within(item).getByText("적용됨")).toBeTruthy());
  expect(within(item).queryByRole("button", { name: "적용 내용 확인" })).toBeNull();
});

it("stops after the first publish conflict, reports partial completion and does not touch later targets", async () => {
  const data = fixture(); data.releases = [2, 3, 4].map(id => release(id, { champion_id: id, status: "approved" })); data.publications = [];
  const mock = mockApi(data);
  mock.mockImplementation(async (url, options) => {
    if (options?.method === "POST") return JSON.parse(options.body as string).id === 3 ? Response.json({ error: "공개 상태가 바뀌었습니다." }, { status: 409 }) : Response.json({ ok: true });
    if (url.endsWith("mayhem-references")) return Response.json(data);
    if (url.endsWith("mayhem-champion-datasets")) return Response.json({ releases: [], publications: [], sync: [], readiness: {} });
    return Response.json({ releases: [], publications: [], mappings: [], augments: [], sync: [] });
  });
  render(createElement(MayhemDatasetReviewPanel));
  const item = await screen.findByRole("article", { name: "아이템·신발" });
  fireEvent.click(within(item).getByRole("button", { name: "적용 내용 확인" }));
  fireEvent.click(within(item).getByRole("button", { name: "확인하고 적용" }));
  expect(await screen.findByText(/1\/3개 적용 후 중단했습니다/)).toBeTruthy();
  expect(writes(mock).map(row => [row.action, row.id])).toEqual([["publish", 4], ["publish", 3]]);
});

it("keeps the success receipt when a subsequent status reload fails", async () => {
  const data = fixture(); const mock = mockApi(data); let published = false;
  mock.mockImplementation(async (url, options) => {
    if (options?.method === "POST") { if (JSON.parse(options.body as string).action === "publish") published = true; return Response.json({ ok: true }); }
    if (published) return Response.json({}, { status: 503 });
    if (url.endsWith("mayhem-references")) return Response.json(data);
    if (url.endsWith("mayhem-champion-datasets")) return Response.json({ releases: [], publications: [], sync: [], readiness: {} });
    return Response.json({ releases: [], publications: [], mappings: [], augments: [], sync: [] });
  });
  render(createElement(MayhemDatasetReviewPanel));
  const item = await screen.findByRole("article", { name: "아이템·신발" });
  fireEvent.click(within(item).getByRole("button", { name: "적용 내용 확인" }));
  fireEvent.click(within(item).getByRole("button", { name: "확인하고 적용" }));
  expect(await screen.findByText(/자료 1개를 적용했습니다/)).toBeTruthy();
  expect(await screen.findByText(/티어·아이템·패치 순위 자료를 불러오지 못했습니다/)).toBeTruthy();
  expect(screen.queryByText(/적용 후 중단/)).toBeNull();
});

it("does not publish after leaving the page while approval is in flight", async () => {
  const data = fixture(); const mock = mockApi(data); let finish!: (value: Response) => void;
  mock.mockImplementation(async (url, options) => {
    if (options?.method === "POST") return new Promise<Response>(resolve => { finish = resolve; });
    if (url.endsWith("mayhem-references")) return Response.json(data);
    if (url.endsWith("mayhem-champion-datasets")) return Response.json({ releases: [], publications: [], sync: [], readiness: {} });
    return Response.json({ releases: [], publications: [], mappings: [], augments: [], sync: [] });
  });
  const view = render(createElement(MayhemDatasetReviewPanel));
  const item = await screen.findByRole("article", { name: "아이템·신발" });
  fireEvent.click(within(item).getByRole("button", { name: "적용 내용 확인" }));
  fireEvent.click(within(item).getByRole("button", { name: "확인하고 적용" }));
  view.unmount(); await act(async () => { finish(Response.json({ ok: true })); });
  expect(writes(mock).map(row => row.action)).toEqual(["approve"]);
});

it("disables applying when public use is off and preserves other loaded summaries on a failed GET", async () => {
  const data = fixture(); data.publicEnabled = false;
  const mock = mockApi(data);
  mock.mockImplementation(async url => url.endsWith("mayhem-references") ? Response.json(data) : Response.json({}, { status: 503 }));
  render(createElement(MayhemDatasetReviewPanel));
  const item = await screen.findByRole("article", { name: "아이템·신발" });
  expect((within(item).getByRole("button", { name: "적용 내용 확인" }) as HTMLButtonElement).disabled).toBe(true);
  expect(within(item).getByText(/화면 적용 설정이 꺼져 있습니다/)).toBeTruthy();
  expect(screen.getAllByRole("article")).toHaveLength(3);
  expect(screen.getByText(/챔피언별 증강 자료를 불러오지 못했습니다/)).toBeTruthy();
});

it("blocks incomplete champion captures and unmapped combos with a plain Korean reason", async () => {
  const mock = mockApi();
  mock.mockImplementation(async url => {
    if (url.endsWith("mayhem-references")) return Response.json(fixture());
    if (url.endsWith("mayhem-champion-datasets")) return Response.json({
      releases: [{ id: 1, client_patch: "16.22", source_data_date: "2026-11-04", fetched_at: "2026-11-05T00:00:00Z", status: "pending", metadata: { expectedChampionIds: [29], files: [] } }],
      publications: [], sync: [], readiness: { apiKeyConfigured: true, reuseConfirmed: true, enabled: true, persistenceEnabled: true },
    });
    return Response.json({ releases: [{ id: 1, verified_client_patch: "16.22", fetched_at: "2026-11-05T00:00:00Z", status: "pending", metadata: { unknown_count: 5 } }], publications: [], mappings: [], augments: [], sync: [] });
  });
  render(createElement(MayhemDatasetReviewPanel));
  const champion = await screen.findByRole("article", { name: "챔피언별 증강" });
  const combo = screen.getByRole("article", { name: "증강 추천 조합" });
  expect(within(champion).getByText("챔피언 자료가 모두 모이지 않았습니다.")).toBeTruthy();
  expect(within(combo).getByText("증강 5개의 이름을 먼저 연결해야 합니다.")).toBeTruthy();
  expect((within(champion).getByRole("button", { name: "적용 내용 확인" }) as HTMLButtonElement).disabled).toBe(true);
  expect(within(combo).getByRole("button", { name: "이름 연결하기" })).toBeTruthy();
  expect(within(combo).queryByRole("button", { name: "적용 내용 확인" })).toBeNull();
  expect(writes(mock)).toEqual([]);
});

it("shows a collection failure for the combo job without blaming unrelated collection jobs", async () => {
  const mock = mockApi();
  mock.mockImplementation(async url => {
    if (url.endsWith("mayhem-references")) return Response.json(fixture());
    if (url.endsWith("mayhem-champion-datasets")) return Response.json({ releases: [], publications: [], sync: [], readiness: {} });
    return Response.json({ releases: [], publications: [], sync: [{ job_key: "mayhem-external:arammayhem", last_error_code: "dataset_sync_failed" }] });
  });
  render(createElement(MayhemDatasetReviewPanel));
  const combo = await screen.findByRole("article", { name: "증강 추천 조합" });
  expect(within(combo).getByText("최근 수집이 완료되지 않았습니다. 기존 적용 자료는 유지됩니다.")).toBeTruthy();
});
