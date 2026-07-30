/**
 * @fileoverview AI 가 제출한 게임 데이터 변경안을 검증하는 게이트입니다.
 *
 * 핵심은 evidence_quote(원문 인용) 검증입니다. 프롬프트의 "환각 차단 가이드라인"은
 * 지시일 뿐 강제력이 없으므로, 인용문이 패치노트 원문에 실제로 존재하는지를
 * 코드가 문자열 검색으로 확인합니다. 존재하지 않으면 승인 대상에서 제외됩니다.
 *
 * 이 모듈은 순수 함수만 노출합니다. DB·네트워크 접근이 없어 단위 테스트가 가능합니다.
 */

import { checkColumnValue, isPatchableTable, PATCHABLE_COLUMNS } from "./weaponSchema";

/** AI 응답 1건. 신뢰할 수 없는 입력으로 취급합니다. */
export interface RawWeaponChange {
  target_table?: unknown;
  target_id?: unknown;
  column_name?: unknown;
  new_value?: unknown;
  evidence_quote?: unknown;
  confidence?: unknown;
}

/** 검증 대상 행의 현재 스냅샷. key 는 `${table}:${id}` 입니다. */
export type CurrentRows = Map<string, Record<string, unknown>>;

export type ValidationState = "ok" | "stale" | "invalid";

export interface ValidatedWeaponChange {
  targetTable: string;
  targetId: string;
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
    const columnName = typeof raw.column_name === "string" ? raw.column_name.trim() : "";
    const evidenceQuote = typeof raw.evidence_quote === "string" ? raw.evidence_quote.trim() : "";
    const confidence = readConfidence(raw.confidence);

    const base = {
      targetTable,
      targetId,
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

    // 2. 컬럼 화이트리스트
    if (!(columnName in PATCHABLE_COLUMNS[targetTable])) {
      changes.push(invalid(base, `편집이 허용되지 않은 컬럼: ${targetTable}.${columnName || "(비어 있음)"}`));
      continue;
    }

    if (!targetId) {
      changes.push(invalid(base, "대상 항목 id 가 비어 있음"));
      continue;
    }

    // 3. 값 타입·범위·enum
    const valueCheck = checkColumnValue(targetTable, columnName, raw.new_value);
    if (!valueCheck.ok) {
      changes.push(invalid(base, valueCheck.reason));
      continue;
    }
    base.newValue = valueCheck.value;

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

    // 7. 현재값과 동일하면 적용 불필요
    if (isSameValue(currentValue, valueCheck.value)) {
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
  };
}
