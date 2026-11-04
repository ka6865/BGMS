import { act, renderHook } from "@testing-library/react";
import { useCratesState } from "../app/crates/useCratesState";
import type { CrateTemplate } from "../types/crates";

jest.mock("sonner", () => ({ toast: { success: jest.fn(), error: jest.fn() } }));
jest.mock("../lib/analytics", () => ({ trackEvent: jest.fn() }));

const makeCrate = (id: string, code: string): CrateTemplate => ({
  id, name: id, asset_key: id, normalized_name: id, r2_key: "", type: "loot_crate",
  price_gcoin: 250, bundle_price_gcoin: 2500, bonus_currency_code: code, bonus_amount_single: 15,
  bonus_amount_bundle: 150, image_url: "", description: "", items: [], prime_parcel_items: [],
});

describe("상자별 이벤트 토큰 잔액", () => {
  const crates = [makeCrate("bentley", "bentley_token"), makeCrate("ive", "ive_token")];

  it("토큰 종류가 다른 상자는 잔액을 섞지 않는다", () => {
    const { result, rerender } = renderHook(({ id }) => useCratesState({ initialCrates: crates, selectedCrateId: id }), {
      initialProps: { id: "bentley" },
    });
    act(() => result.current.setTokens(500));
    expect(result.current.tokens).toBe(500);

    rerender({ id: "ive" });
    expect(result.current.tokens).toBe(0);
    act(() => result.current.setTokens((prev: number) => prev + 70));
    expect(result.current.tokens).toBe(70);

    rerender({ id: "bentley" });
    expect(result.current.tokens).toBe(500);
  });

  it("초기화하면 모든 토큰 잔액이 0이 된다", () => {
    const { result, rerender } = renderHook(({ id }) => useCratesState({ initialCrates: crates, selectedCrateId: id }), {
      initialProps: { id: "bentley" },
    });
    act(() => result.current.setTokens(500));
    act(() => result.current.executeResetSimulator());
    rerender({ id: "ive" });
    expect(result.current.tokens).toBe(0);
    rerender({ id: "bentley" });
    expect(result.current.tokens).toBe(0);
  });
});
