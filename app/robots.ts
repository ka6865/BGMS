import { MetadataRoute } from 'next';

export const dynamic = 'force-static';

export default function robots(): MetadataRoute.Robots {
  return {
    rules: {
      userAgent: '*',
      // 랭킹 본문 렌더링에 필요한 공개 조회만 허용한다.
      allow: ['/', '/api/rankings$', '/api/rankings?'],
      disallow: [
        '/admin',
        '/login',
        '/map-editor',
        '/api',
      ],
    },
    sitemap: `${process.env.NEXT_PUBLIC_SITE_URL || 'https://bgms.kr'}/sitemap.xml`,
  };
}
