import { expect, it } from "vitest";
import {
  categoryFor,
  classifyWindow,
  koreanDay,
} from "../lib/community-agent/policy";

it("UTC 15시에 다음 한국 날짜로 넘어간다", () => {
  expect(koreanDay(new Date("2026-09-08T15:00:00Z"))).toBe("2026-09-09");
});

it("작성 시각이 없는 검색 결과를 최근 민심에 넣지 않는다", () => {
  expect(classifyWindow(null, new Date("2026-09-08T01:00:00Z"))).toBe(
    "unknown",
  );
  expect(
    classifyWindow(
      "2026-09-09T00:00:00Z",
      new Date("2026-09-08T01:00:00Z"),
    ),
  ).toBe("unknown");
  expect(categoryFor("question")).toBe("자유");
});

it("잘못된 날짜는 한국 날짜로 변환하지 않고 명시적으로 거부한다", () => {
  expect(() => koreanDay(new Date("not-a-date"))).toThrow(RangeError);
});

it("잘못된 게시 시각과 현재 시각은 unknown으로 분류한다", () => {
  const now = new Date("2026-09-08T00:00:00Z");

  expect(classifyWindow("not-a-date", now)).toBe("unknown");
  expect(classifyWindow("2026-09-08T00:00:00Z", new Date("not-a-date"))).toBe(
    "unknown",
  );
});

it("24시간과 7일 경계는 각각 해당 창에 포함한다", () => {
  const now = new Date("2026-09-08T00:00:00Z");

  expect(classifyWindow("2026-09-07T00:00:00Z", now)).toBe("24h");
  expect(classifyWindow("2026-09-01T00:00:00Z", now)).toBe("7d");
  expect(classifyWindow("2026-08-31T23:59:59Z", now)).toBe("older");
});

it("news만 배그 소식이고 tip·question은 자유로 매핑한다", () => {
  expect(categoryFor("news")).toBe("배그 소식");
  expect(categoryFor("tip")).toBe("자유");
  expect(categoryFor("question")).toBe("자유");
});
