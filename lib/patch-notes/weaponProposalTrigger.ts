/**
 * @fileoverview 패치노트 동기화 경로에서 무기도감 갱신 제안을 생성하는 공통 진입점입니다.
 *
 * 동기화 경로 3개(cron, 관리자 수동 sync, CLI 스크립트)가 모두 이 함수를 호출합니다.
 * 제안 생성은 부가 작업이므로 실패해도 패치노트 게시글 저장을 되돌리지 않습니다.
 * 대신 실패 사유를 반환해 호출자가 응답이나 로그에 남길 수 있게 합니다.
 */

import type { SupabaseClient } from "@supabase/supabase-js";
import { createGeminiExtractDeps } from "./weaponExtract";
import {
  createWeaponPatchProposal,
  type CreateProposalResult,
} from "./weaponProposalService";

type AdminClient = SupabaseClient<any, any, any>;

/** 제안 추출을 시도할 최소 원문 길이. 이보다 짧으면 본문 수집이 실패한 것으로 본다. */
export const MIN_SOURCE_TEXT_LENGTH = 200;

/**
 * 패치노트 제목에서 버전 라벨을 뽑습니다.
 * 도감에 표시할 "업데이트 42.1" 같은 값이며, 못 찾으면 null 을 반환합니다.
 */
export function extractPatchLabel(title: string): string | null {
  const normalized = title.normalize("NFC");

  const korean = normalized.match(/업데이트\s*(\d+(?:\.\d+)?)/);
  if (korean) return `업데이트 ${korean[1]}`;

  const english = normalized.match(/\bUpdate\s*(\d+(?:\.\d+)?)/i);
  if (english) return `업데이트 ${english[1]}`;

  const patchOnly = normalized.match(/\b(\d+\.\d+)\s*(?:패치|버전|Patch)/i);
  if (patchOnly) return `업데이트 ${patchOnly[1]}`;

  return null;
}

export type ProposalTriggerOutcome =
  | { status: "skipped"; reason: string }
  | { status: "failed"; reason: string }
  | { status: "duplicate"; proposalId: string }
  | { status: "no_changes" }
  | { status: "created"; proposalId: string; changeCount: number; okCount: number };

export interface TriggerProposalInput {
  supabaseAdmin: AdminClient;
  sourceText: string;
  sourceUrl: string;
  title: string;
  sourcePostId?: number | null;
  /** 테스트에서 주입합니다. 생략하면 Gemini 를 사용합니다. */
  createDeps?: typeof createGeminiExtractDeps;
}

/**
 * 패치노트 1건에 대한 무기도감 갱신 제안을 생성합니다.
 *
 * 다음 경우에는 AI 를 호출하지 않고 건너뜁니다.
 *   - 패치노트 카테고리가 아닌 글(상점 소식 등)은 호출자가 판단해 이 함수를 부르지 않습니다.
 *   - 원문이 너무 짧아 본문 수집 실패로 보이는 경우
 *   - Gemini API 키가 없는 경우
 */
export async function triggerWeaponPatchProposal(
  input: TriggerProposalInput
): Promise<ProposalTriggerOutcome> {
  const sourceText = input.sourceText.trim();

  if (sourceText.length < MIN_SOURCE_TEXT_LENGTH) {
    return {
      status: "skipped",
      reason: `원문이 너무 짧아 제안을 생성하지 않았습니다. (${sourceText.length}자)`,
    };
  }

  const apiKey = process.env.GOOGLE_GEMINI_API_KEY;
  if (!apiKey) {
    return { status: "skipped", reason: "GOOGLE_GEMINI_API_KEY 가 설정되지 않았습니다." };
  }

  try {
    const depsFactory = input.createDeps ?? createGeminiExtractDeps;
    const result: CreateProposalResult = await createWeaponPatchProposal({
      supabaseAdmin: input.supabaseAdmin,
      deps: depsFactory(apiKey),
      sourceText,
      sourceUrl: input.sourceUrl,
      patchLabel: extractPatchLabel(input.title),
      sourcePostId: input.sourcePostId ?? null,
    });

    if (result.status === "duplicate") {
      return { status: "duplicate", proposalId: result.proposalId };
    }
    if (result.status === "no_changes") {
      return { status: "no_changes" };
    }

    return {
      status: "created",
      proposalId: result.proposalId,
      changeCount: result.summary.total,
      okCount: result.summary.ok,
    };
  } catch (error: unknown) {
    return {
      status: "failed",
      reason: error instanceof Error ? error.message : "제안 생성 중 알 수 없는 오류",
    };
  }
}
