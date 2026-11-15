// @vitest-environment jsdom
import { createElement } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import WeaponsClient from "@/app/weapons/WeaponsClient";
import type { OfficialItem } from "@/lib/patch-notes/officialCatalog";
import officialWeapons from "./fixtures/catalog/simulator-weapons.json";
import storedAttachments from "./fixtures/catalog/simulator-attachments.json";

const data = vi.hoisted(() => ({ weapons: [
  { id: "ar_m416", name: "M416", type: "AR", damage: 41, bullet_speed: 880 },
  { id: "ar_akm", name: "AKM", type: "AR", damage: 48, bullet_speed: 715 },
] }));
vi.mock("@/lib/supabase", () => ({ supabase: { from() {
  const query = { select: () => query, is: () => query,
    order: async () => ({ data: data.weapons, error: null }),
    not: async () => ({ data: storedAttachments, error: null }) };
  return query;
} } }));
vi.mock("@/components/ads/AdSenseBanner", () => ({ default: () => null }));
vi.mock("@/lib/analytics", () => ({ trackEvent: vi.fn() }));
afterEach(() => cleanup());
const official = (key: string) => officialWeapons.find((item) => item.key === key) as OfficialItem;

describe("공식 선택 전달과 파츠 UI", () => {
  it("선택한 AKM을 초기 대상으로 삼고 M416으로 대체하지 않는다", async () => {
    const { rerender } = render(createElement(WeaponsClient, { requestedItem: official("akm"), officialItems: officialWeapons }));
    const builder = await screen.findByLabelText("무기 파츠 조작 영역");
    expect(within(builder).getByRole("heading", { name: /AKM/ })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "손잡이 파츠 선택" })).toBeNull();
    rerender(createElement(WeaponsClient, { requestedItem: { ...official("m416"), key: "unlinked", name: "연결 안 됨" }, officialItems: officialWeapons }));
    expect(screen.getByRole("status").textContent).toContain("다른 무기로 대체하지 않았습니다");
    expect(within(builder).queryByRole("heading", { name: /M416/ })).toBeNull();
  });
  it("호환 탄창만 제공하고 장착·제거·선택 전환 시 계산을 보존한다", async () => {
    const { rerender } = render(createElement(WeaponsClient, { requestedItem: official("m416"), officialItems: officialWeapons }));
    await screen.findByLabelText("탄창 파츠 선택");
    fireEvent.click(screen.getByRole("button", { name: "총구 파츠 선택" }));
    fireEvent.click(screen.getByRole("button", { name: /AR 보정기/ }));
    expect(screen.getByText("85")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "탄창 파츠 선택" }));
    fireEvent.click(screen.getByRole("button", { name: /대용량 퀵드로우 탄창/ }));
    expect(screen.getByText("40발")).toBeTruthy();
    expect(screen.getByText("70")).toBeTruthy();
    rerender(createElement(WeaponsClient, { requestedItem: official("akm"), officialItems: officialWeapons }));
    await waitFor(() => expect(screen.getByText("공식 수치 미확인")).toBeTruthy());
    expect(screen.queryByRole("button", { name: "탄창 파츠 제거" })).toBeNull();
    rerender(createElement(WeaponsClient, { requestedItem: { ...official("m416") }, officialItems: officialWeapons }));
    expect(screen.getByText("40발")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "탄창 파츠 제거" }));
    expect(screen.getByText("30발")).toBeTruthy();
  });
});
