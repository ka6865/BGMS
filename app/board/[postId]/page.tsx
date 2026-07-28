import { Metadata } from 'next';
import { createClient } from '@/utils/supabase/server';
import { getPostMetadata, getBreadcrumbJsonLd, getPostArticleJsonLd } from '@/lib/seo-config';
import { JsonLdProps } from '@/types/seo';
import BoardDetailClient from '@/components/board/BoardDetailClient';
import Link from 'next/link';
import { CircleAlert, ChevronLeft } from 'lucide-react';
import { maskIp } from '@/lib/board/ipUtils';
import { resolvePromoteExpectedParentRevision } from '@/lib/board/promotionRevision';

//  캐시를 완전히 끄고 항상 실시간 데이터를 가져오도록 설정 (수정 사항 반영 확인용)
export const revalidate = 0;

export async function generateMetadata({ params }: { params: Promise<{ postId: string }> }): Promise<Metadata> {
  const { postId } = await params;
  const metadata = await getPostMetadata(postId);
  
  if (!metadata) {
    return {
      title: "존재하지 않는 게시글입니다 | BGMS",
      description: "요청하신 게시글을 찾을 수 없습니다. 삭제되었거나 주소가 잘못되었을 수 있습니다.",
      robots: { index: false }
    };
  }
  
  return metadata;
}

export default async function PostDetailPage({ params }: { params: Promise<{ postId: string }> }) {
  const { postId } = await params;
  const numericPostId = Number(postId);
  
  const supabase = await createClient();
  const metadata = await getPostMetadata(postId);
  
  const jsonLd: JsonLdProps[] = [
    getBreadcrumbJsonLd([
      { name: "커뮤니티", item: "/board" },
      { name: metadata?.title?.toString() || "게시글", item: `/board/${postId}` }
    ]) as JsonLdProps
  ];

  const articleJsonLd = await getPostArticleJsonLd(postId);
  if (articleJsonLd) {
    jsonLd.push(articleJsonLd as JsonLdProps);
  }

  // 데이터 조회 (작성자 최신 닉네임을 위해 profiles join)
  const { data: postResult } = await supabase
    .from("posts")
    .select("*, profiles(nickname)")
    .eq("id", numericPostId)
    .single();

  const { data: commentResult } = await supabase
    .from("comments")
    .select("*, profiles(nickname)")
    .eq("post_id", numericPostId)
    .order("created_at", { ascending: true });

  if (!postResult) {
    return (
      <div className="w-full h-[calc(100vh-100px)] bg-[#121212] flex flex-col items-center justify-center p-6 text-center animate-in fade-in duration-500">
        <div className="bg-[#1a1a1a] border border-[#333] p-10 rounded-2xl shadow-2xl flex flex-col items-center max-w-md w-full">
          <div className="w-16 h-16 bg-red-500/10 rounded-full flex items-center justify-center mb-6">
            <CircleAlert className="w-8 h-8 text-red-500" />
          </div>
          <h1 className="text-2xl font-black text-white mb-2">게시글을 찾을 수 없습니다</h1>
          <p className="text-[#999] text-sm leading-relaxed mb-8">
            삭제된 게시글이거나 유효하지 않은 주소입니다.<br />
            입력하신 주소를 다시 한번 확인해 주세요.
          </p>
          <div className="flex flex-col gap-3 w-full">
            <Link 
              href="/board"
              className="flex items-center justify-center gap-2 w-full py-4 bg-[#F2A900] text-black font-bold rounded-xl hover:bg-[#d49400] transition-all active:scale-95"
            >
              <ChevronLeft className="w-4 h-4" />
              게시판 목록으로 돌아가기
            </Link>
            <Link 
              href="/"
              className="text-[#999] text-xs hover:text-[#F2A900] transition-colors"
            >
              홈으로 가기
            </Link>
          </div>
        </div>
      </div>
    );
  }

  let promoteExpectedParentRevision = resolvePromoteExpectedParentRevision(postResult, null, null);
  if (postResult.parent_id !== null) {
    const { data: parentResult, error: parentError } = await supabase
      .from("posts")
      .select("revision")
      .eq("id", postResult.parent_id)
      .single();
    promoteExpectedParentRevision = resolvePromoteExpectedParentRevision(postResult, parentResult, parentError);
  }

  // 비회원(user_id가 null)은 profiles join이 없으므로 author를 그대로 유지하고 IP 마스킹
  const post = {
    ...postResult,
    author: postResult.user_id
      ? ((postResult as any).profiles?.nickname || postResult.author || '알 수 없음')
      : (postResult.author || '익명'),
    ip_address: postResult.ip_address ? maskIp(postResult.ip_address) : null,
  };

  const comments = (commentResult || []).map((comment: any) => ({
    ...comment,
    author: comment.user_id
      ? (comment.profiles?.nickname || comment.author || '알 수 없음')
      : (comment.author || '익명'),
    ip_address: comment.ip_address ? maskIp(comment.ip_address) : null,
  }));

  return (
    <div className="w-full h-full overflow-y-auto bg-[#121212] flex flex-col pt-6">
      <BoardDetailClient 
        initialPost={post} 
        initialComments={comments}
        promoteExpectedParentRevision={promoteExpectedParentRevision}
      />
    </div>
  );
}
