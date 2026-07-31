/**
 * @fileoverview Storage 초기화 스크립트. 되돌릴 수 없는 파괴적 작업입니다.
 *
 * app-data 의 블루존 원본과 telemetry 버킷 객체를 삭제합니다.
 * 삭제된 객체를 복원하는 수단이 없으므로 다음 안전 장치를 둡니다.
 *   - 기본은 dry-run 이며 실제 삭제는 --apply 를 명시해야 수행됩니다.
 *   - --apply 와 함께 --confirm=RESET 를 함께 전달해야 합니다.
 *   - 삭제 오류가 발생하면 성공으로 끝내지 않고 종료 코드를 1로 둡니다.
 *
 * 어떤 워크플로나 애플리케이션 코드도 이 스크립트를 호출하지 않습니다.
 * 운영 데이터를 지우는 용도이므로 수동 실행 전용으로 유지합니다.
 */

import { createClient } from "@supabase/supabase-js";
import dotenv from "dotenv";

dotenv.config({ path: ".env.local" });

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
);

// 실수 실행을 막기 위한 확인 문구. --confirm 값이 이 문자열과 정확히 일치해야 합니다.
const CONFIRM_PHRASE = "RESET";

function parseArgs(argv: readonly string[]): { apply: boolean; confirm: string | null } {
  const apply = argv.includes("--apply");
  const confirmArg = argv.find((arg) => arg.startsWith("--confirm="));
  return { apply, confirm: confirmArg ? confirmArg.slice("--confirm=".length) : null };
}

async function reset() {
  const { apply, confirm } = parseArgs(process.argv.slice(2));

  if (!apply) {
    console.info("[Storage Reset] dry-run 입니다. 아무것도 삭제하지 않았습니다.");
    console.info("[Storage Reset] 실제 삭제: npx tsx scripts/reset_storage.ts --apply --confirm=RESET");
    return;
  }

  if (confirm !== CONFIRM_PHRASE) {
    console.error(`[Storage Reset] 확인 문구가 필요합니다. --confirm=${CONFIRM_PHRASE} 를 함께 전달하세요.`);
    process.exitCode = 1;
    return;
  }

  console.warn("[Storage Reset] 되돌릴 수 없는 삭제를 시작합니다.");
  let hasFailure = false;

  // 1. app-data/bluezone_data.json 삭제
  const { error: err1 } = await supabase.storage
    .from("app-data")
    .remove(["bluezone_data.json"]);
  if (err1) {
    hasFailure = true;
    console.error(`bluezone_data.json 삭제 실패: ${err1.message}`);
  } else {
    console.info("bluezone_data.json 삭제 완료");
  }

  // 2. telemetry 버킷 비우기 (페이지네이션 적용)
  let allDeleted = 0;
  while (true) {
    const { data: files } = await supabase.storage.from("telemetry").list("", { limit: 100 });
    if (!files || files.length === 0) break;

    const names = files.map(f => f.name);
    const { error: err2 } = await supabase.storage.from("telemetry").remove(names);
    if (err2) {
      hasFailure = true;
      console.error(`telemetry 파일 삭제 중 오류: ${err2.message}`);
      break;
    }
    allDeleted += names.length;
    console.info(`telemetry 파일 ${allDeleted}개 삭제 중`);
    if (files.length < 100) break;
  }

  if (hasFailure) {
    console.error(`[Storage Reset] 일부 삭제가 실패했습니다. (삭제 ${allDeleted}개)`);
    process.exitCode = 1;
    return;
  }

  console.info(`[Storage Reset] 정리 완료 (총 ${allDeleted}개 삭제)`);
}

void reset().catch((error: unknown) => {
  const detail = error instanceof Error
    ? `${error.message}${error.stack ? `\n${error.stack}` : ""}`
    : String(error);
  console.error(`[Storage Reset] 실패: ${detail}`);
  process.exitCode = 1;
});
