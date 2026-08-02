import { describe, expect, it } from "vitest";

import { SUPPORTED_MAP_IDS, resolveMapIdFromSlug } from "../lib/map-ids";

describe("지도 slug 해석 경계", () => {
  it("지원 지도 slug를 내부 지도 ID로 해석한다", () => {
    expect(resolveMapIdFromSlug("erangel")).toBe("Erangel");
    expect(resolveMapIdFromSlug("miramar")).toBe("Miramar");
    expect(resolveMapIdFromSlug("taego")).toBe("Taego");
    expect(resolveMapIdFromSlug("rondo")).toBe("Rondo");
    expect(resolveMapIdFromSlug("vikendi")).toBe("Vikendi");
    expect(resolveMapIdFromSlug("deston")).toBe("Deston");
  });

  it("대소문자와 앞뒤 공백을 정규화한다", () => {
    expect(resolveMapIdFromSlug("ERANGEL")).toBe("Erangel");
    expect(resolveMapIdFromSlug("Erangel")).toBe("Erangel");
    expect(resolveMapIdFromSlug("  taego  ")).toBe("Taego");
  });

  it("지원하지 않는 slug는 null로 fail-closed한다", () => {
    for (const slug of ["", " ", "nonexistent", "karakin", "sanhok", "erangel2", "../etc/passwd"]) {
      expect(resolveMapIdFromSlug(slug)).toBeNull();
    }
  });

  it("지원 목록은 타일 리소스와 동일한 6개 지도를 유지한다", () => {
    expect([...SUPPORTED_MAP_IDS]).toEqual([
      "Erangel",
      "Miramar",
      "Taego",
      "Rondo",
      "Vikendi",
      "Deston",
    ]);
  });
});
