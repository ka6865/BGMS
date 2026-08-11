import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  buildPendingMarkerReviewUrl,
  formatContributorNames,
} from "@/lib/admin/pendingMarkerReview";

const reviewSource = readFileSync(resolve("app/admin/review/page.tsx"), "utf8");
const reportsRouteSource = readFileSync(resolve("app/api/admin/reports/route.ts"), "utf8");
const dashboardSource = readFileSync(resolve("app/admin/dashboard/page.tsx"), "utf8");

describe("관리자 제보 심사 진입", () => {
  it("제보 UUID를 단건 심사 URL로 안전하게 만든다", () => {
    expect(buildPendingMarkerReviewUrl("2c7d/marker?id=1")).toBe(
      "/admin/review?id=2c7d%2Fmarker%3Fid%3D1",
    );
  });

  it("작성자 UUID를 닉네임으로 표시하고 누락된 프로필은 숨기지 않는다", () => {
    expect(
      formatContributorNames(
        ["user-a", "user-b", "user-missing"],
        new Map([
          ["user-a", "첫 제보자"],
          ["user-b", "두 번째 제보자"],
        ]),
      ),
    ).toBe("첫 제보자, 두 번째 제보자, 알 수 없음");
  });
});

describe("관리자 제보 목록/작성자 연결 계약", () => {
  it("ID 없는 진입은 목록을 보여주고 목록 행에서 ID가 있는 심사 URL로 이동한다", () => {
    expect(reviewSource).toContain('from("pending_markers")');
    expect(reviewSource).toContain("pendingMarkers.map");
    expect(reviewSource).toContain("buildPendingMarkerReviewUrl");
    expect(reviewSource).toContain('from("profiles")');
    expect(reviewSource).toContain("contributor_ids");
  });

  it("게시판 신고도 로그인 제보자의 닉네임과 게스트 상태를 함께 반환한다", () => {
    expect(reportsRouteSource).toContain("reporter_nickname");
    expect(reportsRouteSource).toContain('from("profiles")');
    expect(dashboardSource).toContain("report.reporter_nickname");
  });
});
