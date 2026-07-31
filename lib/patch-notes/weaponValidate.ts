/**
 * @fileoverview AI 가 제출한 게임 데이터 변경안을 검증하는 게이트입니다.
 *
 * 핵심은 evidence_quote(원문 인용) 검증입니다. 프롬프트의 "환각 차단 가이드라인"은
 * 지시일 뿐 강제력이 없으므로, 인용문이 패치노트 원문에 실제로 존재하는지를
 * 코드가 문자열 검색으로 확인합니다. 존재하지 않으면 승인 대상에서 제외됩니다.
 *
 * 이 모듈은 순수 함수만 노출합니다. DB·네트워크 접근이 없어 단위 테스트가 가능합니다.
 */

import {
  checkColumnValue,
  isPatchableTable,
  mentionsRemoval,
  PATCHABLE_COLUMNS,
  REMOVAL_COLUMN,
  type PatchOperation,
} from "./weaponSchema";

/** AI 응답 1건. 신뢰할 수 없는 입력으로 취급합니다. */
export interface RawWeaponChange {
  target_table?: unknown;
  target_id?: unknown;
  column_name?: unknown;
  new_value?: unknown;
  evidence_quote?: unknown;
  confidence?: unknown;
  operation?: unknown;
}

/** 검증 대상 행의 현재 스냅샷. key 는 `${table}:${id}` 입니다. */
export type CurrentRows = Map<string, Record<string, unknown>>;

export type ValidationState = "ok" | "stale" | "invalid";

export interface ValidatedWeaponChange {
  targetTable: string;
  targetId: string;
  operation: PatchOperation;
  columnName: string;
  oldValue: unknown;
  newValue: number | string | null;
  evidenceQuote: string;
  evidenceFound: boolean;
  confidence: number | null;
  validationState: ValidationState;
  validationReason: string | null;
}

export interface ValidationSummary {
  total: number;
  ok: number;
  stale: number;
  invalid: number;
  evidenceMissing: number;
  duplicates: number;
  /** 삭제 제안 건수. 관리자가 파괴적 변경 개수를 한눈에 보기 위한 값입니다. */
  removals: number;
}

export interface ValidationResult {
  changes: ValidatedWeaponChange[];
  summary: ValidationSummary;
}

export function rowKey(table: string, id: string): string {
  return `${table}:${id}`;
}

/**
 * 인용문 대조용 정규화.
 * 크롤링 본문과 모델 출력은 공백·개행·전각 문자 처리가 달라지므로
 * 공백을 접고 유니코드를 NFC 로 통일한 뒤 비교합니다.
 */
export function normalizeForQuoteMatch(text: string): string {
  return text
    .normalize("NFC")
    .replace(/[\u200b-\u200d\ufeff]/g, "")
    .replace(/[“”„]/g, '"')
    .replace(/[‘’]/g, "'")
    .replace(/[–—−]/g, "-")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

const MIN_QUOTE_LENGTH = 8;

/** 인용문이 원문에 존재하는지 확인합니다. */
export function isQuoteGrounded(sourceText: string, quote: string): boolean {
  const normalizedQuote = normalizeForQuoteMatch(quote);
  if (normalizedQuote.length < MIN_QUOTE_LENGTH) return false;
  return normalizeForQuoteMatch(sourceText).includes(normalizedQuote);
}

function readConfidence(value: unknown): number | null {
  if (typeof value !== "number" || !Number.isFinite(value)) return null;
  if (value < 0 || value > 1) return null;
  return Math.round(value * 100) / 100;
}

function invalid(
  base: Omit<ValidatedWeaponChange, "validationState" | "validationReason">,
  reason: string
): ValidatedWeaponChange {
  return { ...base, validationState: "invalid", validationReason: reason };
}

/**
 * AI 응답 목록을 검증합니다.
 *
 * @param rawChanges 모델이 제출한 변경안
 * @param sourceText 패치노트 원문(인용 대조용)
 * @param currentRows 대상 행의 현재 값. rowKey() 로 키를 만든 Map
 */
export function validateWeaponChanges(
  rawChanges: unknown,
  sourceText: string,
  currentRows: CurrentRows
): ValidationResult {
  const list = Array.isArray(rawChanges) ? rawChanges : [];
  const changes: ValidatedWeaponChange[] = [];
  const seen = new Set<string>();
  let duplicates = 0;

  for (const entry of list) {
    const raw = (entry ?? {}) as RawWeaponChange;
    const targetTable = typeof raw.target_table === "string" ? raw.target_table.trim() : "";
    const targetId = typeof raw.target_id === "string" ? raw.target_id.trim() : "";
    const evidenceQuote = typeof raw.evidence_quote === "string" ? raw.evidence_quote.trim() : "";
    const confidence = readConfidence(raw.confidence);

    // 삭제 제안은 column_name 을 removed_at 으로 고정한다.
    // 모델이 다른 컬럼명을 보내도 무시해 SQL 제약과 어긋나지 않게 한다.
    const isRemoval = raw.operation === "remove";
    const operation: PatchOperation = isRemoval ? "remove" : "update";
    const columnName = isRemoval
      ? REMOVAL_COLUMN
      : typeof raw.column_name === "string"
        ? raw.column_name.trim()
        : "";

    const base = {
      targetTable,
      targetId,
      operation,
      columnName,
      oldValue: null as unknown,
      newValue: null as number | string | null,
      evidenceQuote,
      evidenceFound: false,
      confidence,
    };

    // 1. 대상 테이블 화이트리스트
    if (!isPatchableTable(targetTable)) {
      changes.push(invalid(base, `편집이 허용되지 않은 테이블: ${targetTable || "(비어 있음)"}`));
      continue;
    }

    // 2. 컬럼 화이트리스트. 삭제는 컬럼 편집이 아니므로 이 검사를 건너뛴다.
    if (!isRemoval && !(columnName in PATCHABLE_COLUMNS[targetTable])) {
      changes.push(invalid(base, `편집이 허용되지 않은 컬럼: ${targetTable}.${columnName || "(비어 있음)"}`));
      continue;
    }

    if (!targetId) {
      changes.push(invalid(base, "대상 항목 id 가 비어 있음"));
      continue;
    }

    // 3. 값 검사. 삭제는 새 값이 없으므로 건너뛴다.
    let newValue: number | string | null = null;
    if (!isRemoval) {
      const valueCheck = checkColumnValue(targetTable, columnName, raw.new_value);
      if (!valueCheck.ok) {
        changes.push(invalid(base, valueCheck.reason));
        continue;
      }
      newValue = valueCheck.value;
      base.newValue = valueCheck.value;
    }

    // 4. 대상 행 존재 확인
    const row = currentRows.get(rowKey(targetTable, targetId));
    if (!row) {
      changes.push(invalid(base, `존재하지 않는 항목: ${targetTable}.${targetId}`));
      continue;
    }
    const currentValue = row[columnName] ?? null;
    base.oldValue = currentValue;

    // 5. 인용문 검증 — 환각 차단 게이트
    const grounded = isQuoteGrounded(sourceText, evidenceQuote);
    base.evidenceFound = grounded;
    if (!grounded) {
      changes.push(invalid(base, "인용문을 패치노트 원문에서 찾을 수 없음"));
      continue;
    }

    // 6. 중복 제안 제거 (동일 대상·컬럼)
    const dedupeKey = `${targetTable}:${targetId}:${columnName}`;
    if (seen.has(dedupeKey)) {
      duplicates += 1;
      changes.push(invalid(base, "같은 대상·컬럼에 대한 중복 제안"));
      continue;
    }
    seen.add(dedupeKey);

    if (isRemoval) {
      // 7-a. 삭제는 파괴적이므로 근거 문장이 실제로 제거를 명시해야 한다.
      // 인용문이 원문에 존재하더라도 밸런스 조정 문장이면 삭제 근거로 인정하지 않는다.
      if (!mentionsRemoval(evidenceQuote)) {
        changes.push(
          invalid(base, "근거 문장에 항목 제거를 명시하는 표현이 없음")
        );
        continue;
      }

      // 이미 삭제 처리된 항목은 다시 삭제할 필요가 없다.
      if (currentValue !== null) {
        changes.push({
          ...base,
          validationState: "stale",
          validationReason: "이미 삭제 처리된 항목",
        });
        continue;
      }

      changes.push({ ...base, validationState: "ok", validationReason: null });
      continue;
    }

    // 7-b. 현재값과 동일하면 적용 불필요
    if (newValue !== null && isSameValue(currentValue, newValue)) {
      changes.push({
        ...base,
        validationState: "stale",
        validationReason: "현재 값과 동일해 변경할 내용이 없음",
      });
      continue;
    }

    changes.push({ ...base, validationState: "ok", validationReason: null });
  }

  return { changes, summary: summarize(changes, duplicates) };
}

function isSameValue(current: unknown, next: number | string): boolean {
  if (typeof next === "number") {
    const currentNumber = typeof current === "number" ? current : Number(current);
    return Number.isFinite(currentNumber) && currentNumber === next;
  }
  return typeof current === "string" && current.trim() === next;
}

function summarize(changes: ValidatedWeaponChange[], duplicates: number): ValidationSummary {
  return {
    total: changes.length,
    ok: changes.filter((c) => c.validationState === "ok").length,
    stale: changes.filter((c) => c.validationState === "stale").length,
    invalid: changes.filter((c) => c.validationState === "invalid").length,
    evidenceMissing: changes.filter((c) => !c.evidenceFound).length,
    duplicates,
    removals: changes.filter((c) => c.operation === "remove").length,
  };
}
