/**
 * @fileoverview 배그 소식 기사 분류 헬퍼입니다.
 *
 * 기존에 scripts/sync_patch_notes.ts, app/api/cron/patch-notes/route.ts,
 * app/api/admin/patch-notes/sync/route.ts 세 곳에 같은 로직이 복제되어 있었습니다.
 * 무기도감 추출기가 PATCH_NOTE 기사만 대상으로 하므로 공용 모듈로 분리했습니다.
 */

export type PatchNoteCategory = "PATCH_NOTE" | "STORE_INFO" | "DEV_LETTER" | "GENERAL";

export function identifyCategory(title: string, url: string): PatchNoteCategory {
  const normalizedTitle = title.toLowerCase();
  const normalizedUrl = url.toLowerCase();

  if (
    normalizedTitle.includes("상점") ||
    normalizedTitle.includes("shop") ||
    normalizedTitle.includes("store") ||
    normalizedTitle.includes("아이템") ||
    normalizedTitle.includes("에디션") ||
    normalizedTitle.includes("세일")
  ) {
    return "STORE_INFO";
  }
  if (
    normalizedTitle.includes("개발자") ||
    normalizedTitle.includes("개발일지") ||
    normalizedTitle.includes("개발 일지") ||
    normalizedTitle.includes("dev") ||
    normalizedUrl.includes("dev")
  ) {
    return "DEV_LETTER";
  }
  if (
    normalizedTitle.includes("패치노트") ||
    normalizedTitle.includes("패치 노트") ||
    // 카카오 게시판의 무점검 패치 공지도 무기 수치 변경을 포함한다.
    // 제목에 "패치노트" 표기가 없어 기존 조건으로는 GENERAL 로 분류되었다.
    normalizedTitle.includes("무점검 패치") ||
    normalizedTitle.includes("무점검패치") ||
    normalizedUrl.includes("patch")
  ) {
    return "PATCH_NOTE";
  }
  return "GENERAL";
}

/**
 * 무기 스탯 추출을 시도할 기사인지 판정합니다.
 * 상점 안내나 개발일지에는 적용 가능한 수치 변경이 없어 AI 호출 비용만 발생합니다.
 */
export function shouldExtractWeaponChanges(category: PatchNoteCategory): boolean {
  return category === "PATCH_NOTE";
}
