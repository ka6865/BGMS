import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  isQuoteGrounded,
  normalizeForQuoteMatch,
  rowKey,
  validateWeaponChanges,
  type CurrentRows,
} from "@/lib/patch-notes/weaponValidate";

const sourceText = readFileSync(
  resolve("tests/fixtures/patch-notes/update-42-1.txt"),
  "utf8"
);

function buildCurrentRows(): CurrentRows {
  return new Map<string, Record<string, unknown>>([
    [
      rowKey("weapons", "ar_m416"),
      { id: "ar_m416", name: "M416", damage: 41, bullet_speed: 880, type: "AR", availability: "월드 스폰" },
    ],
    [
      rowKey("weapons", "ar_beryl"),
      { id: "ar_beryl", name: "Beryl M762", damage: 47, bullet_speed: 715, type: "AR", availability: "월드 스폰" },
    ],
    [
      rowKey("weapons", "dmr_mini14"),
      { id: "dmr_mini14", name: "Mini14", damage: 46, bullet_speed: 990, type: "DMR", availability: "월드 스폰" },
    ],
    [
      rowKey("attachments", "grip_vertical"),
      { id: "grip_vertical", name: "수직 손잡이", vertical_recoil: 15, horizontal_recoil: 0 },
    ],
  ]);
}

function validateOne(change: Record<string, unknown>) {
  const result = validateWeaponChanges([change], sourceText, buildCurrentRows());
  return result.changes[0];
}

describe("인용문 대조", () => {
  it("공백과 따옴표 표기 차이를 무시하고 원문을 찾는다", () => {
    expect(normalizeForQuoteMatch("M416의   기본\n데미지가")).toBe("m416의 기본 데미지가");
    expect(isQuoteGrounded(sourceText, "M416의 기본 데미지가 41에서   43으로 상향되었습니다.")).toBe(true);
  });

  it("원문에 없는 문장은 거부한다", () => {
    expect(isQuoteGrounded(sourceText, "AKM의 데미지가 49에서 52로 상향되었습니다.")).toBe(false);
  });

  it("너무 짧은 인용문은 근거로 인정하지 않는다", () => {
    expect(isQuoteGrounded(sourceText, "M416")).toBe(false);
  });
});

describe("validateWeaponChanges 게이트", () => {
  it("근거와 값이 모두 유효하면 ok 로 판정하고 현재값을 old_value 로 채운다", () => {
    const change = validateOne({
      target_table: "weapons",
      target_id: "ar_m416",
      column_name: "damage",
      new_value: 43,
      evidence_quote: "M416의 기본 데미지가 41에서 43으로 상향되었습니다.",
      confidence: 0.95,
    });

    expect(change.validationState).toBe("ok");
    expect(change.validationReason).toBeNull();
    expect(change.evidenceFound).toBe(true);
    expect(change.oldValue).toBe(41);
    expect(change.newValue).toBe(43);
    expect(change.confidence).toBe(0.95);
  });

  it("인용문이 원문에 없으면 invalid 로 막는다 (환각 차단)", () => {
    const change = validateOne({
      target_table: "weapons",
      target_id: "ar_m416",
      column_name: "damage",
      new_value: 50,
      evidence_quote: "M416의 데미지가 41에서 50으로 대폭 상향되었습니다.",
      confidence: 0.99,
    });

    expect(change.validationState).toBe("invalid");
    expect(change.evidenceFound).toBe(false);
    expect(change.validationReason).toContain("원문에서 찾을 수 없음");
  });

  it("화이트리스트 밖의 컬럼은 거부한다", () => {
    const change = validateOne({
      target_table: "weapons",
      target_id: "ar_m416",
      column_name: "name",
      new_value: "M416 (개편)",
      evidence_quote: "M416의 기본 데미지가 41에서 43으로 상향되었습니다.",
    });

    expect(change.validationState).toBe("invalid");
    expect(change.validationReason).toContain("허용되지 않은 컬럼");
  });

  it("화이트리스트 밖의 테이블은 거부한다", () => {
    const change = validateOne({
      target_table: "profiles",
      target_id: "ar_m416",
      column_name: "damage",
      new_value: 43,
      evidence_quote: "M416의 기본 데미지가 41에서 43으로 상향되었습니다.",
    });

    expect(change.validationState).toBe("invalid");
    expect(change.validationReason).toContain("허용되지 않은 테이블");
  });

  it("허용 범위를 넘는 값은 거부한다", () => {
    const change = validateOne({
      target_table: "weapons",
      target_id: "ar_m416",
      column_name: "damage",
      new_value: 9999,
      evidence_quote: "M416의 기본 데미지가 41에서 43으로 상향되었습니다.",
    });

    expect(change.validationState).toBe("invalid");
    expect(change.validationReason).toContain("허용 범위");
  });

  it("숫자 컬럼에 문자열이 오면 거부한다", () => {
    const change = validateOne({
      target_table: "weapons",
      target_id: "ar_m416",
      column_name: "damage",
      new_value: "43",
      evidence_quote: "M416의 기본 데미지가 41에서 43으로 상향되었습니다.",
    });

    expect(change.validationState).toBe("invalid");
    expect(change.validationReason).toContain("숫자여야 함");
  });

  it("enum 컬럼의 허용되지 않은 값은 거부한다", () => {
    const change = validateOne({
      target_table: "weapons",
      target_id: "dmr_mini14",
      column_name: "type",
      new_value: "SNIPER",
      evidence_quote: "Mini14는 이제 월드 스폰이 아닌 보급 상자에서만 획득할 수 있습니다.",
    });

    expect(change.validationState).toBe("invalid");
    expect(change.validationReason).toContain("다음 중 하나여야 함");
  });

  it("DB 에 없는 항목은 거부한다", () => {
    const change = validateOne({
      target_table: "weapons",
      target_id: "ar_does_not_exist",
      column_name: "damage",
      new_value: 43,
      evidence_quote: "M416의 기본 데미지가 41에서 43으로 상향되었습니다.",
    });

    expect(change.validationState).toBe("invalid");
    expect(change.validationReason).toContain("존재하지 않는 항목");
  });

  it("현재값과 같으면 stale 로 표시해 적용 대상에서 제외한다", () => {
    const change = validateOne({
      target_table: "weapons",
      target_id: "ar_beryl",
      column_name: "bullet_speed",
      new_value: 715,
      evidence_quote: "Beryl M762의 탄속이 715m/s에서 730m/s로 증가했습니다.",
    });

    expect(change.validationState).toBe("stale");
    expect(change.validationReason).toContain("현재 값과 동일");
  });

  it("문자열 컬럼 변경도 근거가 있으면 통과한다", () => {
    const change = validateOne({
      target_table: "weapons",
      target_id: "dmr_mini14",
      column_name: "availability",
      new_value: "보급 상자",
      evidence_quote: "Mini14는 이제 월드 스폰이 아닌 보급 상자에서만 획득할 수 있습니다.",
    });

    expect(change.validationState).toBe("ok");
    expect(change.newValue).toBe("보급 상자");
  });

  it("같은 대상·컬럼의 중복 제안은 두 번째부터 거부한다", () => {
    const duplicate = {
      target_table: "weapons",
      target_id: "ar_m416",
      column_name: "damage",
      new_value: 43,
      evidence_quote: "M416의 기본 데미지가 41에서 43으로 상향되었습니다.",
    };
    const result = validateWeaponChanges([duplicate, duplicate], sourceText, buildCurrentRows());

    expect(result.changes[0].validationState).toBe("ok");
    expect(result.changes[1].validationState).toBe("invalid");
    expect(result.changes[1].validationReason).toContain("중복 제안");
    expect(result.summary.duplicates).toBe(1);
  });

  it("배열이 아닌 입력은 빈 결과로 처리한다", () => {
    const result = validateWeaponChanges(null, sourceText, buildCurrentRows());
    expect(result.changes).toEqual([]);
    expect(result.summary.total).toBe(0);
  });

  it("요약 집계가 상태별 개수와 일치한다", () => {
    const result = validateWeaponChanges(
      [
        {
          target_table: "weapons",
          target_id: "ar_m416",
          column_name: "damage",
          new_value: 43,
          evidence_quote: "M416의 기본 데미지가 41에서 43으로 상향되었습니다.",
        },
        {
          target_table: "weapons",
          target_id: "ar_beryl",
          column_name: "bullet_speed",
          new_value: 715,
          evidence_quote: "Beryl M762의 탄속이 715m/s에서 730m/s로 증가했습니다.",
        },
        {
          target_table: "weapons",
          target_id: "ar_m416",
          column_name: "damage",
          new_value: 60,
          evidence_quote: "존재하지 않는 근거 문장입니다.",
        },
      ],
      sourceText,
      buildCurrentRows()
    );

    expect(result.summary).toEqual({
      total: 3,
      ok: 1,
      stale: 1,
      invalid: 1,
      evidenceMissing: 1,
      duplicates: 0,
    });
  });
});
