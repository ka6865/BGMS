import { describe, expect, it } from "vitest";
import { asRecord, extractAugments } from "@/lib/lol/augments/extract";
import { renderTooltip } from "@/lib/lol/augments/tooltip";
import { chooseAugmentDisplay } from "@/lib/lol/augments/validate";
import { buildIngestion } from "@/lib/lol/augments/ingest";
import sample from "./fixtures/lol-augments/sample-16.21";
import runtime from "./fixtures/lol-augments/runtime-16.21";

const augments = extractAugments(runtime);
const display = (id: number) => {
  const augment = augments.find(entry => entry.platformId === id)!;
  const context = { ...augment.rootSpell, stringTable: runtime.stringTableKo };
  return chooseAugmentDisplay(renderTooltip(augment.ko.tooltip, context), renderTooltip(augment.ko.description, context));
};

describe("16.21 스킬·퀘스트·분기 원본 근거", () => {
  it("스킬 이름을 슬롯 근거에 따라 대체하고 반복 토큰에 메타데이터를 보존한다", () => {
    const result = renderTooltip("{{SpellName}} 스킬로 공격하고 @SpellName@ 사용", {
      dataValues: [{ name: "QAbilityHaste", values: [50] }],
    });
    expect(result).toMatchObject({ text: "Q 스킬로 공격하고 Q 스킬 사용", status: "ok", unresolvedTokenCount: 0 });
    expect(result.tokens.filter(token => token.championDependent)).toHaveLength(2);
    expect(chooseAugmentDisplay(result, result).notice).toBe("스킬 이름은 챔피언마다 다릅니다");
    expect(renderTooltip("{{SpellName}} 스킬").text).toBe("해당 스킬");
    expect(renderTooltip("{{SpellName}}", { dataValues: ["QAbilityHaste", "WAbilityHaste"].map(name => ({ name, values: [1] })) }).text).toBe("해당 스킬");
    const internal = extractAugments(sample).find(entry => entry.platformId === 3173)!;
    expect(renderTooltip("{{SpellName}}", internal.rootSpell).text).toBe("R 스킬");
    expect(renderTooltip("\uE002위조").tokens.some(token => token.championDependent)).toBe(false);
  });
  it.each([[1154, 18], [2055, 50], [2100, 10], [2103, 15], [2108, 3000], [2116, 10]])(
    "%s의 QuestData.Quest → ModesQuestData.Milestones[0].{7fec0982}=%s를 읽는다", (id, requirement) => {
      const augment = augments.find(entry => entry.platformId === id)!;
      expect(augment.rootSpell.dataValues.find(value => value.name === "QuestRequirement")?.values).toEqual([requirement]);
      expect(display(id).displaySource).not.toBe("desc_partial");
    },
  );
  it.each([[1170, 50, 75], [1071, 100, 150], [1115, 150, 250]])(
    "%s의 mSpell.DataValues RangedRangeIncrease=%s / MeleeRangeIncrease=%s를 우선한다", (id, ranged, melee) => {
      expect(display(id).text).toBe(`공격 사거리가 원거리 ${ranged} / 근접 ${melee} 증가합니다.`);
    },
  );
  it("퀘스트 원본 조건이 없으면 최초 목표를 지어내지 않는다", () => {
    const source = structuredClone(runtime);
    const augment = Object.values(source.kiwiBin).map(asRecord).find(entry => entry.AugmentPlatformId === 2100)!;
    delete augment.QuestData;
    const root = extractAugments(source).find(entry => entry.platformId === 2100)!.rootSpell;
    expect(renderTooltip("@QuestRequirement@", root).unresolvedTokens).toEqual(["@QuestRequirement@"]);
  });
  it("퍼센트 식에 능력치 항이 여러 개면 괄호를 한 번만 묶는다", () => {
    const result = renderTooltip("@Value@", { calculations: { Value: { __type: "GameCalculation", mDisplayAsPercent: true,
      mFormulaParts: [{ __type: "NumberCalculationPart", mNumber: 0.25 },
        ...[1, 6].map(mStat => ({ __type: "StatByCoefficientCalculationPart", mStat, mStatFormula: 2, mCoefficient: 0.0035 }))],
    } } });
    expect(result.text).toBe("25% (+추가 방어력 100당 35% + 추가 마법 저항력 100당 35%)");
    expect(result.text).not.toMatch(/\)\s*\(/);
  });
  it("분기 계산의 mRangedMultiplier와 퍼센트 단위를 함께 보존한다", () => {
    expect(display(2157).text).toContain("원거리 15% / 근접 40%");
    expect(display(1325).text).toContain("원거리 15% / 근접 25%");
    expect(display(2096).text).toContain("원거리 100.05 / 근접 150");
    expect(display(2096).text).toContain("원거리 39.975% / 근접 75%");
  });
  it.each([
    [1214, "50%"], [1375, "300"], [2140, "20%"], [3018, "35%"], [3039, "50%"],
    [3051, "200~450%"], [3053, "300~750"], [3055, "50"], [3063, "10~25"], [3094, "추가 체력의 4%"], [3129, "20초"], [3163, "7마리"],
  ])("%s의 FNV-1a 이름 해시 계산을 원문 필드 그대로 조회한다", (id, text) => {
    expect(display(Number(id)).text).toContain(text);
    expect(display(Number(id)).displaySource).not.toBe("desc_partial");
  });
  it("cooldownTime·Cooldown.values와 BaseCooldown을 읽되 없는 값은 추정하지 않는다", () => {
    const source = structuredClone(runtime);
    const augment = Object.values(source.kiwiBin).map(asRecord).find(entry => entry.AugmentPlatformId === 1061)!;
    const spell = asRecord(asRecord(asRecord(source.kiwiBin)[String(augment.RootSpell)]).mSpell);
    delete spell.DataValues;
    spell.cooldownTime = [9, 7];
    let root = extractAugments(source).find(entry => entry.platformId === 1061)!.rootSpell;
    expect(renderTooltip("@Cooldown@", root).text).toBe("9");
    delete spell.cooldownTime;
    spell.Cooldown = { values: [0, 7] };
    root = extractAugments(source).find(entry => entry.platformId === 1061)!.rootSpell;
    expect(renderTooltip("@Cooldown@", root).text).toBe("0");
    delete spell.Cooldown;
    root = extractAugments(source).find(entry => entry.platformId === 1061)!.rootSpell;
    expect(renderTooltip("@Cooldown@", root).unresolvedTokens).toEqual(["@Cooldown@"]);
    expect(display(1061).text).toContain("7초마다");
    spell.cooldownTime = [null];
    expect(() => extractAugments(source)).toThrow("cooldownTime");
  });
  it("계산 참조·해시 DataValue의 연결과 순환 차단을 보존한다", () => {
    expect(renderTooltip("@Value@", { dataValues: [{ name: "HealthPercentTrigger", values: [0.5] }], calculations: {
      Value: { __type: "{f3cbe7b2}", mSpellCalculationKey: "Threshold" },
      Threshold: { __type: "NamedDataValueCalculationPart", mDataValue: "{9d8c75c8}" },
    } }).text).toBe("0.5");
    expect(renderTooltip("@Loop@", { calculations: { Loop: { __type: "{f3cbe7b2}", mSpellCalculationKey: "Loop" } } }).unresolvedTokens).toEqual(["@Loop@"]);
    expect(display(2016).displaySource).toBe("desc_partial");
    expect(display(2016).text).toContain("(수치 미확인)");
  });
  it("championDependent를 수집 → tooltip_rendered JSON 저장 계약까지 보존한다", () => {
    const result = buildIngestion("16.21", { "augment-lists": runtime.augmentLists, "cherry-augments": runtime.cherryAugments,
      "kiwi-bin": runtime.kiwiBin, "stringtable-ko": runtime.stringTableKo, "stringtable-en": runtime.stringTableEn },
    { url: "", published_at: null, added_names: [], removed_names: [], parse_status: "ok" });
    const localization = result.rows.find(entry => entry.platform_id === 2100)!.localizations[0];
    const stored = JSON.parse(JSON.stringify(localization));
    expect(stored.tooltip_rendered.some((token: { championDependent?: true }) => token.championDependent)).toBe(true);
    expect(stored.display_text).toContain("해당 스킬");
    expect(stored.display_source).not.toBe("desc_partial");
  });
});
