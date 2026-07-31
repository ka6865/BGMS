/**
 * @fileoverview 무기도감 갱신 제안을 관리자 화면용 형태로 조회·결정하는 계층입니다.
 *
 * 이 모듈은 제안 테이블만 읽고 씁니다. 서비스 테이블(weapons 등) 적용은
 * apply_weapon_patch_proposal RPC 가 담당합니다.
 */

import type { SupabaseClient } from "@supabase/supabase-js";
import { PATCHABLE_COLUMNS, isPatchableTable, type PatchableTable } from "./weaponSchema";

type AdminClient = SupabaseClient<any, any, any>;

export const PROPOSAL_STATUSES = [
  "pending",
  "partially_applied",
  "applied",
  "rejected",
  "superseded",
] as const;

export type ProposalStatus = (typeof PROPOSAL_STATUSES)[number];

export const CHANGE_DECISIONS = ["pending", "accepted", "rejected"] as const;

export type ChangeDecision = (typeof CHANGE_DECISIONS)[number];

export function isProposalStatus(value: unknown): value is ProposalStatus {
  return typeof value === "string" && (PROPOSAL_STATUSES as readonly string[]).includes(value);
}

export function isChangeDecision(value: unknown): value is ChangeDecision {
  return typeof value === "string" && (CHANGE_DECISIONS as readonly string[]).includes(value);
}

/** 관리자 화면 카드 1장에 필요한 변경 항목 정보입니다. */
export interface ProposalChangeView {
  id: string;
  targetTable: PatchableTable;
  targetId: string;
  targetName: string;
  /** update(수치 변경) 또는 remove(게임에서 제거) */
  operation: string;
  columnName: string;
  columnLabel: string;
  oldValue: unknown;
  newValue: unknown;
  evidenceQuote: string;
  evidenceFound: boolean;
  confidence: number | null;
  validationState: string;
  validationReason: string | null;
  decision: ChangeDecision;
}

export interface ProposalView {
  id: string;
  sourceUrl: string;
  sourcePostId: number | null;
  patchLabel: string | null;
  status: string;
  modelName: string | null;
  validationSummary: Record<string, unknown>;
  createdAt: string;
  reviewedAt: string | null;
  changes: ProposalChangeView[];
}

/**
 * 컬럼 표시명. 관리자가 DB 컬럼명을 몰라도 무엇이 바뀌는지 알 수 있게 합니다.
 */
const COLUMN_LABELS: Record<string, string> = {
  damage: "데미지",
  bullet_speed: "탄속",
  ammo: "사용 탄약",
  type: "무기 분류",
  availability: "습득처",
  spawn_maps: "등장 맵",
  weight: "무게",
  patch_notes: "패치 메모",
  vertical_recoil: "수직 반동",
  horizontal_recoil: "수평 반동",
  reload_speed: "장전 속도",
  ads_speed: "조준 속도",
  cast_time: "사용 시간",
  trunk_capacity: "트렁크 용량",
};

export function describeColumn(table: string, column: string): string {
  const label = COLUMN_LABELS[column];
  if (!label) return column;
  if (!isPatchableTable(table)) return label;
  return PATCHABLE_COLUMNS[table][column] ? label : column;
}

interface ChangeRow {
  id: string;
  proposal_id: string;
  target_table: string;
  target_id: string;
  operation: string;
  column_name: string;
  old_value: unknown;
  new_value: unknown;
  evidence_quote: string;
  evidence_found: boolean;
  confidence: number | string | null;
  validation_state: string;
  validation_reason: string | null;
  decision: string;
}

interface ProposalRow {
  id: string;
  source_url: string;
  source_post_id: number | null;
  patch_label: string | null;
  status: string;
  model_name: string | null;
  validation_summary: Record<string, unknown> | null;
  created_at: string;
  reviewed_at: string | null;
}

/**
 * 대상 행의 표시명을 한 번에 조회합니다.
 * 항목마다 개별 조회하면 제안 1건에 수십 번의 왕복이 발생합니다.
 */
async function loadTargetNames(
  supabaseAdmin: AdminClient,
  changes: ChangeRow[]
): Promise<Map<string, string>> {
  const idsByTable = new Map<string, Set<string>>();
  for (const change of changes) {
    if (!isPatchableTable(change.target_table)) continue;
    const ids = idsByTable.get(change.target_table) ?? new Set<string>();
    ids.add(change.target_id);
    idsByTable.set(change.target_table, ids);
  }

  const names = new Map<string, string>();
  for (const [table, ids] of idsByTable) {
    const { data } = await supabaseAdmin
      .from(table)
      .select("id,name")
      .in("id", Array.from(ids));

    for (const row of ((data ?? []) as unknown) as { id: string; name: string | null }[]) {
      names.set(`${table}:${row.id}`, row.name ?? row.id);
    }
  }
  return names;
}

export interface ListProposalsOptions {
  status?: ProposalStatus;
  limit?: number;
}

const DEFAULT_LIMIT = 20;
const MAX_LIMIT = 50;

/** 제안 목록과 각 제안의 변경 항목을 함께 반환합니다. */
export async function listWeaponPatchProposals(
  supabaseAdmin: AdminClient,
  options: ListProposalsOptions = {}
): Promise<ProposalView[]> {
  const limit = Math.min(Math.max(options.limit ?? DEFAULT_LIMIT, 1), MAX_LIMIT);

  let query = supabaseAdmin
    .from("weapon_patch_proposals")
    .select(
      "id,source_url,source_post_id,patch_label,status,model_name,validation_summary,created_at,reviewed_at"
    )
    .order("created_at", { ascending: false })
    .limit(limit);

  if (options.status) {
    query = query.eq("status", options.status);
  }

  const { data: proposalRows, error } = await query;
  if (error) throw new Error(`제안 목록 조회 실패: ${error.message}`);

  const proposals = ((proposalRows ?? []) as unknown) as ProposalRow[];
  if (proposals.length === 0) return [];

  const { data: changeRows, error: changesError } = await supabaseAdmin
    .from("weapon_patch_proposal_changes")
    .select(
      "id,proposal_id,target_table,target_id,operation,column_name,old_value,new_value,evidence_quote,evidence_found,confidence,validation_state,validation_reason,decision"
    )
    .in("proposal_id", proposals.map((row) => row.id));

  if (changesError) throw new Error(`변경 항목 조회 실패: ${changesError.message}`);

  const changes = ((changeRows ?? []) as unknown) as ChangeRow[];
  const targetNames = await loadTargetNames(supabaseAdmin, changes);

  const changesByProposal = new Map<string, ProposalChangeView[]>();
  for (const change of changes) {
    if (!isPatchableTable(change.target_table)) continue;
    const list = changesByProposal.get(change.proposal_id) ?? [];
    list.push({
      id: change.id,
      targetTable: change.target_table,
      targetId: change.target_id,
      targetName: targetNames.get(`${change.target_table}:${change.target_id}`) ?? change.target_id,
      operation: change.operation === "remove" ? "remove" : "update",
      columnName: change.column_name,
      columnLabel: describeColumn(change.target_table, change.column_name),
      oldValue: change.old_value ?? null,
      newValue: change.new_value,
      evidenceQuote: change.evidence_quote,
      evidenceFound: change.evidence_found,
      confidence: change.confidence === null ? null : Number(change.confidence),
      validationState: change.validation_state,
      validationReason: change.validation_reason,
      decision: isChangeDecision(change.decision) ? change.decision : "pending",
    });
    changesByProposal.set(change.proposal_id, list);
  }

  return proposals.map((row) => ({
    id: row.id,
    sourceUrl: row.source_url,
    sourcePostId: row.source_post_id,
    patchLabel: row.patch_label,
    status: row.status,
    modelName: row.model_name,
    validationSummary: row.validation_summary ?? {},
    createdAt: row.created_at,
    reviewedAt: row.reviewed_at,
    changes: (changesByProposal.get(row.id) ?? []).sort((a, b) => {
      if (a.targetName !== b.targetName) return a.targetName.localeCompare(b.targetName);
      return a.columnName.localeCompare(b.columnName);
    }),
  }));
}

export type DecideChangesResult =
  | { ok: false; reason: string }
  | { ok: true; updated: number; proposalStatus: ProposalStatus };

/**
 * 변경 항목의 승인/거부 결정을 기록합니다.
 *
 * 검증을 통과하지 않은 항목(validation_state != 'ok')은 승인할 수 없습니다.
 * DB CHECK 제약도 같은 규칙을 강제하지만, 사용자에게 이유를 설명하기 위해
 * 여기서 먼저 걸러냅니다.
 */
export async function decideProposalChanges(
  supabaseAdmin: AdminClient,
  proposalId: string,
  changeIds: string[],
  decision: ChangeDecision,
  actorId: string
): Promise<DecideChangesResult> {
  if (changeIds.length === 0) {
    return { ok: false, reason: "결정할 변경 항목이 없습니다." };
  }

  const { data: rows, error } = await supabaseAdmin
    .from("weapon_patch_proposal_changes")
    .select("id,validation_state")
    .eq("proposal_id", proposalId)
    .in("id", changeIds);

  if (error) return { ok: false, reason: `변경 항목 조회 실패: ${error.message}` };

  const found = ((rows ?? []) as unknown) as { id: string; validation_state: string }[];
  if (found.length !== changeIds.length) {
    return { ok: false, reason: "이 제안에 속하지 않은 변경 항목이 포함되어 있습니다." };
  }

  if (decision === "accepted") {
    const blocked = found.filter((row) => row.validation_state !== "ok");
    if (blocked.length > 0) {
      return {
        ok: false,
        reason: `검증을 통과하지 않은 항목은 승인할 수 없습니다. (${blocked.length}건)`,
      };
    }
  }

  const { error: updateError } = await supabaseAdmin
    .from("weapon_patch_proposal_changes")
    .update({
      decision,
      decided_at: new Date().toISOString(),
      decided_by: actorId,
    })
    .eq("proposal_id", proposalId)
    .in("id", changeIds);

  if (updateError) return { ok: false, reason: `결정 저장 실패: ${updateError.message}` };

  // 결정 반영 후 제안 자체의 상태를 재계산한다.
  // apply RPC 는 승인 경로에서만 상태를 갱신하므로, 이 처리가 없으면
  // 모든 항목을 거부해도 제안이 계속 검토 대기 목록에 남는다.
  const proposalStatus = await syncProposalStatus(supabaseAdmin, proposalId, actorId);

  return { ok: true, updated: changeIds.length, proposalStatus };
}

/**
 * 변경 항목의 결정 상태를 보고 제안 행의 status 를 재계산합니다.
 *
 * 판정 규칙
 *   - 미결정 항목이 남아 있으면 pending 을 유지한다.
 *   - 전부 거부되었으면 rejected 로 종료한다.
 *   - 승인된 항목이 있으면 DB 반영 단계가 남아 있으므로 pending 을 유지한다.
 *     실제 반영 후 상태는 apply_weapon_patch_proposal RPC 가 결정한다.
 *
 * 이미 applied / partially_applied 로 넘어간 제안은 건드리지 않습니다.
 */
async function syncProposalStatus(
  supabaseAdmin: AdminClient,
  proposalId: string,
  actorId: string
): Promise<ProposalStatus> {
  const { data: proposalRow } = await supabaseAdmin
    .from("weapon_patch_proposals")
    .select("status")
    .eq("id", proposalId)
    .maybeSingle();

  const currentStatus = (proposalRow?.status as string | undefined) ?? "pending";
  if (currentStatus !== "pending") {
    return isProposalStatus(currentStatus) ? currentStatus : "pending";
  }

  const { data: rows } = await supabaseAdmin
    .from("weapon_patch_proposal_changes")
    .select("decision")
    .eq("proposal_id", proposalId);

  const decisions = ((rows ?? []) as { decision: string }[]).map((row) => row.decision);
  if (decisions.length === 0) return "pending";

  const hasPending = decisions.some((decision) => decision === "pending");
  const hasAccepted = decisions.some((decision) => decision === "accepted");
  if (hasPending || hasAccepted) return "pending";

  await supabaseAdmin
    .from("weapon_patch_proposals")
    .update({
      status: "rejected",
      reviewed_at: new Date().toISOString(),
      reviewed_by: actorId,
    })
    .eq("id", proposalId)
    .eq("status", "pending");

  return "rejected";
}
