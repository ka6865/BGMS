import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  trailingSlash: false,
  allowedDevOrigins: [
    'localhost',
    '127.0.0.1',
    ...(process.env.BGMS_TAILSCALE_DEV_HOST ? [process.env.BGMS_TAILSCALE_DEV_HOST] : []),
  ],
  images: {
    /*
      허용 호스트를 와일드카드로 열어두면 제3자가 임의 외부 이미지를
      우리 이미지 최적화 쿼터로 변환할 수 있다. 실제 사용 호스트만 허용한다.
    */
    remotePatterns: [
      {
        protocol: 'https',
        hostname: 'kolwueoejdasoqyopkao.supabase.co',
        pathname: '/storage/v1/object/public/**',
      },
      {
        protocol: 'https',
        hostname: 'wstatic-prod-boc.krafton.com',
        pathname: '/**',
      },
      {
        protocol: 'https',
        hostname: '*.daumcdn.net',
        pathname: '/**',
      },
    ],
  },
  async headers() {
    return [{ source: '/lol/augment-art/:path*', headers: [
      { key: 'Cache-Control', value: 'public, max-age=31536000, immutable' },
      { key: 'X-Content-Type-Options', value: 'nosniff' },
    ] }, { source: '/gta6/tiles/:path*', headers: [
      // 타일 경로에 지도 버전이 들어 있어 내용이 바뀌지 않는다.
      { key: 'Cache-Control', value: 'public, max-age=31536000, immutable' },
      { key: 'X-Content-Type-Options', value: 'nosniff' },
    ] }, { source: '/api/rankings', headers: [
      { key: 'X-Robots-Tag', value: 'noindex' },
    ] }];
  },
  async redirects() {
    return [
      // 총기 메타 시험 페이지는 무기도감 안의 대시보드로 통합했다.
      { source: '/meta', destination: '/weapons', permanent: true },
    ];
  },
};

export default nextConfig;
