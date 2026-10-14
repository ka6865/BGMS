import { describe, expect, it, vi } from "vitest";
import catalog431 from "../data/crates/pubg-43-1.json";
import catalog432 from "../data/crates/pubg-43-2.json";
import { buildCatalogSql, itemKey, validateCatalog, verifyOfficialHtml, type CrateCatalog } from "../scripts/sync_crates";
import { drawSingleItem } from "../lib/crateUtils";
import type { CrateItem } from "../types/crates";

const catalog = catalog431 as CrateCatalog;

describe("PUBG #43.1 crate catalog", () => {
  it("contains all 397 official outcomes in six complete probability pools", () => {
    expect(catalog.crates.map(crate => crate.items.length)).toEqual([52, 93, 55, 53, 91, 53]);
    expect(() => validateCatalog(catalog)).not.toThrow();
    expect(catalog.crates.map(crate => crate.bonusQuantity)).toEqual([10, 15, 10, 10, 1, 10]);
  });

  it("keeps schematic/polymer quantities distinct and out of the event token balance", () => {
    const sukuna = catalog.crates[0];
    const schematics = sukuna.items.filter(item => item.name === "도면");
    expect(schematics.map(item => [item.quantity, Number(item.probability.toFixed(6))])).toEqual([[1, 0.009], [3, 0.003], [5, 0.004]]);
    expect(new Set(schematics.map(itemKey)).size).toBe(3);
    const sql = buildCatalogSql(catalog, "data/crates/pubg-43-1.json");
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

describe("PUBG #43.2 crate catalog", () => {
  const next = catalog432 as CrateCatalog;

  it("adds the Bentley cargo and keeps the three carried-over pools", () => {
    expect(next.crates.map(crate => [crate.name, crate.items.length])).toEqual([
      ["벤틀리 화물", 129], ["플라밍고 플링 - 밀수품 상자", 55], ["상상력 풀가동 - 밀수품 상자", 53], ["글라시아 화물", 91],
    ]);
    expect(() => validateCatalog(next)).not.toThrow();
    const bentley = next.crates[0];
    expect(bentley).toMatchObject({ imageId: "14300065", bonusCurrency: "벤틀리 토큰", bonusQuantity: 15, bonusCurrencyCode: "bentley_token" });
    for (const carried of next.crates.slice(1)) {
      expect(carried).toEqual(catalog.crates.find(crate => crate.id === carried.id));
    }
  });

  it("retires the Jujutsu Kaisen crates without deleting their outcomes", () => {
    const sql = buildCatalogSql(next, "data/crates/pubg-43-2.json");
    expect(next.retiredCrates?.map(crate => crate.name)).toEqual(["양면 스쿠나 - 밀수품 상자", "주술회전 화물"]);
    expect(sql).toContain("UPDATE public.crate_templates SET active=false\nWHERE id IN ('90bc2976-5615-41b2-bba9-4c467b5fb59a'::uuid, 'c6ef3fa9-53e4-444b-b840-02dcf423948b'::uuid);");
    expect(sql).not.toContain("'90bc2976-5615-41b2-bba9-4c467b5fb59a'::uuid, 'pubgitems_");
    expect(() => validateCatalog({ ...next, retiredCrates: [{ id: next.crates[0].id, name: "벤틀리 화물" }] })).toThrow("still listed");
  });

  it("reads official tables by header so the added item type column is skipped", () => {
    const crate = { ...next.crates[1], items: next.crates[1].items.slice(0, 1).map(item => ({ ...item, probability: 1 })) };
    const item = crate.items[0];
    const html = (name: string) => `<h2>${crate.name}</h2><table>
      <tr><th>아이템</th><th>종류</th><th>등급</th><th>획득 수량</th><th>확률</th></tr>
      <tr><td>${name}<hr>스크랩</td><td>무기<hr>-</td><td>에픽<hr>-</td><td>1<hr>10</td><td>100%</td></tr>
      <tr><td>합계</td><td>100.0%</td></tr></table>`;
    const single = { ...next, crates: [crate], retiredCrates: [] };
    expect(item.rarity).toBe("EPIC");
    expect(() => verifyOfficialHtml(single, html(item.name))).not.toThrow();
    expect(() => verifyOfficialHtml(single, html("다른 아이템"))).toThrow("Official row mismatch");
  });
});
