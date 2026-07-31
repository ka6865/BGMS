/**
 * @fileoverview 이미 저장된 패치노트 글의 원문을 다시 수집하는 모듈입니다.
 *
 * 무기도감 갱신 제안은 패치노트 동기화 시점에만 생성되므로, 파이프라인이
 * 도입되기 전에 저장된 과거 패치노트에는 제안이 없습니다. 이 모듈은 과거
 * 글에 남아 있는 원문 링크를 이용해 본문을 다시 받아옵니다.
 *
 * 수집 대상 선택자는 기존 동기화 경로(app/api/cron/patch-notes,
 * app/api/admin/patch-notes/sync, scripts/sync_patch_notes.ts)와 동일하게 유지합니다.
 */

import { parse } from "node-html-parser";

/** 원문 수집에 사용할 User-Agent. 공식 홈페이지가 기본 UA 를 거부하는 경우가 있습니다. */
const REQUEST_USER_AGENT = "Mozilla/5.0 (Windows NT 10.0; Win64; x64)";

/** 제안 생성에 넘길 원문 최대 길이. weaponExtract 의 잘라내기 기준과 동일합니다. */
export const SOURCE_TEXT_MAX_LENGTH = 15000;

export type PatchNoteSource = "pubg" | "kakao" | "unknown";

/**
 * 저장된 게시글 본문 HTML 에서 원문 링크를 찾습니다.
 *
 * 동기화가 만든 게시글에는 "원문 보러가기" 앵커가 항상 포함되므로 이를 사용합니다.
 * 여러 링크가 있으면 패치노트 도메인에 해당하는 첫 링크를 고릅니다.
 */
export function extractSourceUrlFromContent(content: string | null | undefined): string | null {
  if (!content) return null;

  const hrefs: string[] = [];
  const pattern = /href=["'](https?:\/\/[^"']+)["']/gi;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(content)) !== null) {
    hrefs.push(match[1]);
  }
  if (hrefs.length === 0) return null;

  const known = hrefs.find((url) => detectSource(url) !== "unknown");
  return known ?? null;
}

/** URL 을 보고 어느 사이트의 패치노트인지 판정합니다. */
export function detectSource(url: string): PatchNoteSource {
  const normalized = url.toLowerCase();
  if (normalized.includes("pubg.com")) return "pubg";
  if (normalized.includes("daum.net") || normalized.includes("kakao.com")) return "kakao";
  return "unknown";
}

/** 수집한 텍스트의 공백을 정리하고 길이를 제한합니다. */
function normalizeSourceText(raw: string): string {
  return raw.replace(/\s+/g, " ").trim().slice(0, SOURCE_TEXT_MAX_LENGTH);
}

export interface FetchSourceTextResult {
  ok: boolean;
  sourceText: string;
  reason?: string;
  /** 원문이 삭제되어 더 이상 수집할 수 없는 경우 true. 재시도해도 소용이 없습니다. */
  gone?: boolean;
}

export interface FetchSourceTextDeps {
  /** 테스트에서 주입합니다. 생략하면 전역 fetch 를 사용합니다. */
  fetchImpl?: typeof fetch;
}

/**
 * 공식 홈페이지(pubg.com) 패치노트 본문을 수집합니다.
 *
 * DOM 파싱으로 얻은 텍스트가 너무 짧으면 Nuxt 인라인 데이터에서 직접 추출합니다.
 * cron 경로에 이미 적용된 보완 로직과 같은 방식입니다.
 */
async function fetchPubgSourceText(
  url: string,
  fetchImpl: typeof fetch
): Promise<FetchSourceTextResult> {
  // 공식 홈페이지는 삭제된 글을 목록 페이지로 302 리다이렉트한다.
  // redirect: manual 로 받아 리다이렉트 자체를 삭제 신호로 판정한다.
  const response = await fetchImpl(url, {
    cache: "no-store",
    redirect: "manual",
    headers: { "User-Agent": REQUEST_USER_AGENT },
  });

  if (response.status >= 300 && response.status < 400) {
    const location = response.headers.get("location") ?? "";
    if (location.includes("NOT_FOUND_POST")) {
      return {
        ok: false,
        sourceText: "",
        reason: "공식 홈페이지에서 원문이 삭제되었습니다.",
        gone: true,
      };
    }
    return {
      ok: false,
      sourceText: "",
      reason: `원문이 다른 주소로 이동했습니다 (${response.status}).`,
    };
  }

  if (response.status === 404 || response.status === 410) {
    return {
      ok: false,
      sourceText: "",
      reason: `원문을 찾을 수 없습니다 (${response.status}).`,
      gone: true,
    };
  }

  if (!response.ok) {
    return { ok: false, sourceText: "", reason: `원문 접속 실패 (${response.status})` };
  }

  const html = await response.text();
  const root = parse(html);
  const content =
    root.querySelector(".post-detail__content") ||
    root.querySelector(".news-detail__content") ||
    root.querySelector(".content-template__inner") ||
    root.querySelector("article") ||
    root.querySelector(".news-detail__body");

  let rawText = content ? content.text : "";

  if (normalizeSourceText(rawText).length < 100) {
    const nuxtMatch = html.match(/content\s*:\s*"((?:\\.|[^"\\])*)"/);
    if (nuxtMatch) {
      rawText = nuxtMatch[1].replace(/\\u002F/g, "/").replace(/\\"/g, '"');
    }
  }

  const sourceText = normalizeSourceText(rawText);
  if (!sourceText) {
    return { ok: false, sourceText: "", reason: "본문 텍스트를 찾지 못했습니다." };
  }
  return { ok: true, sourceText };
}

/**
 * 카카오 무점검 패치 본문을 수집합니다.
 *
 * 카카오 게시판은 본문을 ajax 응답으로 제공하므로 read 경로를 ajax/read 로 바꿉니다.
 * ajax 응답이 실패하면 원본 페이지 HTML 로 대체합니다.
 */
async function fetchKakaoSourceText(
  url: string,
  fetchImpl: typeof fetch
): Promise<FetchSourceTextResult> {
  const ajaxUrl = url.replace("/notice/read?", "/notice/ajax/read?");
  const candidates = ajaxUrl === url ? [url] : [ajaxUrl, url];
  let lastReason = "본문 텍스트를 찾지 못했습니다.";

  for (const candidate of candidates) {
    const response = await fetchImpl(candidate, {
      cache: "no-store",
      headers: { "User-Agent": REQUEST_USER_AGENT, Referer: url },
    });
    if (!response.ok) {
      lastReason = `원문 접속 실패 (${response.status})`;
      continue;
    }

    const root = parse(await response.text());
    root.querySelectorAll("script, style, ins, .wrap_page, .view_btn").forEach((el) => el.remove());
    const body =
      root.querySelector(".board-view__area") || root.querySelector(".view_cont") || root;

    const sourceText = normalizeSourceText(body.text);
    if (sourceText.length >= 100) return { ok: true, sourceText };
    lastReason = "본문 텍스트가 너무 짧습니다.";
  }

  return { ok: false, sourceText: "", reason: lastReason };
}

/**
 * 원문 URL 에서 패치노트 본문 텍스트를 수집합니다.
 * 네트워크 오류는 예외로 던지지 않고 실패 사유로 반환합니다.
 */
export async function fetchPatchNoteSourceText(
  url: string,
  deps: FetchSourceTextDeps = {}
): Promise<FetchSourceTextResult> {
  const fetchImpl = deps.fetchImpl ?? fetch;
  const source = detectSource(url);

  try {
    if (source === "pubg") return await fetchPubgSourceText(url, fetchImpl);
    if (source === "kakao") return await fetchKakaoSourceText(url, fetchImpl);
    return { ok: false, sourceText: "", reason: "지원하지 않는 원문 도메인입니다." };
  } catch (error: unknown) {
    return {
      ok: false,
      sourceText: "",
      reason: error instanceof Error ? error.message : "원문 수집 중 알 수 없는 오류",
    };
  }
}
