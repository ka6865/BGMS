/**
 * @fileoverview 과거 패치노트 글에 대한 무기도감 갱신 제안을 소급 생성하는 모듈입니다.
 *
 * 무기도감 갱신 제안은 패치노트 동기화 시점에만 만들어지므로, 파이프라인 도입 이전에
 * 저장된 패치노트에는 제안이 없습니다. 이 모듈은 저장된 글에서 원문 링크를 찾아
 * 본문을 다시 수집한 뒤 기존 제안 생성기(triggerWeaponPatchProposal)를 재사용합니다.
 *
 * 안전 장치
 *   1. 패치노트 카테고리 글만 대상으로 한다. 상점 안내·개발일지는 AI 비용만 발생한다.
 *   2. 본문 해시가 같은 제안이 이미 있으면 제안 생성기가 duplicate 로 종료한다.
 *   3. AI 호출량을 제한할 수 있도록 처리 건수 상한을 둔다.
 *   4. 제안 테이블에만 기록한다. 서비스 테이블 반영은 관리자 승인 후에만 일어난다.
 */

import type { SupabaseClient } from "@supabase/supabase-js";
import { identifyCategory, shouldExtractWeaponChanges } from "./categorize";
import {
  extractSourceUrlFromContent,
  fetchPatchNoteSourceText,
  type FetchSourceTextDeps,
} from "./patchNoteSourceFetch";
import {
  triggerWeaponPatchProposal,
  type ProposalTriggerOutcome,
  type TriggerProposalInput,
} from "./weaponProposalTrigger";

type AdminClient = SupabaseClient<any, any, any>;

/** 배그 소식 글이 저장되는 게시판 카테고리 이름입니다. */
export const NEWS_CATEGORY = "배그 소식";

/** 한 번의 백필에서 제안 생성을 시도할 기본 최대 건수입니다. */
export const DEFAULT_BACKFILL_LIMIT = 5;

/** 조회할 후보 글 최대 개수. 카테고리 판정 전이라 limit 보다 넉넉하게 둡니다. */
const CANDIDATE_SCAN_LIMIT = 100;

export type BackfillItemStatus =
  | "created"
  | "duplicate"
  | "no_changes"
  | "skipped"
  | "source_gone"
  | "failed";

export interface BackfillItemResult {
  postId: number;
  title: string;
  sourceUrl: string | null;
  status: BackfillItemStatus;
  reason?: string;
  proposalId?: string;
  changeCount?: number;
}

export interface BackfillSummary {
  /** 패치노트로 판정된 후보 글 수 */
  candidates: number;
  /** 실제로 제안 생성을 시도한 글 수 */
  processed: number;
  created: number;
  duplicate: number;
  noChanges: number;
  skipped: number;
  /** 원문이 삭제되어 소급 생성이 불가능한 글 수 */
  sourceGone: number;
  failed: number;
  results: BackfillItemResult[];
}

export interface BackfillOptions {
  supabaseAdmin: AdminClient;
  /** 제안 생성을 시도할 최대 건수. 기본 DEFAULT_BACKFILL_LIMIT */
  limit?: number;
  /** 특정 글만 처리할 때 지정합니다. 지정하면 카테고리 자동 탐색을 건너뜁니다. */
  postIds?: number[];
  /** true 면 원문 수집까지만 하고 AI 를 호출하지 않습니다. */
  dryRun?: boolean;
  /** 테스트에서 주입합니다. */
  fetchDeps?: FetchSourceTextDeps;
  /** 테스트에서 주입합니다. */
  createDeps?: TriggerProposalInput["createDeps"];
  /** 진행 로그 출력용 콜백. CLI 에서 사용합니다. */
  onProgress?: (message: string) => void;
}

interface CandidatePost {
  id: number;
  title: string;
  content: string | null;
}

/**
 * 백필 후보 글을 조회합니다.
 * postIds 가 지정되면 해당 글만, 아니면 배그 소식 카테고리에서 최신순으로 가져옵니다.
 */
async function loadCandidatePosts(
  supabaseAdmin: AdminClient,
  postIds?: number[]
): Promise<CandidatePost[]> {
  const query = supabaseAdmin.from("posts").select("id, title, content");

  const { data, error } = postIds && postIds.length > 0
    ? await query.in("id", postIds)
    : await query
        .eq("category", NEWS_CATEGORY)
        .order("id", { ascending: false })
        .limit(CANDIDATE_SCAN_LIMIT);

  if (error) {
    throw new Error(`패치노트 글 조회 실패: ${error.message}`);
  }

  return ((data ?? []) as unknown as Record<string, unknown>[]).map((row) => ({
    id: Number(row.id),
    title: String(row.title ?? ""),
    content: (row.content as string | null) ?? null,
  }));
}

/** 이미 제안이 있는 글의 id 집합을 반환합니다. 중복 AI 호출을 미리 차단합니다. */
async function loadProposedPostIds(supabaseAdmin: AdminClient): Promise<Set<number>> {
  const { data, error } = await supabaseAdmin
    .from("weapon_patch_proposals")
    .select("source_post_id");

  if (error) {
    throw new Error(`기존 제안 조회 실패: ${error.message}`);
  }

  const ids = new Set<number>();
  for (const row of (data ?? []) as { source_post_id: number | null }[]) {
    if (row.source_post_id !== null) ids.add(Number(row.source_post_id));
  }
  return ids;
}

function toItemStatus(outcome: ProposalTriggerOutcome): BackfillItemResult["status"] {
  if (outcome.status === "created") return "created";
  if (outcome.status === "duplicate") return "duplicate";
  if (outcome.status === "no_changes") return "no_changes";
  if (outcome.status === "skipped") return "skipped";
  return "failed";
}

/**
 * 과거 패치노트 글에 대한 제안을 소급 생성합니다.
 *
 * 개별 글 실패는 전체를 중단시키지 않고 결과 목록에 기록합니다.
 * 이미 제안이 있는 글은 AI 호출 없이 duplicate 로 건너뜁니다.
 */
export async function backfillWeaponPatchProposals(
  options: BackfillOptions
): Promise<BackfillSummary> {
  const { supabaseAdmin } = options;
  const limit = options.limit ?? DEFAULT_BACKFILL_LIMIT;
  const log = options.onProgress ?? (() => {});

  const posts = await loadCandidatePosts(supabaseAdmin, options.postIds);
  const alreadyProposed = await loadProposedPostIds(supabaseAdmin);

  const results: BackfillItemResult[] = [];
  let candidates = 0;
  let processed = 0;

  // 오래된 글부터 처리해 도감 버전 라벨이 시간순으로 남게 한다.
  const ordered = [...posts].sort((a, b) => a.id - b.id);

  for (const post of ordered) {
    const sourceUrl = extractSourceUrlFromContent(post.content);

    // 카테고리 판정에는 원문 URL 도 사용한다. 제목만으로는 오분류가 생긴다.
    const category = identifyCategory(post.title, sourceUrl ?? "");
    if (!shouldExtractWeaponChanges(category)) continue;

    candidates += 1;

    if (alreadyProposed.has(post.id)) {
      results.push({
        postId: post.id,
        title: post.title,
        sourceUrl,
        status: "duplicate",
        reason: "이미 제안이 생성된 글입니다.",
      });
      continue;
    }

    if (processed >= limit) {
      results.push({
        postId: post.id,
        title: post.title,
        sourceUrl,
        status: "skipped",
        reason: `처리 상한(${limit}건)에 도달해 건너뛰었습니다.`,
      });
      continue;
    }

    if (!sourceUrl) {
      results.push({
        postId: post.id,
        title: post.title,
        sourceUrl: null,
        status: "skipped",
        reason: "글 본문에서 원문 링크를 찾지 못했습니다.",
      });
      continue;
    }

    log(`[${post.id}] 원문 수집: ${sourceUrl}`);
    const fetched = await fetchPatchNoteSourceText(sourceUrl, options.fetchDeps);
    if (!fetched.ok) {
      results.push({
        postId: post.id,
        title: post.title,
        sourceUrl,
        // 원문이 삭제된 글은 재시도해도 복구되지 않으므로 실패와 구분한다.
        status: fetched.gone ? "source_gone" : "failed",
        reason: fetched.reason ?? "원문 수집 실패",
      });
      continue;
    }

    if (options.dryRun) {
      processed += 1;
      results.push({
        postId: post.id,
        title: post.title,
        sourceUrl,
        status: "skipped",
        reason: `dry-run: 원문 ${fetched.sourceText.length}자 수집 확인, AI 호출 생략`,
      });
      continue;
    }

    processed += 1;
    log(`[${post.id}] 제안 생성 시도 (원문 ${fetched.sourceText.length}자)`);

    const outcome = await triggerWeaponPatchProposal({
      supabaseAdmin,
      sourceText: fetched.sourceText,
      sourceUrl,
      title: post.title,
      sourcePostId: post.id,
      createDeps: options.createDeps,
    });

    results.push({
      postId: post.id,
      title: post.title,
      sourceUrl,
      status: toItemStatus(outcome),
      reason: "reason" in outcome ? outcome.reason : undefined,
      proposalId: "proposalId" in outcome ? outcome.proposalId : undefined,
      changeCount: "changeCount" in outcome ? outcome.changeCount : undefined,
    });
  }

  return {
    candidates,
    processed,
    created: results.filter((r) => r.status === "created").length,
    duplicate: results.filter((r) => r.status === "duplicate").length,
    noChanges: results.filter((r) => r.status === "no_changes").length,
    skipped: results.filter((r) => r.status === "skipped").length,
    sourceGone: results.filter((r) => r.status === "source_gone").length,
    failed: results.filter((r) => r.status === "failed").length,
    results,
  };
}
