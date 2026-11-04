// @vitest-environment jsdom
import { createElement } from "react";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import LolMayhemComboMapping from "@/components/lol/LolMayhemComboMapping";
import type { MappingPreview } from "@/lib/lol/mayhemMappingReview";
const fixture = (): MappingPreview => ({ releaseId: 5, sources: [1, 2, 3].map(id => ({ externalId: `source_${id}`, name: `증강 ${id}`, nameEn: `Augment ${id}`, rarity: "gold", conflict: false, uses: ["rates"] })),
  patches: [{ patch: "16.21", purpose: "선택률·추천 조합", externalIds: ["source_1", "source_2", "source_3"], augments: [1, 2, 3].map(id => ({ id, name: `증강 ${id}`, nameEn: `Augment ${id}`, rarity: "gold", text: `공식 효과 설명 ${id}`, icon: null, isNew: false, notice: null })) }], mappings: [] });
function setup(data = fixture()) {
  const fetchMock = vi.fn(async (url: string, options?: RequestInit) => options?.method === "POST" ? Response.json({ ok: true }) : Response.json(url.includes("?mapping=") ? data : { releases: [{ id: 5 }] }));
  vi.stubGlobal("fetch", fetchMock); const prepared = vi.fn();
  const view = render(createElement(LolMayhemComboMapping, { onPrepared: prepared }));
  return { fetchMock, prepared, view };
}
const posts = (mock: ReturnType<typeof setup>["fetchMock"]) => mock.mock.calls.filter(call => call[1]?.method === "POST").map(call => JSON.parse(call[1]!.body as string));
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });
it("shows names and official effects without raw identifier fields, and saves only after confirmation", async () => {
  const { fetchMock } = setup(); await screen.findByLabelText("게임 증강 검색");
  expect(screen.queryByText("source_1")).toBeNull(); expect(screen.queryByLabelText("외부 증강 ID")).toBeNull();
  expect(within(screen.getByLabelText("증강 이름 비교")).getByText(/공식 효과 설명 1/)).toBeTruthy();
  const save = screen.getByRole("button", { name: "이 이름 연결 저장" });
  expect((save as HTMLButtonElement).disabled).toBe(true); expect(posts(fetchMock)).toEqual([]);
  fireEvent.click(screen.getByLabelText("수집한 이름과 공식 설명을 확인했습니다."));
  fireEvent.click(save);
  expect(await screen.findByText(/1개 이름 연결을 저장했습니다/)).toBeTruthy();
  expect(posts(fetchMock)).toEqual([expect.objectContaining({ action: "map", patch: "16.21", externalId: "source_1", platformId: 1, confirm: true, evidence: expect.stringContaining("공식 설명을 확인") })]);
  expect(posts(fetchMock).some(row => row.action === "sync" || row.action === "publish")).toBe(false);
  expect(screen.queryByRole("button", { name: "증강 1" })).toBeNull();
});
it("clears confirmation on changing the source, official target or patch", async () => {
  const data = fixture(); data.patches.push({ ...data.patches[0], patch: "16.22", purpose: "추천 조합" });
  setup(data); await screen.findByLabelText("게임 증강 검색");
  const checkbox = () => screen.getByLabelText("수집한 이름과 공식 설명을 확인했습니다.") as HTMLInputElement;
  fireEvent.click(checkbox()); fireEvent.click(screen.getByRole("button", { name: "증강 2" })); expect(checkbox().checked).toBe(false);
  fireEvent.click(checkbox()); fireEvent.change(screen.getByLabelText("연결할 게임 증강"), { target: { value: "3" } }); expect(checkbox().checked).toBe(false);
  fireEvent.click(checkbox()); fireEvent.change(screen.getByLabelText("연결할 자료"), { target: { value: "16.22" } }); expect(checkbox().checked).toBe(false);
});
it("stops a confirmed batch on the first error and keeps successful names linked", async () => {
  const { fetchMock } = setup(); let written = 0;
  fetchMock.mockImplementation(async (url, options) => {
    if (options?.method === "POST") return ++written === 2 ? Response.json({ error: "실패" }, { status: 503 }) : Response.json({ ok: true });
    return Response.json(url.includes("?mapping=") ? fixture() : { releases: [{ id: 5 }] });
  });
  fireEvent.click(await screen.findByText("이름이 일치하는 3개 한 번에 확인"));
  const button = screen.getByRole("button", { name: "확인한 3개 연결 저장" }); expect((button as HTMLButtonElement).disabled).toBe(true);
  fireEvent.click(screen.getByLabelText("위 이름과 공식 설명을 확인했습니다.")); fireEvent.click(button);
  expect(await screen.findByText(/1\/3개 연결 후 중단했습니다/)).toBeTruthy();
  expect(posts(fetchMock).map(row => row.externalId)).toEqual(["source_1", "source_2"]);
  expect(screen.queryByRole("button", { name: "증강 1" })).toBeNull();
});
it("prepares a private candidate separately and notifies the summary only after success", async () => {
  const { fetchMock, prepared } = setup(); fireEvent.click(await screen.findByRole("button", { name: "연결 결과 반영" }));
  expect(await screen.findByText(/자료를 준비했습니다/)).toBeTruthy();
  expect(posts(fetchMock)).toEqual([{ action: "sync", confirm: true }]); expect(prepared).toHaveBeenCalledOnce();
});
it("does not start the next map after the panel is closed", async () => {
  const { fetchMock, view } = setup(); let finish!: (response: Response) => void;
  await screen.findByLabelText("게임 증강 검색");
  fetchMock.mockImplementation(async (_url, options) => options?.method === "POST" ? new Promise<Response>(resolve => { finish = resolve; }) : Response.json(fixture()));
  fireEvent.click(screen.getByLabelText("위 이름과 공식 설명을 확인했습니다.")); fireEvent.click(screen.getByRole("button", { name: "확인한 3개 연결 저장", hidden: true }));
  view.unmount(); await act(async () => { finish(Response.json({ ok: true })); });
  expect(posts(fetchMock)).toHaveLength(1);
});
it("does not suggest ambiguous names and offers a readable retry after failed loading", async () => {
  const fetchMock = vi.fn().mockRejectedValueOnce(new Error("offline")).mockImplementation(async (url: string) => Response.json(url.includes("?mapping=") ? { ...fixture(), sources: fixture().sources.map(row => ({ ...row, conflict: true })) } : { releases: [{ id: 5 }] }));
  vi.stubGlobal("fetch", fetchMock); render(createElement(LolMayhemComboMapping, { onPrepared: vi.fn() }));
  expect(await screen.findByRole("alert")).toBeTruthy(); fireEvent.click(screen.getByRole("button", { name: "다시 불러오기" }));
  await screen.findByLabelText("게임 증강 검색");
  expect(screen.queryByText(/한 번에 확인/)).toBeNull();
  expect((screen.getByRole("button", { name: "이 이름 연결 저장" }) as HTMLButtonElement).disabled).toBe(true);
  fireEvent.change(screen.getByLabelText("연결할 게임 증강"), { target: { value: "1" } });
  await waitFor(() => expect(screen.getByText(/원본에서 이름이 다르게 쓰입니다/)).toBeTruthy());
});

it("does not mark a name as saved when a successful HTTP response lacks a valid success receipt", async () => {
  const { fetchMock } = setup(); await screen.findByLabelText("게임 증강 검색");
  fetchMock.mockImplementation(async () => new Response("<html>try again</html>", { status: 200 }));
  fireEvent.click(screen.getByLabelText("수집한 이름과 공식 설명을 확인했습니다."));
  fireEvent.click(screen.getByRole("button", { name: "이 이름 연결 저장" }));
  expect(await screen.findByText(/0\/1개 연결 후 중단했습니다/)).toBeTruthy();
  expect(screen.getByRole("button", { name: "증강 1" })).toBeTruthy();
});
