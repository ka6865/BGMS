import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const detailSource = readFileSync(
  resolve("components/board/BoardDetailClient.tsx"),
  "utf8",
);
const commentSectionSource = readFileSync(
  resolve("components/CommentSection.tsx"),
  "utf8",
);

describe("게시판 중복 제출 방어: 댓글 등록", () => {
  it("진행 상태를 관리하는 state 가 존재한다", () => {
    expect(detailSource).toContain("isSubmittingComment");
    expect(detailSource).toMatch(/const \[isSubmittingComment, setIsSubmittingComment\] = useState\(false\)/);
  });

  it("진행 중이면 핸들러 진입을 차단한다", () => {
    expect(detailSource).toMatch(/handleSaveComment = async[\s\S]{0,200}?if \(isSubmittingComment\) return;/);
  });

  it("요청 종료 시 finally 로 상태를 해제한다", () => {
    expect(detailSource).toMatch(/finally \{\s*setIsSubmittingComment\(false\);/);
  });

  it("등록 버튼에 진행 상태를 전달한다", () => {
    expect(detailSource).toContain("isSubmitting={isSubmittingComment}");
  });

  it("등록 버튼이 진행 중 비활성화된다", () => {
    expect(commentSectionSource).toContain("disabled={isSubmitting}");
    expect(commentSectionSource).toContain("disabled:cursor-not-allowed");
  });

  it("기존 사용처가 깨지지 않도록 진행 상태 prop 은 옵셔널이다", () => {
    expect(commentSectionSource).toMatch(/isSubmitting\?: boolean;/);
    expect(commentSectionSource).toMatch(/isSubmitting = false,/);
  });
});

describe("게시판 중복 제출 방어: 게시글 추천", () => {
  it("진행 상태를 관리하는 state 가 존재한다", () => {
    expect(detailSource).toMatch(/const \[isLikingPost, setIsLikingPost\] = useState\(false\)/);
  });

  it("진행 중이면 핸들러 진입을 차단한다", () => {
    expect(detailSource).toMatch(/handleLikePost = async[\s\S]{0,200}?if \(isLikingPost\) return;/);
  });

  it("추천 기록 삽입 실패 시 카운트를 올리지 않는다", () => {
    // 동시 클릭으로 unique 제약 위반이 발생하면 증가 RPC 로 진행하지 않아야 한다.
    expect(detailSource).toMatch(/insertError[\s\S]{0,160}?return;/);
    const insertIndex = detailSource.indexOf("insertError");
    const incrementIndex = detailSource.indexOf("increment_likes");
    expect(insertIndex).toBeGreaterThan(0);
    expect(incrementIndex).toBeGreaterThan(insertIndex);
  });

  it("증가 RPC 실패 시 화면 카운트를 올리지 않는다", () => {
    expect(detailSource).toContain("incrementError");
    const errorIndex = detailSource.indexOf("incrementError");
    const setPostIndex = detailSource.indexOf("likes: prev.likes + 1");
    expect(errorIndex).toBeGreaterThan(0);
    expect(setPostIndex).toBeGreaterThan(errorIndex);
  });

  it("요청 종료 시 finally 로 상태를 해제한다", () => {
    expect(detailSource).toMatch(/finally \{\s*setIsLikingPost\(false\);/);
  });

  it("추천 버튼이 진행 중 비활성화된다", () => {
    expect(detailSource).toContain("disabled={isLikingPost}");
  });

  it("중복 조회에 single 대신 maybeSingle 을 사용한다", () => {
    // single 은 결과가 없을 때 오류를 발생시켜 정상 흐름을 방해한다.
    expect(detailSource).toMatch(/post_likes[\s\S]{0,200}?maybeSingle\(\)/);
  });
});

describe("Storage 초기화 스크립트 안전 장치", () => {
  const resetSource = readFileSync(resolve("scripts/reset_storage.ts"), "utf8");

  it("기본은 dry-run 이며 --apply 가 필요하다", () => {
    expect(resetSource).toContain("--apply");
    expect(resetSource).toContain("dry-run");
  });

  it("확인 문구를 요구한다", () => {
    expect(resetSource).toContain("CONFIRM_PHRASE");
    expect(resetSource).toContain("--confirm=");
  });

  it("삭제 실패를 성공으로 끝내지 않는다", () => {
    expect(resetSource).toContain("hasFailure");
    expect(resetSource).toContain("process.exitCode = 1");
  });
});
