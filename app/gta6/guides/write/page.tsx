import type { Metadata } from "next";
import BoardWriteClient from "@/components/board/BoardWriteClient";
import { GTA6_GUIDE_CATEGORY } from "@/lib/gta6/guides";

export const metadata: Metadata = { title: { absolute: "GTA6 공략 쓰기 | BGMS" }, robots: { index: false } };

export default function Gta6GuideWritePage() {
  return <div className="min-h-0 flex-1 overflow-y-auto"><BoardWriteClient initialCategory={GTA6_GUIDE_CATEGORY} /></div>;
}
