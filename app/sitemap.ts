import { MetadataRoute } from 'next';
import { createClient } from '@/utils/supabase/server';
import { rankerLessons } from '@/lib/learn/lessons';
import { listDailyRankerStories } from '@/lib/learn/dailyStories';

export const dynamic = 'force-dynamic';

/**
 * [V3] 사이트맵 고도화: 정적 경로 + 동적 커뮤니티 게시글 포함
 */
export default async function sitemap(): Promise<MetadataRoute.Sitemap> {
  // 사이트맵용 베이스 URL 설정
  let siteUrl = process.env.NEXT_PUBLIC_SITE_URL || 'https://bgms.kr';
  if (siteUrl.endsWith('/')) siteUrl = siteUrl.slice(0, -1);

  const maps = ["erangel", "miramar", "taego", "rondo", "vikendi", "deston"];
  const mapEntries: MetadataRoute.Sitemap = maps.map((map) => ({
    url: `${siteUrl}/maps/${map}`,
    lastModified: new Date(),
    changeFrequency: 'daily',
    priority: 0.8,
  }));

  const lessonEntries: MetadataRoute.Sitemap = [
    { url: `${siteUrl}/learn`, lastModified: new Date(), changeFrequency: 'weekly', priority: 0.6 },
    { url: `${siteUrl}/learn/daily`, lastModified: new Date(), changeFrequency: 'daily', priority: 0.7 },
    ...rankerLessons.map((lesson) => ({
      url: `${siteUrl}/learn/${lesson.id}`,
      lastModified: new Date(),
      changeFrequency: 'monthly' as const,
      priority: 0.6,
    })),
  ];
  let dailyStoryEntries: MetadataRoute.Sitemap = [];
  try {
    const stories = await listDailyRankerStories(100);
    dailyStoryEntries = stories.map((story) => ({
      url: `${siteUrl}/learn/daily/${story.dayKst}`,
      lastModified: new Date(story.publishedAt),
      changeFrequency: 'monthly',
      priority: 0.6,
    }));
  } catch (error) {
    console.error('[Sitemap] Failed to fetch daily stories:', error);
  }

  const staticEntries: MetadataRoute.Sitemap = [
    {
      url: `${siteUrl}/`,
      lastModified: new Date(),
      changeFrequency: 'daily',
      priority: 1.0,
    },
    {
      url: `${siteUrl}/board`,
      lastModified: new Date(),
      changeFrequency: 'daily',
      priority: 0.7,
    },
    {
      url: `${siteUrl}/stats`,
      lastModified: new Date(),
      changeFrequency: 'daily',
      priority: 0.6,
    },
    {
      url: `${siteUrl}/weapons`,
      lastModified: new Date(),
      changeFrequency: 'weekly',
      priority: 0.5,
    },
    {
      url: `${siteUrl}/backpack`,
      lastModified: new Date(),
      changeFrequency: 'weekly',
      priority: 0.5,
    },
  ];

  // 동적 게시글 경로 추가 (최신 100개)
  let postEntries: MetadataRoute.Sitemap = [];
  try {
    const supabase = await createClient();
    const { data: posts } = await supabase
      .from('posts')
      .select('id, created_at')
      .order('created_at', { ascending: false })
      .limit(100);

    if (posts) {
      postEntries = posts.map((post) => ({
        url: `${siteUrl}/board/${post.id}`,
        lastModified: new Date(post.created_at),
        changeFrequency: 'weekly',
        priority: 0.6,
      }));
    }
  } catch (error) {
    console.error('[Sitemap] Failed to fetch posts:', error);
  }

  return [...staticEntries, ...mapEntries, ...lessonEntries, ...dailyStoryEntries, ...postEntries];
}
