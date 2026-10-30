import { describe, expect, it, vi } from "vitest";
import { createElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";

vi.mock("next/link", () => ({ default: ({ href, children, ...rest }: { href: string; children?: ReactNode }) => createElement("a", { href, ...rest }, children) }));

const { default: LolMastersView } = await import("@/components/lol/LolMastersView");
const { default: LolLadderView } = await import("@/components/lol/LolLadderView");
const { toPublicMasterBoard, toPublicRankingBoard } = await import("@/lib/lol/ranking");

const champions = [{ id: 266, imageId: "Aatrox", name: "아트록스", title: "", tags: [] }, { id: 1, imageId: "Annie", name: "애니", title: "", tags: [] }];
const observedAt = "2026-10-30T20:00:00.000Z";
const master = toPublicMasterBoard({ observedAt, season: "2026-01-08", coverage: 80, playerCount: 120, champions: [
  { championId: 266, eligibleCount: 1, rows: [{ rank: 1, riot_id: "Alpha#KR1", tier: "CHALLENGER", league_points: 500, games: 20, wins: 12, riot_id_hmac: "a".repeat(64) }] },
] });
const ranking = toPublicRankingBoard({ payload: [{ rank: 1, riot_id: "Bravo#KR2", tier: "CHALLENGER", league_points: 1200, wins: 10, losses: 5, riot_id_hmac: "b".repeat(64) }],
  playerCount: 1, observedAt });

describe("장인 화면", () => {
  it("조건, 수집 범위, 기준 시각을 고정 표시하고 금지 표현을 쓰지 않는다", () => {
    const html = renderToStaticMarkup(LolMastersView({ champions, championsError: false, board: master, boardError: false, selectedId: 266 }));
    expect(html).toContain("조건: 이번 시즌 솔로 랭크 15판 이상, 승률 50% 이상, 판수 많은 순, 챌린저·그랜드마스터 대상");
    expect(html).toContain("챌린저·그랜드마스터 120명 중 80% 확인");
    expect(html).toContain("수집 중, 판수가 실제보다 적을 수 있습니다");
    expect(html).toContain("Alpha");
    expect(html).toContain("판수 20");
    expect(html).toContain("개인정보처리방침");
    expect(html).not.toMatch(/점수|실력|1등|숙련도/);
    expect(html).toContain("aria-label=\"챔피언 선택\"");
    expect(html).not.toMatch(/riot_id_hmac|puuid/);
  });

  it("자격자가 없는 챔피언은 조건 만족자가 없다고 안내한다", () => {
    const html = renderToStaticMarkup(LolMastersView({ champions, championsError: false, board: master, boardError: false, selectedId: 1 }));
    expect(html).toContain("조건을 만족한 플레이어가 아직 없습니다");
  });

  it("게시본이 없으면 빈 상태를, 오류면 오류 상태를 보여 준다", () => {
    const empty = renderToStaticMarkup(LolMastersView({ champions, championsError: false, board: null, boardError: false }));
    expect(empty).toContain("아직 집계되지 않았습니다");
    const error = renderToStaticMarkup(LolMastersView({ champions, championsError: false, board: null, boardError: true }));
    expect(error).toContain("장인 게시본을 불러오지 못했습니다");
  });
});

describe("랭킹 화면", () => {
  it("상위 3명과 순위 목록을 보여 주고 PUUID나 해시를 드러내지 않는다", () => {
    const html = renderToStaticMarkup(LolLadderView({ rows: [], today: "2026-10-30", ranking }));
    expect(html).toContain("솔로 랭크 순위");
    expect(html).toContain("Bravo");
    expect(html).toContain("aria-label=\"상위 3명\"");
    expect(html).not.toMatch(/riot_id_hmac|puuid/);
    expect(html).toContain("자체 계산 값이 아닙니다");
  });

  it("게시본이 없으면 순위 자리에 빈 상태를 두고 컷 기록은 그대로 남긴다", () => {
    const html = renderToStaticMarkup(LolLadderView({ rows: [], today: "2026-10-30", ranking: null }));
    expect(html).toContain("아직 집계되지 않았습니다");
    expect(html).toContain("랭크 컷 기록");
  });
});
