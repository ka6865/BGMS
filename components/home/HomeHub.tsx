import Link from "next/link";
import { createClient } from "@/utils/supabase/server";
import { getLatestMayhemPublication } from "@/lib/lol/mayhemDatasetStore.server";
import { lolRiotDataPublic } from "@/lib/lol/previewAccess";
import { LOL_LEGAL_ENGLISH } from "@/components/lol/LolLegalNotice";
import HomeStatsSearch from "./HomeStatsSearch";

type NewsItem = { href: string; label: string; title: string; at: string };

const PUBG_LINKS = [
  { href: "/maps/erangel", label: "지도" },
  { href: "/stats", label: "AI 전적" },
  { href: "/rankings", label: "랭킹" },
  { href: "/weapons", label: "무기 도감" },
  { href: "/backpack", label: "가방 계산기" },
  { href: "/board", label: "커뮤니티" },
];
const LOL_LOCKED_LINKS = [
  { href: "/lol/kr", label: "전적 검색" },
  { href: "/lol/kr/champions", label: "챔피언" },
  { href: "/lol/kr/ladder", label: "랭킹" },
];

const NEWS_LIMIT = 6;
const NOTICE_DAYS = 30;

// 소식은 부가 정보라 출처별로 실패해도 나머지 홈은 그대로 보여 준다.
// 최근 30일 공지(최대 3개)와 증바람 갱신을 먼저 담고, 남은 자리를 최신 게시글로 채운 뒤 날짜순으로 정렬한다.
async function getNews(): Promise<NewsItem[]> {
  const since = new Date(Date.now() - NOTICE_DAYS * 86_400_000).toISOString();
  const recentPosts = async (notice: boolean) => {
    const query = (await createClient()).from("posts").select("id, title, category, created_at")
      .eq("status", "published").eq("is_notice", notice);
    return (notice ? query.gte("created_at", since) : query).order("created_at", { ascending: false }).limit(notice ? 3 : NEWS_LIMIT);
  };
  const [notices, latest, mayhem] = await Promise.allSettled([recentPosts(true), recentPosts(false), getLatestMayhemPublication()]);
  const items: NewsItem[] = [];
  if (notices.status === "fulfilled" && !notices.value.error) {
    for (const post of notices.value.data ?? []) items.push({ href: `/board/${post.id}`, label: "공지", title: post.title, at: post.created_at });
  }
  if (mayhem.status === "fulfilled" && mayhem.value) {
    items.push({ href: "/lol/kr/aram-mayhem", label: "LoL", title: `증바람 ${mayhem.value.patch.replace(/^16\./, "26.")} 조합·증강 자료 갱신`, at: mayhem.value.publishedAt });
  }
  if (latest.status === "fulfilled" && !latest.value.error) {
    for (const post of (latest.value.data ?? []).slice(0, NEWS_LIMIT - items.length)) {
      items.push({ href: `/board/${post.id}`, label: post.category || "새 글", title: post.title, at: post.created_at });
    }
  }
  return items.sort((a, b) => Date.parse(b.at) - Date.parse(a.at));
}

const dateLabel = (value: string) => new Date(value).toLocaleDateString("ko-KR", { timeZone: "Asia/Seoul", year: "2-digit", month: "2-digit", day: "2-digit" });
const chip = "inline-flex min-h-10 items-center rounded-lg border border-white/10 px-3 text-sm font-semibold text-white/80 transition hover:border-white/25 hover:text-white";

export default async function HomeHub() {
  const news = await getNews();
  const riotLocked = !lolRiotDataPublic();
  return (
    <div className="w-full bg-[var(--color-bg-base)] text-white">
      <div className="mx-auto flex w-full max-w-6xl flex-col gap-6 px-4 py-8 sm:py-10">
        <header className="rounded-2xl border border-white/10 bg-gradient-to-br from-[#F2A900]/15 via-[var(--color-bg-surface)] to-amber-500/5 p-6 sm:p-8">
          <h1 className="text-2xl font-black tracking-tight sm:text-3xl">배그와 롤, 전적과 전술 정보를 한곳에서</h1>
          <p className="mt-2 max-w-2xl text-sm leading-relaxed text-white/60 sm:text-base">
            배틀그라운드 지도·AI 전적 분석과 리그 오브 레전드 증바람 증강 정보를 제공합니다.
          </p>
        </header>

        <div className="grid grid-cols-[minmax(0,1fr)] gap-6 lg:grid-cols-[minmax(0,1fr)_320px]">
          <div className="grid grid-cols-[minmax(0,1fr)] gap-4 md:grid-cols-2">
            <section aria-labelledby="home-pubg" className="flex flex-col gap-4 rounded-2xl border border-white/10 bg-[var(--color-bg-surface)] p-5">
              <div>
                <p className="text-xs font-bold uppercase tracking-widest text-[#F2A900]">PUBG</p>
                <h2 id="home-pubg" className="mt-1 text-xl font-black">배틀그라운드</h2>
                <p className="mt-1 text-sm text-white/60">맵별 차량·비밀방 위치, AI 전적 분석과 랭킹</p>
              </div>
              <HomeStatsSearch />
              <nav aria-label="배틀그라운드 메뉴" className="flex flex-wrap gap-2">
                {PUBG_LINKS.map(link => <Link key={link.href} href={link.href} className={chip}>{link.label}</Link>)}
              </nav>
            </section>

            <section aria-labelledby="home-lol" className="flex flex-col gap-4 rounded-2xl border border-amber-500/20 bg-[var(--color-bg-surface)] p-5">
              <div>
                <p className="text-xs font-bold uppercase tracking-widest text-amber-300">League of Legends</p>
                <h2 id="home-lol" className="mt-1 text-xl font-black">리그 오브 레전드</h2>
                <p className="mt-1 text-sm text-white/60">무작위 총력전: 아수라장 증강 도감과 챔피언별 조합</p>
              </div>
              <Link href="/lol/kr/aram-mayhem" className="inline-flex min-h-11 items-center justify-center rounded-lg bg-amber-400 px-4 text-sm font-bold text-zinc-950 transition hover:bg-amber-300">
                증바람 증강 보기
              </Link>
              <nav aria-label="리그 오브 레전드 메뉴" className="flex flex-wrap gap-2">
                {LOL_LOCKED_LINKS.map(link => (
                  <Link key={link.href} href={link.href} className={chip}>
                    {link.label}
                    {riotLocked && <span className="ml-1.5 rounded bg-white/10 px-1 py-px text-[10px] font-bold text-white/50">개발 중</span>}
                  </Link>
                ))}
              </nav>
              <p lang="en" className="mt-auto text-[11px] leading-relaxed text-white/40">{LOL_LEGAL_ENGLISH}</p>
            </section>
          </div>

          {news.length > 0 && (
            <section aria-labelledby="home-news" className="rounded-2xl border border-white/10 bg-[var(--color-bg-surface)] p-5">
              <h2 id="home-news" className="text-base font-bold">최근 소식</h2>
              <ul className="mt-3 divide-y divide-white/5">
                {news.map(item => (
                  <li key={item.href + item.at}>
                    <Link href={item.href} className="flex min-h-11 items-center gap-2 py-2 text-sm text-white/80 hover:text-white">
                      <span className="max-w-[6rem] shrink-0 truncate rounded bg-white/10 px-1.5 py-0.5 text-[11px] font-bold text-white/60">{item.label}</span>
                      <span className="min-w-0 flex-1 truncate">{item.title}</span>
                      <time dateTime={item.at} className="shrink-0 text-xs text-white/40">{dateLabel(item.at)}</time>
                    </Link>
                  </li>
                ))}
              </ul>
            </section>
          )}
        </div>
      </div>
    </div>
  );
}
