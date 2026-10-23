import type { Metadata } from "next";
import { requireLolPublicPage } from "@/lib/lol/publicAccess.server";

export const dynamic = "force-dynamic";
export const metadata: Metadata = {
  title: { absolute: "BGMS | LoL 전적 검색" },
  description: "한국 서버 LoL 전적을 조회합니다.",
  robots: { index: false, follow: false },
};

export default function LolPublicLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  requireLolPublicPage();
  return children;
}
