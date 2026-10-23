import { describe, expect, it } from "vitest";
import { extractAugments } from "@/lib/lol/augments/extract";
import { parseStringTable, stringTableHash } from "@/lib/lol/augments/stringTable";
import { renderTooltip } from "@/lib/lol/augments/tooltip";
import { chooseAugmentDisplay, tooltipTokenStats, validateAugments } from "@/lib/lol/augments/validate";
import sample from "./fixtures/lol-augments/sample-16.21";

describe("안전한 툴팁 치환", () => {
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
        Damage: { __type: "GameCalculation", mFormulaParts: [{ __type: "StatByCoefficientCalculationPart", mCoefficient: 0.5 }] },
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
