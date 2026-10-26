import { Suspense } from "react";
import LolStatusBanner from "@/components/lol/LolStatusBanner";
import LolHeader from "@/components/lol/LolHeader";
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
  return <div className="flex h-full min-h-0 flex-col bg-zinc-950">
    <LolHeader />
    <Suspense fallback={null}><LolStatusBanner /></Suspense>
    <div className="min-h-0 flex-1 overflow-y-auto">{children}</div>
  </div>;
}
