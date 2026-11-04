import { expect, it } from "vitest";
import { mappingSources, suggestedMapping, type MappingSource } from "@/lib/lol/mayhemMappingReview";
import type { LolMayhemAugment } from "@/lib/lol/augments/catalog";
const file = (rows: unknown[]) => ({ schemaVersion: 1, licenseUrl: "https://creativecommons.org/licenses/by/4.0/", meta: { releaseId: "release:1" }, rows });
const official: LolMayhemAugment = { id: 1, name: "지옥의 전도체", nameEn: "Infernal Conduit", rarity: "gold", text: "공식 효과 설명", icon: null, isNew: false, notice: null };
const source: MappingSource = { externalId: "infernal_conduit", name: official.name, nameEn: official.nameEn, rarity: "gold", conflict: false, uses: ["rates", "combos"] };
it("reads Korean and English names from saved rate and combo files and retains their distinct uses", () => {
  const sources = mappingSources(file([{ augmentId: "rate", name: { "ko-KR": "선택률 이름", en: "Rate" }, rarity: "silver" }]), file([{ augmentIds: ["combo"], augmentNames: [{ "ko-KR": "조합 이름", en: "Combo" }] }]), ["rate", "combo", "missing"], "release:1");
  expect(sources.find(row => row.externalId === "rate")).toMatchObject({ name: "선택률 이름", rarity: "silver", uses: ["rates"] });
  expect(sources.find(row => row.externalId === "combo")).toMatchObject({ name: "조합 이름", nameEn: "Combo", uses: ["combos"] });
  expect(sources.find(row => row.externalId === "missing")).toMatchObject({ name: null, nameEn: null, uses: [] });
});
it("marks conflicting source names for manual review rather than choosing one silently", () => {
  const [value] = mappingSources(file([{ augmentId: source.externalId, name: { "ko-KR": source.name } }]), file([{ augmentIds: [source.externalId], augmentNames: [{ "ko-KR": "다른 이름" }] }]), [source.externalId], "release:1");
  expect(value.conflict).toBe(true); expect(suggestedMapping(value, [official])).toBeNull();
});
it("suggests only a unique exact Korean or English name with compatible rarity", () => {
  expect(suggestedMapping({ ...source, name: null, nameEn: " INFERNAL CONDUIT " }, [official])).toEqual(official);
  expect(suggestedMapping({ ...source, rarity: "silver" }, [official])).toBeNull();
  expect(suggestedMapping({ ...source, name: null, nameEn: "Conduit" }, [official])).toBeNull();
  expect(suggestedMapping(source, [official, { ...official, id: 2 }])).toBeNull();
  expect(suggestedMapping({ ...source, name: "다른 증강" }, [official, { ...official, id: 2, name: "다른 증강", nameEn: "Other" }])).toBeNull();
  expect(suggestedMapping({ ...source, name: null, nameEn: null }, [official])).toBeNull();
});
it("rejects mixed captures, oversized collections, invalid identifiers and names", () => {
  const row = { augmentId: "valid", name: { "ko-KR": "정상" }, rarity: "gold" };
  for (const raw of [file([{ ...row, augmentId: "../invalid" }]), file([{ ...row, name: { "ko-KR": "x".repeat(201) } }]), file([{ ...row, name: { en: "bad\nname" } }]), file([{ ...row, rarity: "invented" }]), file(Array(10001).fill(row)), { ...file([row]), meta: { releaseId: "other" } }]) expect(() => mappingSources(raw, file([]), ["valid"], "release:1")).toThrow();
  expect(() => mappingSources(file([]), file([{ augmentIds: ["valid"], augmentNames: [] }]), ["valid"], "release:1")).toThrow();
  expect(() => mappingSources(file([]), file([]), ["valid", "valid"], "release:1")).toThrow();
});
