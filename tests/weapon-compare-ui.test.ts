// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { createElement } from "react";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import WeaponCompare, { type CompareEntry } from "@/components/game-data/WeaponCompare";
import { simulateWeapon } from "@/lib/weapons/simulator";
import { weapons } from "./fixtures/official-catalog/items";

afterEach(cleanup);
const withSpecs = (index: number, specs: Record<string, string>) => ({ ...weapons[index], specs });

describe("무기 비교", () => {
  it("비교 대상이 없으면 아무것도 그리지 않는다", () => {
    const { container } = render(createElement(WeaponCompare, { entries: [], onRemove: vi.fn(), onClear: vi.fn() }));
    expect(container).toBeEmptyDOMElement();
  });

  it("공식 지표와 시뮬레이터 구성을 한 표에 놓고 행마다 유리한 값을 표시한다", () => {
    const entries: CompareEntry[] = [
      { key: "official:m416", name: "M416", item: withSpecs(0, { "발 당 데미지": "40", "안정성": "43" }) },
      { key: "build:ar_akm:", name: "AKM", item: withSpecs(1, { "발 당 데미지": "48", "안정성": "30" }),
        build: { parts: [], damage: 47, bulletSpeed: 715, stats: simulateWeapon("ar_akm", null, []) } },
    ];
    const onRemove = vi.fn();
    render(createElement(WeaponCompare, { entries, onRemove, onClear: vi.fn() }));
    const damage = screen.getByRole("row", { name: /공식 발 당 데미지/ });
    expect(within(damage).getByText("48")).toHaveTextContent("(최고)");
    expect(within(screen.getByRole("row", { name: /공식 안정성/ })).getByText("43")).toHaveTextContent("(최고)");
    // 도감 항목에는 BGMS 계산값이 없으므로 비교 우위를 매기지 않는다.
    expect(within(screen.getByRole("row", { name: /BGMS 데미지/ })).getByText("47")).not.toHaveTextContent("(최고)");
    expect(within(screen.getByRole("row", { name: /장착 파츠/ })).getByText("없음")).toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: "M416 비교에서 빼기" }));
    expect(onRemove).toHaveBeenCalledWith("official:m416");
  });
});
