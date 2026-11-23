import { describe, expect, it } from "vitest";
import { findDisallowedLatinWords, sanitizeAiCoachingLanguageText } from "@/lib/pubg-analysis/aiCoachingQuality";

describe("AI 문장 영어 노출 차단", () => {
  it("영어 프롬프트 용어를 한국어로 바꾼다", () => {
    expect(sanitizeAiCoachingLanguageText("백업 반응 속도가 9.73초로 global average 12.20초보다 빠릅니다."))
      .toBe("백업 반응 속도가 9.73초로 전체 팀 평균 12.20초보다 빠릅니다.");
    expect(sanitizeAiCoachingLanguageText("부활 성공률이 14.8%로 global revive rate 34%보다 낮습니다."))
      .toBe("부활 성공률이 14.8%로 전체 팀 평균 34%보다 낮습니다.");
  });

  it("확인된 오타를 고친다", () => {
    expect(sanitizeAiCoachingLanguageText("배기지 없는 저격수")).toBe("배지 없는 저격수");
    expect(sanitizeAiCoachingLanguageText("2명을 쓰리게 만들었네.")).toBe("2명을 쓰러지게 만들었네.");
  });

  it("무기·단위·등급·닉네임은 허용하고 나머지 라틴 단어를 찾는다", () => {
    expect(findDisallowedLatinWords("Kar98k로 300m 밖 적을, 베릴 M762와 SCAR-L로 마무리했고 등급은 B+야.")).toEqual([]);
    expect(findDisallowedLatinWords("o_o7ouo7o_o가 먼저 쓰러졌어.", ["o_o7ouo7o_o"])).toEqual([]);
    expect(findDisallowedLatinWords("백업 속도가 good 수준이야.")).toEqual(["good"]);
  });
});
