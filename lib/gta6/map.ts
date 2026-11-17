export const CATEGORIES = {
  all: { label: "전체 장소", color: "#efb64b" },
  hotel: { label: "호텔", color: "#de9fba" },
  residential: { label: "주거", color: "#bdabdf" },
  retail: { label: "상점", color: "#efb64b" },
  restaurant: { label: "음식점", color: "#ed997e" },
  transportation: { label: "교통", color: "#9cbfe1" },
  natural: { label: "자연", color: "#92c6a5" },
  leisure: { label: "여가", color: "#b6cd8e" },
  landmark: { label: "명소", color: "#e7cf94" },
  government: { label: "공공 기관", color: "#b7c9dc" },
  public: { label: "공공 시설", color: "#b7c9dc" },
  industrial: { label: "산업", color: "#b7bbc7" },
  agriculture: { label: "농업", color: "#b6cd8e" },
  construction: { label: "건설", color: "#ed997e" },
  utilities: { label: "기반 시설", color: "#b7bbc7" },
  office: { label: "업무", color: "#9cbfe1" },
  mixed: { label: "복합 시설", color: "#bdabdf" },
  other: { label: "기타", color: "#b7bbc7" },
} as const;

export type Category = keyof typeof CATEGORIES;
export type Landmark = {
  id: string;
  name: string;
  address: string;
  coordinates: [number, number];
  realAddress: string;
  category: Category;
  unconfirmed: boolean;
  search: string;
};
export type Progress = { version: 1; favorites: string[]; visited: string[] };
export const STORAGE_KEY = "bgms:gta6:progress:v1";
export const TILE_BOUNDS: [[number, number], [number, number]] = [[-25600, 5376], [-5376, 26624]];
export const MAP_BOUNDS: [[number, number], [number, number]] = [TILE_BOUNDS[0], [-5376, 19884]];
const validId = /^L[1-9]\d*$/;

const regions: Record<string, string> = {
  "Vice City": "바이스 시티", "Vice Beach": "바이스 비치", "Ocean Beach": "오션 비치",
  "Washington Beach": "워싱턴 비치", "Port Gellhorn": "포트 겔혼", "Key Lento": "키 렌토",
  "Leonida Keys": "레오니다 키스", "Leonida": "레오니다", "Crosstown": "크로스타운",
  "Ambrosia": "앰브로시아", "Grassrivers": "그래스리버스", "Mount Kalaga": "칼라가 산",
  "Kelly County": "켈리 카운티", "Lummox County": "러먹스 카운티", "Hamlet": "햄릿",
};
const names: Record<string, string> = {
  L16: "Y 바이스 시티", L17: "크리스털", L20: "디 아톨", L25: "도미니언 호텔",
  L101: "바이스 비치 환영 벽화", L172: "잭 오브 하츠", L266: "제이슨의 집",
  L308: "알파 주유소", L317: "보카마르 다리", L360: "사라의 미용실", L530: "칼라가 산",
};

export function parseLandmarks(input: unknown): Landmark[] {
  if (!input || typeof input !== "object" || Array.isArray(input)) throw new Error("장소 데이터 형식 오류");
  return Object.entries(input).flatMap(([id, row]) => {
    if (!validId.test(id) || !Array.isArray(row) || typeof row[0] !== "string" ||
      !Array.isArray(row[1]) || typeof row[3] !== "string" || !Array.isArray(row[6]) ||
      !row[6].every((tag: unknown) => typeof tag === "string")) throw new Error(`장소 데이터 오류: ${id}`);
    if (row[1].length === 0) return [];
    if (row[1].length !== 2 || !row[1].every((n: unknown) => typeof n === "number" && Number.isFinite(n) && Math.abs(n) <= 16384)) {
      throw new Error(`장소 좌표 오류: ${id}`);
    }
    const tags: string[] = row[6];
    const category = tags.find((tag): tag is Category => tag !== "all" && Object.hasOwn(CATEGORIES, tag)) ?? "other";
    const originalName = row[0].split(",")[0].trim();
    const name = names[id] ?? (originalName && !originalName.startsWith("?") ? originalName : `이름 미확인 · ${CATEGORIES[category].label}`);
    const aliases = Object.entries(regions).filter(([english]) => row[0].includes(english)).map(([, korean]) => korean);
    return [{ id, name, address: row[0], coordinates: row[1] as [number, number], realAddress: row[3], category,
      unconfirmed: tags.includes("unconfirmed"),
      search: [id, name, row[0], CATEGORIES[category].label, ...aliases].join(" ").toLocaleLowerCase("ko-KR") }];
  });
}

export function filterLandmarks(places: Landmark[], query: string, category: Category): Landmark[] {
  const words = query.trim().toLocaleLowerCase("ko-KR").split(/\s+/).filter(Boolean);
  return places.filter(place => (category === "all" || place.category === category) && words.every(word => place.search.includes(word)));
}

// 원본 z=5의 픽셀 좌표를 CRS.Simple의 북쪽 양수 좌표와 맞춘다.
export function worldToMap([x, y]: [number, number]): [number, number] {
  return [y - 16384, x + 16384];
}

// 경계에 걸친 타일도 잘라내야 축소·이동 중 원본 설명판이 다시 나타나지 않는다.
export function tileCropRight(column: number, zoom: number): number {
  return Math.max(0, Math.min(256, (column + 1) * 256 - MAP_BOUNDS[1][1] * 2 ** zoom));
}

export function parseProgress(raw: string | null): Progress {
  const empty: Progress = { version: 1, favorites: [], visited: [] };
  if (!raw) return empty;
  try {
    const value = JSON.parse(raw);
    if (!value || value.version !== 1) return empty;
    const ids = (input: unknown) => Array.isArray(input)
      ? [...new Set(input.filter((id): id is string => typeof id === "string" && validId.test(id)))] : [];
    return { version: 1, favorites: ids(value.favorites), visited: ids(value.visited) };
  } catch { return empty; }
}
