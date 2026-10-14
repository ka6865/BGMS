import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

// 공개 API 는 DB·외부 호출 에러 원문을 응답 본문에 담지 않고 고정 문구만 돌려준다.
const PUBLIC_ROUTES = [
  "app/api/maps/[mapId]/markers/route.ts",
  "app/api/maps/settings/route.ts",
  "app/api/pubg/hotdrop/route.ts",
  "app/api/pubg/matches-summary/route.ts",
  "app/api/pubg/ai-summary/route.ts",
  "app/api/pubg/squad-analyze/route.ts",
  "app/api/pubg/ai-analyze/route.ts",
  "app/api/pubg/player/matches/route.ts",
  "app/api/report/notify/route.ts",
  "app/api/pubg/battle/route.ts",
  "app/api/auth/delete-account/route.ts",
];
const RAW_ERROR_TEMPLATE = /error:\s*`[^`]*\$\{\w+\.message\}/;

const RAW_ERROR_RESPONSE = /NextResponse\.json\(\s*\{\s*error:\s*(?:\w+\.message|message)\b/;
const RAW_ERROR_MESSAGE_VARIABLE = /const message = \w+ instanceof Error \? \w+\.message/;

describe("공개 API 에러 응답 경계", () => {
  for (const route of PUBLIC_ROUTES) {
    it(`${route} 는 에러 원문을 응답에 담지 않는다`, () => {
      const source = readFileSync(resolve(route), "utf8");
      expect(source).not.toMatch(RAW_ERROR_RESPONSE);
      expect(source).not.toMatch(RAW_ERROR_MESSAGE_VARIABLE);
      expect(source).not.toMatch(RAW_ERROR_TEMPLATE);
    });
  }
});
