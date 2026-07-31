'use client';

import React, { useState, useEffect, useMemo } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { Post } from "@/types/board";
import { PenLine } from "lucide-react";
import { trackEvent } from "@/lib/analytics";
import PostItem from "./PostItem";
import BoardSearch from "./BoardSearch";
import BoardPagination from "./BoardPagination";
import { useAuth } from "@/components/AuthProvider";
import { supabase } from "@/lib/supabase";
import AdfitBanner from "@/components/ads/AdfitBanner";
import AdSenseBanner from "@/components/ads/AdSenseBanner";

const BOARD_CATEGORIES = ["배그 소식", "자유", "듀오/스쿼드 모집", "클랜홍보", "제보/문의"];
const POSTS_PER_PAGE = 10;
const MAX_VISIBLE_PAGES = 5;


interface BoardListClientProps {
  posts: Post[];
  totalPosts: number;
  currentPage: number;
  currentFilter: string;
  currentSearchOption?: string;
  currentSearchQuery?: string;
  hasError?: boolean;
}

export default function BoardListClient({
  posts,
  totalPosts,
  currentPage,
  currentFilter,
  currentSearchOption = "all",
  currentSearchQuery = "",
  hasError = false,
}: BoardListClientProps) {
  const router = useRouter();
  const { user } = useAuth();
  const [isAdmin, setIsAdmin] = useState(false);
  const [isMobile, setIsMobile] = useState(false);
  const [searchInput, setSearchInput] = useState(currentSearchQuery);
  const [searchOption, setSearchOption] = useState(currentSearchOption);

  useEffect(() => {
    if (!user) {
      setIsAdmin(false);
      return;
    }
    supabase.from("profiles").select("role").eq("id", user.id).single().then(({ data }) => {
      if (data) {
        setIsAdmin(data.role === "admin");
      }
    });
  }, [user]);

  const filterCategories = useMemo(() => {
    const list = ["전체", "추천", ...BOARD_CATEGORIES];
    if (isAdmin) {
      list.push("어드민 검증");
    }
    return list;
  }, [isAdmin]);

  useEffect(() => {
    trackEvent({
      name: "board_viewed",
      params: {
        category: currentFilter
      }
    });
  }, [currentFilter]);

  useEffect(() => {
    const handleResize = () => setIsMobile(window.innerWidth < 768);
    handleResize();
    window.addEventListener("resize", handleResize);
    return () => window.removeEventListener("resize", handleResize);
  }, []);

  const totalPages = Math.max(1, Math.ceil(totalPosts / POSTS_PER_PAGE));
  let startPage = Math.max(1, currentPage - Math.floor(MAX_VISIBLE_PAGES / 2));
  let endPage = startPage + MAX_VISIBLE_PAGES - 1;
  if (endPage > totalPages) {
    endPage = totalPages;
    startPage = Math.max(1, endPage - MAX_VISIBLE_PAGES + 1);
  }
  const pageNumbers = Array.from({ length: endPage - startPage + 1 }, (_, i) => startPage + i);

  const formatTimeAgo = (dateString: string) => {
    const parts = new Intl.DateTimeFormat("en-US-u-nu-latn", {
      timeZone: "Asia/Seoul",
      year: "numeric",
      month: "numeric",
      day: "numeric",
    }).formatToParts(new Date(dateString));
    const values = Object.fromEntries(parts.map(({ type, value }) => [type, value]));
    return `${values.year}. ${values.month}. ${values.day}.`;
  };

  const handleSearch = (e: React.FormEvent) => {
    e.preventDefault();
    const searchParams = new URLSearchParams();
    if (currentFilter !== "전체") searchParams.set("f", currentFilter);
    if (searchInput) {
      searchParams.set("q", searchInput);
      searchParams.set("search_type", searchOption);
    }
    router.push(`/board?${searchParams.toString()}`);
  };

  const buildPageLink = (page: number) => {
    const params = new URLSearchParams();
    if (currentFilter !== "전체") params.set("f", currentFilter);
    if (currentSearchQuery) {
      params.set("q", currentSearchQuery);
      params.set("search_type", currentSearchOption);
    }
    params.set("page", page.toString());
    return `/board?${params.toString()}`;
  };

  return (
    <div className="w-full flex justify-center pb-20">
      <div className="w-full max-w-[1280px] px-4 xl:grid xl:grid-cols-[160px_minmax(0,900px)_160px] xl:justify-center xl:gap-5">
        {/* 본문 영역 */}
        <div className="w-full min-w-0 xl:col-start-2">
          {/* 상단 필터 및 글쓰기 버튼 */}
          <div className="flex justify-between items-center mb-6 gap-4">
            <div className="flex gap-2 overflow-x-auto no-scrollbar flex-1 py-1 px-1">
            {filterCategories.map((f) => {
              const isActive = currentFilter === f;
              const href = f === "전체" ? "/board" : `/board?f=${f}`;
                return (
                  <Link key={f} href={href} className="shrink-0">
                    <button
                      className={`px-4 py-2 rounded-lg border text-[13px] whitespace-nowrap transition-all duration-200 ${
                        isActive
                          ? "border-[#F2A900] bg-[#F2A900] text-black font-extrabold shadow-[0_0_15px_rgba(242,169,0,0.3)]"
                          : "border-white/5 bg-white/5 text-white/40 hover:bg-white/10 hover:text-white/70"
                      }`}
                    >
                      {f}
                    </button>
                  </Link>
                );
              })}
            </div>

            <Link href="/board/write" className="shrink-0">
              <button className="flex items-center gap-2 px-5 py-2 bg-[#F2A900] border-none rounded-lg font-black text-[14px] text-black hover:bg-[#d4940a] active:scale-95 transition-all shadow-[0_4px_12px_rgba(242,169,0,0.2)]">
                <PenLine size={16} strokeWidth={3} />
                글쓰기
              </button>
            </Link>
          </div>

          {/* 게시글 목록 */}
          <div className="bg-[#1a1a1a] rounded-2xl border border-white/5 overflow-hidden shadow-2xl">
            {hasError ? (
              <div className="py-24 px-4 text-center">
                <p className="text-base font-medium text-white/70">일시적인 문제가 발생했습니다. 잠시 후 다시 시도해 주세요.</p>
                <button
                  type="button"
                  onClick={() => router.refresh()}
                  className="mt-5 rounded-lg border border-[#F2A900]/30 bg-[#F2A900]/10 px-4 py-2 text-xs font-bold text-[#F2A900] transition-colors hover:bg-[#F2A900]/20"
                >
                  다시 시도
                </button>
              </div>
            ) : posts.length === 0 ? (
              <div className="py-24 text-center text-white/20">
                <p className="text-base font-medium">등록된 게시글이 없습니다</p>
                <p className="text-xs mt-2 opacity-50">첫 번째 주인공이 되어보세요!</p>
              </div>
            ) : isMobile ? (
              <ul className="list-none p-0 m-0 divide-y divide-white/5">
                {posts.map((post) => (
                  <PostItem 
                    key={post.id} 
                    post={post} 
                    isMobile={true} 
                    onClickDesktop={() => router.push(`/board/${post.id}`)}
                    formatTimeAgo={formatTimeAgo} 
                  />
                ))}
              </ul>
            ) : (
              <table className="w-full border-collapse">
                <thead>
                  <tr className="bg-white/[0.02] border-b border-white/5">
                    {[
                      { label: "분류", width: "100px" },
                      { label: "제목", width: "auto" },
                      { label: "글쓴이", width: "120px" },
                      { label: "작성일", width: "100px" },
                      { label: "조회", width: "80px" },
                      { label: "추천", width: "80px" }
                    ].map((h) => (
                      <th 
                        key={h.label} 
                        style={{ width: h.width }}
                        className="p-4 text-left text-[11px] font-black tracking-widest uppercase text-white/20"
                      >
                        {h.label}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody className="divide-y divide-white/[0.03]">
                  {posts.map((post) => (
                    <PostItem 
                      key={post.id} 
                      post={post} 
                      isMobile={false}
                      onClickDesktop={() => router.push(`/board/${post.id}`)}
                      formatTimeAgo={formatTimeAgo} 
                    />
                  ))}
                </tbody>
              </table>
            )}
          </div>

          {/* 하단 검색 및 페이지네이션 */}
          <div className="flex justify-between items-center mt-4 flex-wrap gap-3">
            <BoardSearch 
              searchOption={searchOption}
              setSearchOption={setSearchOption}
              searchInput={searchInput}
              setSearchInput={setSearchInput}
              onSearch={handleSearch}
            />

            <BoardPagination 
              currentPage={currentPage}
              totalPages={totalPages}
              pageNumbers={pageNumbers}
              buildPageLink={buildPageLink}
            />
          </div>
        </div>

        {/* 뷰포트 고정 광고는 좌측 한 곳만 유지한다. self-start를 제거해 컬럼 전체 높이를 확보한다. */}
        <aside
          className="hidden [@media(min-width:1280px)_and_(min-height:680px)]:block xl:col-start-1 xl:row-start-1"
          aria-label="광고"
        >
          <div className="sticky top-20 h-[600px] w-[160px]">
            <AdSenseBanner client="ca-pub-3993032200487955" slot="7728921550" />
          </div>
        </aside>
        {/* 우측 레일은 고정하지 않고 문서 흐름에 배치한다. 좌우 동시 고정 광고는 정책 위반이다. */}
        <aside
          className="hidden [@media(min-width:1280px)_and_(min-height:680px)]:block xl:col-start-3 xl:row-start-1 self-start"
          aria-label="광고"
        >
          <div className="h-[600px] w-[160px]">
            <AdfitBanner adUnit="DAN-RjyosR2uf8eSsVIC" adWidth={160} adHeight={600} />
          </div>
        </aside>
      </div>
    </div>
  );
}
