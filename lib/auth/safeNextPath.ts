export const DEFAULT_NEXT_PATH = "/maps/erangel";

const CONTROL_CHARACTER = /[\u0000-\u001f\u007f]/;

/** Keep post-login redirects on this origin and reject browser-normalized protocol-relative paths. */
export function safeNextPath(value: string | null | undefined, fallback = DEFAULT_NEXT_PATH): string {
  if (!value || value.length > 2_048 || value !== value.trim()) return fallback;
  if (!value.startsWith("/") || value.startsWith("//") || value.includes("\\") || CONTROL_CHARACTER.test(value)) {
    return fallback;
  }
  return value;
}
