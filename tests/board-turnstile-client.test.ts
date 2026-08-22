import { existsSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const detailSource = readFileSync(
  new URL("../components/board/BoardDetailClient.tsx", import.meta.url),
  "utf8",
);
const writeSource = readFileSync(
  new URL("../components/board/BoardWriteClient.tsx", import.meta.url),
  "utf8",
);
const commentSectionSource = readFileSync(
  new URL("../components/CommentSection.tsx", import.meta.url),
  "utf8",
);
const sessionVerificationFlag = ["turnstile", "verified"].join("_");
const standaloneVerifyRoute = ["/api/board", "turnstile"].join("/");
const obsoleteCaptchaState = ["captcha", "Verified"].join("");
const obsoletePendingState = ["captcha", "PendingAction"].join("");

describe("게시판 Turnstile client 저장 경계", () => {
  it("댓글에서 세션 사전인증과 회원 direct insert를 제거한다", () => {
    expect(detailSource).not.toContain(sessionVerificationFlag);
    expect(detailSource).not.toContain(obsoleteCaptchaState);
    expect(detailSource).not.toContain(obsoletePendingState);
    expect(detailSource).not.toMatch(/supabase\.from\(["']comments["']\)\.insert/);
  });

  it("회원·guest 댓글은 공용 route를 사용하고 guest token을 실제 payload에 전달한다", () => {
    expect(detailSource).toContain('fetch("/api/board/comments"');
    expect(detailSource).toContain("turnstileToken: user ? null : verifiedToken");
    expect(detailSource).toContain("void handleSaveComment(token)");
    expect(detailSource).toContain("TURNSTILE_ACTIONS.comment");
    expect(writeSource).toContain("TURNSTILE_ACTIONS.post");
  });

  it("독립 Turnstile 사전 검증 route를 제거한다", () => {
    const routeFile = ["../app/api/board", "turnstile", "route.ts"].join("/");
    expect(existsSync(new URL(routeFile, import.meta.url))).toBe(false);
    expect(detailSource).not.toContain(standaloneVerifyRoute);
  });

  it("댓글 모달은 guest_comment action과 일회성 안내를 사용한다", () => {
    expect(detailSource).toContain('action={TURNSTILE_ACTIONS.comment}');
    expect(detailSource).toContain("비회원 댓글을 등록하려면 보안 인증을 완료해주세요.");
    expect(detailSource).not.toContain("같은 탭");
    expect(detailSource).not.toContain("한 번만 인증");
  });

  it("새로고침 후에도 서버에 저장된 대댓글 content를 그대로 렌더링한다", () => {
    const hasValidContentRender = commentSectionSource.includes("{renderCommentContent(c.content)}") || commentSectionSource.includes("{c.content}");
    expect(hasValidContentRender).toBe(true);
    expect(detailSource).not.toContain("finalComment");
  });
});
