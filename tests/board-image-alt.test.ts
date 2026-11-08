import { describe, expect, it } from "vitest";
import { fillMissingImageAlt } from "../lib/board/imageAlt";

describe("게시글 이미지 alt 보정", () => {
  it("alt 가 없는 이미지에 대체 텍스트를 넣는다", () => {
    expect(fillMissingImageAlt('<img src="/a.png">', "제목")).toBe('<img src="/a.png" alt="제목">');
  });

  it("비어 있는 alt 는 대체 텍스트로 바꾼다", () => {
    expect(fillMissingImageAlt('<img alt="" src="/a.png"/>', "제목")).toBe('<img src="/a.png" alt="제목"/>');
  });

  it("이미 있는 alt 와 다른 태그는 건드리지 않는다", () => {
    const html = '<p alt>글</p><img src="/a.png" alt="설명"><imgx src="/b.png">';
    expect(fillMissingImageAlt(html, "제목")).toBe(html);
  });

  it("제목의 따옴표와 꺾쇠를 이스케이프한다", () => {
    expect(fillMissingImageAlt('<img src="/a.png">', '"a" <b>')).toBe('<img src="/a.png" alt="&quot;a&quot; &lt;b&gt;">');
  });

  it("제목이 비어 있으면 기본 문구를 쓴다", () => {
    expect(fillMissingImageAlt('<img src="/a.png">', "  ")).toBe('<img src="/a.png" alt="게시글 이미지">');
  });
});
