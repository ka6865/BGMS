// GTA6 공략은 기존 게시판 posts에 분류로 저장하고 /gta6/guides 화면에서만 따로 보여 준다.
export const GTA6_GUIDE_CATEGORY = "GTA6 공략";

export const GTA6_OG_IMAGE = { url: "/gta6/og.jpg", width: 1200, height: 630, alt: "GTA6 지도 - 레오니다 한국어 장소 검색" };

export function postBasePath(category?: string | null): string {
  return category === GTA6_GUIDE_CATEGORY ? "/gta6/guides" : "/board";
}
