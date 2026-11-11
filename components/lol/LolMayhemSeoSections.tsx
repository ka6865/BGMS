import Link from "next/link";
import type { LolChampion } from "@/lib/lol/champions";
import type { MayhemTip } from "@/lib/lol/mayhemTips";
import { mayhemChampionPath, mayhemTipPath } from "@/lib/lol/mayhemSeo";

// 검색 수집기가 스크립트 없이도 챔피언별 페이지와 제보 글을 따라갈 수 있게 서버에서 링크를 그린다.
export function LolMayhemChampionLinks({ champions }: { champions: LolChampion[] }) {
  if (!champions.length) return null;
  const sorted = [...champions].sort((a, b) => a.name.localeCompare(b.name, "ko"));
  return <details className="mt-8 rounded-lg border border-zinc-800 px-3">
    <summary className="min-h-11 cursor-pointer content-center text-sm font-semibold text-zinc-300">챔피언별 증바람 증강 페이지</summary>
    <nav aria-label="챔피언별 증바람 증강" className="flex flex-wrap gap-x-3 gap-y-1 pb-3 text-sm text-zinc-400">
      {sorted.map(champion => <Link key={champion.id} href={mayhemChampionPath(champion.imageId)} className="inline-flex min-h-8 items-center hover:text-amber-300">{champion.name}</Link>)}
    </nav>
  </details>;
}

export function LolMayhemTipLinks({ heading, tips }: { heading: string; tips: MayhemTip[] }) {
  if (!tips.length) return null;
  return <section className="mt-8">
    <h2 className="text-base font-semibold">{heading}</h2>
    <ul className="mt-2 space-y-1 text-sm">{tips.map(tip => <li key={tip.id}>
      <Link href={mayhemTipPath(tip.id)} className="inline-flex min-h-11 items-center gap-2 text-zinc-300 hover:text-amber-300">
        {tip.kind === "question" && <span className="rounded bg-sky-400/15 px-1.5 text-[11px] font-bold text-sky-300">질문</span>}{tip.summary}
        <span className="text-xs text-zinc-500">추천 {tip.up} · {tip.kind === "question" ? "답변" : "댓글"} {tip.comments}</span>
      </Link>
    </li>)}</ul>
  </section>;
}
