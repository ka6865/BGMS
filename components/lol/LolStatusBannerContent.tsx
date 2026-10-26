"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import type { LolPlatformStatus } from "@/lib/lol/status";

const STATUS_PATH = "/lol/kr/status";

// 서버 공지는 스크롤 영역 밖에 고정되므로 한 줄로 접어 두고, 같은 내용을 보여 주는 상태 페이지에서는 숨긴다.
export default function LolStatusBannerContent({ status, admin = false }: { status: LolPlatformStatus; admin?: boolean }) {
  const pathname = usePathname();
  if (!status.items.length || pathname === STATUS_PATH) return null;
  const [first] = status.items;
  const kind = (item: LolPlatformStatus["items"][number]) => item.kind === "maintenance" ? "점검" : "장애";
  return <aside aria-label="LoL 서버 상태 알림" role="status" className="w-full shrink-0 border-b border-amber-900 bg-amber-950/40 text-sm text-amber-200">
    <details className="group px-4">
      <summary className="flex min-h-11 cursor-pointer list-none items-center gap-2 [&::-webkit-details-marker]:hidden">
        <span className="shrink-0 font-semibold">{status.stale ? "마지막 확인 공지" : "서버 공지"} {status.items.length}건</span>
        <span className="min-w-0 flex-1 truncate text-amber-100/80 group-open:hidden">{kind(first)} · {first.title}</span>
        <span aria-hidden="true" className="ml-auto shrink-0 text-xs text-amber-300 group-open:rotate-180">▾</span>
      </summary>
      <div className="break-words pb-3">
        <p className="text-xs text-amber-300/80">{status.stale ? "마지막 확인 시점의 서버 공지" : "LoL 한국 서버 공지"}</p>
        <ul className="mt-1 space-y-1">{status.items.map(item => <li key={`${item.kind}:${item.id}`}>
          {kind(item)} · {item.title}
        </li>)}</ul>
        {!admin && <Link href={STATUS_PATH} className="mt-1 inline-flex min-h-11 items-center underline">서버 상태 자세히 보기</Link>}
      </div>
    </details>
  </aside>;
}
