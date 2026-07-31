/**
 * @fileoverview 패치노트 기반 게임 데이터 갱신에서 편집을 허용하는 테이블·컬럼 화이트리스트입니다.
 *
 * 이 모듈이 편집 가능 범위의 단일 진실 공급원입니다.
 * - AI 추출 결과 검증(lib/patch-notes/weaponValidate.ts)
 * - 관리자 승인 후 적용(supabase/migrations 의 weapon_patch_editable_columns())
 * - 관리자 직접 편집 API(app/api/admin/game-data/route.ts)
 * 세 경로가 모두 이 정의를 참조해야 합니다.
 *
 * SQL 쪽 목록과의 일치는 tests/weapon-patch-schema-parity.test.ts 가 검증합니다.
 */

export const PATCHABLE_TABLES = [
  "weapons",
  "attachments",
  "ammo",
  "consumables",
  "throwables",
  "vehicles",
] as const;

export type PatchableTable = (typeof PATCHABLE_TABLES)[number];

export type ColumnRule =
  | { kind: "number"; min: number; max: number; integer?: boolean }
  | { kind: "string"; maxLength: number }
  | { kind: "enum"; values: readonly string[] };

/**
 * 무기 분류값. types/game-data.ts 의 Weapon["type"] 과 일치해야 합니다.
 * "ALL" 은 UI 필터 전용 값이므로 편집 대상에서 제외합니다.
 */
export const WEAPON_TYPES = [
  "AR",
  "DMR",
  "SR",
  "SMG",
  "SG",
  "HG",
  "LMG",
  "Melee",
  "Other",
] as const;

/**
 * 테이블별 편집 허용 컬럼과 값 제약.
 *
 * 2026-07-30 운영 DB information_schema 조회로 컬럼 존재와 타입을 확인했다.
 *   weapons.damage / bullet_speed: integer
 *   weapons.weight, ammo.weight, attachments.weight, consumables.weight, throwables.weight: numeric
 *   attachments.vertical_recoil / horizontal_recoil / reload_speed / ads_speed: integer
 *   consumables.cast_time: text (숫자가 아니다)
 *   vehicles.trunk_capacity: integer not null
 * consumables 에는 heal_amount 컬럼이 없고 effect(text) 만 존재하므로 대상에서 제외한다.
 *
 * id 와 name 은 의도적으로 제외합니다. 식별자와 표시명이 자동 변경되면
 * R2 이미지 키(/api/images/weapons/{id}.webp)와 분석 엔진 상수가 함께 깨집니다.
 */
export const PATCHABLE_COLUMNS: Record<PatchableTable, Record<string, ColumnRule>> = {
  weapons: {
    damage: { kind: "number", min: 0, max: 300, integer: true },
    bullet_speed: { kind: "number", min: 0, max: 2000, integer: true },
    ammo: { kind: "string", maxLength: 40 },
    type: { kind: "enum", values: WEAPON_TYPES },
    availability: { kind: "string", maxLength: 120 },
    spawn_maps: { kind: "string", maxLength: 200 },
    weight: { kind: "number", min: 0, max: 100 },
    patch_notes: { kind: "string", maxLength: 2000 },
  },
  attachments: {
    vertical_recoil: { kind: "number", min: -100, max: 100, integer: true },
    horizontal_recoil: { kind: "number", min: -100, max: 100, integer: true },
    reload_speed: { kind: "number", min: -100, max: 100, integer: true },
    ads_speed: { kind: "number", min: -100, max: 100, integer: true },
    weight: { kind: "number", min: 0, max: 100 },
    patch_notes: { kind: "string", maxLength: 2000 },
  },
  ammo: {
    weight: { kind: "number", min: 0, max: 100 },
    patch_notes: { kind: "string", maxLength: 2000 },
  },
  consumables: {
    // 운영 스키마에서 text 컬럼이다. "8초" 처럼 단위를 포함한 값이 저장된다.
    cast_time: { kind: "string", maxLength: 40 },
    weight: { kind: "number", min: 0, max: 100 },
    patch_notes: { kind: "string", maxLength: 2000 },
  },
  throwables: {
    weight: { kind: "number", min: 0, max: 100 },
    patch_notes: { kind: "string", maxLength: 2000 },
  },
  vehicles: {
    trunk_capacity: { kind: "number", min: 0, max: 10000, integer: true },
    patch_notes: { kind: "string", maxLength: 2000 },
  },
};

export function isPatchableTable(value: unknown): value is PatchableTable {
  return typeof value === "string" && (PATCHABLE_TABLES as readonly string[]).includes(value);
}

/** 제안이 표현할 수 있는 연산 종류입니다. */
export const PATCH_OPERATIONS = ["update", "remove"] as const;

export type PatchOperation = (typeof PATCH_OPERATIONS)[number];

export function isPatchOperation(value: unknown): value is PatchOperation {
  return typeof value === "string" && (PATCH_OPERATIONS as readonly string[]).includes(value);
}

/**
 * 삭제 제안이 사용하는 고정 컬럼명입니다.
 * 삭제는 특정 컬럼 편집이 아니라 소프트 삭제 표시이므로 removed_at 하나로 고정합니다.
 * SQL 쪽 weapon_patch_proposal_changes_remove_column_check 제약과 일치해야 합니다.
 */
export const REMOVAL_COLUMN = "removed_at";

/**
 * 삭제 제안의 근거 문장에 반드시 포함되어야 하는 표현입니다.
 *
 * 삭제는 수치 변경보다 파괴적이므로 인용문 존재 확인만으로는 부족합니다.
 * 패치노트가 실제로 "제거"를 말했는지 확인해, 단순 밸런스 조정 문장이
 * 삭제 근거로 오인되는 것을 막습니다.
 */
export const REMOVAL_EVIDENCE_KEYWORDS = [
  "제거",
  "삭제",
  "단종",
  "빠집니다",
  "빠졌습니다",
  "제외됩니다",
  "제외되었습니다",
  "더 이상 등장하지",
  "removed",
  "retired",
  "no longer",
] as const;

/** 근거 문장이 삭제를 명시하는지 확인합니다. */
export function mentionsRemoval(quote: string): boolean {
  const normalized = quote.normalize("NFC").toLowerCase();
  return REMOVAL_EVIDENCE_KEYWORDS.some((keyword) => normalized.includes(keyword.toLowerCase()));
}

export function getColumnRule(table: string, column: string): ColumnRule | null {
  if (!isPatchableTable(table)) return null;
  return PATCHABLE_COLUMNS[table][column] ?? null;
}

/** SQL 화이트리스트 함수와 비교하기 위한 평탄화 목록입니다. */
export function listPatchableColumns(): { table: PatchableTable; column: string }[] {
  return PATCHABLE_TABLES.flatMap((table) =>
    Object.keys(PATCHABLE_COLUMNS[table]).map((column) => ({ table, column }))
  );
}

export type ColumnValueCheck =
  | { ok: true; value: number | string }
  | { ok: false; reason: string };

/** 화이트리스트 규칙에 따라 제안값의 타입·범위·enum 을 검사합니다. */
export function checkColumnValue(
  table: string,
  column: string,
  value: unknown
): ColumnValueCheck {
  const rule = getColumnRule(table, column);
  if (!rule) {
    return { ok: false, reason: `편집이 허용되지 않은 컬럼: ${table}.${column}` };
  }

  if (rule.kind === "number") {
    if (typeof value !== "number" || !Number.isFinite(value)) {
      return { ok: false, reason: `${column} 은 숫자여야 함 (받은 값: ${JSON.stringify(value)})` };
    }
    if (rule.integer && !Number.isInteger(value)) {
      return { ok: false, reason: `${column} 은 정수여야 함 (받은 값: ${value})` };
    }
    if (value < rule.min || value > rule.max) {
      return { ok: false, reason: `${column} 허용 범위 ${rule.min}~${rule.max} 초과 (받은 값: ${value})` };
    }
    return { ok: true, value };
  }

  if (rule.kind === "string") {
    if (typeof value !== "string") {
      return { ok: false, reason: `${column} 은 문자열이어야 함 (받은 값: ${JSON.stringify(value)})` };
    }
    const trimmed = value.trim();
    if (trimmed.length === 0) {
      return { ok: false, reason: `${column} 은 빈 문자열일 수 없음` };
    }
    if (trimmed.length > rule.maxLength) {
      return { ok: false, reason: `${column} 최대 길이 ${rule.maxLength}자 초과 (${trimmed.length}자)` };
    }
    return { ok: true, value: trimmed };
  }

  if (typeof value !== "string" || !rule.values.includes(value)) {
    return {
      ok: false,
      reason: `${column} 은 다음 중 하나여야 함: ${rule.values.join(", ")} (받은 값: ${JSON.stringify(value)})`,
    };
  }
  return { ok: true, value };
}
