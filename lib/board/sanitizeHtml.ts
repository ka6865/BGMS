/**
 * @fileoverview 서버에서 동작하는 게시글 본문 HTML 정화기입니다.
 *
 * 배경: components/board/BoardDetailClient.tsx 의 sanitizeHTML 은 브라우저 전용
 * dompurify 를 쓰기 때문에 SSR 단계와 hydration 이전에는 원본 HTML 을 그대로 반환했습니다.
 * 게시글 본문에는 사용자 입력뿐 아니라 AI 가 생성한 HTML 과 외부 크롤링 결과도 들어가므로
 * 서버 렌더링 시점과 DB 저장 시점 모두에서 정화가 필요합니다.
 *
 * 새 의존성을 추가하지 않기 위해 이미 서버에서 사용 중인 node-html-parser 로 구현했습니다.
 * 허용 목록은 클라이언트 dompurify 설정과 동일하게 유지합니다.
 */

import { parse, HTMLElement, NodeType, type Node } from "node-html-parser";

/** 클라이언트 DOMPurify ALLOWED_TAGS 와 동일하게 유지해야 합니다. */
export const ALLOWED_TAGS = new Set([
  "p", "br", "strong", "em", "u", "s", "ul", "ol", "li",
  "h1", "h2", "h3", "blockquote", "img", "a", "span", "iframe", "div",
]);

/** 클라이언트 DOMPurify ALLOWED_ATTR 와 동일하게 유지해야 합니다. */
export const ALLOWED_ATTRIBUTES = new Set([
  "href", "target", "rel", "src", "style", "class",
  "width", "height", "alt", "title",
  "frameborder", "allow", "allowfullscreen",
]);

/** 태그 자체와 내용을 모두 제거할 요소 */
const DROP_WITH_CONTENT = new Set([
  "script", "style", "noscript", "template", "object", "embed", "svg", "math",
  "form", "input", "button", "select", "textarea", "link", "meta", "base",
]);

/** src / href 에 허용할 스킴. 상대 경로도 허용합니다. */
const SAFE_URL_SCHEMES = ["http:", "https:", "mailto:"];

/**
 * iframe src 로 허용할 호스트.
 * iframe 은 임의 페이지를 삽입할 수 있으므로 상대 경로와 프로토콜 상대 URL(//host)을
 * 허용하면 같은 도메인의 다른 화면을 끼워 넣거나 외부 피싱 페이지를 띄울 수 있습니다.
 * 게시글에서 필요한 용도는 동영상 임베드뿐이라 해당 호스트만 통과시킵니다.
 */
const IFRAME_ALLOWED_HOSTS = new Set([
  "www.youtube.com",
  "youtube.com",
  "www.youtube-nocookie.com",
  "youtube-nocookie.com",
  "player.vimeo.com",
  "www.twitch.tv",
  "player.twitch.tv",
  "clips.twitch.tv",
  "tv.naver.com",
]);

/** 제어문자를 끼워 넣어 javascript: 등을 우회하는 형태를 정규화합니다. */
function normalizeUrlForCheck(value: string): string {
  return value.trim().replace(/[\u0000-\u0020]/g, "").toLowerCase();
}

function isDangerousScheme(normalized: string): boolean {
  if (normalized.startsWith("javascript:") || normalized.startsWith("vbscript:")) return true;
  // data: URI 는 이미지 인라인 삽입 우회 경로가 되므로 전면 차단합니다.
  if (normalized.startsWith("data:")) return true;
  return false;
}

function isSafeUrl(value: string): boolean {
  const trimmed = value.trim();
  if (trimmed === "") return false;

  const normalized = normalizeUrlForCheck(trimmed);
  if (isDangerousScheme(normalized)) return false;

  // 스킴이 없으면 상대 경로로 보고 허용합니다.
  const schemeMatch = /^([a-z][a-z0-9+.-]*):/i.exec(normalized);
  if (!schemeMatch) return true;
  return SAFE_URL_SCHEMES.includes(schemeMatch[1].toLowerCase() + ":");
}

/** iframe src 는 https 절대 URL + 호스트 화이트리스트만 허용합니다. */
function isSafeIframeSrc(value: string): boolean {
  const normalized = normalizeUrlForCheck(value);
  if (normalized === "" || isDangerousScheme(normalized)) return false;
  // 프로토콜 상대 URL(//host/path) 차단
  if (normalized.startsWith("//")) return false;
  if (!normalized.startsWith("https://")) return false;

  try {
    return IFRAME_ALLOWED_HOSTS.has(new URL(normalized).hostname);
  } catch {
    return false;
  }
}

/**
 * style 속성에서 스크립트 실행 가능 패턴을 제거합니다.
 * 값 전체가 위험하면 빈 문자열을 반환해 속성을 떨어뜨립니다.
 */
function sanitizeStyle(value: string): string {
  const lowered = value.toLowerCase();
  if (
    lowered.includes("expression(") ||
    lowered.includes("javascript:") ||
    lowered.includes("vbscript:") ||
    lowered.includes("url(")
  ) {
    return "";
  }
  return value;
}

function sanitizeElement(element: HTMLElement): void {
  // 자식부터 처리해야 제거 후 인덱스가 흔들리지 않습니다.
  for (const child of [...element.childNodes]) {
    sanitizeNode(child, element);
  }

  const tagName = element.rawTagName?.toLowerCase() ?? "";

  for (const name of Object.keys(element.attributes)) {
    const lowerName = name.toLowerCase();
    const value = element.getAttribute(name) ?? "";

    // on* 이벤트 핸들러는 전부 제거
    if (lowerName.startsWith("on") || !ALLOWED_ATTRIBUTES.has(lowerName)) {
      element.removeAttribute(name);
      continue;
    }

    // iframe src 는 별도의 엄격한 규칙을 적용합니다.
    if (lowerName === "src" && tagName === "iframe") {
      if (!isSafeIframeSrc(value)) element.removeAttribute(name);
      continue;
    }

    if ((lowerName === "href" || lowerName === "src") && !isSafeUrl(value)) {
      element.removeAttribute(name);
      continue;
    }

    if (lowerName === "style") {
      const safeStyle = sanitizeStyle(value);
      if (safeStyle === "") element.removeAttribute(name);
      else if (safeStyle !== value) element.setAttribute(name, safeStyle);
    }
  }

  // src 가 제거된 iframe 은 빈 프레임으로 남으므로 태그 자체를 무력화합니다.
  if (tagName === "iframe" && !element.getAttribute("src")) {
    element.remove();
    return;
  }

  // 외부 링크에 noopener 를 강제합니다.
  if (tagName === "a" && element.getAttribute("target") === "_blank") {
    element.setAttribute("rel", "noopener noreferrer");
  }
}

function sanitizeNode(node: Node, parent: HTMLElement): void {
  if (node.nodeType === NodeType.COMMENT_NODE) {
    parent.removeChild(node);
    return;
  }
  if (node.nodeType !== NodeType.ELEMENT_NODE) return;

  const element = node as HTMLElement;
  const tagName = element.rawTagName?.toLowerCase() ?? "";

  if (DROP_WITH_CONTENT.has(tagName)) {
    parent.removeChild(node);
    return;
  }

  if (!ALLOWED_TAGS.has(tagName)) {
    // 허용되지 않은 태그는 내용을 살리고 태그만 벗겨냅니다.
    sanitizeElement(element);
    element.replaceWith(element.innerHTML);
    return;
  }

  sanitizeElement(element);
}

/**
 * 게시글 본문 HTML 을 허용 목록 기준으로 정화합니다.
 * 서버 컴포넌트, API 라우트, CLI 스크립트에서 모두 사용할 수 있습니다.
 */
export function sanitizeBoardHtml(html: string | null | undefined): string {
  if (!html) return "";

  const root = parse(html, {
    lowerCaseTagName: false,
    comment: true,
    blockTextElements: { script: false, noscript: false, style: false, pre: true },
  });

  for (const child of [...root.childNodes]) {
    sanitizeNode(child, root);
  }

  return root.toString();
}
