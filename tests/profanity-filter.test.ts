import { describe, expect, it } from "vitest";
import { checkProfanity } from "@/lib/board/profanityFilter";

describe("비속어 필터", () => {
  it.each(["씨 발 사기", "존나 쎔", "ㅅㅂ 이게 뭐야", "ㅈㄴ 좋음", "병신 조합", "좆같은 조합", "니미 너무 쎄"])("%s는 막는다", text => {
    expect(checkProfanity(text).blocked).toBe(true);
  });

  // 받침과 다음 글자 초성이 이어져 초성 욕설처럼 보이는 평범한 문장은 통과해야 한다.
  it.each(["스킬 멈춰도 됨", "받침 있는 이름", "참치 김밥", "합시다", "골드 증강 먼저 고르세요", "애니비아 궁"])("%s는 통과한다", text => {
    expect(checkProfanity(text).blocked).toBe(false);
  });
});
