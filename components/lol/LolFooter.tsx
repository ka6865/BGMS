import Link from "next/link";
import { LOL_LEGAL_ENGLISH, LOL_LEGAL_KOREAN } from "./LolLegalNotice";

// 공개 LoL 경로(/lol) 전용 푸터. 사이트 공통 푸터(PUBG 고지·PUBG 메뉴 링크) 대신 쓴다.
// Riot이 요구하는 법적 고지, 심사 때 확인하는 개인정보처리방침·이용약관, 삭제 요청 경로인 고객센터만 둔다.
const LINKS = [
  { href: "/privacy", label: "개인정보처리방침" },
  { href: "/terms", label: "이용약관" },
  { href: "/support", label: "고객센터" },
] as const;

export default function LolFooter() {
  return (
    <footer data-testid="lol-footer" className="mt-8 border-t border-zinc-800 bg-zinc-950 px-4 py-6 text-xs text-zinc-400 sm:px-6">
      <div className="mx-auto w-full max-w-7xl space-y-4">
        <div className="flex flex-wrap items-center justify-between gap-x-6 gap-y-2">
          <span className="text-base font-black italic uppercase tracking-tighter text-amber-400">
            BG<span className="text-white">MS</span>
            <span className="ml-1.5 align-middle text-[11px] font-bold not-italic normal-case tracking-normal text-amber-300">LoL</span>
          </span>
          <nav aria-label="LoL 사이트 정보" className="flex flex-wrap items-center gap-x-1">
            {LINKS.map((link) => (
              <Link key={link.href} href={link.href} className="inline-flex min-h-11 items-center px-2 font-semibold text-zinc-300 hover:text-white">
                {link.label}
              </Link>
            ))}
          </nav>
        </div>
        <section aria-label="Riot Games 법적 고지" className="space-y-2 leading-relaxed">
          <p lang="en">{LOL_LEGAL_ENGLISH}</p>
          <p>{LOL_LEGAL_KOREAN}</p>
        </section>
        <p className="text-zinc-600">© {new Date().getFullYear()} BGMS</p>
      </div>
    </footer>
  );
}
