import { Metadata } from 'next';
import { cache } from 'react';
import { BreadcrumbList, ArticleSchema } from '@/types/seo';
import { createClient } from '@/utils/supabase/server';
import { toBoardImageProxyUrl } from '@/lib/board-image-proxy';

// 환경 변수 정기화 유틸리티 (항시 최상단 위치)
const clean = (val: string | undefined) => (val || '').replace(/['";\s]+/g, '').trim();

const baseUrl = clean(process.env.NEXT_PUBLIC_SITE_URL) || "https://bgms.kr";

export const tabMetadata: Record<string, { title: string; desc: string }> = {
  Erangel: { title: "에란겔(Erangel) 고젠 위치 및 비밀의 열쇠 지도", desc: "배그 에란겔 맵의 모든 고정 젠(고젠) 차량/보트 위치와 비밀의 열쇠 및 비밀방 상세 정보를 BGMS에서 확인하세요." },
  Miramar: { title: "미라마(Miramar) 고젠 및 비밀방 위치 지도", desc: "미라마 맵의 고정 차량(고젠) 스폰 지역과 황금 미라도, 비밀방 위치 등 핵심 전술 정보를 BGMS에서 확인하세요." },
  Taego: { title: "테이고(태이고) 고젠 및 비밀의 열쇠 위치 지도", desc: "테이고(Taego) 맵의 고정 탈것 장소와 포터, 비밀의 열쇠 및 비밀방 상세 위치를 확인하세요." },
  Rondo: { title: "론도(Rondo) 고젠 및 비밀의 열쇠/비밀방 위치 지도", desc: "론도 맵의 고정 젠 차량 위치와 비밀의 열쇠 및 비밀방 상세 정보를 BGMS에서 확인하세요." },
  Vikendi: { title: "비켄디(Vikendi) 고젠 위치 및 전술 지도", desc: "비켄디 리본 맵의 고정 차량 스폰(고젠) 위치와 스노우모빌 정보, 주요 파밍 지역과 이동 동선을 BGMS 지도에서 한눈에 확인하세요." },
  Deston: { title: "데스턴(Deston) 고젠 위치 및 전술 지도", desc: "데스턴 맵의 고정 젠 차량 및 에어보트 위치와 주요 파밍 루트, 핵심 전술 지점을 BGMS 지도에서 확인하세요." },
  Stats: { title: "배그 전적 검색 및 실시간 딜량 계산기", desc: "배틀그라운드 시즌별 전적과 평균 딜량, 킬뎃 정보를 즉시 조회하고 AI가 분석한 경기별 코칭과 스쿼드 비교를 확인하세요." },
  Board: { title: "생존자 커뮤니티 및 고젠 공략 게시판", desc: "배틀그라운드 최신 업데이트 소식과 유저들의 고젠 공략을 공유하는 공간입니다." }
};


/**
 * 포스트 데이터를 조회합니다. (React cache로 중복 쿼리 방지)
 */
const getPostData = cache(async (postId: string) => {
  try {
    const numericPostId = Number(postId);
    if (!Number.isSafeInteger(numericPostId) || numericPostId <= 0) return null;

    // 🌟 검증된 서버용 클라이언트 사용
    const supabase = await createClient();

    const { data: post, error } = await supabase
      .from('posts')
      .select('id, title, content, category, author, created_at, image_url')
      .eq('id', numericPostId)
      .maybeSingle();

    if (error) throw new Error('게시글 메타데이터 조회 실패', { cause: error });
    return post;
  } catch (e) {
    console.error('getPostData error:', e);
    throw e;
  }
});

/**
 * 포스트 메타데이터를 생성합니다.
 */
export async function getPostMetadata(postId: string): Promise<Metadata | null> {
  const post = await getPostData(postId);
  if (!post) return null;

  const rawText = post.content?.replace(/<[^>]*>/g, ' ').replace(/&nbsp;/g, ' ').replace(/\s+/g, ' ').trim() || '';
  // 본문이 짧은 글은 검색 결과 설명이 비지 않도록 제목과 카테고리로 보충한다
  const plainText = (rawText.length >= 40 ? rawText : `${rawText} ${post.title} - ${post.category} 게시글입니다. BGMS 커뮤니티에서 확인하세요.`.trim()).substring(0, 150);
  const shortTitle = post.title.length > 40 ? `${post.title.substring(0, 39)}…` : post.title;
  const canonicalUrl = `${baseUrl}/board/${postId}`;
  const imageUrl = post.image_url ? toBoardImageProxyUrl(post.image_url, baseUrl) : `${baseUrl}/logo.png`;
  
  return {
    title: `${shortTitle} | ${post.category}`,
    description: plainText,
    alternates: { canonical: canonicalUrl },
    openGraph: {
      title: `${post.title} - BGMS`,
      description: plainText,
      url: canonicalUrl,
      type: 'article',
      publishedTime: post.created_at,
      modifiedTime: post.created_at,
      authors: [post.author],
      images: [imageUrl],
    },
    twitter: {
      card: 'summary_large_image',
      title: `${post.title} - BGMS`,
      description: plainText,
      images: [imageUrl],
    }
  };
}

/**
 * 탭별 SEO 정보를 생성합니다.
 */
export function getTabSeo(tab: string): Metadata {
  const currentMeta = tabMetadata[tab] || { 
    title: "배틀그라운드 통합 지도 및 전략 서비스", 
    desc: "모든 맵의 차량 위치와 실시간 전적, 아이템 무게 계산기를 제공하는 전문 전술 플랫폼입니다." 
  };

  const path = tab === "Erangel" ? "maps/erangel" : 
               tab === "Board" ? "board" : 
               tab === "Stats" ? "stats" : 
               `maps/${tab.toLowerCase()}`;

  const canonicalUrl = `${baseUrl}/${path}`;

  return {
    title: currentMeta.title,
    description: currentMeta.desc,
    alternates: { canonical: canonicalUrl },
    openGraph: {
      title: `${currentMeta.title} - BGMS`,
      description: currentMeta.desc,
      url: canonicalUrl,
      images: [
        ["Erangel", "Miramar", "Taego", "Rondo", "Vikendi", "Deston"].includes(tab)
          ? `${baseUrl}/tiles/${tab}/0/0/-1.jpg`
          : `${baseUrl}/logo.png`,
      ],
    }
  };
}

/**
 * 브레드크럼(Breadcrumb) JSON-LD를 생성합니다.
 */
export function getBreadcrumbJsonLd(items: { name: string; item: string }[]): BreadcrumbList {
  return {
    "@context": "https://schema.org",
    "@type": "BreadcrumbList",
    itemListElement: items.map((item, index) => ({
      "@type": "ListItem",
      position: index + 1,
      name: item.name,
      item: item.item.startsWith('http') ? item.item : `${baseUrl}${item.item.startsWith('/') ? '' : '/'}${item.item}`,
    })),
  };
}

/**
 * 게시글 상세용 Article JSON-LD를 생성합니다.
 */
export async function getPostArticleJsonLd(postId: string): Promise<ArticleSchema | null> {
  const post = await getPostData(postId);
  if (!post) return null;

  const plainText = post.content?.replace(/<[^>]*>/g, '').substring(0, 150) || '';
  const imageUrl = post.image_url ? toBoardImageProxyUrl(post.image_url, baseUrl) : `${baseUrl}/logo.png`;
  return {
    "@context": "https://schema.org",
    "@type": "Article",
    headline: post.title,
    description: plainText,
    image: imageUrl,
    datePublished: post.created_at,
    dateModified: post.created_at, // updated_at 대신 created_at 사용
    author: {
      "@type": "Person",
      name: post.author,
    },
    publisher: {
      "@type": "Organization",
      name: "BGMS",
      logo: {
        "@type": "ImageObject",
        url: `${baseUrl}/logo.png`,
      },
    },
  };
}
