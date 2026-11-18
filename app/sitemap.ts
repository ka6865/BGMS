import { MetadataRoute } from 'next';
import { createClient } from '@/utils/supabase/server';
import { postBasePath } from '@/lib/gta6/guides';
import { getLolChampions } from '@/lib/lol/champions.server';
import { listMayhemTipSitemap } from '@/lib/lol/mayhemTips.server';
import { listPublicPlayersForSitemap } from '@/lib/stats/playerSeo.server';
import { MAYHEM_PATH, mayhemChampionPath, mayhemTipPath } from '@/lib/lol/mayhemSeo';

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
    changeFrequency: 'daily',
    priority: 0.8,
  }));

  const staticEntries: MetadataRoute.Sitemap = [
    {
      url: `${siteUrl}/gta6`,
      changeFrequency: 'weekly',
      priority: 0.7,
    },
    {
      url: `${siteUrl}/gta6/guides`,
      changeFrequency: 'daily',
      priority: 0.6,
    },
    {
      url: `${siteUrl}/`,
      changeFrequency: 'daily',
      priority: 0.9,
    },
    {
      url: `${siteUrl}/rankings`,
      changeFrequency: 'daily',
      priority: 0.7,
    },
    {
      url: `${siteUrl}/crates`,
      changeFrequency: 'monthly',
      priority: 0.4,
    },
    {
      url: `${siteUrl}/board`,
      changeFrequency: 'daily',
      priority: 0.7,
    },
    {
      url: `${siteUrl}/stats`,
      changeFrequency: 'daily',
      priority: 0.6,
    },
    {
      url: `${siteUrl}/weapons`,
      changeFrequency: 'weekly',
      priority: 0.5,
    },
    {
      url: `${siteUrl}/backpack`,
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
      .select('id, category, created_at')
      .eq('status', 'published')
      .order('created_at', { ascending: false })
      .limit(100);

    if (posts) {
      postEntries = posts.map((post) => ({
        url: `${siteUrl}${postBasePath(post.category)}/${post.id}`,
        lastModified: new Date(post.created_at),
        changeFrequency: 'weekly',
        priority: 0.6,
      }));
    }
  } catch (error) {
    console.error('[Sitemap] Failed to fetch posts:', error);
  }

  // 최근 30일 안에 2번 이상 검색된 공개 플레이어 전적 페이지(최대 1000명, 하루 캐시)
  const playerEntries: MetadataRoute.Sitemap = (await listPublicPlayersForSitemap().catch((error) => {
    console.error('[Sitemap] Failed to fetch players:', error);
    return [];
  })).map((player) => ({
    url: `${siteUrl}/stats/${player.platform}/${encodeURIComponent(player.nickname)}`,
    ...(player.updatedAt ? { lastModified: new Date(player.updatedAt) } : {}),
    changeFrequency: 'daily',
    priority: 0.5,
  }));

  // LoL은 증바람 페이지만 검색에 싣고, 공개 설정이 꺼져 있으면 넣지 않는다.
  const mayhemEntries: MetadataRoute.Sitemap = [];
  if (process.env.LOL_PUBLIC_ENABLED === 'true') {
    mayhemEntries.push({ url: `${siteUrl}${MAYHEM_PATH}`, changeFrequency: 'daily', priority: 0.7 });
    const [champions, tips] = await Promise.all([
      getLolChampions().catch(() => null),
      process.env.LOL_MAYHEM_TIPS_ENABLED === 'true' ? listMayhemTipSitemap().catch(() => []) : [],
    ]);
    for (const champion of champions?.champions ?? []) {
      mayhemEntries.push({ url: `${siteUrl}${mayhemChampionPath(champion.imageId)}`, changeFrequency: 'daily', priority: 0.6 });
    }
    for (const tip of tips) {
      mayhemEntries.push({ url: `${siteUrl}${mayhemTipPath(tip.id)}`, lastModified: new Date(tip.updated_at ?? tip.created_at), changeFrequency: 'weekly', priority: 0.5 });
    }
  }

  return [...staticEntries, ...mapEntries, ...postEntries, ...playerEntries, ...mayhemEntries];
}
