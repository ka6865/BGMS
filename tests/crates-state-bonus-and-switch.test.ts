// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, renderHook } from "@testing-library/react";
import { CARGO_DROP_DURATION_MS, useCratesState } from "@/app/crates/useCratesState";
import type { CrateTemplate } from "@/types/crates";

vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn(), warning: vi.fn() } }));
vi.mock("@/lib/analytics", () => ({ trackEvent: vi.fn() }));

function crate(id: string, overrides: Partial<CrateTemplate> = {}): CrateTemplate {
  return {
    id, name: id, asset_key: id, normalized_name: id, r2_key: "", type: "loot_crate",
    price_gcoin: 250, bundle_price_gcoin: 2500, bonus_currency_code: `${id}_token`,
    bonus_amount_single: 15, bonus_amount_bundle: 150, image_url: "", description: "",
    items: [{
      id: `${id}-reward`, name: `${id} reward`, asset_key: `${id}-reward`, normalized_name: "", r2_key: "",
      rarity: "COMMON", probability: 1, image_url: "", is_prime_parcel: false, token_count: 0,
    }],
    prime_parcel_items: [], bonus_items: [],
    ...overrides,
  } as CrateTemplate;
}

function setup(crates: CrateTemplate[], id = crates[0].id) {
  return renderHook(({ selected }) => useCratesState({ initialCrates: crates, selectedCrateId: selected }), {
    initialProps: { selected: id },
  });
}

beforeEach(() => vi.useFakeTimers());
afterEach(() => {
  cleanup();
  vi.clearAllTimers();
  vi.useRealTimers();
});

describe("useCratesState 보너스 토큰", () => {
  it.each([
    ["one", { bonus_amount_single: 0 }, 0],
    ["ten", { bonus_amount_bundle: 0 }, 0],
    ["one", { bonus_amount_single: null }, 10],
    ["ten", { bonus_amount_bundle: null }, 100],
    ["one", {}, 15],
  ] as const)("직접 개봉(%s)은 설정값 %j를 보존한다", (mode, overrides, expected) => {
    const { result } = setup([crate("A", overrides as Partial<CrateTemplate>)]);
    act(() => result.current.handleChargeGCoin(10_000, 0));

    act(() => result.current.handleOpenLootCrateDirect(mode, "gcoin"));

    expect(result.current.tokens).toBe(expected);
  });
});

describe("상자 전환 전 정산", () => {
  it("개봉 후 공개하지 않은 카드는 전환 전에 정산하면 보상이 남는다", () => {
    const { result, rerender } = setup([crate("A"), crate("B")]);
    act(() => result.current.setInventoryCrates({ A: 1, B: 0 }));
    act(() => result.current.handleOpenInventoryCrates("one"));
    act(() => vi.advanceTimersByTime(CARGO_DROP_DURATION_MS));
    expect(result.current.revealedCards).toEqual([false]);

    // CratesClient의 상자 버튼은 전환 직전에 collectRemainingCards를 호출한다.
    act(() => result.current.collectRemainingCards());
    rerender({ selected: "B" });

    expect(result.current.drawnCards).toEqual([]);
    expect(result.current.obtainedSkins).toEqual({ "A-reward": 1 });
    expect(result.current.history).toHaveLength(1);
    expect(result.current.stats.commonCount).toBe(1);
  });
});
