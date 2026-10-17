import { readFileSync } from "node:fs";
import { BOARD_COMMENT_PUBLIC_FIELDS, BOARD_POST_PUBLIC_FIELDS } from "@/lib/board/publicFields";

// 공개 키로 읽는 게시판 조회는 IP 원문 대신 DB에서 가린 ip_masked만 가져온다.
describe("게시판 공개 조회 칸", () => {
  it("글·댓글 공개 칸은 ip_masked를 ip_address 이름으로 읽고 원문·비밀번호 해시를 읽지 않는다", () => {
    for (const fields of [BOARD_POST_PUBLIC_FIELDS, BOARD_COMMENT_PUBLIC_FIELDS]) {
      const columns = fields.split(",").map(field => field.trim());
      expect(columns).toContain("ip_address:ip_masked");
      expect(columns).not.toContain("ip_address");
      expect(columns).not.toContain("password_hash");
    }
  });

  it("게시판 목록 페이지도 가린 IP만 조회한다", () => {
    const source = readFileSync("app/board/page.tsx", "utf8");
    expect(source).toContain("ip_address:ip_masked");
    expect(source).not.toMatch(/parent_id, ip_address,/);
    // 칸 단위 권한만으로는 comments(count) 집계가 권한 오류를 낸다.
    expect(source).not.toContain("comments(count)");
  });

  it("본인 프로필 전체 조회는 get_my_profile을 쓰고 profiles 전체 칸을 직접 읽지 않는다", () => {
    for (const file of [
      "app/mypage/page.tsx",
      "components/mypage/MyPage.tsx",
      "components/common/GlobalHeader.tsx",
      "hooks/useMapData.ts",
      "hooks/useStatsProfilePrefill.ts",
    ]) {
      const source = readFileSync(file, "utf8");
      expect({ file, usesRpc: source.includes("get_my_profile") }).toEqual({ file, usesRpc: true });
      expect(source).not.toMatch(/from\(\s*["']profiles["']\s*\)\s*\.select\(\s*["']\*["']/);
    }
  });
});
