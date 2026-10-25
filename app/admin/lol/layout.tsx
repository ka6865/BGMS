import { Suspense } from "react";
import LolStatusBanner from "@/components/lol/LolStatusBanner";
import type { Metadata } from "next";
import { requireLolDevPageAdmin } from "@/lib/lol/access.server";

export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: { absolute: "LoL 비공개 개발" },
  robots: { index: false, follow: false },
};

export default async function LolDevLayout({
  children,
}: Readonly<{ children: React.ReactNode }>): Promise<React.ReactNode> {
  await requireLolDevPageAdmin();
  return <div className="flex h-full min-h-0 flex-col bg-zinc-950">
    <nav aria-label="LoL 관리자 메뉴" className="flex shrink-0 flex-wrap gap-4 border-b border-zinc-800 px-4 py-2 text-sm text-zinc-300">
      <Suspense fallback={null}><LolStatusBanner admin /></Suspense>
      <a href="/admin/lol" className="py-2 hover:text-white">전적 개발</a>
      <a href="/admin/lol/augments" className="py-2 hover:text-white">증강 수집·검토</a>
    </nav>
    <div className="min-h-0 flex-1 overflow-y-auto">{children}</div>
  </div>;
}
