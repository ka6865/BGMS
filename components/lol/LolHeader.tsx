"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

// 공개 LoL 경로(/lol) 전용 헤더. 사이트 공통 헤더(PUBG 메뉴)와 하단 메뉴 대신 쓴다.
// 운영 키 승인 전에는 BGMS 다른 화면에서 LoL로 들어오는 링크를 만들지 않으며, PUBG로 돌아가는 메뉴도 아직 두지 않는다.
// Riot ID 경로(/lol/kr/이름-태그)가 메뉴 이름으로 시작해도 잘못 표시하지 않도록 경로 조각 단위로 비교한다.
const under = (path: string, base: string) => path === base || path.startsWith(`${base}/`);
// 랭크 컷 화면은 "랭킹"으로 통합되어 순위표와 일별 컷을 함께 보여 준다.
const RESERVED_BASES = ["/lol/kr/champions", "/lol/kr/aram-mayhem", "/lol/kr/ladder", "/lol/kr/masters", "/lol/kr/status"];
const NAV = [
  { href: "/lol/kr", label: "전적 검색", masters: false, match: (path: string) => path === "/lol" || path === "/lol/kr"
    || (path.startsWith("/lol/kr/") && !RESERVED_BASES.some(base => under(path, base))) },
  { href: "/lol/kr/champions", label: "챔피언", masters: false, match: (path: string) => under(path, "/lol/kr/champions") },
  { href: "/lol/kr/aram-mayhem", label: "증바람", masters: false, match: (path: string) => under(path, "/lol/kr/aram-mayhem") },
  { href: "/lol/kr/ladder", label: "랭킹", masters: false, match: (path: string) => under(path, "/lol/kr/ladder") },
  { href: "/lol/kr/masters", label: "장인", masters: true, match: (path: string) => under(path, "/lol/kr/masters") },
  { href: "/lol/kr/status", label: "서버 상태", masters: false, match: (path: string) => under(path, "/lol/kr/status") },
] as const;

// 장인 메뉴는 서버가 LOL_MASTERS_PUBLIC을 읽어 넘긴 값으로만 보인다.
export default function LolHeader({ mastersEnabled = false }: { mastersEnabled?: boolean }) {
  const pathname = usePathname() ?? "";
  return (
    <header
      data-testid="lol-header"
      className="safe-top flex min-h-14 w-full shrink-0 flex-wrap items-center gap-x-3 border-b border-amber-500/30 bg-zinc-950 px-4 pt-2 text-zinc-100 sm:flex-nowrap sm:gap-x-6 sm:px-6 sm:pt-0"
    >
      <Link href="/lol/kr" aria-label="BGMS LoL 전적 검색" className="flex shrink-0 items-center gap-1.5">
        <span className="text-[20px] font-black italic uppercase tracking-tighter text-amber-400">
          BG<span className="text-white">MS</span>
        </span>
        <span className="rounded bg-amber-400/15 px-1.5 py-0.5 text-[11px] font-bold text-amber-300 ring-1 ring-amber-400/30">LoL</span>
      </Link>
      <nav aria-label="LoL 메뉴" className="flex w-full min-w-0 items-center gap-0.5 overflow-x-auto sm:w-auto sm:flex-1 sm:gap-1">
        {NAV.filter(item => !item.masters || mastersEnabled).map((item) => {
          const active = item.match(pathname);
          return (
            <Link
              key={item.href}
              href={item.href}
              aria-current={active ? "page" : undefined}
              className={`inline-flex min-h-11 items-center whitespace-nowrap rounded-lg px-2 text-[13px] font-semibold transition sm:px-3 sm:text-sm ${active
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
