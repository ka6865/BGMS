import { describe, expect, it } from "vitest";
import { asRecord, extractAugments, extractAugmentPool, normalizeIconPath } from "@/lib/lol/augments/extract";
import { diffAugments } from "@/lib/lol/augments/diff";
import { toClientPatch, toDisplayPatch, validatePatchMapping } from "@/lib/lol/augments/patchMap";
import { lookupString, parseStringTable, stringTableHash, xxh3_64 } from "@/lib/lol/augments/stringTable";
import sample from "./fixtures/lol-augments/sample-16.21";
import oldPool from "./fixtures/lol-augments/pool-16.20.json";
import newPool from "./fixtures/lol-augments/pool-16.21.json";
import patchNames from "./fixtures/lol-augments/patch-26.21.json";

describe("증강 패치 대응", () => {
  it("근거가 있는 연도만 변환하고 gameVersion을 받는다", () => {
    expect(toDisplayPatch("16.21.123.456")).toBe("26.21");
    expect(toDisplayPatch("15.1.1")).toBe("25.1");
    expect(toClientPatch("26.21")).toBe("16.21");
    expect(toClientPatch("25.1")).toBe("15.1");
    for (const value of ["14.21", "17.1", "16.0", "16.21junk", "16.21.", "26.21"]) expect(toDisplayPatch(value)).toBeNull();
    for (const value of ["24.1", "27.1", "26.0", "26.21.1"]) expect(toClientPatch(value)).toBeNull();
  });
  it("Data Dragon 버전에 대응 패치가 존재해야 한다", () => {
    expect(validatePatchMapping("16.21.123", "26.21", ["16.21.1", "16.20.1"])).toBe(true);
    expect(validatePatchMapping("16.21.123", "26.20", ["16.21.1"])).toBe(false);
    expect(validatePatchMapping("16.21.123", "26.21", ["16.20.1"])).toBe(false);
    expect(validatePatchMapping("17.1", "27.1", ["17.1.1"])).toBe(false);
  });
});

describe("문자열 테이블", () => {
  it("기준 라이브러리의 짧은·중간·긴 입력 경계와 UTF-8 벡터를 맞춘다", () => {
    const vectors: [number, string][] = [
      [4, "c39f76e8799dd0cc"], [8, "4267e87c9cb0bc97"], [9, "7bd3d408882c63a9"], [16, "df76ff0d7f0d9edf"],
      [17, "89975e6b7d2f5a11"], [32, "4e0c9e78cf63407f"], [33, "b2f838286ad45e97"], [64, "269cb9f6acf81244"],
      [65, "f98431abcf1929f2"], [96, "c0496550472180e4"], [97, "69b7288d5d7b01b2"], [128, "4ca37e83f6cddd17"],
      [129, "e4f9742108fe27dc"], [160, "36bd3097b41f5ad9"], [239, "94641f36cad96cd2"], [240, "3e16ca8a0c6ccb68"],
      [241, "14da9e5c301a6a1d"], [1023, "044a8287e4e340aa"], [1024, "fc56a7ce85b3164a"],
      [1025, "9cd2e05a61b8a761"], [2048, "f3a5d4fe3fbf91b6"],
    ];
    for (const [length, hash] of vectors) expect(xxh3_64("x".repeat(length)).toString(16).padStart(16, "0")).toBe(hash);
    expect(xxh3_64("한글 문자열 ".repeat(40)).toString(16)).toBe("1d7747bef53bd660");
  });
  it("xxh3_64 기준 벡터와 실제 하위 38비트 키를 맞춘다", () => {
    expect(xxh3_64("").toString(16)).toBe("2d06800538d394c2");
    expect(xxh3_64("a").toString(16)).toBe("e6c632b61e964e1f");
    expect(xxh3_64("abc").toString(16)).toBe("78af5f94892f3950");
    expect(stringTableHash("Kiwi_Augment_ArcaneAxiom_Name")).toBe("{2a51d68d8b}");
    const table = parseStringTable(sample.stringTableKo);
    expect(lookupString(table, "Kiwi_Augment_ArcaneAxiom_Name")).toBe("비전 원칙");
    expect(lookupString({ plain: "평문", [stringTableHash("plain")]: "해시" }, "PLAIN")).toBe("평문");
    expect(lookupString({ plain: "" }, "plain")).toBe("");
    expect(lookupString({}, "constructor")).toBeNull();
    expect(lookupString({}, "없는 키")).toBeNull();
  });
  it("테이블 객체와 문자열 경계를 검증한다", () => {
    for (const input of [null, [], { entries: [] }, { entries: { key: 123 } }]) expect(() => parseStringTable(input)).toThrow();
  });
});

describe("KIWI 증강 추출", () => {
  const augments = extractAugments(sample);
  it("현재 풀은 249개이며 JADE와 CHERRY를 섞지 않는다", () => {
    expect(extractAugmentPool(newPool.augmentLists, newPool.cherryAugments)).toHaveLength(249);
    expect(extractAugmentPool(oldPool.augmentLists, oldPool.cherryAugments)).toHaveLength(223);
    expect(extractAugmentPool([...newPool.augmentLists, { modeName: "CHERRY", augmentList: ["invalid"] }], newPool.cherryAugments)).toHaveLength(249);
  });
  it("신규 35개 한국어 이름과 등급을 패치 노트 발췌와 대조한다", () => {
    expect(patchNames).toHaveLength(35);
    for (const expected of patchNames) {
      expect(augments.find(augment => augment.platformId === expected.platformId)).toMatchObject({
        ko: { name: expected.ko }, rarity: expected.rarity, rarityEvidence: { cherry: expected.rarity, bin: expected.rarity },
      });
    }
    expect(augments.find(augment => augment.platformId === 3086)?.en.name).toBe("BEES!!!");
  });
  it("ID·원문·수치·태그·플래그를 보존하며 입력을 수정하지 않는다", () => {
    const before = JSON.stringify(sample);
    const result = extractAugments(sample);
    expect(result.find(augment => augment.platformId === 3118)).toMatchObject({
      nameId: "ArcaneAxiom", ko: { name: "비전 원칙" }, en: { name: "Arcane Axiom" },
      icons: { small: "assets/ux/kiwi/augments/icons/arcaneaxiom_small.png", large: "assets/ux/kiwi/augments/icons/arcaneaxiom_large.png" },
      enabled: true, rarity: "gold", isInternal: false, rootSpell: { dataValues: [{ name: "ResetWindow", values: [3, 3, 3, 3, 3, 3, 3] }] },
    });
    expect(result.find(augment => augment.platformId === 1066)?.enabled).toBe(false);
    expect(result.find(augment => augment.platformId === 2100)?.quest).toBe(true);
    expect(result.find(augment => augment.platformId === 1103)?.ability).toBe(true);
    expect(result.find(augment => augment.platformId === 3176)).toMatchObject({ isInternal: true, ko: { name: null } });
    expect(result.find(augment => augment.platformId === 1067)?.rootSpell.dataValues.find(value => value.name === "BonusPercentMin")?.values).toEqual([]);
    expect(JSON.stringify(sample)).toBe(before);
  });
  it("누락·중복·ID 충돌을 조용히 건너뛰지 않는다", () => {
    expect(() => extractAugments({ ...sample, kiwiBin: {} })).toThrow(/매핑/);
    expect(() => extractAugmentPool(newPool.augmentLists, [...newPool.cherryAugments, newPool.cherryAugments[0]])).toThrow(/중복/);
    expect(() => extractAugmentPool([{ modeName: "KIWI", augmentList: ["missing"] }], newPool.cherryAugments)).toThrow(/매핑/);
    const corrupted = structuredClone(sample);
    const entry = Object.values(corrupted.kiwiBin).find(value => "AugmentPlatformId" in value)!;
    Object.assign(entry, { AugmentNameId: "conflict" });
    expect(() => extractAugments(corrupted)).toThrow(/일치/);
  });
  it("아이콘은 안전한 상대 PNG 경로만 반환한다", () => {
    expect(normalizeIconPath("ASSETS/UX/Kiwi/Example.TEX")).toBe("assets/ux/kiwi/example.png");
    expect(normalizeIconPath("/lol-game-data/assets/ASSETS/UX/example.png")).toBe("assets/ux/example.png");
    for (const value of [null, "https://example.test/icon.png", "assets/../secret.png", "assets/x.png?x=1"]) expect(normalizeIconPath(value)).toBeNull();
  });
  it("잘못된 타입·비트마스크·계산 구조와 등급 불일치를 숨기지 않는다", () => {
    for (const mutation of [{ Enabled: "false" }, { IsAbilityAugment: 1 }, { mBuildTags: -1 }, { AugmentPlatformId: "3118" }]) {
      const input = structuredClone(sample);
      const entry = Object.values(input.kiwiBin).find(value => "AugmentPlatformId" in value && value.AugmentPlatformId === 3118)!;
      Object.assign(entry, mutation);
      expect(() => extractAugments(input)).toThrow(/형식|비트마스크|ID/);
    }
    const input = structuredClone(sample);
    const entry = Object.values(input.kiwiBin).find(value => "AugmentPlatformId" in value && value.AugmentPlatformId === 3118)!;
    Object.assign(entry, { rarity: 99 });
    expect(extractAugments(input).find(augment => augment.platformId === 3118)?.rarityEvidence).toEqual({ cherry: "gold", bin: null });
    const spell = asRecord(Object.values(input.kiwiBin).find(value => value.__type === "SpellObject"));
    Object.assign(asRecord(spell.mSpell), { mSpellCalculations: [] });
    expect(() => extractAugments(input)).toThrow(/Calculations/);
  });
});

describe("패치 증강 diff", () => {
  it("신규 35개·GoH 5개·삭제 14개를 분리하고 미공지 2089를 남긴다", () => {
    const result = diffAugments(extractAugmentPool(oldPool.augmentLists, oldPool.cherryAugments), extractAugmentPool(newPool.augmentLists, newPool.cherryAugments));
    expect(result.added.map(augment => augment.platformId)).toEqual(patchNames.map(augment => augment.platformId).sort((a, b) => a - b));
    expect(result.internal.added.map(augment => augment.platformId)).toEqual([3170, 3171, 3172, 3173, 3176]);
    const announced = [2128, 2024, 1356, 2063, 2031, 2006, 1220, 2042, 2095, 2082, 2046, 1345, 2118];
    expect(result.removed.map(augment => augment.platformId)).toEqual([...announced, 2089].sort((a, b) => a - b));
    expect(result.changed).toEqual([]);
  });
  it("이름·설명·수치·등급·enabled 변경을 ID로 비교한다", () => {
    const old = extractAugments(sample).find(augment => augment.platformId === 3118)!;
    const next = structuredClone(old);
    next.ko.name = "새 이름"; next.en.description = "새 설명"; next.rarity = "silver"; next.enabled = false;
    next.rootSpell.dataValues[0].values[0] = 5;
    expect(diffAugments([old], [next]).changed[0].fields).toEqual(["name", "description", "values", "rarity", "enabled"]);
    expect(() => diffAugments([old, old], [next])).toThrow(/중복/);
    const reordered = { ...old, rootSpell: { ...old.rootSpell, calculations: Object.fromEntries(Object.entries(old.rootSpell.calculations).reverse()) } };
    expect(diffAugments([old], [reordered]).changed).toEqual([]);
    const extra = { ...old, rootSpell: { ...old.rootSpell, dataValues: [...old.rootSpell.dataValues, { name: "Extra", values: [2] }] } };
    expect(diffAugments([extra], [{ ...extra, rootSpell: { ...extra.rootSpell, dataValues: extra.rootSpell.dataValues.slice().reverse() } }]).changed).toEqual([]);
  });
});
