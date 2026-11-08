const IMG_TAG = /<img\b([^>]*?)(\s*\/?)>/gi;
const FILLED_ALT = /\balt\s*=\s*(?:"[^"]*[^\s"][^"]*"|'[^']*[^\s'][^']*'|[^\s"'>]+)/i;
const BLANK_ALT = /\s+alt\s*=\s*(?:""|'')/gi;

function escapeAttr(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/**
 * alt 가 없거나 비어 있는 게시글 이미지에 대체 텍스트를 채웁니다.
 * 저장된 본문은 건드리지 않고 렌더링 시점에만 적용하므로 과거 글에도 동일하게 반영됩니다.
 * 이미 alt 가 있는 이미지는 그대로 둡니다.
 */
export function fillMissingImageAlt(html: string, fallbackAlt: string): string {
  const alt = escapeAttr(fallbackAlt.trim() || "게시글 이미지");
  return html.replace(IMG_TAG, (tag, attrs: string, close: string) => {
    if (FILLED_ALT.test(attrs)) return tag;
    const rest = attrs.replace(BLANK_ALT, "");
    return `<img${rest} alt="${alt}"${close}>`;
  });
}
