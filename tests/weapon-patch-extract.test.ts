import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  buildWeaponExtractionPrompt,
  coerceNumericValues,
  extractWeaponChanges,
  hashSourceText,
  parseWeaponChangeResponse,
  WEAPON_EXTRACT_MAX_SOURCE_LENGTH,
  type CatalogRow,
  type WeaponExtractDeps,
} from "@/lib/patch-notes/weaponExtract";
import { rowKey, validateWeaponChanges, type CurrentRows } from "@/lib/patch-notes/weaponValidate";

const sourceText = readFileSync(
  resolve("tests/fixtures/patch-notes/update-42-1.txt"),
  "utf8"
);

const catalog: CatalogRow[] = [
  { table: "weapons", id: "ar_m416", name: "M416", values: { damage: 41, bullet_speed: 880 } },
  { table: "weapons", id: "ar_beryl", name: "Beryl M762", values: { damage: 47, bullet_speed: 715 } },
];

const currentRows: CurrentRows = new Map([
  [rowKey("weapons", "ar_m416"), { id: "ar_m416", name: "M416", damage: 41, bullet_speed: 880 }],
  [rowKey("weapons", "ar_beryl"), { id: "ar_beryl", name: "Beryl M762", damage: 47, bullet_speed: 715 }],
]);

function stubDeps(text: string): WeaponExtractDeps {
  return {
    async generateJson() {
      return { text, modelName: "gemini-3.1-flash-lite", promptTokens: 1200, completionTokens: 90 };
    },
  };
}

describe("hashSourceText", () => {
  it("공백과 유니코드 표기를 정규화해 같은 원문을 같은 해시로 만든다", () => {
    expect(hashSourceText("  업데이트 42.1  ")).toBe(hashSourceText("업데이트 42.1"));
  });

  it("본문이 다르면 해시가 달라진다", () => {
    expect(hashSourceText("업데이트 42.1")).not.toBe(hashSourceText("업데이트 42.2"));
  });
});

describe("buildWeaponExtractionPrompt", () => {
  it("현재 항목 목록과 편집 가능 컬럼을 프롬프트에 포함한다", () => {
    const prompt = buildWeaponExtractionPrompt(sourceText, catalog);

    expect(prompt).toContain("weapons|ar_m416|M416|damage=41 bullet_speed=880");
    expect(prompt).toContain("weapons: damage(숫자 0~300)");
    expect(prompt).toContain("글자 그대로 복사한 문장");
    expect(prompt).toContain("M416의 기본 데미지가 41에서 43으로 상향되었습니다.");
  });

  it("원문을 최대 길이로 자른다", () => {
    const long = "가".repeat(WEAPON_EXTRACT_MAX_SOURCE_LENGTH + 500);
    const prompt = buildWeaponExtractionPrompt(long, catalog);
    expect(prompt).toContain("가".repeat(WEAPON_EXTRACT_MAX_SOURCE_LENGTH));
    expect(prompt).not.toContain("가".repeat(WEAPON_EXTRACT_MAX_SOURCE_LENGTH + 1));
  });

  it("편집이 허용되지 않은 컬럼은 프롬프트에 노출하지 않는다", () => {
    const prompt = buildWeaponExtractionPrompt(sourceText, catalog);
    expect(prompt).not.toContain("weapons: id");
    expect(prompt).not.toMatch(/weapons: .*\bname\(/);
  });
});

describe("parseWeaponChangeResponse", () => {
  it("정상 JSON 을 파싱한다", () => {
    const { rawChanges } = parseWeaponChangeResponse('{"changes":[{"target_id":"ar_m416"}]}');
    expect(rawChanges).toHaveLength(1);
  });

  it("코드펜스로 감싼 응답을 파싱한다", () => {
    const { rawChanges } = parseWeaponChangeResponse('```json\n{"changes":[{"target_id":"ar_m416"}]}\n```');
    expect(rawChanges).toHaveLength(1);
  });

  it("깨진 JSON 을 jsonrepair 로 복구한다", () => {
    const { rawChanges } = parseWeaponChangeResponse('{"changes":[{"target_id":"ar_m416",}');
    expect(rawChanges).toHaveLength(1);
  });

  it("복구 불가한 응답은 빈 목록과 파싱 오류 표시를 남긴다", () => {
    const { rawChanges, rawResponse } = parseWeaponChangeResponse("완전히 JSON 이 아닌 텍스트");
    expect(rawChanges).toEqual([]);
    expect(rawResponse).toMatchObject({ parseError: true });
  });

  it("changes 가 배열이 아니면 빈 목록으로 처리한다", () => {
    const { rawChanges } = parseWeaponChangeResponse('{"changes":"없음"}');
    expect(rawChanges).toEqual([]);
  });
});

describe("coerceNumericValues", () => {
  it("숫자 컬럼의 문자열 값을 숫자로 되돌린다", () => {
    const [change] = coerceNumericValues([
      { target_table: "weapons", target_id: "ar_m416", column_name: "damage", new_value: "43" },
    ]) as Record<string, unknown>[];
    expect(change.new_value).toBe(43);
  });

  it("단위가 붙은 값은 변환하지 않아 검증 게이트가 거부하게 둔다", () => {
    const [change] = coerceNumericValues([
      { target_table: "weapons", target_id: "ar_beryl", column_name: "bullet_speed", new_value: "730m/s" },
    ]) as Record<string, unknown>[];
    expect(change.new_value).toBe("730m/s");
  });

  it("문자열 컬럼 값은 그대로 둔다", () => {
    const [change] = coerceNumericValues([
      { target_table: "weapons", target_id: "ar_m416", column_name: "availability", new_value: "보급 상자" },
    ]) as Record<string, unknown>[];
    expect(change.new_value).toBe("보급 상자");
  });
});

describe("extractWeaponChanges", () => {
  it("추출 결과를 검증 게이트에 그대로 넘길 수 있다", async () => {
    const deps = stubDeps(
      JSON.stringify({
        changes: [
          {
            target_table: "weapons",
            target_id: "ar_m416",
            column_name: "damage",
            new_value: "43",
            evidence_quote: "M416의 기본 데미지가 41에서 43으로 상향되었습니다.",
            confidence: 0.9,
          },
          {
            target_table: "weapons",
            target_id: "ar_beryl",
            column_name: "bullet_speed",
            new_value: "730",
            evidence_quote: "Beryl M762의 탄속이 715m/s에서 730m/s로 증가했습니다.",
            confidence: 0.88,
          },
        ],
      })
    );

    const extracted = await extractWeaponChanges(sourceText, catalog, deps);
    expect(extracted.modelName).toBe("gemini-3.1-flash-lite");
    expect(extracted.promptTokens).toBe(1200);

    const validated = validateWeaponChanges(extracted.rawChanges, sourceText, currentRows);
    expect(validated.summary.ok).toBe(2);
    expect(validated.changes.map((c) => c.newValue)).toEqual([43, 730]);
    expect(validated.changes.map((c) => c.oldValue)).toEqual([41, 715]);
  });

  it("모델이 지어낸 근거는 검증 단계에서 전부 걸러진다", async () => {
    const deps = stubDeps(
      JSON.stringify({
        changes: [
          {
            target_table: "weapons",
            target_id: "ar_m416",
            column_name: "damage",
            new_value: "55",
            evidence_quote: "전반적인 무기 밸런스가 개선되었습니다.",
            confidence: 0.7,
          },
        ],
      })
    );

    const extracted = await extractWeaponChanges(sourceText, catalog, deps);
    const validated = validateWeaponChanges(extracted.rawChanges, sourceText, currentRows);

    expect(validated.summary.ok).toBe(0);
    expect(validated.summary.evidenceMissing).toBe(1);
  });

  it("변경 사항이 없는 응답도 오류 없이 처리한다", async () => {
    const extracted = await extractWeaponChanges(sourceText, catalog, stubDeps('{"changes":[]}'));
    expect(extracted.rawChanges).toEqual([]);
  });
});
