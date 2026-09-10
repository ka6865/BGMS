import { describe, expect, it, vi } from "vitest";
import catalog from "../data/crates/pubg-43-1.json";
import { buildCatalogSql, itemKey, validateCatalog } from "../scripts/sync_crates_43_1";
import { drawSingleItem } from "../lib/crateUtils";
import type { CrateItem } from "../types/crates";

describe("PUBG #43.1 crate catalog", () => {
  it("contains all 397 official outcomes in six complete probability pools", () => {
    expect(catalog.crates.map(crate => crate.items.length)).toEqual([52, 93, 55, 53, 91, 53]);
    expect(() => validateCatalog()).not.toThrow();
    expect(catalog.crates.map(crate => crate.bonusQuantity)).toEqual([10, 15, 10, 10, 1, 10]);
  });

  it("keeps schematic/polymer quantities distinct and out of the event token balance", () => {
    const sukuna = catalog.crates[0];
    const schematics = sukuna.items.filter(item => item.name === "도면");
    expect(schematics.map(item => [item.quantity, Number(item.probability.toFixed(6))])).toEqual([[1, 0.009], [3, 0.003], [5, 0.004]]);
    expect(new Set(schematics.map(itemKey)).size).toBe(3);
    const sql = buildCatalogSql();
    expect(sql).toContain("o.probability, 0, false, false");
    expect(sql).toContain("r.drop_type='base'");
    expect(sql).toContain("ON CONFLICT (crate_template_id, asset_id, drop_type)");
  });

  it("uses the real draw function at the boundaries of the 0.6% Sukuna outcome", () => {
    const items = catalog.crates[0].items as unknown as CrateItem[];
    const random = vi.spyOn(Math, "random");
    try {
      random.mockReturnValue(0);
      expect(drawSingleItem(items).name).toBe("양면 스쿠나 - 베릴 M762");
      random.mockReturnValue(0.005999);
      expect(drawSingleItem(items).name).toBe("양면 스쿠나 - 베릴 M762");
      random.mockReturnValue(0.006001);
      expect(drawSingleItem(items).name).toBe("사이코 킬러 - M24");
      random.mockReturnValue(0.999999);
      expect(drawSingleItem(items)).toBe(items.at(-1));
    } finally {
      random.mockRestore();
    }
  });

  it("records source URLs and the corrected Glasya image IDs", () => {
    const glasya = catalog.crates.find(crate => crate.imageId === "14300063")!;
    expect(glasya.items.find(item => item.name === "글라시아 도안")?.imageId).toBe("17000004");
    expect(glasya.items.find(item => item.name === "트러블메이커 헬멧 세트 도안")?.imageId).toBe("13001597");
    for (const image of Object.values(catalog.images)) {
      expect(new URL(image.url).hostname).toBe("cdn.pubgitems.info");
      expect(new URL(image.sourceUrl).hostname).toBe("pubgitems.info");
    }
  });
});
