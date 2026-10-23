import { describe, expect, it } from "vitest";
import { extractAugments } from "@/lib/lol/augments/extract";
import { parseStringTable, stringTableHash } from "@/lib/lol/augments/stringTable";
import { renderTooltip } from "@/lib/lol/augments/tooltip";
import { chooseAugmentDisplay, tooltipTokenStats, validateAugments } from "@/lib/lol/augments/validate";
import sample from "./fixtures/lol-augments/sample-16.21";
import formulaCases from "./fixtures/lol-augments/tooltip-formulas-16.21";

describe("안전한 툴팁 치환", () => {
  it.each(formulaCases)("16.21 $id의 선택 문장을 단순화한 결과로 고정한다", entry => {
    const tooltip = renderTooltip(entry.tooltip, entry);
    const description = renderTooltip(entry.description, entry);
    expect(chooseAugmentDisplay(tooltip, description).text).toBe(entry.expected);
  });
  it("원문에 이름이 있으면 아이콘은 접근성 라벨만 남기고 없으면 라벨을 표시한다", () => {
    const result = renderTooltip("치명타 확률%i:scaleCrit%을 얻고 %i:scaleAP%를 얻습니다.");
    expect(result.text).toBe("치명타 확률을 얻고 주문력를 얻습니다.");
    expect(result.tokens.filter(token => token.icon)).toEqual([
      { text: "", label: "치명타 확률", icon: "scaleCrit", style: ["statIcon"] },
      { text: "주문력", label: "주문력", icon: "scaleAP", style: ["statIcon"] },
    ]);
    expect(renderTooltip("%i:scaleAPen% 방어구 관통력").text).toBe(" 방어구 관통력");
  });
  it("명시적 퍼센트 배수와 퍼센트 능력치 단위를 보존하고 비선형 식은 남긴다", () => {
    const calculations = {
      Value: { __type: "GameCalculation", mFormulaParts: [
        { __type: "NumberCalculationPart", mNumber: 0.25 },
        { __type: "StatByCoefficientCalculationPart", mCoefficient: 0.00045 },
      ] },
      Crit: { __type: "StatByCoefficientCalculationPart", mStat: 9, mStatFormula: 2, mCoefficient: 1 },
      Nonlinear: { __type: "ProductOfSubPartsCalculationPart",
        mPart1: { __type: "StatByCoefficientCalculationPart", mCoefficient: 1 },
        mPart2: { __type: "StatByCoefficientCalculationPart", mStat: 2, mCoefficient: 1 } },
    };
    expect(renderTooltip("@Value*100@% / @Crit*100@%", { calculations }).text)
      .toBe("25% (+주문력 100당 4.5%) / 추가 치명타 피해량 1%당 1%");
    const result = renderTooltip("피해 @Nonlinear@", { calculations });
    expect(result).toMatchObject({ text: "피해 @Nonlinear@", unresolvedTokenCount: 1 });
    expect(chooseAugmentDisplay(result, renderTooltip("안전한 설명")).displaySource).toBe("desc");
  });
  it("숫자 곱셈·음수·대소문자·첫 유효값 정책을 적용한다", () => {
    const rendered = renderTooltip("@Value@ / @value*100@ / @Value*-1@ / @Zero@", {
      dataValues: [{ name: "Value", values: [0.25, 0.5] }, { name: "Zero", values: [0, 5] }],
    });
    expect(rendered).toMatchObject({ text: "0.25 / 25 / -0.25 / 0", status: "ok", tokenCount: 4, unresolvedTokenCount: 0 });
  });
  it("실제 비전 원칙 툴팁을 레벨 범위·퍼센트로 치환한다", () => {
    const augment = extractAugments(sample).find(augment => augment.platformId === 3118)!;
    const result = renderTooltip(augment.ko.tooltip, { ...augment.rootSpell, stringTable: parseStringTable(sample.stringTableKo) });
    expect(result.status).toBe("ok");
    expect(result.text).toContain("3초");
    expect(result.text).toContain("15~30%");
    expect(result.text).not.toContain("@");
  });
  it("Calc 강제 조회·합·곱·수정 계산과 반전된 범위를 지원한다", () => {
    const result = renderTooltip("@Value:Calc@ / @Modified@ / @Range*-1@ / @Product@", {
      dataValues: [{ name: "Value", values: [99] }, { name: "Base", values: [4] }],
      calculations: {
        Value: { __type: "GameCalculation", mFormulaParts: [
          { __type: "NamedDataValueCalculationPart", mDataValue: "Base" }, { __type: "NumberCalculationPart", mNumber: 2 },
        ] },
        Modified: { __type: "GameCalculationModified", mModifiedGameCalculation: "Value", mMultiplier: { __type: "NumberCalculationPart", mNumber: 3 } },
        Range: { __type: "ByCharLevelInterpolationCalculationPart", mStartValue: 30, mEndValue: 15 },
        Product: { __type: "ProductOfSubPartsCalculationPart", mPart1: { __type: "NumberCalculationPart", mNumber: 2 }, mPart2: {
          __type: "SumOfSubPartsCalculationPart", mSubparts: [{ __type: "NumberCalculationPart", mNumber: 3 }, { __type: "NumberCalculationPart", mNumber: 1 }],
        } },
      },
    });
    expect(result).toMatchObject({ status: "ok", text: "6 / 18 / -30~-15 / 8" });
  });
  it("중첩 문자열을 해시로 조회하고 순환과 깊이를 제한한다", () => {
    const stringTable = { outer: "<healing>{{ Inner }}</healing>", [stringTableHash("inner")]: "@Heal@ 회복", cycle: "{{cycle}}" };
    expect(renderTooltip("{{outer}}", { stringTable, dataValues: [{ name: "Heal", values: [25] }] })).toMatchObject({
      status: "ok", text: "25 회복", tokens: [{ text: "25 회복", style: ["healing"] }],
    });
    expect(renderTooltip("{{cycle}}", { stringTable }).unresolvedTokens).toEqual(["{{cycle}}"]);
    const deep = Object.fromEntries(Array.from({ length: 12 }, (_, index) => [`key${index}`, `{{key${index + 1}}}`]));
    expect(renderTooltip("{{key0}}", { stringTable: deep }).unresolvedTokens).toEqual(["{{key8}}"]);
  });
  it("허용 태그는 스타일 토큰으로 바꾸고 스크립트·임의 속성은 버린다", () => {
    const result = renderTooltip('<script>alert(1)</script><healing onclick="x">회복 <b>강화</b></healing><br>'
      + '<img src=x onerror="x"><a href="javascript:x">링크</a><font color="#F0C200">금색</font>&nbsp;&lt;x&gt;&#65;');
    expect(result.text).toBe("회복 강화\n링크금색 <x>A");
    expect(result.tokens).toContainEqual({ text: "강화", style: ["healing", "bold"] });
    expect(result.tokens).toContainEqual({ text: "금색", style: ["highlight"] });
    expect(JSON.stringify(result.tokens)).not.toMatch(/onclick|javascript|onerror|alert|src=/);
    expect(renderTooltip("&#999999999; &#xD800;").text).toBe("&#999999999; &#xD800;");
  });
  it("런타임·미지원 계산·순환은 추정하지 않으며 중복 미치환 횟수를 보존한다", () => {
    const result = renderTooltip("@Missing@ @Missing@ @Damage@ @Loop@ @Value+2@ @Known@", {
      dataValues: [{ name: "Known", values: [1] }],
      calculations: {
        Damage: { __type: "GameCalculation", mFormulaParts: [{ __type: "StatByCoefficientCalculationPart", mStat: 999, mCoefficient: 0.5 }] },
        Loop: { __type: "GameCalculationModified", mModifiedGameCalculation: "Loop" },
      },
    });
    expect(result).toMatchObject({ status: "partial", tokenCount: 6, unresolvedTokenCount: 5, unsupportedCalculations: ["StatByCoefficientCalculationPart"] });
    expect(result.unresolvedTokens).toEqual(["@Missing@", "@Damage@", "@Loop@", "@Value+2@"]);
    expect(renderTooltip("@Missing@").status).toBe("failed");
    expect(renderTooltip(null).status).toBe("failed");
    expect(renderTooltip("설명").status).toBe("ok");
  });
  it("알 수 없는 해시 타입이나 비유한 수치는 미치환으로 남긴다", () => {
    expect(renderTooltip("@Unknown@", { calculations: { Unknown: { __type: "{abcdef12}" } } })).toMatchObject({
      status: "failed", unsupportedCalculations: ["{abcdef12}"] , unresolvedTokens: ["@Unknown@"],
    });
    expect(renderTooltip("@Bad@", { calculations: { Bad: { __type: "NumberCalculationPart", mNumber: Infinity } } }).status).toBe("failed");
  });
  it("아이콘은 공식 라벨 배지로 바꾸고 미지 아이콘은 기록하며 수치 통계에서 제외한다", () => {
    const result = renderTooltip("무작위 %i:Augment% / <scaleAP>%i:scaleAP%</scaleAP> / %i:Unknown% @Value@", {
      stringTable: { aram_hextech_augbuffbar: "증강", [stringTableHash("spell_listtype_cherry_ap")]: "공식 주문력" },
      dataValues: [{ name: "Value", values: [12] }],
    });
    expect(result).toMatchObject({ status: "ok", tokenCount: 1, unresolvedTokenCount: 0, unknownIcons: ["Unknown"] });
    expect(result.tokens).toContainEqual({ text: "증강", label: "증강", style: ["statIcon"], icon: "Augment" });
    expect(result.tokens).toContainEqual({ text: "공식 주문력", label: "공식 주문력", style: ["scaleAP", "statIcon"], icon: "scaleAP" });
    expect(result.text).not.toContain("%i:");
    expect(renderTooltip("%i:scaleAP% %i:constructor%")).toMatchObject({ text: "주문력 ", unknownIcons: ["constructor"], tokenCount: 0 });
    expect(renderTooltip("%i:OnHit%", { stringTable: { item_keyword_onhit: "<OnHit>적중 시</OnHit> %i:OnHit%" } }).text).toBe("적중 시");
  });
  it("16.21 원본의 AP 생략값과 AD=2·체력=12 및 추가 능력치 공식=2를 문장으로 보존한다", () => {
    // 1066 APRequiredTooltipOnly/ADRequiredTooltipOnly/BonusHPRequiredTooltipOnly의 원본 필드 대응이다.
    const result = renderTooltip("@AP@ / @AD@ / @HP@ / @BonusHP@", { calculations: {
      AP: { __type: "StatByCoefficientCalculationPart", mCoefficient: 0.3 },
      AD: { __type: "StatByCoefficientCalculationPart", mStat: 2, mStatFormula: 2, mCoefficient: 0.15 },
      HP: { __type: "StatByCoefficientCalculationPart", mStat: 12, mCoefficient: 0.05 },
      BonusHP: { __type: "StatByNamedDataValueCalculationPart", mStat: 12, mStatFormula: 2, mDataValue: "Ratio" },
    }, dataValues: [{ name: "Ratio", values: [0.04] }] });
    expect(result).toMatchObject({ status: "ok", text: "주문력의 30% / 추가 공격력의 15% / 최대 체력의 5% / 추가 체력의 4%", unresolvedTokenCount: 0 });
    expect(result.tokens.filter(token => token.formula)).toHaveLength(4);
  });
  it.each([
    [1, "방어력"], [4, "공격 속도"], [6, "마법 저항력"], [7, "이동 속도"],
    [8, "치명타 확률"], [9, "치명타 피해량"], [11, "스킬 가속"], [34, "체력 회복 및 보호막 효과"],
  ])("원본의 mStat=%s를 %s에 대응한다", (mStat, label) => {
    // 1324 ConversionRate, 1386 AttackSpeedCoefficient, 1081 MSToASConversion, 1415 AdditionalMisDivision,
    // 2016 CritAmp, 1098 AbilityHasteToMSConversion, 2133 HSPercent에서 능력치 이름을 교차 확인했다.
    expect(renderTooltip("@Value@", { calculations: { Value: { __type: "StatByCoefficientCalculationPart", mStat, mCoefficient: 0.1 } } }).text)
      .toBe(`${label}의 10%`);
  });
  it("수치·능력치 합과 곱·수정 계산을 조합하며 퍼센트와 명시 배수를 보존한다", () => {
    const calculations = {
      Value: { __type: "GameCalculation", mFormulaParts: [
        { __type: "NumberCalculationPart", mNumber: 10 }, { __type: "StatByCoefficientCalculationPart", mCoefficient: 0.3 },
      ] },
      Modified: { __type: "GameCalculationModified", mModifiedGameCalculation: "Value", mMultiplier: { __type: "NumberCalculationPart", mNumber: 2 } },
      Product: { __type: "ProductOfSubPartsCalculationPart", mPart1: { __type: "NumberCalculationPart", mNumber: 2 },
        mPart2: { __type: "StatByCoefficientCalculationPart", mCoefficient: 0.3 } },
      Percent: { __type: "GameCalculation", mDisplayAsPercent: true, mFormulaParts: [{ __type: "StatByCoefficientCalculationPart", mCoefficient: 0.001 }] },
    };
    expect(renderTooltip("@Value@ / @Modified@ / @Product@ / @Product*-1@ / @Percent@", { calculations }))
      .toMatchObject({ status: "ok", text: "10 + 주문력의 30% / 20 + 주문력의 60% / 주문력의 60% / 주문력의 -60% / 주문력 100당 10%" });
  });
  it("기본 마나 자원과 버프 중첩 계수·DataValue를 숫자로 추정하지 않는다", () => {
    expect(renderTooltip("@Mana@ / @Stack@ / @Named@", { dataValues: [{ name: "HastePerStack", values: [3] }], calculations: {
      Mana: { __type: "AbilityResourceByCoefficientCalculationPart", mCoefficient: 0.1 },
      Stack: { __type: "BuffCounterByCoefficientCalculationPart", mBuffName: "{76180b74}", mCoefficient: 0.1 },
      Named: { __type: "BuffCounterByNamedDataValueCalculationPart", mBuffName: "{95ab772f}", mDataValue: "HastePerStack" },
    } })).toMatchObject({ status: "ok", text: "최대 마나의 10% / 중첩당 0.1 / 중첩당 3" });
  });
  it("레벨 1~18의 경계 직전·직후 극값과 최초 레벨 증가량을 계산한다", () => {
    // 3121 FruitCount: 레벨 1에 3개, 7/11/15에서 각각 1개 추가한다.
    const result = renderTooltip("@Fruit@ / @Linear@ / @Peak@", { calculations: {
      Fruit: { __type: "ByCharLevelBreakpointsCalculationPart", mLevel1Value: 3,
        mBreakpoints: [7, 11, 15].map(mLevel => ({ __type: "Breakpoint", mLevel, mAdditionalBonusAtThisLevel: 1 })) },
      Linear: { __type: "ByCharLevelBreakpointsCalculationPart", mLevel1Value: 70, mInitialBonusPerLevel: 10 },
      Peak: { __type: "ByCharLevelBreakpointsCalculationPart", mLevel1Value: 10,
        mBreakpoints: [{ mLevel: 7, mAdditionalBonusAtThisLevel: 30 }, { mLevel: 11, mAdditionalBonusAtThisLevel: -20 }] },
    } });
    expect(result).toMatchObject({ status: "ok", text: "3~6(레벨에 따라) / 70~240(레벨에 따라) / 10~40(레벨에 따라)" });
    expect(result.tokens.filter(token => token.formula)).toHaveLength(3);
  });
  it("2078 충돌 범위와 원거리·근접 배율을 각각 보존한다", () => {
    const result = renderTooltip("@Collision@ / @Ranged@", { dataValues: [{ name: "Min", values: [10] }, { name: "Max", values: [40] }], calculations: {
      Collision: { __type: "{ee18a47b}", StartDataValue: "Min", EndDataValue: "Max" },
      Ranged: { __type: "{e9a3c91d}", mFormulaParts: [{ __type: "NumberCalculationPart", mNumber: 10 }],
        mRangedMultiplier: { __type: "NumberCalculationPart", mNumber: 0.5 } },
    } });
    expect(result).toMatchObject({ text: "10~40 / 원거리 5 / 근접 10", unresolvedTokens: [], unsupportedCalculations: [] });
  });
  it("미확인 능력치·공식·자원·경계 형식은 원래 토큰을 보존한다", () => {
    for (const calculation of [
      { __type: "StatByCoefficientCalculationPart", mStat: 999, mCoefficient: 0.1 },
      { __type: "StatByCoefficientCalculationPart", mStatFormula: 9, mCoefficient: 0.1 },
      { __type: "StatByCoefficientCalculationPart", mCoefficient: 1e308 },
      { __type: "AbilityResourceByCoefficientCalculationPart", mAbilityResource: 1, mCoefficient: 0.1 },
      { __type: "AbilityResourceByCoefficientCalculationPart", mAbilityResourceFormula: 1, mCoefficient: 0.1 },
      { __type: "ByCharLevelBreakpointsCalculationPart", mLevel1Value: 1, unknown: 2 },
      { __type: "ByCharLevelBreakpointsCalculationPart", mLevel1Value: 1, mBreakpoints: [{ mLevel: 5, unknown: 1 }] },
      { __type: "ByCharLevelBreakpointsCalculationPart", mLevel1Value: 1, mBreakpoints: [{ mLevel: 6 }, { mLevel: 3 }] },
    ]) expect(renderTooltip("@Value@", { calculations: { Value: calculation } })).toMatchObject({ status: "failed", text: "@Value@", unresolvedTokenCount: 1 });
  });
  it("런타임 변수로 고르는 문자열 키를 추정하거나 이중 집계하지 않는다", () => {
    expect(renderTooltip("{{Augment_ARAM_QQQuest_Tooltip@f6@}}", {
      stringTable: { augment_aram_qqquest_tooltip0: "미선택 단계" },
    })).toMatchObject({ text: "{{Augment_ARAM_QQQuest_Tooltip@f6@}}", status: "failed", tokenCount: 1, unresolvedTokenCount: 1 });
  });
});

describe("증강 게시 차단", () => {
  const base = extractAugments(sample).find(augment => augment.platformId === 3118)!;
  const pool = (size: number) => Array.from({ length: size }, (_, index) => ({ ...structuredClone(base), platformId: index + 1 }));
  const ratio = (unresolved: number, total: number) => ({ ...renderTooltip("설명"), tokenCount: total, unresolvedTokenCount: unresolved });
  it("풀 변화 ±30% 초과만 막고 내부·비활성 증강을 일반 풀에서 제외한다", () => {
    expect(validateAugments({ previous: pool(10), current: pool(13), tooltips: [] }).ok).toBe(true);
    expect(validateAugments({ previous: pool(10), current: pool(7), tooltips: [] }).ok).toBe(true);
    expect(validateAugments({ previous: pool(10), current: pool(14), tooltips: [] }).problems[0].code).toBe("pool_change");
    expect(validateAugments({ previous: pool(10), current: pool(6), tooltips: [] }).problems[0].code).toBe("pool_change");
    const ignored = pool(10).map(entry => ({ ...entry, isInternal: true }));
    expect(validateAugments({ previous: pool(10), current: [...pool(10), ...ignored, { ...base, enabled: false }], tooltips: [] }).ok).toBe(true);
    expect(validateAugments({ previous: [], current: pool(1), tooltips: [] }).ok).toBe(false);
  });
  it("이름 누락은 3개까지 허용하고 등급 불일치는 하나라도 막는다", () => {
    const missing = pool(4).map(entry => ({ ...entry, ko: { ...entry.ko, name: "" } }));
    expect(validateAugments({ current: missing.slice(0, 3), tooltips: [] }).ok).toBe(true);
    expect(validateAugments({ current: missing, tooltips: [] }).problems[0].code).toBe("missing_names");
    expect(validateAugments({ current: [{ ...base, rarityEvidence: { cherry: "gold", bin: "silver" } }], tooltips: [] }).problems[0].code).toBe("rarity_mismatch");
  });
  it("미치환 비율은 차단하지 않고 통계로 남긴다", () => {
    expect(validateAugments({ current: pool(1), tooltips: [ratio(1, 20)] }).ok).toBe(true);
    expect(validateAugments({ current: pool(1), tooltips: [ratio(20, 20)] }).ok).toBe(true);
    expect(tooltipTokenStats([ratio(1, 2), ratio(1, 8)])).toEqual({ tokenCount: 10, unresolvedTokenCount: 2, ratio: 0.2 });
    expect(tooltipTokenStats([]).ratio).toBe(0);
  });
});

describe("증강 표시 fallback과 검토 경고", () => {
  it("tooltip, desc, 부분 설명 순서로 안전한 토큰을 선택한다", () => {
    const ok = renderTooltip("<b>설명</b>");
    const partial = renderTooltip("피해 @Unknown@ / @Unknown@");
    expect(chooseAugmentDisplay(ok, partial)).toMatchObject({ displaySource: "tooltip", text: "설명", notice: null });
    expect(chooseAugmentDisplay(partial, ok)).toMatchObject({ displaySource: "desc", text: "설명", notice: null });
    const result = chooseAugmentDisplay(partial, partial);
    expect(result).toMatchObject({ displaySource: "desc_partial", text: "피해 (수치 미확인) / (수치 미확인)" });
    expect(result.tokens.map(token => token.text).join("")).toBe(result.text);
    expect(result.notice).toBe("일부 수치는 게임 안에서 확인하세요");
  });
  it("빈 설명은 차단하고 완전 치환율 10%p 초과 하락은 경고만 남긴다", () => {
    const base = extractAugments(sample).find(augment => augment.platformId === 3118)!;
    expect(validateAugments({ current: [{ ...base, ko: { ...base.ko, description: " " } }] }))
      .toMatchObject({ ok: false, problems: [{ code: "empty_description" }] });
    const previousDescriptions = Array.from({ length: 10 }, () => renderTooltip("설명"));
    const descriptions = [...previousDescriptions];
    descriptions[0] = renderTooltip("@Unknown@");
    expect(validateAugments({ current: [base], descriptions, previousDescriptions }).warnings).toEqual([]);
    descriptions[1] = renderTooltip("@Unknown@");
    expect(validateAugments({ current: [base], descriptions, previousDescriptions }))
      .toMatchObject({ ok: true, problems: [], warnings: [{ code: "review" }] });
  });
});
