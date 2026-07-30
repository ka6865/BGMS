import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  ALLOWED_ATTRIBUTES,
  ALLOWED_TAGS,
  sanitizeBoardHtml,
} from "@/lib/board/sanitizeHtml";

describe("sanitizeBoardHtml", () => {
  it("script 태그와 내용을 통째로 제거한다", () => {
    const output = sanitizeBoardHtml('<p>안녕</p><script>alert("xss")</script>');
    expect(output).toBe("<p>안녕</p>");
    expect(output).not.toContain("alert");
  });

  it("style, iframe 외 위험 요소를 제거한다", () => {
    const output = sanitizeBoardHtml(
      '<style>body{display:none}</style><object data="x"></object><embed src="y">'
    );
    expect(output).toBe("");
  });

  it("on* 이벤트 핸들러를 제거한다", () => {
    const output = sanitizeBoardHtml('<div onclick="steal()" onmouseover="x()">본문</div>');
    expect(output).toBe("<div>본문</div>");
  });

  it("img onerror 를 제거하고 태그는 남긴다", () => {
    const output = sanitizeBoardHtml('<img src="https://cdn.test/a.png" onerror="alert(1)">');
    expect(output).toContain('src="https://cdn.test/a.png"');
    expect(output).not.toContain("onerror");
  });

  it("javascript: 스킴 링크를 제거한다", () => {
    const output = sanitizeBoardHtml('<a href="javascript:alert(1)">클릭</a>');
    expect(output).not.toContain("javascript");
    expect(output).toContain("클릭");
  });

  it("제어문자로 우회한 javascript: 스킴도 제거한다", () => {
    const output = sanitizeBoardHtml('<a href="java\u0000script:alert(1)">클릭</a>');
    expect(output).not.toContain("script:");
  });

  it("data: URI 이미지를 제거한다", () => {
    const output = sanitizeBoardHtml('<img src="data:text/html;base64,PHNjcmlwdD4=">');
    expect(output).not.toContain("data:");
  });

  it("상대 경로와 https 링크는 유지한다", () => {
    expect(sanitizeBoardHtml('<a href="/board/1">글</a>')).toContain('href="/board/1"');
    expect(sanitizeBoardHtml('<a href="https://bgms.kr">홈</a>')).toContain('href="https://bgms.kr"');
  });

  it("target=_blank 링크에 noopener 를 강제한다", () => {
    const output = sanitizeBoardHtml('<a href="https://pubg.com" target="_blank">원문</a>');
    expect(output).toContain('rel="noopener noreferrer"');
  });

  it("허용되지 않은 태그는 내용만 남기고 벗겨낸다", () => {
    const output = sanitizeBoardHtml("<section><p>본문</p></section>");
    expect(output).toBe("<p>본문</p>");
  });

  it("허용되지 않은 속성을 떨어뜨린다", () => {
    const output = sanitizeBoardHtml('<p data-evil="1" id="x" class="ok">본문</p>');
    expect(output).toContain('class="ok"');
    expect(output).not.toContain("data-evil");
    expect(output).not.toContain('id="x"');
  });

  it("style 안의 expression 과 url() 을 제거한다", () => {
    expect(sanitizeBoardHtml('<div style="width:expression(alert(1))">x</div>')).not.toContain("expression");
    expect(sanitizeBoardHtml('<div style="background:url(//evil)">x</div>')).not.toContain("url(");
    expect(sanitizeBoardHtml('<div style="color:red">x</div>')).toContain('style="color:red"');
  });

  it("HTML 주석을 제거한다", () => {
    expect(sanitizeBoardHtml("<p>a</p><!-- 비밀 메모 -->")).toBe("<p>a</p>");
  });

  it("AI 패치노트 요약 카드 구조를 훼손하지 않는다", () => {
    const aiHtml =
      '<div class="patch-note-container space-y-4">' +
      '<div class="bg-[#F2A900]/10 border rounded-lg p-4"><h3 class="text-[#F2A900] font-black">🤖 요약</h3></div>' +
      '<ul class="space-y-1"><li class="relative pl-4">' +
      '<strong class="text-[#F2A900] font-black">M416</strong> 데미지 상향</li></ul>' +
      '<a href="https://pubg.com/ko/news/1" target="_blank" rel="noopener noreferrer" class="px-6">원문</a>' +
      "</div>";

    const output = sanitizeBoardHtml(aiHtml);
    expect(output).toContain("patch-note-container");
    expect(output).toContain("<strong");
    expect(output).toContain('href="https://pubg.com/ko/news/1"');
    expect(output).toContain("M416");
    // h3 는 허용 태그이므로 유지된다
    expect(output).toContain("<h3");
  });

  it("iframe src 는 허용 호스트의 https 절대 URL 만 통과한다", () => {
    // 독립 감사에서 발견된 우회 벡터: 프로토콜 상대 URL 과 상대 경로
    expect(sanitizeBoardHtml('<iframe src="//evil.com/phishing"></iframe>')).toBe("");
    expect(sanitizeBoardHtml('<iframe src="/admin/game-data"></iframe>')).toBe("");
    expect(sanitizeBoardHtml('<iframe src="http://www.youtube.com/embed/x"></iframe>')).toBe("");
    expect(sanitizeBoardHtml('<iframe src="https://evil.com/x"></iframe>')).toBe("");
    expect(sanitizeBoardHtml('<iframe src="https://www.youtube.com.evil.com/x"></iframe>')).toBe("");
    expect(sanitizeBoardHtml('<iframe src="javascript:alert(1)"></iframe>')).toBe("");
    expect(sanitizeBoardHtml("<iframe></iframe>")).toBe("");

    const allowed = sanitizeBoardHtml(
      '<iframe src="https://www.youtube.com/embed/abc123" allowfullscreen></iframe>'
    );
    expect(allowed).toContain('src="https://www.youtube.com/embed/abc123"');
    expect(sanitizeBoardHtml('<iframe src="https://player.twitch.tv/?video=1"></iframe>'))
      .toContain("player.twitch.tv");
  });

  it("srcdoc 등 허용 목록 밖 속성은 제거한다", () => {
    const output = sanitizeBoardHtml(
      '<iframe src="https://www.youtube.com/embed/a" srcdoc="<script>alert(1)</script>"></iframe>'
    );
    expect(output).not.toContain("srcdoc");
    expect(output).toContain("youtube.com/embed/a");
  });

  it("빈 입력과 null 을 안전하게 처리한다", () => {    expect(sanitizeBoardHtml("")).toBe("");
    expect(sanitizeBoardHtml(null)).toBe("");
    expect(sanitizeBoardHtml(undefined)).toBe("");
  });

  it("두 번 정화해도 결과가 같다 (멱등성)", () => {
    const once = sanitizeBoardHtml('<p onclick="x()">본문<script>1</script></p>');
    expect(sanitizeBoardHtml(once)).toBe(once);
  });

  it("허용 목록이 클라이언트 dompurify 설정과 일치한다", () => {
    const clientSource = readFileSync(resolve("components/board/BoardDetailClient.tsx"), "utf8");

    const tagBlock = clientSource.split("ALLOWED_TAGS: [")[1].split("]")[0];
    const attrBlock = clientSource.split("ALLOWED_ATTR: [")[1].split("]")[0];
    const clientTags = [...tagBlock.matchAll(/"([a-z0-9]+)"/g)].map((m) => m[1]);
    const clientAttrs = [...attrBlock.matchAll(/"([a-z]+)"/g)].map((m) => m[1]);

    expect([...clientTags].sort()).toEqual([...ALLOWED_TAGS].sort());
    expect([...clientAttrs].sort()).toEqual([...ALLOWED_ATTRIBUTES].sort());
  });
});
