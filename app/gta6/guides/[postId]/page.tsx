import { permanentRedirect } from "next/navigation";
import BoardPostPage from "@/app/board/[postId]/page";
import { createClient } from "@/utils/supabase/server";
import { GTA6_GUIDE_CATEGORY } from "@/lib/gta6/guides";

export { generateMetadata } from "@/app/board/[postId]/page";
export const revalidate = 0;

// 본문·댓글·추천·신고는 게시판 상세를 그대로 쓰고, GTA6 레이아웃 안에서 스크롤되게 감싼다.
export default async function Gta6GuidePage(props: { params: Promise<{ postId: string }> }) {
  const { postId } = await props.params;
  const { data } = await (await createClient()).from("posts").select("category").eq("id", Number(postId)).maybeSingle();
  if (data && data.category !== GTA6_GUIDE_CATEGORY) permanentRedirect(`/board/${postId}`);
  return <div className="min-h-0 flex-1"><BoardPostPage {...props} /></div>;
}
