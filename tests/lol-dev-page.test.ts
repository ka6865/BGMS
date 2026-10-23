import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { formatKdaRatio } from "@/components/lol/lolFormat";
import { lolRiotIdPath, parseLolRiotIdParam, parseLolRiotIdSegment, LOL_RIOT_ID_ERROR } from "@/lib/lol/riotId";

const mocks = vi.hoisted(() => ({
  requireAdmin: vi.fn(),
  redirect: vi.fn(),
  notFound: vi.fn(),
  redirectSignal: new Error("redirect signal"),
  notFoundSignal: new Error("not found signal"),
}));

vi.mock("server-only", () => ({}));
vi.mock("next/navigation", () => ({
  redirect: mocks.redirect,
  notFound: mocks.notFound,
}));
vi.mock("@/lib/server/adminGuard", () => ({
  requireAdmin: mocks.requireAdmin,
}));

import { requireLolDevPageAdmin } from "@/lib/lol/access.server";
import LolDevLayout, { dynamic, metadata } from "@/app/admin/lol/layout";
import LolDevPage from "@/app/admin/lol/page";
import LolRiotIdPage, { generateMetadata } from "@/app/admin/lol/kr/[riotId]/page";

beforeEach(() => {
  vi.resetAllMocks();
  vi.stubEnv("LOL_DEV_ENABLED", "true");
  vi.stubEnv("LOL_DEV_OWNER_USER_ID", undefined);
  mocks.redirect.mockImplementation(() => {
    throw mocks.redirectSignal;
  });
  mocks.notFound.mockImplementation(() => {
    throw mocks.notFoundSignal;
  });
  mocks.requireAdmin.mockResolvedValue({
    ok: true,
    user: { id: "11111111-1111-4111-8111-111111111111" },
  });
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.clearAllMocks();
});

describe("requireLolDevPageAdmin", () => {
  it("성공이면 반환한다", async () => {
    await expect(requireLolDevPageAdmin()).resolves.toBeUndefined();
  });

  it("401은 로그인으로 redirect한다", async () => {
    mocks.requireAdmin.mockResolvedValue({
      ok: false,
      error: Response.json({}, { status: 401 }),
    });
    await expect(requireLolDevPageAdmin()).rejects.toBe(mocks.redirectSignal);
    expect(mocks.redirect).toHaveBeenCalledWith("/login");
  });

  it.each([403, 404])("%i는 notFound로 처리한다", async (status) => {
    if (status === 404) vi.stubEnv("LOL_DEV_ENABLED", "false");
    else
      mocks.requireAdmin.mockResolvedValue({
        ok: false,
        error: Response.json({}, { status }),
      });
    await expect(requireLolDevPageAdmin()).rejects.toBe(mocks.notFoundSignal);
    expect(mocks.notFound).toHaveBeenCalledOnce();
  });

  it.each([500, 503])(
    "%i는 민감 정보 없는 일반 오류를 던진다",
    async (status) => {
      mocks.requireAdmin.mockResolvedValue({
        ok: false,
        error: Response.json({ error: "private diagnostic" }, { status }),
      });
      await expect(requireLolDevPageAdmin()).rejects.toMatchObject({
        message: "접근 권한을 확인할 수 없습니다.",
      });
    },
  );
});

describe("LoL 개발 페이지", () => {
  it("Riot ID 동적 페이지는 Promise params를 해제하고 페이지 권한을 다시 확인한다", async () => {
    const page = await LolRiotIdPage({ params: Promise.resolve({ riotId: "홍 길-동-5955" }) });
    expect(page).toMatchObject({ props: { initialRiotId: "홍 길-동#5955" } });
    expect(mocks.requireAdmin).toHaveBeenCalledOnce();
    mocks.requireAdmin.mockResolvedValue({ ok: false, error: Response.json({}, { status: 403 }) });
    await expect(LolRiotIdPage({ params: Promise.resolve({ riotId: "홍길동-5955" }) })).rejects.toBe(mocks.notFoundSignal);
    await expect(generateMetadata({ params: Promise.resolve({ riotId: "홍길동-5955" }) })).rejects.toBe(mocks.notFoundSignal);
  });

  it("잘못된 URL은 검색 화면에 오류를 전달하고 유효한 페이지 제목은 Riot ID를 포함한다", async () => {
    expect(await LolRiotIdPage({ params: Promise.resolve({ riotId: "invalid" }) }))
      .toMatchObject({ props: { initialError: LOL_RIOT_ID_ERROR } });
    expect(await generateMetadata({ params: Promise.resolve({ riotId: "홍길동-5955" }) })).toEqual({
      title: { absolute: "홍길동#5955 - LoL 비공개 개발" }, robots: { index: false, follow: false },
    });
    expect(await LolRiotIdPage({ params: Promise.resolve({ riotId: "100% Player-KR1" }) }))
      .toMatchObject({ props: { initialRiotId: "100% Player#KR1" } });
  });
  it("레이아웃 성공 뒤에도 페이지는 회수된 권한을 다시 검사한다", async () => {
    await expect(LolDevLayout({ children: "protected child" })).resolves.toMatchObject({
      props: { children: [expect.anything(), expect.objectContaining({ props: expect.objectContaining({ children: "protected child" }) })] },
    });
    mocks.requireAdmin.mockResolvedValue({
      ok: false,
      error: Response.json({}, { status: 403 }),
    });
    await expect(LolDevPage()).rejects.toBe(mocks.notFoundSignal);
    expect(mocks.requireAdmin).toHaveBeenCalledTimes(2);
  });

  it("레이아웃도 페이지와 별도로 가드를 실행하고 children을 반환한다", async () => {
    const children = "protected child";
    const layout = await LolDevLayout({ children });
    expect(layout).toMatchObject({ props: { children: [expect.anything(), expect.objectContaining({ props: expect.objectContaining({ children }) })] } });
    const navigation = (layout as React.ReactElement<{ children: React.ReactElement[] }>).props.children[0];
    expect(navigation.props).toMatchObject({ "aria-label": "LoL 관리자 메뉴" });
    expect(mocks.requireAdmin).toHaveBeenCalledOnce();
  });

  it("페이지 직접 실행도 독립 검사 후 전적 검색 UI를 렌더링한다", async () => {
    const page = await LolDevPage();
    expect(mocks.requireAdmin).toHaveBeenCalledOnce();
    expect(page).toMatchObject({
      type: expect.any(Function),
      props: {},
    });
    expect((page as { type?: unknown }).type).toHaveProperty(
      "name",
      "LolSearchPanel",
    );
  });

  it("보호 레이아웃을 동적 렌더링하고 고정 noindex 메타데이터를 제공한다", () => {
    expect(dynamic).toBe("force-dynamic");
    expect(metadata).toMatchObject({
      title: { absolute: "LoL 비공개 개발" },
      robots: { index: false, follow: false },
    });
  });
});

describe("LoL Riot ID URL", () => {
  it.each([
    ["홍길동-5955", "홍길동#5955"], [" 홍 길 동 - KR1 ", "홍 길 동#KR1"],
    ["A-B-C-KR1", "A-B-C#KR1"], ["%ED%99%8D%EA%B8%B8%EB%8F%99-5955", "홍길동#5955"],
    ["100%25%20Player-KR1", "100% Player#KR1"],
    ["name", null], ["-KR1", null], ["name-", null], ["name-   ", null],
    ["name%ZZ-KR1", null], ["name%0A-KR1", null], ["name%23other-KR1", null],
    [`${"a".repeat(65)}-KR1`, null], [`name-${"1".repeat(17)}`, null],
  ])("세그먼트 %s를 %s로 해석한다", (segment, expected) => {
    expect(parseLolRiotIdSegment(segment!)).toBe(expected);
  });

  it("라우트 params는 인코딩 상태와 무관하게 같은 Riot ID로 해석한다", () => {
    expect(parseLolRiotIdParam("%ED%99%8D%EA%B8%B8%EB%8F%99-5955")).toBe("홍길동#5955");
    expect(parseLolRiotIdParam("홍길동-5955")).toBe("홍길동#5955");
    expect(parseLolRiotIdParam("강 희-성-KR1")).toBe("강 희-성#KR1");
    expect(parseLolRiotIdParam("name")).toBeNull();
  });

  it("검색 입력은 고정 관리자 경로로 인코딩하고 잘못된 입력은 거부한다", () => {
    const path = lolRiotIdPath(" 강 희-성 # KR1 ");
    expect(path).toBe(`/admin/lol/kr/${encodeURIComponent("강 희-성-KR1")}`);
    expect(parseLolRiotIdSegment(path!.split("/").pop()!)).toBe("강 희-성#KR1");
    for (const invalid of ["name", "#tag", "name#", "name#KR-1", "name#one#two", "name\n#KR1"])
      expect(lolRiotIdPath(invalid)).toBeNull();
  });
});

describe("LoL KDA 표시", () => {
  it.each([
    [undefined, 2, 3, "미제공"],
    [1, null, 3, "미제공"],
    [1, 2, Number.NaN, "미제공"],
    [1, Number.POSITIVE_INFINITY, 3, "미제공"],
    [-1, 2, 3, "미제공"],
    [0, 0, 0, "Perfect"],
    [0, 2, 0, "0.00:1"],
    [8, 2, 6, "7.00:1"],
  ] as const)("%s/%s/%s는 %s로 표시한다", (kills, deaths, assists, expected) => {
    expect(formatKdaRatio(kills, deaths, assists)).toBe(expected);
  });
});
