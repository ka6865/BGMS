import { describe, expect, it } from "vitest";
import { checkLolKeyPuuid } from "../scripts/lol_check_key_puuid";

const accounts = [
  { puuid: "stored-a", game_name: "A", tag_line: "KR1" },
  { puuid: "stored-b", game_name: "B", tag_line: "KR1" },
  { puuid: "stored-c", game_name: "C", tag_line: "KR1" },
];

describe("Riot 키 교체 PUUID 점검", () => {
  it("모두 같으면 same, 하나라도 다르면 different로 판정한다", async () => {
    const same = await checkLolKeyPuuid(accounts, async (name) => ({ status: 200, puuid: `stored-${name.toLowerCase()}` }), 0);
    expect(same).toEqual({ checked: 3, same: 3, different: 0, notFound: 0, failed: 0, verdict: "same" });
    const different = await checkLolKeyPuuid(accounts, async (name) => ({ status: 200, puuid: name === "B" ? "prod-b" : `stored-${name.toLowerCase()}` }), 0);
    expect(different).toMatchObject({ same: 2, different: 1, verdict: "different" });
  });

  it("이름 변경(404)과 일시 실패는 판정에서 빼고, 같은 계정이 없으면 판단하지 않는다", async () => {
    const result = await checkLolKeyPuuid(accounts, async (name) => (name === "A" ? { status: 404 } : { status: 503 }), 0);
    expect(result).toEqual({ checked: 3, same: 0, different: 0, notFound: 1, failed: 2, verdict: "inconclusive" });
  });

  it("결과에 PUUID를 담지 않는다", async () => {
    const result = await checkLolKeyPuuid(accounts, async (name) => ({ status: 200, puuid: `prod-${name}` }), 0);
    expect(JSON.stringify(result)).not.toMatch(/stored-|prod-/);
  });
});
