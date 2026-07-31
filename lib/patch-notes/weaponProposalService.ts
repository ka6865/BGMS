/**
 * @fileoverview 무기도감 갱신 제안을 생성·저장하는 서비스 계층입니다.
 *
 * 흐름: 현재 DB 스냅샷 로드 → AI 추출 → 검증 게이트 → 제안 테이블 저장.
 * 서비스 테이블(weapons 등)에는 쓰지 않습니다. 적용은 관리자 승인 후
 * apply_weapon_patch_proposal RPC 가 담당합니다.
 */

import type { SupabaseClient } from "@supabase/supabase-js";
import {
  extractWeaponChanges,
  hashSourceText,
  type CatalogRow,
  type WeaponExtractDeps,
} from "./weaponExtract";
import {
  PATCHABLE_COLUMNS,
  PATCHABLE_TABLES,
  REMOVAL_COLUMN,
  type PatchableTable,
} from "./weaponSchema";
import {
  rowKey,
  validateWeaponChanges,
  type CurrentRows,
  type ValidationSummary,
} from "./weaponValidate";


type AdminClient = SupabaseClient<any, any, any>;

export interface CatalogSnapshot {
  catalog: CatalogRow[];
  currentRows: CurrentRows;
}

/**
 * 편집 대상 테이블의 현재 값을 읽어 프롬프트용 목록과 검증용 Map 을 만듭니다.
 * 화이트리스트에 있는 컬럼만 조회하므로 불필요한 데이터가 프롬프트에 섞이지 않습니다.
 */
export async function loadCatalogSnapshot(
  supabaseAdmin: AdminClient,
  tables: readonly PatchableTable[] = PATCHABLE_TABLES
): Promise<CatalogSnapshot> {
  const catalog: CatalogRow[] = [];
  const currentRows: CurrentRows = new Map();

  for (const table of tables) {
    const columns = Object.keys(PATCHABLE_COLUMNS[table]);
    // removed_at 은 편집 화이트리스트에 없지만 삭제 제안 검증에 현재 상태가 필요하다.
    // 이미 삭제된 항목을 다시 삭제 제안하는 것을 막는 데 사용한다.
    const { data, error } = await supabaseAdmin
      .from(table)
      .select(["id", "name", REMOVAL_COLUMN, ...columns].join(","))
      .order("id", { ascending: true });

    if (error) {
      throw new Error(`${table} 현재 데이터 조회 실패: ${error.message}`);
    }

    for (const row of ((data ?? []) as unknown) as Record<string, unknown>[]) {
      const id = typeof row.id === "string" ? row.id : String(row.id ?? "");
      if (!id) continue;

      // 이미 삭제 처리된 항목은 프롬프트 카탈로그에서 제외한다.
      // AI 가 사라진 무기를 다시 변경 대상으로 보지 않게 하고 토큰도 절약한다.
      if (row[REMOVAL_COLUMN] !== null && row[REMOVAL_COLUMN] !== undefined) {
        currentRows.set(rowKey(table, id), row);
        continue;
      }

      const values: Record<string, unknown> = {};
      for (const column of columns) values[column] = row[column] ?? null;

      catalog.push({
        table,
        id,
        name: typeof row.name === "string" ? row.name : id,
        values,
      });
      currentRows.set(rowKey(table, id), row);
    }
  }

  return { catalog, currentRows };
}

export interface CreateProposalInput {
  supabaseAdmin: AdminClient;
  deps: WeaponExtractDeps;
  sourceText: string;
  sourceUrl: string;
  patchLabel?: string | null;
  sourcePostId?: number | null;
  /** 추출 대상 테이블 제한. 기본은 화이트리스트 전체 */
  tables?: readonly PatchableTable[];
}

export type CreateProposalResult =
  | { status: "duplicate"; proposalId: string }
  | { status: "no_changes"; summary: ValidationSummary }
  | { status: "created"; proposalId: string; summary: ValidationSummary };

const POSTGRES_UNIQUE_VIOLATION = "23505";

/**
 * 패치노트 1건에 대한 제안을 생성합니다.
 *
 * 같은 본문(해시 일치)에 대한 제안이 이미 있으면 AI 를 호출하지 않고 종료합니다.
 * 기존 동기화의 중복 판정(sync_history.last_url / posts.title)은 제목이 바뀌면
 * 우회되므로 본문 해시를 기준으로 둡니다.
 */
export async function createWeaponPatchProposal(
  input: CreateProposalInput
): Promise<CreateProposalResult> {
  const { supabaseAdmin, deps, sourceText, sourceUrl } = input;
  const sourceTextHash = hashSourceText(sourceText);

  const { data: existing, error: existingError } = await supabaseAdmin
    .from("weapon_patch_proposals")
    .select("id")
    .eq("source_text_hash", sourceTextHash)
    .maybeSingle();

  if (existingError) {
    throw new Error(`기존 제안 조회 실패: ${existingError.message}`);
  }
  if (existing?.id) {
    return { status: "duplicate", proposalId: existing.id as string };
  }

  const { catalog, currentRows } = await loadCatalogSnapshot(supabaseAdmin, input.tables);
  const extracted = await extractWeaponChanges(sourceText, catalog, deps);
  const validated = validateWeaponChanges(extracted.rawChanges, sourceText, currentRows);

  // 저장할 항목이 아무것도 없으면 제안 행을 만들지 않는다.
  // 빈 제안이 쌓이면 관리자 검토 목록만 오염된다.
  if (validated.changes.length === 0) {
    return { status: "no_changes", summary: validated.summary };
  }

  const { data: inserted, error: insertError } = await supabaseAdmin
    .from("weapon_patch_proposals")
    .insert({
      source_post_id: input.sourcePostId ?? null,
      source_url: sourceUrl,
      source_text_hash: sourceTextHash,
      patch_label: input.patchLabel ?? null,
      status: "pending",
      model_name: extracted.modelName,
      raw_ai_response: extracted.rawResponse ?? null,
      validation_summary: validated.summary,
    })
    .select("id")
    .single();

  if (insertError) {
    // 동시 실행으로 같은 본문이 먼저 저장된 경우
    if (insertError.code === POSTGRES_UNIQUE_VIOLATION) {
      const { data: raced } = await supabaseAdmin
        .from("weapon_patch_proposals")
        .select("id")
        .eq("source_text_hash", sourceTextHash)
        .maybeSingle();
      if (raced?.id) return { status: "duplicate", proposalId: raced.id as string };
    }
    throw new Error(`제안 저장 실패: ${insertError.message}`);
  }

  const proposalId = inserted.id as string;

  const { error: changesError } = await supabaseAdmin
    .from("weapon_patch_proposal_changes")
    .insert(
      validated.changes.map((change) => ({
        proposal_id: proposalId,
        target_table: change.targetTable,
        target_id: change.targetId,
        operation: change.operation,
        column_name: change.columnName,
        old_value: change.oldValue ?? null,
        // 삭제 제안은 새 값이 없다. new_value 는 not null 이므로 null 리터럴 jsonb 를 저장한다.
        new_value: change.operation === "remove" ? null : change.newValue,
        evidence_quote: change.evidenceQuote,
        evidence_found: change.evidenceFound,
        confidence: change.confidence,
        validation_state: change.validationState,
        validation_reason: change.validationReason,
        decision: "pending",
      }))
    );

  if (changesError) {
    // 변경 항목이 없는 제안 행은 의미가 없으므로 되돌린다.
    await supabaseAdmin.from("weapon_patch_proposals").delete().eq("id", proposalId);
    throw new Error(`변경 항목 저장 실패: ${changesError.message}`);
  }

  return { status: "created", proposalId, summary: validated.summary };
}
