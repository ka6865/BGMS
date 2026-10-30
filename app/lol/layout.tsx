import { Suspense } from "react";
import LolStatusBanner from "@/components/lol/LolStatusBanner";
import LolHeader from "@/components/lol/LolHeader";
import LolFooter from "@/components/lol/LolFooter";
import type { Metadata } from "next";
import { requireLolPublicPage } from "@/lib/lol/publicAccess.server";
import { lolMastersPublic } from "@/lib/lol/ranking";

export const dynamic = "force-dynamic";
export const metadata: Metadata = {
  title: { absolute: "BGMS | LoL 전적 검색" },
  description: "한국 서버 LoL 전적을 조회합니다.",
  robots: { index: false, follow: false },
};

export default function LolPublicLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  requireLolPublicPage();
  // 내용이 짧은 페이지(빈 검색·서버 상태·404)에서도 LoL 푸터가 화면 아래에 붙도록 본문을 늘린다.
  return <div className="flex h-full min-h-0 flex-1 flex-col bg-zinc-950">
    <LolHeader mastersEnabled={lolMastersPublic()} />
    <Suspense fallback={null}><LolStatusBanner /></Suspense>
    <div className="flex min-h-0 flex-1 flex-col overflow-y-auto">
      <div className="flex-1">{children}</div>
      <LolFooter />
    </div>
  </div>;
}
