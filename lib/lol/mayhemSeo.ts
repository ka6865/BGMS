import type { Metadata } from "next";

export const MAYHEM_PATH = "/lol/kr/aram-mayhem";
export const mayhemChampionPath = (imageId: string) => `${MAYHEM_PATH}/champions/${imageId.toLowerCase()}`;
export const mayhemTipPath = (id: number) => `${MAYHEM_PATH}/tips/${id}`;

// LoL 레이아웃은 검색 제외가 기본이라 증바람 페이지는 robots·공유 정보를 직접 덮어쓴다.
export function mayhemMetadata(title: string, description: string, path: string, index = true): Metadata {
  return {
    title: { absolute: title }, description, alternates: { canonical: path }, robots: { index, follow: true },
    openGraph: { title, description, url: path, siteName: "BGMS", locale: "ko_KR", type: "website", images: [{ url: "/logo.png", width: 1200, height: 630, alt: "BGMS 로고" }] },
    twitter: { card: "summary_large_image", title, description, images: ["/logo.png"] },
  };
}
