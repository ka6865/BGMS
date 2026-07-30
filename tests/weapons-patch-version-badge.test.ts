// @vitest-environment jsdom

import { createElement } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import WeaponsClient from "@/app/weapons/WeaponsClient";

const weaponWithPatchVersion = {
  id: "ar_m416",
  name: "M416",
  type: "AR",
  damage: 41,
  ammo: "5.56mm",
  bullet_speed: 880,
  availability: "일반 스폰",
  spawn_maps: "전체 맵",
  patch_notes: "수직 반동이 조정되었습니다.",
  patch_version: "업데이트 42.1",
  patch_applied_at: "2026-07-30T12:00:00.000Z",
};

const weaponWithoutPatchVersion = {
  ...weaponWithPatchVersion,
  id: "ar_aug",
  name: "AUG",
  patch_version: null,
};

let weapons: Array<typeof weaponWithPatchVersion | typeof weaponWithoutPatchVersion> = [weaponWithPatchVersion];

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn() }),
}));

vi.mock("@/components/ads/AdfitBanner", () => ({
  default: () => null,
}));

vi.mock("@/lib/supabase", () => ({
  supabase: {
    from: (table: string) => {
      if (table === "weapons") {
        return {
          select: () => ({
            order: async () => ({ data: weapons, error: null }),
          }),
        };
      }

      return {
        select: () => ({
          not: async () => ({ data: [], error: null }),
        }),
      };
    },
  },
}));

afterEach(() => {
  cleanup();
  weapons = [weaponWithPatchVersion];
});

describe("WeaponsClient 패치 버전 배지", () => {
  it("패치 버전이 있는 무기 카드와 상세 패널에 버전을 노출한다", async () => {
    render(createElement(WeaponsClient));

    const badges = await screen.findAllByTitle("패치 적용 버전: 업데이트 42.1");

    expect(badges).toHaveLength(2);
    expect(badges.every((badge) => badge.textContent?.includes("업데이트 42.1"))).toBe(true);
  });

  it("패치 버전이 없으면 배지를 렌더링하지 않는다", async () => {
    weapons = [weaponWithoutPatchVersion];
    render(createElement(WeaponsClient));

    await screen.findAllByText("AUG");

    expect(screen.queryByTitle(/^패치 적용 버전:/)).toBeNull();
  });
});
