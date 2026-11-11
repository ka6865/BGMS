import type { Metadata } from "next";
import Link from "next/link";
import { cache } from "react";
import { notFound } from "next/navigation";
import { requireLolPublicPage } from "@/lib/lol/publicAccess.server";
import { getCachedLolAugmentCatalog } from "@/lib/lol/augments/catalog.server";
import { getLolChampions } from "@/lib/lol/champions.server";
import { getMayhemTip, getMayhemTipItems, listMayhemTipComments } from "@/lib/lol/mayhemTips.server";
import { MAYHEM_PATH, mayhemChampionPath, mayhemMetadata, mayhemTipPath } from "@/lib/lol/mayhemSeo";
import { AugmentIcon } from "@/components/lol/LolMayhemArchive";
import { ChampionPortrait } from "@/components/lol/LolMayhemChampionStats";

type Props = { params: Promise<{ id: string }> };

// 메타데이터와 본문이 같은 글을 한 번만 읽는다.
const loadTip = cache(async (rawId: string) => {
  if (process.env.LOL_MAYHEM_TIPS_ENABLED !== "true" || !/^[1-9][0-9]{0,15}$/.test(rawId) || !Number.isSafeInteger(Number(rawId))) return null;
  const [found, champions] = await Promise.all([getMayhemTip(Number(rawId)), getLolChampions().catch(() => null)]);
  if (!found) return null;
  return { ...found, champion: champions?.champions.find(c => c.id === found.tip.championId) ?? null, version: champions?.version ?? null };
});

const excerpt = (text: string) => text.replace(/\s+/g, " ").trim().slice(0, 140);

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  requireLolPublicPage();
  const found = await loadTip((await params).id);
  if (!found) return { title: { absolute: "BGMS LoL 증바람" }, robots: { index: false, follow: false } };
  const { tip, champion } = found, question = tip.kind === "question";
  const subject = champion ? `${champion.name} 증바람` : "증바람 공용";
  return mayhemMetadata(`${tip.summary} - ${subject} ${question ? "질문" : "조합"} | BGMS LoL`,
    excerpt(tip.usage) || `${subject} ${question ? "질문" : "증강 조합 제보"}: ${tip.summary}`,
    mayhemTipPath(tip.id), !question || tip.comments > 0);
}

export default async function LolMayhemTipPage({ params }: Props) {
  requireLolPublicPage();
  const found = await loadTip((await params).id);
  if (!found) notFound();
  const { tip, patch, champion, version } = found, question = tip.kind === "question";
  // 글이 올라온 패치 도감을 먼저 쓰고, 없으면 현재 도감에서 이름을 찾는다.
  const [catalog, comments, items] = await Promise.all([
    getCachedLolAugmentCatalog(patch).then(found => found ?? getCachedLolAugmentCatalog(null)).catch(() => null),
    listMayhemTipComments(tip.id, null).catch(() => null),
    version && tip.itemIds.length ? getMayhemTipItems(version).catch(() => []) : [],
  ]);
  const augments = new Map(catalog?.view.augments.map(a => [a.id, a]));
  const itemNames = new Map(items.map(i => [i.id, i.name]));
  const author = tip.anonymous ? "익명" : tip.author ?? "BGMS 유저";
  const date = (value: string) => new Date(value).toLocaleDateString("ko-KR", { timeZone: "Asia/Seoul" });
  const visible = (comments ?? []).filter(c => !c.deleted);
  const jsonLd = {
    "@context": "https://schema.org", "@type": "DiscussionForumPosting", headline: tip.summary, text: tip.usage || tip.summary, url: mayhemTipPath(tip.id),
    datePublished: tip.createdAt, ...(tip.updatedAt ? { dateModified: tip.updatedAt } : {}), author: { "@type": "Person", name: author },
    interactionStatistic: [{ "@type": "InteractionCounter", interactionType: "https://schema.org/LikeAction", userInteractionCount: tip.up },
      { "@type": "InteractionCounter", interactionType: "https://schema.org/CommentAction", userInteractionCount: tip.comments }],
    comment: visible.map(c => ({ "@type": "Comment", text: c.body, datePublished: c.createdAt, author: { "@type": "Person", name: c.anonymous ? "익명" : c.author ?? "BGMS 유저" } })),
  };
  return <main className="mx-auto w-full max-w-3xl px-4 py-6 text-zinc-100 sm:px-6">
    {/* 사용자 글이 들어가므로 </script> 탈출을 막는다. */}
    <script type="application/ld+json" dangerouslySetInnerHTML={{ __html: JSON.stringify(jsonLd).replace(/</g, "\\u003c") }} />
    <nav aria-label="이동 경로" className="text-sm text-zinc-400">
      <Link href={MAYHEM_PATH} className="hover:text-amber-300">증바람 증강</Link>
      {champion && <> · <Link href={mayhemChampionPath(champion.imageId)} className="hover:text-amber-300">{champion.name}</Link></>}
    </nav>
    <article className="mt-4 rounded-xl border border-zinc-800 bg-zinc-900/70 p-4">
      <header className="flex items-center gap-3">
        {champion ? <ChampionPortrait champion={champion} version={version} size={48} /> : <span className="inline-flex size-12 shrink-0 items-center justify-center rounded-lg bg-zinc-800 text-xs font-bold text-zinc-300">공용</span>}
        <div className="min-w-0">
          <h1 className="break-words text-lg font-bold">{question && <span className="mr-1.5 rounded bg-sky-400/15 px-1.5 align-[2px] text-xs font-bold text-sky-300">질문</span>}{tip.summary}</h1>
          <p className="text-xs text-zinc-400">{champion?.name ?? "공용 조합"} · {author} · {date(tip.createdAt)}{tip.updatedAt && " · 수정됨"} · 추천 {tip.up}</p>
        </div>
      </header>
      {tip.augmentIds.length > 0 && <ol aria-label="증강" className="mt-4 flex flex-wrap gap-1.5">{tip.augmentIds.map(id => { const a = augments.get(id); return <li key={id} className="flex items-center gap-2 rounded-lg bg-zinc-950/60 py-1 pl-1 pr-2.5 text-[13px]">
        {catalog && <AugmentIcon icon={a?.icon} patch={catalog.view.clientPatch} rarity={a?.rarity} size={28} />}{a?.name ?? `증강 ${id}`}
      </li>; })}</ol>}
      {tip.itemIds.length > 0 && <p className="mt-3 text-sm text-zinc-300">아이템: {tip.itemIds.map(id => itemNames.get(id) ?? `아이템 ${id}`).join(" → ")}</p>}
      {tip.usage && <p className="mt-3 whitespace-pre-line break-words text-sm leading-6 text-zinc-300">{tip.usage}</p>}
    </article>
    <section className="mt-6">
      <h2 className="text-base font-semibold">{question ? "답변" : "댓글"} {visible.length}</h2>
      {comments === null ? <p role="alert" className="mt-2 text-sm text-zinc-400">{question ? "답변을" : "댓글을"} 불러오지 못했습니다.</p>
        : visible.length === 0 ? <p className="mt-2 text-sm text-zinc-400">아직 {question ? "답변이" : "댓글이"} 없습니다.</p>
        : <ul className="mt-2 space-y-2">{visible.map(c => <li key={c.id} className={`rounded-lg bg-zinc-900 p-3 text-sm ${c.parentId ? "ml-6" : ""}`}>
          <p className="text-xs text-zinc-400">{c.anonymous ? "익명" : c.author ?? "BGMS 유저"}{c.byTipAuthor && " (글쓴이)"} · {date(c.createdAt)}</p>
          <p className="mt-1 whitespace-pre-line break-words leading-6 text-zinc-200">{c.body}</p>
        </li>)}</ul>}
    </section>
    <Link href={`${MAYHEM_PATH}?view=tips`} className="mt-6 inline-flex min-h-11 items-center rounded-lg border border-zinc-700 px-3 text-sm hover:bg-zinc-800">추천·{question ? "답변" : "댓글"}은 유저 조합 제보에서 남기기</Link>
  </main>;
}
