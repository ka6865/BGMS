export const LOL_RIOT_ID_ERROR = "Riot ID 형식은 게임 이름#태그입니다. 주소는 이름-태그 형식이어야 합니다.";

function validRiotId(gameName: string, tagLine: string): string | null {
  if (!gameName || !tagLine || gameName.length > 64 || tagLine.length > 16
    || /[\u0000-\u001f\u007f#]/.test(gameName + tagLine) || tagLine.includes("-")) return null;
  return `${gameName}#${tagLine}`;
}

export function parseLolRiotIdSegment(segment: string): string | null {
  try {
    const decoded = decodeURIComponent(segment);
    if (/[\u0000-\u001f\u007f]/.test(decoded)) return null;
    const separator = decoded.lastIndexOf("-");
    if (separator < 1) return null;
    return validRiotId(decoded.slice(0, separator).trim(), decoded.slice(separator + 1).trim());
  } catch {
    return null;
  }
}

// Next.js 라우트 params는 실행 경로에 따라 퍼센트 인코딩이 남아 있거나 해제된 채로 온다.
// 인코딩 흔적이 있으면 그대로 한 번 해제하고, 이미 해제된 값은 다시 인코딩해 같은 규칙으로 해석한다.
export function parseLolRiotIdParam(value: string): string | null {
  return parseLolRiotIdSegment(/%[0-9A-Fa-f]{2}/.test(value) ? value : encodeURIComponent(value));
}

export function lolRiotIdPath(input: string): string | null {
  if (/[\u0000-\u001f\u007f]/.test(input)) return null;
  const separator = input.lastIndexOf("#");
  if (separator < 1) return null;
  const gameName = input.slice(0, separator).trim();
  const tagLine = input.slice(separator + 1).trim();
  return validRiotId(gameName, tagLine) ? `/admin/lol/kr/${encodeURIComponent(`${gameName}-${tagLine}`)}` : null;
}
