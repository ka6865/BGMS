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
