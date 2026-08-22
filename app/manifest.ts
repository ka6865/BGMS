import { MetadataRoute } from 'next'

export const dynamic = 'force-static'

export default function manifest(): MetadataRoute.Manifest {
  return {
    name: 'BGMS | 배그 고젠 및 통합 지도',
    short_name: 'BGMS',
    description: '배틀그라운드 모든 맵의 고정 젠(고젠) 위치와 전술 정보를 제공합니다.',
    start_url: '/',
    display: 'standalone',
    background_color: '#121212',
    theme_color: '#F2A900',
    icons: [
      {
        src: '/icon.png',
        sizes: '512x512',
        type: 'image/png',
      },
      {
        src: '/icon-192.png',
        sizes: '192x192',
        type: 'image/png',
      },
      {
        src: '/icon-512.png',
        sizes: '512x512',
        type: 'image/png',
      },
    ],
  }
}
