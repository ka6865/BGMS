import { describe, expect, it } from "vitest";
import { parseOfficialCatalog } from "@/lib/patch-notes/officialCatalog";

const sample = `<script>window.__NUXT__=(function(a,b,c,d,e,f,g,h,i,j){return {fetch:{page:{vehicleCategories:[{vehicles:[{key:a,name:b,imageUrl:c,description:d,updateDate:e,feature:{title:f,specs:[{title:g,data:h},{title:i,data:j}]}}]}]}}}}("coupe_rb","쿠페 RB","image","","2025-02-12","제원","체력","900","최대 속력","150km/h"));</script>`;

describe("공식 도감 파싱", () => {
  it("정적 데이터의 식별자와 제원을 추출한다", () => {
    expect(parseOfficialCatalog(sample)).toMatchObject([{ key: "coupe_rb", name: "쿠페 RB", updated: "2025-02-12", ammunition: null, specs: { 체력: "900", "최대 속력": "150km/h" }, official: { imageUrl: "image" } }]);
  });
  it("스크립트를 실행하지 않고 변경된 형식을 거부한다", () => {
    expect(() => parseOfficialCatalog('<script>window.__NUXT__=alert(1)</script>')).toThrow();
    expect(() => parseOfficialCatalog(sample.replace('"900"', 'alert(1)'))).toThrow();
  });
});

function htmlWithCategories(field: "weaponCategories" | "vehicleCategories", categories: unknown[]) {
  return `<script>window.__NUXT__=(function(){return ${JSON.stringify({ fetch: { page: { [field]: categories } } })}}());</script>`;
}
const rawItem = (key: string) => ({ key, name: key.toUpperCase(), updateDate: "2026-11-04", ammunition: "5.56mm", feature: { specs: [] }, addOnGroup: { categories: [{ name: "탄창", addOns: [{ name: "퀵 드로우 탄창" }] }] } });

describe("공식 도감 분류 저장 계약", () => {
  it.each(["weaponCategories", "vehicleCategories"] as const)("%s의 모든 상위 분류와 항목 원문을 보존한다", (field) => {
    const first = rawItem("first");
    const second = rawItem("second");
    const collection = field === "weaponCategories" ? "weapons" : "vehicles";
    const result = parseOfficialCatalog(htmlWithCategories(field, [
      { key: "first-category", name: "첫 분류", [collection]: [first] },
      { key: "second-category", name: "다음 분류", [collection]: [second] },
    ]));
    expect(result.map((item) => item.category)).toEqual([{ key: "first-category", name: "첫 분류" }, { key: "second-category", name: "다음 분류" }]);
    expect(result[0].official).toEqual(first);
    expect(result[1].official).toEqual(second);
    expect(JSON.parse(JSON.stringify(result))).toEqual(result);
  });

  it("기존 분류 없는 자료와 불완전한 분류를 이름·제원으로 추정하지 않는다", () => {
    for (const category of [{}, { key: "ar" }, { name: "돌격소총" }, { key: "ar", name: " " }]) {
      const result = parseOfficialCatalog(htmlWithCategories("weaponCategories", [{ ...category, weapons: [rawItem("m416")] }]));
      expect(result[0]).not.toHaveProperty("category");
      expect(result[0].name).toBe("M416");
    }
  });
});
