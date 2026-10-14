const PLATFORM_PREFIXED_NICKNAME = /^(steam|kakao):(.+)$/;

/**
 * 닉네임 옵션 값을 해석한다. 자동완성 선택값은 `플랫폼:닉네임` 형식이며,
 * PUBG 닉네임에는 `:`가 없으므로 직접 입력한 닉네임과 구분된다.
 */
export function parseNicknameOption(value: unknown): { nickname: string; platform: string | null } {
  const raw = typeof value === "string" ? value.trim() : "";
  const prefixed = raw.match(PLATFORM_PREFIXED_NICKNAME);
  return prefixed
    ? { nickname: prefixed[2].trim(), platform: prefixed[1] }
    : { nickname: raw, platform: null };
}
