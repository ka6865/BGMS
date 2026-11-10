import { createHash, createHmac, hkdfSync, timingSafeEqual } from "node:crypto";

// Riot 운영 키 승인 전에는 Riot API 데이터 화면을 심사용 비밀번호로만 연다. proxy.ts와 API가 함께 쓴다.
export const LOL_PREVIEW_COOKIE = "bgms_lol_preview";
export const LOL_PREVIEW_MAX_AGE = 7 * 24 * 60 * 60;
export const LOL_PREVIEW_PATH = "/lol/kr/preview";

// 새 LoL 경로는 기본으로 잠긴다. Riot API 키 없이 만드는 증바람 자료만 공개한다.
const OPEN_PAGES = ["/lol/kr/aram-mayhem", LOL_PREVIEW_PATH];
const OPEN_APIS = ["/api/lol/mayhem", "/api/lol/augment-icons", "/api/lol/preview"];
const under = (path: string, base: string) => path === base || path.startsWith(`${base}/`);

export function lolRiotDataPublic(): boolean {
  return process.env.LOL_RIOT_DATA_PUBLIC === "true";
}

export function lolRiotLockedPath(pathname: string): "page" | "api" | null {
  if (under(pathname, "/api/lol")) return OPEN_APIS.some(base => under(pathname, base)) ? null : "api";
  if (under(pathname, "/lol/kr")) return OPEN_PAGES.some(base => under(pathname, base)) ? null : "page";
  return null;
}

function previewKeys(): { key: Buffer; password: string } | null {
  const secret = process.env.LOL_PARTICIPANT_REF_SECRET?.trim();
  const password = process.env.LOL_PREVIEW_PASSWORD ?? "";
  if (!secret || !password) return null;
  return { key: Buffer.from(hkdfSync("sha256", secret, "bgms-lol", "preview-cookie:v1", 32)), password };
}

export function lolPreviewPasswordEnabled(): boolean {
  return previewKeys() !== null;
}

// 서명에 비밀번호 해시를 넣어, 비밀번호를 바꾸면 이미 발급한 쿠키가 모두 무효가 된다.
function sign(key: Buffer, password: string, expiresAt: number): string {
  const passwordHash = createHash("sha256").update(password).digest("hex");
  return createHmac("sha256", key).update(`${expiresAt}.${passwordHash}`).digest("base64url");
}

const sameText = (a: string, b: string) => {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  return left.length === right.length && timingSafeEqual(left, right);
};

export function checkLolPreviewPassword(input: string): boolean {
  const keys = previewKeys();
  if (!keys) return false;
  const digest = (value: string) => createHmac("sha256", keys.key).update(value).digest("base64url");
  return sameText(digest(input), digest(keys.password));
}

export function createLolPreviewToken(now = Date.now()): string | null {
  const keys = previewKeys();
  if (!keys) return null;
  const expiresAt = Math.floor(now / 1000) + LOL_PREVIEW_MAX_AGE;
  return `${expiresAt}.${sign(keys.key, keys.password, expiresAt)}`;
}

export function verifyLolPreviewToken(token: string | undefined, now = Date.now()): boolean {
  const keys = previewKeys();
  const match = token ? /^(\d{1,12})\.([\w-]{43})$/.exec(token) : null;
  if (!keys || !match) return false;
  const expiresAt = Number(match[1]);
  return expiresAt > Math.floor(now / 1000) && sameText(match[2], sign(keys.key, keys.password, expiresAt));
}

export function hasLolRiotAccess(token: string | undefined): boolean {
  return lolRiotDataPublic() || verifyLolPreviewToken(token);
}

// 잠금 화면에서 돌아갈 경로는 잠긴 LoL 내부 경로만 허용한다.
export function safeLolPreviewNext(value: unknown): string {
  if (typeof value !== "string" || value.length > 512 || !value.startsWith("/lol/") || value.startsWith("//") || /[\\\u0000-\u001f]/.test(value)) return "/lol/kr";
  return lolRiotLockedPath(new URL(value, "http://localhost").pathname) === "page" ? value : "/lol/kr";
}
