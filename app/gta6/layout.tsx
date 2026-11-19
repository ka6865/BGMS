import Link from "next/link";
import { ArrowLeft } from "lucide-react";
import type { Metadata } from "next";
import { GTA6_OG_IMAGE } from "@/lib/gta6/guides";
import manifest from "@/public/gta6/manifest.json";

export const metadata: Metadata = {
  title: { absolute: "GTA6 지도 · 장소 검색 | BGMS" },
  description: "레오니다와 바이스 시티를 탐색하는 GTA6 커뮤니티 지도. 한국어 장소 검색, 카테고리 필터, 즐겨찾기와 방문 체크를 지원합니다. 추정 위치가 포함됩니다.",
  alternates: { canonical: "/gta6" },
  openGraph: {
    title: "GTA6 지도 · 레오니다 한국어 장소 검색 | BGMS",
    description: `바이스 시티와 레오니다 주 ${manifest.locatedCount.toLocaleString("ko-KR")}곳을 한국어로 검색하는 GTA6 커뮤니티 지도와 공략 게시판.`,
    url: "/gta6", type: "website", images: [GTA6_OG_IMAGE],
  },
  twitter: { card: "summary_large_image", title: "GTA6 지도 · 레오니다 한국어 장소 검색 | BGMS", images: [GTA6_OG_IMAGE.url] },
};

export default function Gta6Layout({ children }: { children: React.ReactNode }) {
  return <div className="flex h-dvh min-h-0 flex-col overflow-hidden bg-zinc-950 text-zinc-100 selection:bg-amber-300 selection:text-zinc-950">
    <header className="safe-top flex min-h-14 shrink-0 items-center justify-between gap-3 border-b border-white/10 px-4 sm:px-6">
      <Link href="/gta6" aria-label="BGMS GTA6 지도" className="inline-flex min-h-11 items-center gap-3 rounded focus-visible:outline-2 focus-visible:outline-amber-300">
        <span className="text-lg font-black italic tracking-tight text-amber-300">BG<span className="text-white">MS</span></span>
        <span className="border-l border-white/20 pl-3 text-sm font-semibold">GTA VI</span>
      </Link>
      <nav aria-label="GTA6 메뉴" className="flex items-center gap-1">
        <Link href="/gta6" className="inline-flex min-h-11 items-center rounded px-2 text-xs font-semibold text-zinc-200 hover:text-white focus-visible:outline-2 focus-visible:outline-amber-300">지도</Link>
        <Link href="/gta6/guides"className="inline-flex min-h-11 items-center rounded px-2 text-xs font-semibold text-zinc-200 hover:text-white focus-visible:outline-2 focus-visible:outline-amber-300">공략 게시판</Link>
        <Link href="/" className="inline-flex min-h-11 items-center gap-1.5 rounded px-2 text-xs font-medium text-zinc-300 hover:text-white focus-visible:outline-2 focus-visible:outline-amber-300"><ArrowLeft size={15} aria-hidden />BGMS 홈</Link>
      </nav>
    </header>
    {children}
  </div>;
}
