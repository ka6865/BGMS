/**
 * 서비스가 지원하는 지도 ID 정의.
 *
 * `/maps/[mapId]` 라우트와 SEO 메타데이터가 같은 목록을 공유해
 * 지원하지 않는 지도 주소가 빈 지도로 노출되지 않게 한다.
 */
export const SUPPORTED_MAP_IDS = [
  'Erangel',
  'Miramar',
  'Taego',
  'Rondo',
  'Vikendi',
  'Deston',
] as const;

export type SupportedMapId = (typeof SUPPORTED_MAP_IDS)[number];

/**
 * URL 세그먼트(예: `erangel`)를 내부 지도 ID(`Erangel`)로 변환한다.
 * 지원하지 않는 값이면 null 을 반환한다.
 */
export function resolveMapIdFromSlug(slug: string): SupportedMapId | null {
  const normalized = slug.trim().toLowerCase();
  return (
    SUPPORTED_MAP_IDS.find((mapId) => mapId.toLowerCase() === normalized) ?? null
  );
}
