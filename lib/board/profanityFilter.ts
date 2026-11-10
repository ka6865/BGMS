/**
 * @fileoverview 한국어 비속어 필터
 *
 * 텍스트 정규화(공백, 특수문자, 유사 문자 변환) 및
 * 한글 자모 분해 패턴 검사를 통해 비속어를 탐지합니다.
 */

// 유사 문자 치환 매핑 (leetspeak 및 특수문자 우회 방지)
const SIMILAR_CHARS: Record<string, string> = {
  "0": "o",
  "1": "i",
  "3": "e",
  "@": "a",
  "$": "s",
  "!": "i",
  "ㅣ": "l",
  "ㅡ": "-",
  "丨": "l",
  "ᄉ": "ㅅ",
  "ᄇ": "ㅂ",
  "ᄌ": "ㅈ",
};

// 한국어 비속어 사전 (정규화 후 매칭)
const PROFANITY_WORDS: string[] = [
  "시발",
  "씨발",
  "씨팔",
  "시팔",
  "씨벌",
  "시벌",
  "씹",
  "병신",
  "빙신",
  "byungsin",
  "지랄",
  "찐따",
  "찐다",
  "개새끼",
  "개세끼",
  "개쉐끼",
  "개색기",
  "개색끼",
  "좆",
  "졸라",
  "존나",
  "ㅈㄴ",
  "꺼져",
  "닥쳐",
  "느금마",
  "느금",
  "니엄마",
  "니미",
  "니애미",
  "미친년",
  "미친놈",
  "미친새끼",
  "엠창",
  "엠생",
  "한남",
  "한녀",
  "보지",
  "자지",
  "걸레",
  "창녀",
  "화냥년",
  "쌍년",
  "쌍놈",
  "등신",
  "애미",
  "애비",
  "새끼",
  "쒸발",
  "씌발",
  "시이발",
  "씨이발",
  "시1발",
  "씨1발",
  "ㅗ",
];

// 한글 자모 조합 패턴 (ㅅㅂ, ㅄ, ㅈㄹ 등 초성 비속어)
const JAMO_PATTERNS: RegExp[] = [
  /ㅅㅂ/,
  /ㅄ/,
  /ㅂㅅ/,
  /ㅈㄹ/,
  /ㅆㅂ/,
  /ㄲㅈ/,
  /ㄷㅊ/,
  /ㅅㅅㅂ/,
  /ㄱㅅㄲ/,
  /ㅁㅊ/,
  /ㄴㄱㅁ/,
  /ㅈㄴ/,
  /ㅗㅗ/,
];

/**
 * 텍스트 정규화: 공백, 특수문자 제거, 유사 문자 변환, 소문자 통일
 */
function normalizeText(text: string): string {
  let normalized = text.toLowerCase();

  // 유사 문자 치환
  for (const [from, to] of Object.entries(SIMILAR_CHARS)) {
    normalized = normalized.replaceAll(from, to);
  }

  // 공백, 점, 언더스코어, 하이픈 등 삽입 우회 방지
  normalized = normalized.replace(/[\s._\-*~`'"·•=+\\|<>]/g, "");

  return normalized;
}

/**
 * 한글 유니코드를 자모로 분해
 * 예: '시' → 'ㅅㅣ', '발' → 'ㅂㅏㄹ'
 */
function decomposeHangul(text: string): string {
  const CHO = [
    "ㄱ", "ㄲ", "ㄴ", "ㄷ", "ㄸ", "ㄹ", "ㅁ", "ㅂ", "ㅃ",
    "ㅅ", "ㅆ", "ㅇ", "ㅈ", "ㅉ", "ㅊ", "ㅋ", "ㅌ", "ㅍ", "ㅎ",
  ];
  const JUNG = [
    "ㅏ", "ㅐ", "ㅑ", "ㅒ", "ㅓ", "ㅔ", "ㅕ", "ㅖ", "ㅗ", "ㅘ",
    "ㅙ", "ㅚ", "ㅛ", "ㅜ", "ㅝ", "ㅞ", "ㅟ", "ㅠ", "ㅡ", "ㅢ", "ㅣ",
  ];
  const JONG = [
    "", "ㄱ", "ㄲ", "ㄳ", "ㄴ", "ㄵ", "ㄶ", "ㄷ", "ㄹ", "ㄺ",
    "ㄻ", "ㄼ", "ㄽ", "ㄾ", "ㄿ", "ㅀ", "ㅁ", "ㅂ", "ㅄ", "ㅅ",
    "ㅆ", "ㅇ", "ㅈ", "ㅊ", "ㅋ", "ㅌ", "ㅍ", "ㅎ",
  ];

  let result = "";
  for (const char of text) {
    const code = char.charCodeAt(0);
    // 한글 음절 범위: 0xAC00 ~ 0xD7A3
    if (code >= 0xac00 && code <= 0xd7a3) {
      const offset = code - 0xac00;
      const choIdx = Math.floor(offset / (21 * 28));
      const jungIdx = Math.floor((offset % (21 * 28)) / 28);
      const jongIdx = offset % 28;
      result += CHO[choIdx] + JUNG[jungIdx] + JONG[jongIdx];
    } else {
      result += char;
    }
  }
  return result;
}

export interface ProfanityResult {
  blocked: boolean;
  matchedWord?: string;
}

/**
 * 비속어 검사 메인 함수
 * 정규화된 텍스트와 자모 분해 텍스트 양쪽에서 비속어 패턴을 탐지합니다.
 */
export function checkProfanity(text: string): ProfanityResult {
  if (!text || text.trim().length === 0) {
    return { blocked: false };
  }

  const normalized = normalizeText(text);
  const decomposed = decomposeHangul(normalized);

  // 1. 사전 기반 매칭 (정규화된 텍스트에서 검색)
  for (const word of PROFANITY_WORDS) {
    const normalizedWord = normalizeText(word);
    if (normalized.includes(normalizedWord)) {
      return { blocked: true, matchedWord: word };
    }
    // 완성형 한글로만 이루어진 단어의 경우에만 자모 분해 매칭을 시도하여
    // '오'의 'ㅗ' 모음이 단독 자모 비속어 'ㅗ'에 오탐지되는 것을 방지합니다.
    const isCompleteHangul = /^[가-힣]+$/.test(word);
    if (isCompleteHangul) {
      const decomposedWord = decomposeHangul(normalizedWord);
      if (decomposed.includes(decomposedWord)) {
        return { blocked: true, matchedWord: word };
      }
    }
  }

  // 2. 자모 패턴 매칭 (ㅅㅂ, ㅄ 등 초성 비속어)
  // 사용자가 직접 친 자모만 본다. 분해한 글자에서 찾으면 '멈춰'(ㅁㅊ), '받침'(ㄷㅊ)처럼 받침과 다음 초성이 이어져 오탐지된다.
  for (const pattern of JAMO_PATTERNS) {
    if (pattern.test(normalized)) {
      return { blocked: true, matchedWord: pattern.source };
    }
  }

  return { blocked: false };
}
