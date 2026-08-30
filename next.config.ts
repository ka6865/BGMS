import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  trailingSlash: false,
  allowedDevOrigins: ['localhost:3000', '127.0.0.1:3000'],
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
};

export default nextConfig;
