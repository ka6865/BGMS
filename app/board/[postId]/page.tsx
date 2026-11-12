import { Metadata } from 'next';
import { createClient } from '@/utils/supabase/server';
import { getPostMetadata, getBreadcrumbJsonLd, getPostArticleJsonLd } from '@/lib/seo-config';
import { JsonLdProps } from '@/types/seo';
import BoardDetailClient from '@/components/board/BoardDetailClient';
import { sanitizeBoardHtml } from '@/lib/board/sanitizeHtml';
import { notFound } from 'next/navigation';
import { maskIp } from '@/lib/board/ipUtils';
import { resolvePromoteExpectedParentRevision } from '@/lib/board/promotionRevision';
import { BOARD_POST_PUBLIC_FIELDS, BOARD_COMMENT_PUBLIC_FIELDS } from '@/lib/board/publicFields';

//  캐시를 완전히 끄고 항상 실시간 데이터를 가져오도록 설정 (수정 사항 반영 확인용)
export const revalidate = 0;

export async function generateMetadata({ params }: { params: Promise<{ postId: string }> }): Promise<Metadata> {
  const { postId } = await params;
  const metadata = await getPostMetadata(postId);

  if (!metadata) notFound();

  return metadata;
}

export default async function PostDetailPage({ params }: { params: Promise<{ postId: string }> }) {
  const { postId } = await params;
  const numericPostId = Number(postId);

  const metadata = await getPostMetadata(postId);
  if (!metadata) notFound();
  const supabase = await createClient();

  const jsonLd: JsonLdProps[] = [
    getBreadcrumbJsonLd([
      { name: "커뮤니티", item: "/board" },
      { name: metadata.title?.toString() || "게시글", item: `/board/${postId}` }
    ]) as JsonLdProps
  ];

  const articleJsonLd = await getPostArticleJsonLd(postId);
  if (articleJsonLd) {
    jsonLd.push(articleJsonLd as JsonLdProps);
  }

  // 데이터 조회 (작성자 최신 닉네임을 위해 profiles join)
  const { data: postResult, error: postError } = await supabase
    .from("posts")
    .select(`${BOARD_POST_PUBLIC_FIELDS}, profiles(nickname, role)`)
    .eq("id", numericPostId)
    .maybeSingle();

  if (postError) {
    console.error("게시글 조회 오류:", postError);
    throw new Error("게시글 조회 실패", { cause: postError });
  }
  if (!postResult) notFound();

  const { data: commentResult, error: commentError } = await supabase
    .from("comments")
    .select(`${BOARD_COMMENT_PUBLIC_FIELDS}, profiles(nickname, role)`)
    .eq("post_id", numericPostId)
    .order("created_at", { ascending: true });

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
  // content 는 서버에서 정화해서 넘긴다. 클라이언트 dompurify 는 브라우저 전용이라
  // SSR 출력과 hydration 이전 DOM 을 보호하지 못한다.
  const post = {
    ...postResult,
    content: sanitizeBoardHtml(postResult.content),
    author: postResult.user_id
      ? ((postResult as any).profiles?.nickname || postResult.author || '알 수 없음')
      : (postResult.author || '익명'),
    profiles: (postResult as any).profiles || null,
    ip_address: postResult.ip_address ? maskIp(postResult.ip_address) : null,
  };

  if (commentError) {
    console.error("댓글 조회 오류:", commentError);
  }

  const comments = (commentResult || []).map((comment: any) => ({
    ...comment,
    content: sanitizeBoardHtml(comment.content),
    author: comment.user_id
      ? (comment.profiles?.nickname || comment.author || '알 수 없음')
      : (comment.author || '익명'),
    profiles: comment.profiles || null,
    ip_address: comment.ip_address ? maskIp(comment.ip_address) : null,
  }));

  return (
    <div className="w-full h-full overflow-y-auto bg-[#121212] flex flex-col pt-6">
      <BoardDetailClient
        initialPost={post}
        initialComments={comments}
        promoteExpectedParentRevision={promoteExpectedParentRevision}
        initialCommentsHasError={Boolean(commentError)}
      />
    </div>
  );
}
