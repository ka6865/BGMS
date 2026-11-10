import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mayhemOfferNotes, mayhemRandomExcluded, parseMayhemOfferRuleInput, type MayhemOfferRule } from "@/lib/lol/mayhemOfferRules";
import { extractMayhemOfferHints } from "@/lib/lol/mayhemOfferHints";

const mock = vi.hoisted(() => ({ access: vi.fn(), list: vi.fn(), save: vi.fn(), remove: vi.fn(), revalidate: vi.fn() }));
vi.mock("server-only", () => ({}));
vi.mock("next/cache", () => ({ revalidateTag: mock.revalidate, unstable_cache: (fn: unknown) => fn }));
vi.mock("@/lib/lol/access.server", () => ({ requireLolDevAdmin: mock.access }));
vi.mock("@/lib/lol/mayhemOfferRules.server", () => ({ MAYHEM_OFFER_RULES_TAG: "tag", listMayhemOfferRulesAdmin: mock.list, saveMayhemOfferRule: mock.save, deleteMayhemOfferRule: mock.remove }));

const rule = (augmentId: number, kind: MayhemOfferRule["kind"], patch: string | null, verified = false, text = ""): MayhemOfferRule => ({ id: augmentId, augmentId, kind, text, patch, verified });
const rules = [rule(1134, "random_excluded", "26.9"), rule(1004, "random_excluded", "26.18"), rule(1134, "condition", "26.17", true, "루난의 허리케인을 가지고 있으면 제시되지 않습니다.")];

describe("증강 등장 조건 표시", () => {
  it("무작위 제외 안내를 먼저, 개별 조건을 뒤에 붙인다", () => {
    expect(mayhemOfferNotes(rules, 1134)).toEqual([
      { text: "전환·판도라의 상자·나는 왕이다가 무작위로 주는 증강에서는 나오지 않습니다.", patch: "26.9", verified: false },
      { text: "루난의 허리케인을 가지고 있으면 제시되지 않습니다.", patch: "26.17", verified: true },
    ]);
    expect(mayhemOfferNotes(rules, 9999)).toEqual([]);
  });

  it("제외 목록은 가장 최근 패치를 보이고, 하나라도 미확인이면 확인 필요다", () => {
    expect(mayhemRandomExcluded(rules)).toEqual({ ids: [1134, 1004], patch: "26.18", verified: false });
    expect(mayhemRandomExcluded([rule(1, "random_excluded", null, true)]).verified).toBe(true);
    expect(mayhemRandomExcluded([]).verified).toBe(false);
  });
});

describe("관리자 입력", () => {
  const valid = { augmentId: 1134, kind: "condition", text: "조건", patch: "26.22", verified: false, status: "active", sourceUrl: "https://www.leagueoflegends.com/x" };
  it("게시하려면 대상 증강과 조건 문장이 있어야 한다", () => {
    expect(parseMayhemOfferRuleInput(valid)).toMatchObject({ augmentId: 1134, patch: "26.22" });
    expect(parseMayhemOfferRuleInput({ ...valid, augmentId: null })).toBeNull();
    expect(parseMayhemOfferRuleInput({ ...valid, text: " " })).toBeNull();
    expect(parseMayhemOfferRuleInput({ ...valid, augmentId: null, status: "candidate" })?.augmentId).toBeNull();
    expect(parseMayhemOfferRuleInput({ ...valid, kind: "random_excluded", text: "" })?.kind).toBe("random_excluded");
  });
  it.each([["패치 형식", { patch: "26" }], ["http 링크", { sourceUrl: "http://x" }], ["상태", { status: "draft" }], ["종류", { kind: "other" }], ["확인 여부", { verified: "y" }]])("%s가 틀리면 거부한다", (_name, patch) => {
    expect(parseMayhemOfferRuleInput({ ...valid, ...patch })).toBeNull();
  });
});

describe("패치노트 후보 문장", () => {
  it("아수라장 섹션의 제시 조건 문장만 고른다", () => {
    const html = `<h2>클래식</h2><p>이 증강은 더 이상 등장하지 않습니다.</p>
      <h2>무작위 총력전: 아수라장</h2><p>이번 패치에서는 증강 선택지 등장 방식이 내부적으로 추가 조정됩니다.</p>
      <ul><li>검을 뽑아라: 루난의 허리케인을 가지고 있으면 더 이상 제시되지 않습니다.</li><li>벌이다!!!: 피해량 증가</li>
      <li>전환: 프리즘이 기본으로 돌아가기를 주지 않습니다.</li></ul><h2>아레나</h2><p>등장하지 않습니다.</p>`;
    expect(extractMayhemOfferHints(html)).toEqual([
      "이번 패치에서는 증강 선택지 등장 방식이 내부적으로 추가 조정됩니다.",
      "검을 뽑아라: 루난의 허리케인을 가지고 있으면 더 이상 제시되지 않습니다.",
      "전환: 프리즘이 기본으로 돌아가기를 주지 않습니다.",
    ]);
  });
});

describe("관리자 API", () => {
  const request = (method: string, body?: unknown, query = "") => new Request(`http://localhost/api/admin/lol/offer-rules${query}`, { method, headers: { origin: "http://localhost", host: "localhost" }, body: body ? JSON.stringify(body) : undefined });
  const valid = { augmentId: 1134, kind: "condition", text: "조건", patch: null, verified: true, status: "active", sourceUrl: null };
  beforeEach(() => { mock.access.mockResolvedValue({ ok: true, userId: "admin-1" }); });
  afterEach(() => { vi.clearAllMocks(); });

  it("관리자가 아니면 막고, 저장·삭제하면 공개 캐시를 갱신한다", async () => {
    const { GET, POST, DELETE } = await import("@/app/api/admin/lol/offer-rules/route");
    mock.access.mockResolvedValueOnce({ ok: false, error: new Response(null, { status: 403 }) });
    expect((await GET()).status).toBe(403);
    mock.save.mockResolvedValueOnce({ id: 1 });
    expect((await POST(request("POST", valid))).status).toBe(201);
    expect(mock.save).toHaveBeenCalledWith("admin-1", expect.objectContaining({ verified: true }), null);
    mock.save.mockResolvedValueOnce({ id: 1 });
    expect((await POST(request("POST", { ...valid, id: 1 }))).status).toBe(200);
    mock.save.mockRejectedValueOnce(new Error("offer_rule_duplicate"));
    expect((await POST(request("POST", valid))).status).toBe(409);
    expect((await POST(request("POST", { ...valid, augmentId: null }))).status).toBe(400);
    mock.remove.mockResolvedValueOnce(true);
    expect((await DELETE(request("DELETE", undefined, "?id=1"))).status).toBe(200);
    expect(mock.revalidate).toHaveBeenCalledTimes(3);
  });
});
