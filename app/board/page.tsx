import { Metadata } from 'next';
import { createClient } from '@/utils/supabase/server';
import { getTabSeo } from '@/lib/seo-config';
import BoardListClient from '@/components/board/BoardListClient';
import { maskIp } from "@/lib/board/ipUtils";

export async function generateMetadata(): Promise<Metadata> {
  return getTabSeo("Board");
}

export default async function BoardPage({
  searchParams,
}: {
  searchParams: Promise<{ [key: string]: string | string[] | undefined }>
}) {
  const params = await searchParams;
  
  const page = Number(params.page) || 1;
  const filter = (params.f as string) || "전체";
  const searchType = (params.search_type as string) || "all";
  const q = (params.q as string) || "";
  
  const POSTS_PER_PAGE = 10;
  const from = (page - 1) * POSTS_PER_PAGE;
  const to = from + POSTS_PER_PAGE - 1;

  //  검증된 서버용 클라이언트를 사용하여 RLS 통과 보장
  const supabase = await createClient();

  let query = supabase
    .from("posts")
    .select(
      "id, title, author, user_id, category, image_url, discord_url, discord_channel_id, is_notice, created_at, views, likes, status, parent_id, ip_address, comments(count), profiles(nickname)",
      { count: "exact" }
    );

  if (filter === "어드민 검증") {
    // [어드민 검증] 탭: status = 'draft' 인 초안만 쿼리 (RLS에 의해 어드민만 실제 조회 성공)
    query = query.eq("status", "draft");
  } else {
    // 일반 탭: status = 'published' 인 발행 완료된 글만 쿼리 (어드민이 조회할 때도 초안이 전체 탭에 섞이지 않도록 방지)
    query = query.eq("status", "published");

    if (filter !== "전체" && filter !== "추천") {
      query = query.eq("category", filter);
    }
    if (filter === "추천") {
      query = query.gte("likes", 5);
    }
  }

  if (q) {
    if (searchType === "title") query = query.ilike("title", `%${q}%`);
    else if (searchType === "author") query = query.ilike("author", `%${q}%`);
    else query = query.or(`title.ilike.%${q}%,content.ilike.%${q}%`);
  }

  const { data, count, error } = await query
    .order("is_notice", { ascending: false })
    .order("created_at", { ascending: false })
    .range(from, to);

  let posts = [];
  if (!error && data) {
    posts = data.map((post: any) => ({
      ...post,
      author: post.profiles?.nickname || post.author || '알 수 없음',
      ip_address: post.ip_address ? maskIp(post.ip_address) : null,
      comment_count: post.comments && post.comments[0] ? post.comments[0].count : 0,
    }));
  } else {
    console.error("Board RSC Fetch Error:", error);
  }

  return (
    <div className="w-full h-full overflow-y-auto bg-[#121212] flex flex-col pt-6">
      {/* 상단 타이틀 영역 — 중앙 정렬용 900px wrapper */}
      <div className="w-full max-w-[900px] mx-auto px-4 box-border">
         <div className="mb-6 flex flex-col items-center">
            <h1 className="text-2xl font-black text-[#F2A900] tracking-tighter italic">커뮤니티</h1>
            <p className="text-white/40 text-xs mt-1">자유롭게 배틀그라운드 정보를 나누는 공간입니다</p>
         </div>
      </div>

      {/* 게시판 리스트 컴포넌트 — 900px 안쪽에 relative가 선언되어 있으므로 w-full로 배치 */}
      <div className="w-full">
         <BoardListClient 
            posts={posts} 
            totalPosts={count || 0} 
            currentPage={page} 
            currentFilter={filter}
            currentSearchOption={searchType}
            currentSearchQuery={q}
         />
      </div>
    </div>
  );
}
