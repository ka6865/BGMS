import { Metadata } from 'next';
import { getTabSeo } from '@/lib/seo-config';
import MyPageClient from '@/components/mypage/MyPage';
import { createClient } from '@/utils/supabase/server';
import { redirect } from 'next/navigation';

export async function generateMetadata(): Promise<Metadata> {
  const seo = await getTabSeo("MyPage");
  return {
    ...seo,
    title: "마이페이지",
    robots: { index: false } // 개인정보 페이지이므로 SEO 수집 방지
  };
}

export default async function MyPagePage() {
  const supabase = await createClient();
  
  // 서버 사이드에서 쿠키를 통해 유저 세션 획득
  const { data: { user } } = await supabase.auth.getUser();

  if (!user) {
    redirect('/login');
  }

  // Promise.all을 활용한 초고속 병렬 데이터 패칭
  const [
    { data: userProfile },
    { count: postCount },
    { count: commentCount },
    { data: myPosts }
  ] = await Promise.all([
    supabase.from('profiles').select('*').eq('id', user.id).single(),
    supabase.from('posts').select('*', { count: 'exact', head: true }).eq('user_id', user.id),
    supabase.from('comments').select('*', { count: 'exact', head: true }).eq('user_id', user.id),
    supabase.from('posts').select('id').eq('user_id', user.id)
  ]);

  let likeCount = 0;
  if (myPosts && myPosts.length > 0) {
    const postIds = myPosts.map(p => p.id);
    const { count: likes } = await supabase
      .from('post_likes')
      .select('*', { count: 'exact', head: true })
      .in('post_id', postIds);
    likeCount = likes || 0;
  }

  const activityStats = {
    postCount: postCount || 0,
    commentCount: commentCount || 0,
    likeCount: likeCount
  };

  return (
    <div className="w-full h-full overflow-y-auto bg-[#121212] flex justify-center">
      <MyPageClient 
        initialCurrentUser={user}
        initialUserProfile={userProfile}
        initialActivityStats={activityStats}
      />
    </div>
  );
}
