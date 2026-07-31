import { describe, expect, it } from "vitest";
import { mentionsRemoval, REMOVAL_COLUMN } from "@/lib/patch-notes/weaponSchema";
import { rowKey, validateWeaponChanges, type CurrentRows } from "@/lib/patch-notes/weaponValidate";

const sourceText = [
  "PP-19 비존이 게임에서 제거되었습니다.",
  "모신 나강은 더 이상 등장하지 않습니다.",
  "Win94는 미라마에서만 스폰됩니다.",
  "M416의 기본 데미지가 41에서 43으로 상향되었습니다.",
].join(" ");

/** 삭제 검증에는 removed_at 현재 상태가 필요합니다. */
function buildCurrentRows(): CurrentRows {
  const rows: CurrentRows = new Map();
  rows.set(rowKey("weapons", "smg_bizon"), {
    id: "smg_bizon",
    name: "PP-19 비존",
    damage: 35,
    removed_at: null,
  });
  rows.set(rowKey("weapons", "sr_mosin"), {
    id: "sr_mosin",
    name: "모신 나강",
    damage: 79,
    removed_at: null,
  });
  rows.set(rowKey("weapons", "sr_win94"), {
    id: "sr_win94",
    name: "Win94",
    damage: 66,
    removed_at: null,
  });
  rows.set(rowKey("weapons", "ar_m416"), {
    id: "ar_m416",
    name: "M416",
    damage: 41,
    removed_at: null,
  });
  rows.set(rowKey("weapons", "sr_kar98k"), {
    id: "sr_kar98k",
    name: "Kar98k",
    damage: 75,
    // 이미 삭제 처리된 항목
    removed_at: "2026-07-01T00:00:00.000Z",
  });
  return rows;
}

describe("삭제 근거 표현 판정", () => {
  it("제거를 명시하는 표현을 인식한다", () => {
    expect(mentionsRemoval("PP-19 비존이 게임에서 제거되었습니다.")).toBe(true);
    expect(mentionsRemoval("모신 나강은 더 이상 등장하지 않습니다.")).toBe(true);
    expect(mentionsRemoval("This weapon has been removed.")).toBe(true);
  });

  it("단순 수치 조정 문장은 제거로 보지 않는다", () => {
    expect(mentionsRemoval("M416의 기본 데미지가 41에서 43으로 상향되었습니다.")).toBe(false);
    expect(mentionsRemoval("탄속: 840m/s → 870m/s")).toBe(false);
  });
});

describe("삭제 제안 검증 게이트", () => {
  it("근거가 제거를 명시하면 승인 가능 상태로 통과시킨다", () => {
    const result = validateWeaponChanges(
      [
        {
          target_table: "weapons",
          target_id: "smg_bizon",
          operation: "remove",
          evidence_quote: "PP-19 비존이 게임에서 제거되었습니다.",
        },
      ],
      sourceText,
      buildCurrentRows()
    );

    expect(result.changes).toHaveLength(1);
    expect(result.changes[0].validationState).toBe("ok");
    expect(result.changes[0].operation).toBe("remove");
    // SQL 제약과 맞추기 위해 컬럼명을 removed_at 으로 고정한다.
    expect(result.changes[0].columnName).toBe(REMOVAL_COLUMN);
    expect(result.changes[0].newValue).toBeNull();
    expect(result.summary.removals).toBe(1);
  });

  it("모델이 다른 컬럼명을 보내도 removed_at 으로 고정한다", () => {
    const result = validateWeaponChanges(
      [
        {
          target_table: "weapons",
          target_id: "sr_mosin",
          operation: "remove",
          column_name: "damage",
          new_value: "0",
          evidence_quote: "모신 나강은 더 이상 등장하지 않습니다.",
        },
      ],
      sourceText,
      buildCurrentRows()
    );

    expect(result.changes[0].columnName).toBe(REMOVAL_COLUMN);
    expect(result.changes[0].validationState).toBe("ok");
  });

  it("원문에 있어도 제거 표현이 없는 근거는 거부한다", () => {
    // 맵 한 곳에서만 빠지는 경우를 삭제로 오인하면 무기가 도감에서 사라진다.
    const result = validateWeaponChanges(
      [
        {
          target_table: "weapons",
          target_id: "sr_win94",
          operation: "remove",
          evidence_quote: "Win94는 미라마에서만 스폰됩니다.",
        },
      ],
      sourceText,
      buildCurrentRows()
    );

    expect(result.changes[0].validationState).toBe("invalid");
    expect(result.changes[0].validationReason).toContain("제거를 명시");
  });

  it("원문에 없는 근거는 기존 환각 차단 게이트가 먼저 막는다", () => {
    const result = validateWeaponChanges(
      [
        {
          target_table: "weapons",
          target_id: "smg_bizon",
          operation: "remove",
          evidence_quote: "비존은 삭제되었으며 보상이 지급됩니다.",
        },
      ],
      sourceText,
      buildCurrentRows()
    );

    expect(result.changes[0].validationState).toBe("invalid");
    expect(result.changes[0].validationReason).toContain("찾을 수 없음");
  });

  it("이미 삭제된 항목은 stale 로 처리해 중복 적용을 막는다", () => {
    const result = validateWeaponChanges(
      [
        {
          target_table: "weapons",
          target_id: "sr_kar98k",
          operation: "remove",
          evidence_quote: "PP-19 비존이 게임에서 제거되었습니다.",
        },
      ],
      sourceText,
      buildCurrentRows()
    );

    expect(result.changes[0].validationState).toBe("stale");
    expect(result.changes[0].validationReason).toContain("이미 삭제");
  });

  it("존재하지 않는 항목의 삭제 제안은 거부한다", () => {
    const result = validateWeaponChanges(
      [
        {
          target_table: "weapons",
          target_id: "sr_unknown",
          operation: "remove",
          evidence_quote: "PP-19 비존이 게임에서 제거되었습니다.",
        },
      ],
      sourceText,
      buildCurrentRows()
    );

    expect(result.changes[0].validationState).toBe("invalid");
    expect(result.changes[0].validationReason).toContain("존재하지 않는 항목");
  });

  it("삭제와 수치 변경을 함께 처리하고 요약에 구분해 담는다", () => {
    const result = validateWeaponChanges(
      [
        {
          target_table: "weapons",
          target_id: "smg_bizon",
          operation: "remove",
          evidence_quote: "PP-19 비존이 게임에서 제거되었습니다.",
        },
        {
          target_table: "weapons",
          target_id: "ar_m416",
          column_name: "damage",
          new_value: 43,
          evidence_quote: "M416의 기본 데미지가 41에서 43으로 상향되었습니다.",
        },
      ],
      sourceText,
      buildCurrentRows()
    );

    expect(result.summary.total).toBe(2);
    expect(result.summary.ok).toBe(2);
    expect(result.summary.removals).toBe(1);
  });

  it("operation 이 없으면 기존과 동일하게 수치 변경으로 취급한다", () => {
    const result = validateWeaponChanges(
      [
        {
          target_table: "weapons",
          target_id: "ar_m416",
          column_name: "damage",
          new_value: 43,
          evidence_quote: "M416의 기본 데미지가 41에서 43으로 상향되었습니다.",
        },
      ],
      sourceText,
      buildCurrentRows()
    );

    expect(result.changes[0].operation).toBe("update");
    expect(result.summary.removals).toBe(0);
  });
});
