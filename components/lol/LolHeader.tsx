"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

// 공개 LoL 경로(/lol) 전용 헤더. 사이트 공통 헤더(PUBG 메뉴)와 하단 메뉴 대신 쓴다.
// 운영 키 승인 전에는 BGMS 다른 화면에서 LoL로 들어오는 링크를 만들지 않으며, PUBG로 돌아가는 메뉴도 아직 두지 않는다.
const NAV = [
  { href: "/lol/kr", label: "전적 검색", match: (path: string) => path === "/lol" || path === "/lol/kr"
    || (path.startsWith("/lol/kr/") && !path.startsWith("/lol/kr/ladder") && !path.startsWith("/lol/kr/status")) },
  { href: "/lol/kr/ladder", label: "랭크 컷", match: (path: string) => path.startsWith("/lol/kr/ladder") },
  { href: "/lol/kr/status", label: "서버 상태", match: (path: string) => path.startsWith("/lol/kr/status") },
] as const;

export default function LolHeader() {
  const pathname = usePathname() ?? "";
  return (
    <header
      data-testid="lol-header"
      className="safe-top flex min-h-14 w-full shrink-0 items-center gap-3 border-b border-amber-500/30 bg-zinc-950 px-4 text-zinc-100 sm:gap-6 sm:px-6"
    >
      <Link href="/lol/kr" aria-label="BGMS LoL 전적 검색" className="flex shrink-0 items-center gap-1.5">
        <span className="text-[20px] font-black italic uppercase tracking-tighter text-amber-400">
          BG<span className="text-white">MS</span>
        </span>
        <span className="rounded bg-amber-400/15 px-1.5 py-0.5 text-[11px] font-bold text-amber-300 ring-1 ring-amber-400/30">LoL</span>
      </Link>
      <nav aria-label="LoL 메뉴" className="flex min-w-0 flex-1 items-center justify-end gap-1 sm:justify-start">
        {NAV.map((item) => {
          const active = item.match(pathname);
          return (
            <Link
              key={item.href}
              href={item.href}
              aria-current={active ? "page" : undefined}
              className={`inline-flex min-h-11 items-center whitespace-nowrap rounded-lg px-2.5 text-[13px] font-semibold transition sm:px-3 sm:text-sm ${active
                ? "bg-zinc-800 text-amber-300" : "text-zinc-400 hover:bg-zinc-900 hover:text-zinc-100"}`}
            >
              {item.label}
            </Link>
          );
        })}
      </nav>
    </header>
  );
}
