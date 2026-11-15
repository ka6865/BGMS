// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { createElement } from "react";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { OfficialItem } from "@/lib/patch-notes/officialCatalog";
import OfficialCatalog from "@/components/game-data/OfficialCatalog";
import { vehicles, weapons } from "./fixtures/official-catalog/items";

const mocks = vi.hoisted(() => ({ select: vi.fn(), query: vi.fn() }));
vi.mock("@/lib/supabase", () => ({ supabase: { from: () => ({ select: mocks.select }) } }));
const catalog = (items = weapons, fetchedAt: string | null = "2026-11-16T00:00:00Z") => ({ data: { items, source_url: "https://pubg.com/ko/game-info/weapons/etc", fetched_at: fetchedAt }, error: null });
const list = () => screen.getByLabelText("항목 선택");

beforeEach(() => {
  vi.clearAllMocks();
  mocks.select.mockReturnValue({ eq: () => ({ maybeSingle: mocks.query }) });
  mocks.query.mockResolvedValue(catalog());
  Object.defineProperty(window, "innerWidth", { value: 390, configurable: true });
  Object.defineProperty(window, "scrollY", { value: 0, configurable: true });
  window.scrollTo = vi.fn();
  HTMLElement.prototype.scrollIntoView = vi.fn();
});
afterEach(cleanup);

describe("공식 도감 탐색", () => {
  it("무기 종류·탄약·검색을 함께 적용하고 기존 자료의 분류를 추정하지 않는다", async () => {
    render(createElement(OfficialCatalog, { category: "weapons" }));
    await screen.findByRole("button", { name: "M416" });
    fireEvent.change(screen.getByLabelText("무기 종류"), { target: { value: "ar" } });
    fireEvent.change(screen.getByLabelText("탄약"), { target: { value: "5.56mm" } });
    expect(within(list()).getAllByRole("button").map((button) => button.textContent)).toEqual(["M416"]);
    fireEvent.change(screen.getByLabelText("이름 검색"), { target: { value: "없는 무기" } });
    expect(screen.getByText("검색·필터 결과가 없습니다.")).toBeVisible();
    fireEvent.change(screen.getByLabelText("이름 검색"), { target: { value: "  이전  " } });
    fireEvent.change(screen.getByLabelText("무기 종류"), { target: { value: "__unknown__" } });
    fireEvent.change(screen.getByLabelText("탄약"), { target: { value: "__unknown__" } });
    expect(within(list()).getAllByRole("button").map((button) => button.textContent)).toEqual(["이전 저장 무기"]);
    expect(screen.getByRole("option", { name: "분류 미확인" })).toBeTruthy();
  });

  it.each([{ key: 123, name: "돌격소총" }, { key: "ar", name: 123 }])("잘못된 분류 타입도 미확인으로 처리한다: %j", async (category) => {
    mocks.query.mockResolvedValue(catalog([{ ...weapons[0], category } as unknown as OfficialItem]));
    render(createElement(OfficialCatalog, { category: "weapons" }));
    await screen.findByRole("button", { name: "M416" });
    expect(screen.getByRole("option", { name: "분류 미확인" })).toBeTruthy();
    fireEvent.change(screen.getByLabelText("무기 종류"), { target: { value: "__unknown__" } });
    expect(within(list()).getByRole("button", { name: "M416" })).toBeTruthy();
  });

  it("탈것은 저장된 공식 분류를 사용하고 탄약 필터를 표시하지 않는다", async () => {
    mocks.query.mockResolvedValue(catalog(vehicles));
    render(createElement(OfficialCatalog, { category: "vehicles", onConfigureWeapon: vi.fn() }));
    await screen.findByRole("button", { name: "버기" });
    expect(screen.queryByLabelText("탄약")).toBeNull();
    fireEvent.change(screen.getByLabelText("탈것 분류"), { target: { value: "water" } });
    expect(within(list()).getAllByRole("button").map((button) => button.textContent)).toEqual(["보트"]);
    fireEvent.change(screen.getByLabelText("탈것 분류"), { target: { value: "__unknown__" } });
    expect(within(list()).getByRole("button", { name: "이전 저장 탈것" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "이 무기로 파츠 설정" })).toBeNull();
  });

  it("모바일 상세 복귀 시 검색·필터·선택·목록 및 문서 스크롤·포커스를 유지한다", async () => {
    render(createElement(OfficialCatalog, { category: "weapons" }));
    await screen.findByRole("button", { name: "M416" });
    fireEvent.change(screen.getByLabelText("무기 종류"), { target: { value: "ar" } });
    fireEvent.change(screen.getByLabelText("탄약"), { target: { value: "7.62mm" } });
    fireEvent.change(screen.getByLabelText("이름 검색"), { target: { value: "ak" } });
    const button = within(list()).getByRole("button", { name: "AKM" });
    list().scrollTop = 275;
    Object.defineProperty(window, "scrollY", { value: 480, configurable: true });
    fireEvent.click(button);
    const detail = screen.getByRole("article", { name: "AKM 상세 정보" });
    expect(list().className).toContain("hidden lg:grid");
    expect(detail).toHaveFocus();
    expect(detail.scrollIntoView).toHaveBeenCalledWith({ block: "start" });
    list().scrollTop = 0;
    fireEvent.click(screen.getByRole("button", { name: "목록으로 돌아가기" }));
    expect(screen.getByLabelText("이름 검색")).toHaveValue("ak");
    expect(screen.getByLabelText("무기 종류")).toHaveValue("ar");
    expect(screen.getByLabelText("탄약")).toHaveValue("7.62mm");
    expect(button).toHaveAttribute("aria-pressed", "true");
    expect(button).toHaveFocus();
    expect(list().scrollTop).toBe(275);
    expect(window.scrollTo).toHaveBeenCalledWith({ top: 480, behavior: "instant" });
    expect(detail.className).toContain("hidden lg:block");
  });

  it("데스크톱에서는 목록과 상세를 나란히 유지하고 문서 스크롤을 강제하지 않는다", async () => {
    Object.defineProperty(window, "innerWidth", { value: 1440, configurable: true });
    render(createElement(OfficialCatalog, { category: "weapons" }));
    fireEvent.click(await screen.findByRole("button", { name: "AKM" }));
    expect(list().className).not.toContain("hidden");
    expect(screen.getByRole("article", { name: "AKM 상세 정보" }).className).toContain("lg:block");
    expect(HTMLElement.prototype.scrollIntoView).not.toHaveBeenCalled();
    expect(window.scrollTo).not.toHaveBeenCalled();
  });

  it("선택을 필터에서 숨겼다가 복원해도 기존 선택을 유지한다", async () => {
    Object.defineProperty(window, "innerWidth", { value: 1440, configurable: true });
    render(createElement(OfficialCatalog, { category: "weapons" }));
    fireEvent.click(await screen.findByRole("button", { name: "AKM" }));
    fireEvent.change(screen.getByLabelText("탄약"), { target: { value: "5.56mm" } });
    expect(screen.queryByRole("button", { name: "AKM" })).toBeNull();
    fireEvent.change(screen.getByLabelText("탄약"), { target: { value: "" } });
    expect(screen.getByRole("button", { name: "AKM" })).toHaveAttribute("aria-pressed", "true");
  });

  it("콜백에 선택한 공식 항목 원문을 그대로 전달한다", async () => {
    const onConfigureWeapon = vi.fn();
    render(createElement(OfficialCatalog, { category: "weapons", onConfigureWeapon }));
    fireEvent.click(await screen.findByRole("button", { name: "M416" }));
    fireEvent.click(screen.getByRole("button", { name: "이 무기로 파츠 설정" }));
    expect(onConfigureWeapon).toHaveBeenCalledExactlyOnceWith(weapons[0]);
    expect(onConfigureWeapon.mock.calls[0][0]).toBe(weapons[0]);
  });

  it("성공한 조회만 전체 공식 항목을 상위에 전달한다", async () => {
    const onItemsLoaded = vi.fn();
    mocks.query.mockResolvedValueOnce({ data: null, error: { message: "fixture" } });
    render(createElement(OfficialCatalog, { category: "weapons", onItemsLoaded }));
    await screen.findByRole("alert");
    expect(onItemsLoaded).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "다시 시도" }));
    await screen.findByRole("button", { name: "M416" });
    expect(onItemsLoaded).toHaveBeenCalledExactlyOnceWith(weapons);
    expect(onItemsLoaded.mock.calls[0][0]).toBe(weapons);
    fireEvent.change(screen.getByLabelText("탄약"), { target: { value: "5.56mm" } });
    expect(onItemsLoaded).toHaveBeenCalledTimes(1);
  });

  it("수집일과 공식 항목 수정일을 구분하고 누락된 수집일을 추정하지 않는다", async () => {
    render(createElement(OfficialCatalog, { category: "weapons" }));
    await screen.findByRole("button", { name: "M416" });
    expect(mocks.select).toHaveBeenCalledWith("items,source_url,fetched_at");
    expect(screen.getByText(/공식 자료 수집일:.*2026/)).toHaveTextContent("한국시간");
    expect(screen.getByText("공식 항목 수정일: 2026-11-04")).toBeTruthy();
    cleanup();
    mocks.query.mockResolvedValue(catalog(weapons, null));
    render(createElement(OfficialCatalog, { category: "weapons" }));
    await screen.findByRole("button", { name: "M416" });
    expect(screen.getByText("공식 자료 수집일: 미확인")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "이 무기로 파츠 설정" })).toBeNull();
  });

  it.each(["응답 오류", "네트워크 예외"])("%s 후 다시 시도할 수 있다", async (kind) => {
    if (kind === "응답 오류") mocks.query.mockResolvedValueOnce({ data: null, error: { message: "fixture" } });
    else mocks.query.mockRejectedValueOnce(new Error("fixture"));
    render(createElement(OfficialCatalog, { category: "weapons" }));
    await screen.findByRole("alert");
    fireEvent.click(screen.getByRole("button", { name: "다시 시도" }));
    await screen.findByRole("button", { name: "M416" });
    expect(screen.queryByRole("alert")).toBeNull();
    expect(mocks.query).toHaveBeenCalledTimes(2);
  });

  it("로딩 후 비어 있는 저장 자료를 안내한다", async () => {
    let resolve!: (response: ReturnType<typeof catalog>) => void;
    mocks.query.mockReturnValue(new Promise((done) => { resolve = done; }));
    render(createElement(OfficialCatalog, { category: "weapons" }));
    expect(screen.getByText("불러오는 중…")).toBeVisible();
    resolve(catalog([]));
    await waitFor(() => expect(screen.getByText("아직 등록된 공식 정보가 없습니다.")).toBeVisible());
  });
});
