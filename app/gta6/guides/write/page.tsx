import { Suspense } from "react";
import type { Metadata } from "next";
import BoardWriteClient from "@/components/board/BoardWriteClient";
import { GTA6_GUIDE_CATEGORY } from "@/lib/gta6/guides";

export const metadata: Metadata = { title: { absolute: "GTA6 공략 쓰기 | BGMS" }, robots: { index: false } };

// 글쓰기 화면이 useSearchParams로 수정 대상을 읽어 정적 생성 시 Suspense 경계가 필요하다.
export default function Gta6GuideWritePage() {
  return <div className="min-h-0 flex-1 overflow-y-auto"><Suspense><BoardWriteClient initialCategory={GTA6_GUIDE_CATEGORY} /></Suspense></div>;
}
