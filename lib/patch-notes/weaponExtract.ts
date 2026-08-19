/**
 * @fileoverview 패치노트 원문에서 게임 데이터 변경안을 구조화 추출합니다.
 *
 * 추출 결과는 그 자체로 신뢰되지 않습니다. 호출자는 반드시
 * lib/patch-notes/weaponValidate.ts 의 validateWeaponChanges() 를 통과시켜야 합니다.
 *
 * 새 의존성을 추가하지 않기 위해 이미 사용 중인 @google/generative-ai 의
 * responseSchema(JSON 모드)와 jsonrepair 를 그대로 사용합니다.
 */

import { createHash } from "node:crypto";
import { jsonrepair } from "jsonrepair";
import { GoogleGenerativeAI, SchemaType, type Schema } from "@google/generative-ai";
import {
  PATCHABLE_COLUMNS,
  PATCHABLE_TABLES,
  REMOVAL_EVIDENCE_KEYWORDS,
  type PatchableTable,
} from "./weaponSchema";
import { GEMINI_MODELS_TO_TRY } from "@/lib/pubg-analysis/constants";

/** 기존 패치노트 동기화 경로와 동일한 모델 폴백 순서입니다. */
export const WEAPON_EXTRACT_MODELS = GEMINI_MODELS_TO_TRY;

/**
 * 추출에 사용할 원문 최대 길이.
 * 기존 3개 경로가 15000 / 8000 / 5000자로 갈라져 있어 요약 결과가 경로마다 달랐습니다.
 * 추출은 수치 누락이 곧 품질 저하이므로 가장 긴 값을 기준으로 둡니다.
 */
export const WEAPON_EXTRACT_MAX_SOURCE_LENGTH = 15000;

/** 프롬프트에 함께 넣는 현재 DB 항목 최대 개수. 토큰 비용 상한입니다. */
export const WEAPON_EXTRACT_MAX_CATALOG_ROWS = 400;

export interface CatalogRow {
  table: PatchableTable;
  id: string;
  name: string;
  values: Record<string, unknown>;
}

export interface GenerateJsonResult {
  text: string;
  modelName: string;
  promptTokens: number;
  completionTokens: number;
}

export interface WeaponExtractDeps {
  generateJson(prompt: string): Promise<GenerateJsonResult>;
}

export interface WeaponExtractResult {
  rawChanges: unknown[];
  rawResponse: unknown;
  modelName: string;
  promptTokens: number;
  completionTokens: number;
}

export function hashSourceText(sourceText: string): string {
  return createHash("sha256").update(sourceText.normalize("NFC").trim()).digest("hex");
}

/** 편집 가능 컬럼 목록을 프롬프트용 문자열로 만듭니다. */
export function describeEditableColumns(): string {
  return PATCHABLE_TABLES.map((table) => {
    const columns = Object.entries(PATCHABLE_COLUMNS[table]).map(([column, rule]) => {
      if (rule.kind === "number") return `${column}(숫자 ${rule.min}~${rule.max})`;
      if (rule.kind === "enum") return `${column}(${rule.values.join("|")})`;
      return `${column}(문자열 최대 ${rule.maxLength}자)`;
    });
    return `- ${table}: ${columns.join(", ")}`;
  }).join("\n");
}

export function buildWeaponExtractionPrompt(sourceText: string, catalog: CatalogRow[]): string {
  const trimmedSource = sourceText.slice(0, WEAPON_EXTRACT_MAX_SOURCE_LENGTH);
  const catalogLines = catalog
    .slice(0, WEAPON_EXTRACT_MAX_CATALOG_ROWS)
    .map((row) => {
      const values = Object.entries(row.values)
        .map(([key, value]) => `${key}=${value ?? "null"}`)
        .join(" ");
      return `${row.table}|${row.id}|${row.name}|${values}`;
    })
    .join("\n");

  return `당신은 PUBG 패치노트에서 게임 데이터 수치 변경만 뽑아내는 추출기입니다.
설명하지 말고 지정된 JSON만 출력하세요.

[작업]
아래 패치노트 원문을 읽고 다음 두 가지만 제출하세요.
  A) 우리 DB에 이미 존재하는 항목의 수치가 변경된 경우 (operation = "update")
  B) 우리 DB에 존재하는 항목이 게임에서 완전히 제거·단종된 경우 (operation = "remove")

[편집 가능한 테이블과 컬럼 — 이 목록에 없는 컬럼은 절대 제출 금지]
${describeEditableColumns()}

[우리 DB의 현재 항목 목록 — target_id 는 반드시 이 목록의 id 를 그대로 사용]
형식: table|id|name|현재값
${catalogLines}

[절대 규칙]
1. target_id 는 위 목록에 있는 id 만 사용하세요. 목록에 없는 항목은 제출하지 마세요.
2. evidence_quote 는 패치노트 원문에서 **글자 그대로 복사한 문장**이어야 합니다.
   요약·의역·재작성 금지. 원문에 없는 문장을 쓰면 해당 항목은 자동 폐기됩니다.
3. operation = "update" 는 원문에 구체적인 변경 후 수치가 명시된 경우만 제출하세요.
   "밸런스를 조정했습니다" 처럼 수치가 없는 서술은 제출하지 마세요.
4. operation = "remove" 는 해당 항목이 게임에서 완전히 사라진 경우만 제출하세요.
   근거 문장에 다음과 같은 제거 표현이 반드시 포함되어야 합니다.
   ${REMOVAL_EVIDENCE_KEYWORDS.join(", ")}
   특정 맵에서만 빠지거나 스폰율이 낮아진 경우는 remove 가 아닙니다.
   그런 경우는 spawn_maps 또는 availability 의 update 로 제출하세요.
   remove 를 제출할 때 column_name 과 new_value 는 빈 문자열로 두세요.
5. 신규 항목 추가와 이름 변경은 이 작업의 대상이 아닙니다.
6. 변경 사항이 없으면 changes 를 빈 배열로 두세요. 억지로 채우지 마세요.

[패치노트 원문]
${trimmedSource}`;
}

const RESPONSE_SCHEMA: Schema = {
  type: SchemaType.OBJECT,
  properties: {
    changes: {
      type: SchemaType.ARRAY,
      description: "패치노트에 명시된 수치 변경 목록. 없으면 빈 배열",
      items: {
        type: SchemaType.OBJECT,
        properties: {
          target_table: {
            type: SchemaType.STRING,
            description: `대상 테이블. ${PATCHABLE_TABLES.join(" | ")} 중 하나`,
          },
          target_id: { type: SchemaType.STRING, description: "현재 항목 목록에 있는 id" },
          operation: {
            type: SchemaType.STRING,
            description: "update(수치 변경) 또는 remove(게임에서 제거). 생략하면 update",
          },
          column_name: { type: SchemaType.STRING, description: "편집 가능 컬럼명" },
          new_value: { type: SchemaType.STRING, description: "변경 후 값. 숫자도 문자열로 표기" },
          evidence_quote: { type: SchemaType.STRING, description: "원문에서 그대로 복사한 근거 문장" },
          confidence: { type: SchemaType.NUMBER, description: "0에서 1 사이 확신도" },
        },
        required: ["target_table", "target_id", "evidence_quote"],
      },
    },
  },
  required: ["changes"],
};

/**
 * 모델 응답을 파싱합니다.
 * JSON 모드를 쓰더라도 코드펜스나 잘린 응답이 오는 경우가 있어 jsonrepair 로 복구합니다.
 */
export function parseWeaponChangeResponse(text: string): { rawResponse: unknown; rawChanges: unknown[] } {
  const stripped = text
    .replace(/^\s*```(?:json)?/i, "")
    .replace(/```\s*$/i, "")
    .trim();

  const parseFailure = { rawResponse: { parseError: true, text: stripped.slice(0, 4000) }, rawChanges: [] };

  let parsed: unknown = null;
  try {
    parsed = JSON.parse(stripped);
  } catch {
    try {
      // jsonrepair 는 일반 텍스트를 JSON 문자열로 감싸 돌려주기도 하므로
      // 아래에서 객체 여부를 다시 확인한다.
      parsed = JSON.parse(jsonrepair(stripped));
    } catch {
      return parseFailure;
    }
  }

  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return parseFailure;
  }

  const changes = Array.isArray((parsed as { changes?: unknown }).changes)
    ? (parsed as { changes: unknown[] }).changes
    : [];

  return { rawResponse: parsed, rawChanges: changes };
}

/**
 * 응답의 new_value 는 스키마상 문자열이므로, 컬럼 규칙이 숫자면 숫자로 되돌립니다.
 * 검증 게이트가 타입을 엄격히 보므로 여기서 정규화해 둡니다.
 */
export function coerceNumericValues(rawChanges: unknown[]): unknown[] {
  return rawChanges.map((entry) => {
    if (!entry || typeof entry !== "object") return entry;
    const change = { ...(entry as Record<string, unknown>) };
    const table = change.target_table;
    const column = change.column_name;
    if (typeof table !== "string" || typeof column !== "string") return change;
    if (!(PATCHABLE_TABLES as readonly string[]).includes(table)) return change;

    const rule = PATCHABLE_COLUMNS[table as PatchableTable][column];
    if (!rule || rule.kind !== "number") return change;
    if (typeof change.new_value !== "string") return change;

    // 단위나 기호가 섞인 값은 변환하지 않고 그대로 둬서 검증 게이트가 거부하게 합니다.
    const normalized = change.new_value.trim().replace(/,/g, "");
    if (!/^-?\d+(\.\d+)?$/.test(normalized)) return change;
    change.new_value = Number(normalized);
    return change;
  });
}

export function createGeminiExtractDeps(apiKey: string): WeaponExtractDeps {
  const genAI = new GoogleGenerativeAI(apiKey);

  return {
    async generateJson(prompt: string): Promise<GenerateJsonResult> {
      let lastError: unknown = null;

      for (const modelName of WEAPON_EXTRACT_MODELS) {
        try {
          const model = genAI.getGenerativeModel({
            model: modelName,
            generationConfig: {
              responseMimeType: "application/json",
              responseSchema: RESPONSE_SCHEMA,
              // 수치 추출은 창의성이 필요 없습니다.
              temperature: 0,
            },
          });
          const result = await model.generateContent(prompt);
          const text = result.response.text();
          if (!text) continue;

          const usage = result.response.usageMetadata;
          return {
            text,
            modelName,
            promptTokens: usage?.promptTokenCount ?? 0,
            completionTokens: usage?.candidatesTokenCount ?? 0,
          };
        } catch (err) {
          lastError = err;
          console.warn(`[weapon-extract] ${modelName} 실패:`, err instanceof Error ? err.message : err);
        }
      }

      throw new Error(
        `모든 모델에서 무기 변경 추출에 실패했습니다: ${lastError instanceof Error ? lastError.message : String(lastError)}`
      );
    },
  };
}

export async function extractWeaponChanges(
  sourceText: string,
  catalog: CatalogRow[],
  deps: WeaponExtractDeps
): Promise<WeaponExtractResult> {
  const prompt = buildWeaponExtractionPrompt(sourceText, catalog);
  const generated = await deps.generateJson(prompt);
  const { rawResponse, rawChanges } = parseWeaponChangeResponse(generated.text);

  return {
    rawChanges: coerceNumericValues(rawChanges),
    rawResponse,
    modelName: generated.modelName,
    promptTokens: generated.promptTokens,
    completionTokens: generated.completionTokens,
  };
}
