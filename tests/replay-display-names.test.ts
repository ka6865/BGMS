import { describe, expect, it } from "vitest";
import { restoreNameCase } from "@/lib/replay/displayNames";

describe("리플레이 아군 이름 표기 복원", () => {
  it("좌표 이벤트의 원래 표기로 되돌리고 순서를 유지한다", () => {
    const events = [
      { type: "kill", attacker: "KANGHEESUNG_", victim: "Enemy" },
      { type: "position", name: "MiaeQ_Q" },
      { type: "position", name: "KangHeeSung_" },
    ];
    expect(restoreNameCase(["kangheesung_", "miaeq_q"], events)).toEqual(["KangHeeSung_", "MiaeQ_Q"]);
  });

  it("좌표가 없으면 다른 이벤트 이름을 쓰고, 찾지 못하면 그대로 둔다", () => {
    expect(restoreNameCase(["mate", "ghost"], [{ type: "groggy", victim: "Mate" }])).toEqual(["Mate", "ghost"]);
  });
});
