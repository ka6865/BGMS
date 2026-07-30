/**
 * @fileoverview 과거 패치노트에 대한 무기도감 갱신 제안을 소급 생성하는 CLI 스크립트입니다.
 *
 * 사용법
 *   npx tsx scripts/backfill_weapon_patch_proposals.ts --dry-run
 *   npx tsx scripts/backfill_weapon_patch_proposals.ts --limit=3
 *   npx tsx scripts/backfill_weapon_patch_proposals.ts --posts=42,64
 *
 * dry-run 은 원문 수집만 확인하고 AI 를 호출하지 않으므로 비용이 들지 않습니다.
 * 실제 실행 시에도 제안 테이블에만 기록되며, 무기 데이터는 관리자 승인 후에만 바뀝니다.
 */

import { createClient } from "@supabase/supabase-js";
import * as dotenv from "dotenv";
import {
  backfillWeaponPatchProposals,
  DEFAULT_BACKFILL_LIMIT,
} from "../lib/patch-notes/weaponProposalBackfill";

dotenv.config({ path: ".env.local" });

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

interface CliOptions {
  dryRun: boolean;
  limit: number;
  postIds: number[];
}

function parseArgs(argv: string[]): CliOptions {
  const options: CliOptions = { dryRun: false, limit: DEFAULT_BACKFILL_LIMIT, postIds: [] };

  for (const arg of argv) {
    if (arg === "--dry-run") {
      options.dryRun = true;
      continue;
    }
    if (arg.startsWith("--limit=")) {
      const parsed = Number(arg.slice("--limit=".length));
      if (!Number.isInteger(parsed) || parsed < 1) {
        throw new Error("--limit 은 1 이상의 정수여야 합니다.");
      }
      options.limit = parsed;
      continue;
    }
    if (arg.startsWith("--posts=")) {
      const ids = arg
        .slice("--posts=".length)
        .split(",")
        .map((value) => value.trim())
        .filter(Boolean)
        .map((value) => {
          const parsed = Number(value);
          if (!Number.isInteger(parsed) || parsed < 1) {
            throw new Error(`--posts 값이 올바르지 않습니다: ${value}`);
          }
          return parsed;
        });
      options.postIds = ids;
      continue;
    }
    throw new Error(`알 수 없는 인자입니다: ${arg}`);
  }

  return options;
}

const STATUS_LABELS: Record<string, string> = {
  created: "제안 생성",
  duplicate: "이미 존재",
  no_changes: "변경 없음",
  skipped: "건너뜀",
  source_gone: "원문 삭제",
  failed: "실패",
};

async function main() {
  if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
    throw new Error("NEXT_PUBLIC_SUPABASE_URL 또는 SUPABASE_SERVICE_ROLE_KEY 가 없습니다.");
  }

  const options = parseArgs(process.argv.slice(2));
  const supabaseAdmin = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

  console.log("무기도감 갱신 제안 백필을 시작합니다.");
  console.log(`  모드: ${options.dryRun ? "dry-run (AI 호출 없음)" : "실제 실행"}`);
  console.log(`  처리 상한: ${options.limit}건`);
  if (options.postIds.length > 0) {
    console.log(`  대상 글 ID: ${options.postIds.join(", ")}`);
  }

  const summary = await backfillWeaponPatchProposals({
    supabaseAdmin,
    limit: options.limit,
    postIds: options.postIds,
    dryRun: options.dryRun,
    onProgress: (message) => console.log(`  ${message}`),
  });

  console.log("\n결과 요약");
  console.log(`  패치노트 후보: ${summary.candidates}건`);
  console.log(`  처리 시도: ${summary.processed}건`);
  console.log(
    `  생성 ${summary.created} / 중복 ${summary.duplicate} / 변경없음 ${summary.noChanges} / 건너뜀 ${summary.skipped} / 원문삭제 ${summary.sourceGone} / 실패 ${summary.failed}`
  );

  console.log("\n글별 상세");
  for (const item of summary.results) {
    const label = STATUS_LABELS[item.status] ?? item.status;
    const extra = item.changeCount !== undefined ? ` (변경 ${item.changeCount}건)` : "";
    const reason = item.reason ? ` - ${item.reason}` : "";
    console.log(`  [${item.postId}] ${label}${extra}: ${item.title}${reason}`);
  }

  if (summary.failed > 0) process.exitCode = 1;
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
