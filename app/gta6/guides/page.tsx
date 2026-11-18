import Link from "next/link";
import type { Metadata } from "next";
import { PenLine, ThumbsUp } from "lucide-react";
import { createClient } from "@/utils/supabase/server";
import { GTA6_GUIDE_CATEGORY, GTA6_OG_IMAGE } from "@/lib/gta6/guides";

export const metadata: Metadata = {
  title: { absolute: "GTA6 공략 게시판 · 가이드와 팁 | BGMS" },
  description: "GTA6 미션 공략, 돈 버는 법, 숨은 장소와 팁을 유저들이 직접 공유하는 게시판입니다.",
  alternates: { canonical: "/gta6/guides" },
  openGraph: {
    title: "GTA6 공략 게시판 | BGMS", description: "GTA6 미션 공략, 돈 버는 법, 숨은 장소와 팁을 유저들이 직접 공유하는 게시판입니다.",
    url: "/gta6/guides", type: "website", images: [GTA6_OG_IMAGE],
  },
  twitter: { card: "summary_large_image", title: "GTA6 공략 게시판 | BGMS", images: [GTA6_OG_IMAGE.url] },
};

const PER_PAGE = 20;
const dateLabel = (value: string) => new Date(value).toLocaleDateString("ko-KR", { timeZone: "Asia/Seoul", month: "2-digit", day: "2-digit" });

export default async function Gta6GuidesPage({ searchParams }: { searchParams: Promise<{ page?: string }> }) {
  const page = Math.max(1, Math.floor(Number((await searchParams).page)) || 1);
  const from = (page - 1) * PER_PAGE;
  const { data, count, error } = await (await createClient()).from("posts")
    .select("id, title, author, user_id, created_at, views, likes, is_notice, comments(id), profiles(nickname)", { count: "exact" })
    .eq("status", "published").eq("category", GTA6_GUIDE_CATEGORY)
    .order("is_notice", { ascending: false }).order("created_at", { ascending: false })
    .range(from, from + PER_PAGE - 1);
  if (error) console.error("GTA6 공략 목록 조회 오류:", error);
  const totalPages = Math.max(1, Math.ceil((count ?? 0) / PER_PAGE));
  const pageLink = "inline-flex min-h-11 items-center rounded-lg border border-zinc-700 px-4 text-sm font-semibold text-zinc-200 hover:border-zinc-500";

  return <div className="min-h-0 flex-1 overflow-y-auto">
    <div className="mx-auto w-full max-w-3xl px-4 py-6">
      <div className="flex items-end justify-between gap-3">
        <div>
          <h1 className="text-xl font-black tracking-tight">GTA6 공략 게시판</h1>
          <p className="mt-1 text-sm text-zinc-400">미션 공략, 돈 버는 법, 숨은 장소를 직접 플레이한 유저들이 나눕니다.</p>
        </div>
        <Link href="/gta6/guides/write" className="inline-flex min-h-11 shrink-0 items-center gap-1.5 rounded-lg bg-amber-300 px-4 text-sm font-bold text-zinc-950 hover:bg-amber-200 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-amber-300"><PenLine size={16} aria-hidden />글쓰기</Link>
      </div>
      <p className="mt-4 rounded-lg border border-white/10 bg-zinc-900 px-3 py-2 text-xs leading-relaxed text-zinc-400">운영자가 게임 내용을 일일이 검증하지 않습니다. 추천이 많은 글을 참고하고, 틀린 내용은 댓글로 알려 주세요.</p>

      {error ? <p role="alert" className="mt-6 text-sm text-zinc-300">글 목록을 불러오지 못했습니다. 잠시 후 다시 시도해 주세요.</p>
        : !data?.length ? <div className="mt-6 rounded-xl border border-dashed border-zinc-700 p-8 text-center text-sm text-zinc-400">
          아직 공략이 없습니다. 첫 번째 공략을 남겨 주세요.
        </div> : <ul className="mt-4 divide-y divide-white/5 border-y border-white/10">
          {data.map(post => {
            const author = (post.profiles as { nickname?: string } | null)?.nickname || post.author || "익명";
            const comments = Array.isArray(post.comments) ? post.comments.length : 0;
            return <li key={post.id}>
              <Link href={`/gta6/guides/${post.id}`} className="flex min-h-16 flex-col justify-center gap-1 px-1 py-3 hover:bg-zinc-900 focus-visible:bg-zinc-900 focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-amber-300">
                <span className="flex items-center gap-2 text-sm font-medium">
                  {post.is_notice && <span className="shrink-0 rounded bg-amber-300 px-1.5 text-[11px] font-bold text-zinc-950">공지</span>}
                  <span className="truncate">{post.title}</span>
                  {comments > 0 && <span className="shrink-0 text-xs text-amber-300" aria-label={`댓글 ${comments}개`}>[{comments}]</span>}
                </span>
                <span className="flex items-center gap-3 text-xs text-zinc-400">
                  <span className="truncate">{author}</span>
                  <time dateTime={post.created_at}>{dateLabel(post.created_at)}</time>
                  <span>조회 {post.views ?? 0}</span>
                  <span className="inline-flex items-center gap-1"><ThumbsUp size={12} aria-hidden />{post.likes ?? 0}</span>
                </span>
              </Link>
            </li>;
          })}
        </ul>}

      {totalPages > 1 && <nav aria-label="페이지" className="mt-4 flex items-center justify-center gap-3 text-sm text-zinc-400">
        {page > 1 && <Link href={`/gta6/guides?page=${page - 1}`} className={pageLink}>이전</Link>}
        <span className="tabular-nums">{page} / {totalPages}</span>
        {page < totalPages && <Link href={`/gta6/guides?page=${page + 1}`} className={pageLink}>다음</Link>}
      </nav>}
      <p className="mt-8 text-[11px] leading-relaxed text-zinc-500">Rockstar Games 및 Take-Two Interactive와 관련 없는 팬 서비스입니다.</p>
    </div>
  </div>;
}
