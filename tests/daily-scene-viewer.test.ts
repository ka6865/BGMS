// @vitest-environment jsdom
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { DailyScene } from "@/lib/learn/dailyScenes";
import DailySceneViewer from "@/components/learn/DailySceneViewer";
import BriefingMap from "@/components/learn/BriefingMap";
import DailyModePage from "@/app/learn/daily/[day]/[mode]/page";
import { getDailyRankerStory, type DailyRankerStory } from "@/lib/learn/dailyStories";
import { buildDailyWalkthrough, type DailyWalkthroughChapter } from "@/lib/learn/dailyWalkthrough";

vi.mock("@/lib/learn/dailyStories", () => ({ getDailyRankerStory: vi.fn() }));
vi.mock("@/lib/learn/dailyWalkthrough", () => ({ buildDailyWalkthrough: vi.fn() }));
vi.mock("next/link", () => ({ default: ({ children, href }: { children: React.ReactNode; href: string }) => React.createElement("a", { href }, children) }));
vi.mock("@/components/learn/DailyLegacyDetail", () => ({ default: () => React.createElement("p", null, "기존 경기 상세") }));

vi.mock("@/components/learn/BriefingMapShell", () => ({
  default: ({ snapshot, mapId }: { snapshot: unknown; mapId: string }) => React.createElement("div", {
    "data-testid": "scene-map", "data-map": mapId, "data-snapshot": JSON.stringify(snapshot),
  }),
}));

const scenes = [
  { id: "landing", kind: "opening", title: "착지", startSeconds: 0, anchorSeconds: 30, endSeconds: 40, evidenceIds: ["a"], situation: "비행 경로가 기록됐습니다.", action: "선수가 착지했습니다.", outcome: "위치 표본 1건이 남았습니다.", lesson: "내 착지 지역도 확인하세요.", mapSnapshot: { path: [{ x: 100, y: 200 }], viewSize: 1000 } },
  { id: "finish", kind: "finish", title: "마지막 교전", startSeconds: 90, anchorSeconds: 100, endSeconds: 110, evidenceIds: ["b"], situation: "마지막 상대가 남아 있었습니다.", action: "교전 기록이 확인됩니다.", outcome: "경기 종료가 기록됐습니다." },
] as DailyScene[];

let host: HTMLDivElement;
let root: Root | undefined;
function mount(scenesToShow: DailyWalkthroughChapter[], overview?: DailyScene["mapSnapshot"], highlights?: DailyWalkthroughChapter[], combatScenes?: DailyWalkthroughChapter[]) {
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  act(() => root!.render(React.createElement(DailySceneViewer, { scenes: scenesToShow, mapId: "Erangel", overview, highlights, combatScenes })));
}
afterEach(() => {
  if (root) act(() => root!.unmount());
  root = undefined;
  host?.remove();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

describe("DailySceneViewer", () => {
  it("updates the story and map together with accessible previous/next controls", () => {
    mount(scenes);
    expect(host.querySelector("h2")?.textContent).toBe("착지");
    expect(host.textContent).toContain("내 착지 지역도 확인하세요.");
    expect(Array.from(host.querySelectorAll("article > dl dd"), (item) => item.textContent)).toEqual([
      scenes[0].situation, scenes[0].action, scenes[0].outcome, scenes[0].lesson,
    ]);
    expect(host.querySelector("article details")).toBeNull();
    expect(host.querySelector('[aria-label="운영 포인트"]')).toBeNull();
    expect(host.querySelector('[data-testid="scene-map"]')?.getAttribute("data-map")).toBe("Erangel");
    const previous = host.querySelector<HTMLButtonElement>('button[aria-label="이전 장면"]');
    expect(previous?.disabled).toBe(true);
    act(() => host.querySelector<HTMLButtonElement>('button[aria-label="다음 장면"]')?.click());
    expect(host.querySelector("h2")?.textContent).toBe("마지막 교전");
    expect(host.querySelector('[data-testid="scene-map"]')).toBeNull();
    act(() => host.querySelector("h2")?.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowLeft", bubbles: true })));
    expect(host.querySelector("h2")?.textContent).toBe("마지막 교전");
    act(() => host.querySelector('[aria-label="장면 복기"]')?.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowLeft", bubbles: true })));
    expect(host.querySelector("h2")?.textContent).toBe("착지");
  });

  it("shows an approved operating point and keeps its conditions inside the expandable details", () => {
    const operatingPoint = { conditions: "팀이 흩어졌고 다음 원까지 42초", point: "합류를 마친 뒤 안전구역 안쪽으로 진입", evidenceIds: ["a"] };
    mount([{ ...scenes[0], brief: { situation: "요약 상황", action: "요약 행동", outcome: "요약 결과" }, operatingPoint }]);
    expect(host.querySelector('[aria-label="운영 포인트"]')?.textContent).toContain(operatingPoint.point);
    const details = host.querySelector<HTMLDetailsElement>("article details")!;
    expect(details.open).toBe(false);
    act(() => details.querySelector("summary")!.click());
    expect(details.querySelector("dt")?.textContent).toBe("상황");
    expect(Array.from(details.querySelectorAll("dt"), (item) => item.textContent)).toContain("당시 조건");
    expect(details.textContent).toContain(operatingPoint.conditions);
  });

  it("shows conditions in a disclosure when an operating point has no brief", () => {
    const operatingPoint = { conditions: "혼자 남았고 회복 아이템이 없음", point: "엄폐를 유지하며 교전 거리 확보", evidenceIds: ["b"] };
    mount([{ ...scenes[1], operatingPoint }]);
    expect(host.querySelector('[aria-label="운영 포인트"]')?.textContent).toContain(operatingPoint.point);
    expect(host.querySelector("article details")?.textContent).toContain(operatingPoint.conditions);
  });

  it("uses a neutral label for recovery and return scenes", () => {
    mount([{ ...scenes[0], kind: "recovery", title: "회복 기록" }]);
    expect(host.textContent).toContain("회복·복귀");
    expect(host.textContent).not.toContain("팀원 살리기");
  });

  it("keeps the scene text usable when no location sample exists", () => {
    mount([scenes[1]]);
    expect(host.querySelector("h2")?.textContent).toBe("마지막 교전");
    expect(host.textContent).toContain("기록된 위치가 없어 지도");
    expect(host.querySelector('[data-testid="scene-map"]')).toBeNull();
  });

  it("shows three brief lines before navigation and resets full details when changing chapters", () => {
    const chapters = scenes.map((scene, index) => ({ ...scene, brief: {
      situation: `짧은 상황 ${index + 1}`, action: "이동 → 교전", outcome: `짧은 결과 ${index + 1}`,
    } }));
    mount(chapters);
    expect(Array.from(host.querySelectorAll("article > dl dt"), (item) => item.textContent)).toEqual(["상황", "행동", "결과"]);
    expect(Array.from(host.querySelectorAll("article > dl dd"), (item) => item.textContent)).toEqual(Object.values(chapters[0].brief));
    const details = host.querySelector<HTMLDetailsElement>("article details")!;
    expect(details.open).toBe(false);
    expect(details.querySelector("summary")?.textContent).toBe("이 장면 자세히 보기");
    expect(Array.from(details.querySelectorAll("dd"), (item) => item.textContent)).toEqual([
      scenes[0].situation, scenes[0].action, scenes[0].outcome, scenes[0].lesson,
    ]);
    const next = host.querySelector<HTMLButtonElement>('button[aria-label="다음 장면"]')!;
    expect(next.parentElement?.previousElementSibling).toBe(host.querySelector("article > dl"));
    expect(next.compareDocumentPosition(details) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    act(() => details.querySelector("summary")!.click());
    expect(details.open).toBe(true);
    act(() => next.click());
    const nextDetails = host.querySelector<HTMLDetailsElement>("article details")!;
    expect(nextDetails).not.toBe(details);
    expect(nextDetails.open).toBe(false);
    expect(host.querySelector("article > dl")?.textContent).toContain(chapters[1].brief.situation);
    expect(nextDetails.textContent).toContain(scenes[1].action);
    act(() => nextDetails.querySelector("summary")!.click());
    act(() => host.querySelector<HTMLButtonElement>('button[aria-label="이전 장면"]')!.click());
    expect(host.querySelector<HTMLDetailsElement>("article details")?.open).toBe(false);
    expect(host.querySelector("article h2")?.textContent).toBe("착지");
  });

  it("shows a useful empty state without scene data", () => {
    mount([]);
    expect(host.textContent).toContain("공개된 장면이 없습니다.");
  });

  it("falls back to the whole flow when no connected highlights exist", () => {
    mount(scenes, undefined, []);
    expect(host.querySelector('[aria-label="경기 보기 선택"]')).toBeNull();
    expect(host.querySelector("article h2")?.textContent).toBe(scenes[0].title);
    act(() => host.querySelector<HTMLButtonElement>('button[aria-label="다음 장면"]')!.click());
    expect(host.querySelector("article h2")?.textContent).toBe(scenes[1].title);
  });

  it("opens each combat record with its own map and the earlier observed circle time", () => {
    const brief = { situation: "상대 A와 교전", action: "27:48 수류탄 피해", outcome: "27:53 같은 상대 처치" };
    const fights = [
      { ...scenes[0], id: "fight-a", kind: "combat" as const, title: "상대 A 교전", startSeconds: 1668, anchorSeconds: 1668, endSeconds: 1673,
        brief, combatZone: { phase: 8, observedSeconds: 1200, outsideMeters: null }, action: "랭커가 상대 A에게 수류탄 피해를 주고 처치했습니다.", mapSnapshot: { path: [{ x: 100, y: 200 }], viewSize: 512,
          zone: { x: 150, y: 250, radius: 0.068 }, zoneObservedSeconds: 1200 } },
      { ...scenes[1], id: "fight-b", kind: "combat" as const, title: "상대 B 교전", startSeconds: 1700, anchorSeconds: 1700, endSeconds: 1710,
        brief: { situation: "상대 B와 교전", action: "AWM 피해", outcome: "팀 처치" },
        mapSnapshot: { path: [{ x: 300, y: 400 }], viewSize: 512, zone: { x: 350, y: 450, radius: 80 }, zoneObservedSeconds: 1680 } },
    ];
    const overview = { path: [{ x: 1, y: 2 }], viewSize: 4096 };
    mount(scenes, overview, undefined, fights);
    const views = host.querySelectorAll<HTMLButtonElement>('[aria-label="경기 보기 선택"] button');
    expect(Array.from(views, (button) => button.textContent)).toEqual(["전체 흐름", "교전 기록 2건"]);
    expect(host.querySelector("article h2")?.textContent).toBe("착지");
    act(() => views[1].click());
    expect(views[1].getAttribute("aria-pressed")).toBe("true");
    expect(host.querySelectorAll("button[data-scene-index]")).toHaveLength(2);
    expect(host.textContent).toContain("한 교전에서 여러 킬이 나올 수 있습니다.");
    expect(host.querySelector("article h2")?.textContent).toBe("상대 A 교전");
    expect(host.querySelector("article > dl")?.textContent).toContain("27:53 같은 상대 처치");
    expect(host.querySelector("article details")?.textContent).toContain("랭커가 상대 A에게 수류탄 피해를 주고 처치했습니다.");
    expect(host.textContent).toContain("교전 시각 27:48 / 8단계 · 교전 전에 마지막으로 공개된 안전구역 · 20:00 · 07:48 전");
    const map = () => JSON.parse(host.querySelector('[data-testid="scene-map"]')!.getAttribute("data-snapshot")!);
    expect(map()).toEqual(fights[0].mapSnapshot);
    const details = host.querySelector<HTMLDetailsElement>("article details")!;
    act(() => details.querySelector("summary")!.click());
    act(() => host.querySelector<HTMLButtonElement>('button[aria-label="다음 장면"]')!.click());
    expect(host.querySelector("article h2")?.textContent).toBe("상대 B 교전");
    expect(host.querySelector<HTMLDetailsElement>("article details")?.open).toBe(false);
    expect(host.textContent).toContain("교전 시각 28:20 / 교전 전에 마지막으로 공개된 안전구역 · 28:00");
    expect(map()).toEqual(fights[1].mapSnapshot);
    act(() => views[0].click());
    expect(host.querySelector("article h2")?.textContent).toBe("착지");
    expect(map()).toEqual(scenes[0].mapSnapshot);
  });

  it("keeps a tiny circle's center visible and labeled on the map", () => {
    const markup = renderToStaticMarkup(React.createElement(BriefingMap, { mapId: "Erangel", snapshot: {
      path: [{ x: 0, y: 0 }], viewSize: 512, zone: { x: 1000, y: 0, radius: 0.068 },
    } }));
    const container = document.createElement("div");
    container.innerHTML = markup;
    const marker = Array.from(container.querySelectorAll("circle")).find((circle) => circle.querySelector("title")?.textContent === "표시된 원의 중심")!;
    expect(marker).toBeTruthy();
    expect(Number(marker.getAttribute("r"))).toBeGreaterThan(0.068);
    const [left, , size] = container.querySelector("svg")!.getAttribute("viewBox")!.split(" ").map(Number);
    expect(left).toBeLessThan(1000);
    expect(left + size).toBeGreaterThan(1000);
    expect(container.textContent).toContain("원 중심");
  });

  it("draws each player route segment separately across a death and return", () => {
    host = document.createElement("div");
    document.body.append(host);
    root = createRoot(host);
    act(() => root!.render(React.createElement(BriefingMap, { mapId: "Erangel", snapshot: {
      path: [{ x: 100, y: 100 }, { x: 1200, y: 1200 }, { x: 6000, y: 6000 }, { x: 7100, y: 7100 }],
      pathSegments: [[{ x: 100, y: 100 }, { x: 1200, y: 1200 }], [{ x: 6000, y: 6000 }, { x: 7100, y: 7100 }]],
      viewSize: 8192,
    } })));
    const polylines = host.querySelectorAll<SVGPolylineElement>("polyline");
    expect(Array.from(polylines, (line) => line.getAttribute("points"))).toEqual(["100,100 1200,1200", "6000,6000 7100,7100"]);
    expect(host.querySelectorAll("polygon")).toHaveLength(2);
  });

  it("does not restore the flat route when explicit segments are empty", () => {
    const markup = renderToStaticMarkup(React.createElement(BriefingMap, { mapId: "Erangel", snapshot: {
      path: [{ x: 100, y: 100 }, { x: 7000, y: 7000 }], pathSegments: [], viewSize: 8192,
    } }));
    const container = document.createElement("div");
    container.innerHTML = markup;
    expect(container.querySelector("polyline")).toBeNull();
  });

  it("frames player samples apart from the zone and keeps every recorded coordinate", () => {
    const snapshot = {
      path: [{ x: 3991, y: 5369 }, { x: 4115, y: 5440 }],
      pathStartSeconds: 470, pathEndSeconds: 480, viewSize: 5248,
      zone: { x: 6200, y: 6000, radius: 900 },
      marks: [
        { x: 3991, y: 5369, kind: "opponent" as const, label: "07:56 상대 1 기록된 위치" },
        { x: 3992.4, y: 5369, kind: "opponent" as const, label: "07:57 상대 1 기록된 위치" },
        { x: 3995, y: 5370, kind: "teammate" as const, label: "07:58 팀원 2 기록된 위치" },
        { x: 4000, y: 5371, kind: "teammate" as const, label: "07:59 팀원 2 기록된 위치" },
      ],
    };
    host = document.createElement("div");
    document.body.append(host);
    root = createRoot(host);
    act(() => root!.render(React.createElement(BriefingMap, { mapId: "Erangel", snapshot })));
    const svg = host.querySelector("svg")!;
    vi.spyOn(svg, "getBoundingClientRect").mockReturnValue({ left: 0, top: 0, width: 500, height: 500, right: 500, bottom: 500, x: 0, y: 0, toJSON: () => ({}) });
    expect(Number(svg.getAttribute("viewBox")!.split(" ")[2])).toBe(5248);
    act(() => Array.from(host.querySelectorAll("button")).find((button) => button.textContent === "교전 위치 확대")!.click());
    const [left, top, size] = svg.getAttribute("viewBox")!.split(" ").map(Number);
    expect(size).toBe(186);
    expect(left + size / 2).toBeCloseTo((3991 + 4115) / 2);
    expect(top + size / 2).toBeCloseTo((5369 + 5440) / 2);
    expect(left + size).toBeLessThan(snapshot.zone.x);

    const marks = host.querySelectorAll("[data-player-mark]");
    expect(marks).toHaveLength(4);
    expect(host.querySelector('[data-player-mark="teammate"] circle')?.getAttribute("cx")).toBe("3995");
    const enemies = host.querySelectorAll<SVGPolygonElement>('[data-player-mark="opponent"] polygon');
    const enemyVertices = enemies[0].getAttribute("points")!.split(" ").map((point) => point.split(",").map(Number));
    expect(enemyVertices.reduce((sum, [x]) => sum + x, 0) / enemyVertices.length).toBeCloseTo(3991);
    expect(enemyVertices.reduce((sum, [, y]) => sum + y, 0) / enemyVertices.length).toBeCloseTo(5369);
    expect(enemies[0].getAttribute("fill")).toBe("#fb526b");
    expect(host.querySelector('[data-player-mark="teammate"] circle')?.getAttribute("fill")).toBe("#22d3ee");
    expect(Array.from(host.querySelectorAll("[data-player-mark] text"), (label) => label.textContent)).toEqual(["상대 1", "팀원 2"]);
    expect(host.querySelector('[data-player-mark="opponent"] title')?.textContent).toBe("07:56 상대 1 기록된 위치");
    expect(host.querySelectorAll('[data-player-mark="teammate"] title')).toHaveLength(2);
    expect(host.querySelector('[data-player-mark="teammate"] path')).toBeTruthy();
    expect(Array.from(host.querySelectorAll("circle > title"), (title) => title.textContent)).toContain("본인 시작 위치 · 07:50");
    expect(host.querySelectorAll("text")).toHaveLength(4);
    const captions = Array.from(host.querySelectorAll<SVGRectElement>("[data-map-caption]"), (caption) => ({
      x: Number(caption.getAttribute("x")), y: Number(caption.getAttribute("y")),
      width: Number(caption.getAttribute("width")), height: Number(caption.getAttribute("height")),
    }));
    for (const caption of captions) {
      expect(caption.x).toBeGreaterThanOrEqual(left);
      expect(caption.y).toBeGreaterThanOrEqual(top);
      expect(caption.x + caption.width).toBeLessThanOrEqual(left + size);
      expect(caption.y + caption.height).toBeLessThanOrEqual(top + size);
    }
    for (let index = 0; index < captions.length; index++) {
      for (const other of captions.slice(index + 1)) {
        expect(captions[index].x + captions[index].width <= other.x || other.x + other.width <= captions[index].x
          || captions[index].y + captions[index].height <= other.y || other.y + other.height <= captions[index].y).toBe(true);
      }
    }
    expect(host.querySelectorAll("[data-caption-leader]")).toHaveLength(4);

    const wrapper = host.firstElementChild!;
    expect(wrapper.children[1].textContent).toBe("교전 위치 확대");
    expect(wrapper.children[2].getAttribute("aria-label")).toBe("지도 범례");
    expect(wrapper.children[0].compareDocumentPosition(wrapper.children[2]) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(wrapper.children[0].querySelector('[data-testid="blue-zone-outside"]')).toBeNull();
    const zoomIn = host.querySelector<HTMLButtonElement>('[aria-label="지도 확대"]')!;
    expect(zoomIn.disabled).toBe(false);
    act(() => zoomIn.click());
    expect(Number(svg.getAttribute("viewBox")!.split(" ")[2])).toBeLessThan(size);
  });

  it("keeps captions at 12 screen pixels when the map resizes", () => {
    let renderedWidth = 375;
    let notifyResize = () => {};
    const disconnect = vi.fn();
    class MockResizeObserver {
      constructor(callback: ResizeObserverCallback) {
        notifyResize = () => callback([], this as unknown as ResizeObserver);
      }
      observe = vi.fn();
      disconnect = disconnect;
    }
    vi.stubGlobal("ResizeObserver", MockResizeObserver);
    vi.spyOn(SVGElement.prototype, "getBoundingClientRect").mockImplementation(() => ({
      left: 0, top: 0, width: renderedWidth, height: renderedWidth, right: renderedWidth, bottom: renderedWidth,
      x: 0, y: 0, toJSON: () => ({}),
    }));
    host = document.createElement("div");
    document.body.append(host);
    root = createRoot(host);
    act(() => root!.render(React.createElement(BriefingMap, { mapId: "Erangel", snapshot: {
      path: [{ x: 4000, y: 4000 }], viewSize: 1000,
      marks: [{ x: 4010, y: 4000, kind: "teammate" as const, label: "08:00 팀원 1 기록된 위치" }],
    } })));
    const svg = host.querySelector("svg")!;
    const screenFontSize = () => Number(host.querySelector("text")!.getAttribute("font-size"))
      * renderedWidth / Number(svg.getAttribute("viewBox")!.split(" ")[2]);
    const caption = () => host.querySelector<SVGRectElement>('[data-map-caption="start"]')!;
    const fontSize = () => Number(host.querySelector("text")!.getAttribute("font-size"));
    expect(screenFontSize()).toBeCloseTo(12);
    expect(Number(caption().getAttribute("height")) / fontSize()).toBeCloseTo(1.45);
    expect(Number(caption().getAttribute("stroke-width")) / fontSize()).toBeCloseTo(0.06);

    renderedWidth = 1000;
    act(() => notifyResize());
    expect(screenFontSize()).toBeCloseTo(12);
    expect(Number(caption().getAttribute("height")) / fontSize()).toBeCloseTo(1.45);
    expect(Number(caption().getAttribute("stroke-width")) / fontSize()).toBeCloseTo(0.06);
    act(() => root!.unmount());
    root = undefined;
    expect(disconnect).toHaveBeenCalledOnce();
  });

  it("keeps off-screen player markers and history but hides their captions", () => {
    host = document.createElement("div");
    document.body.append(host);
    root = createRoot(host);
    act(() => root!.render(React.createElement(BriefingMap, { mapId: "Erangel", snapshot: {
      path: [{ x: 1000, y: 4000 }, { x: 7000, y: 4000 }], viewSize: 512,
      marks: [{ x: 4000, y: 4000, kind: "opponent" as const, label: "08:00 상대 1 기록된 위치" }],
    } })));
    const svg = host.querySelector("svg")!;
    vi.spyOn(svg, "getBoundingClientRect").mockReturnValue({ left: 0, top: 0, width: 500, height: 500, right: 500, bottom: 500, x: 0, y: 0, toJSON: () => ({}) });
    act(() => host.querySelector<HTMLButtonElement>('[aria-label="지도 확대"]')!.click());
    expect(host.querySelector('[data-map-caption="start"]')).toBeNull();
    expect(host.querySelector('[data-map-caption="end"]')).toBeNull();
    expect(host.querySelector('[data-player-mark="opponent"] polygon')).toBeTruthy();
    expect(host.querySelector('[data-player-mark="opponent"] title')?.textContent).toBe("08:00 상대 1 기록된 위치");
  });

  it("zooms to a 32 m span using available level-five map tiles", () => {
    host = document.createElement("div");
    document.body.append(host);
    root = createRoot(host);
    act(() => root!.render(React.createElement(BriefingMap, { mapId: "Erangel", snapshot: {
      path: [{ x: 4000, y: 4000 }], viewSize: 512,
    } })));
    const svg = host.querySelector("svg")!;
    vi.spyOn(svg, "getBoundingClientRect").mockReturnValue({ left: 0, top: 0, width: 500, height: 500, right: 500, bottom: 500, x: 0, y: 0, toJSON: () => ({}) });
    act(() => { for (let index = 0; index < 30; index++) host.querySelector<HTMLButtonElement>('[aria-label="지도 확대"]')!.click(); });
    expect(Number(svg.getAttribute("viewBox")!.split(" ")[2])).toBe(32);
    expect(host.querySelector<HTMLButtonElement>('[aria-label="지도 확대"]')?.disabled).toBe(true);
    expect(Array.from(svg.querySelectorAll("image"), (tile) => tile.getAttribute("href")).some((href) => href?.startsWith("/tiles/Erangel/5/"))).toBe(true);
  });

  it("draws the observed blue outside area below the announced yellow circle", () => {
    const container = document.createElement("div");
    container.innerHTML = renderToStaticMarkup(React.createElement(BriefingMap, { mapId: "Erangel", snapshot: {
      path: [{ x: 4000, y: 4000 }], viewSize: 1000,
      blueZone: { x: 4100, y: 4100, radius: 600, observedSeconds: 300, sourceIndex: 2, status: "shrinking" },
      zone: { x: 4200, y: 4200, radius: 300 },
    } }));
    const outside = container.querySelector<SVGPathElement>('[data-testid="blue-zone-outside"]')!;
    const blueBoundary = Array.from(container.querySelectorAll("circle")).find((circle) => circle.querySelector("title")?.textContent === "관측된 현재 안전구역 경계")!;
    const yellowCenter = Array.from(container.querySelectorAll("circle")).find((circle) => circle.querySelector("title")?.textContent === "표시된 원의 중심")!;
    expect(outside.getAttribute("fill-rule")).toBe("evenodd");
    expect(outside.getAttribute("d")).toContain("M0 0 H8192 V8192 H0 Z");
    expect(outside.getAttribute("d")).toContain("M4700 4100 A600 600");
    const [left, top, size] = container.querySelector("svg")!.getAttribute("viewBox")!.split(" ").map(Number);
    expect(size).toBe(1000);
    expect(left).toBeLessThan(4000);
    expect(left + size).toBeGreaterThan(4000);
    expect(top).toBeLessThan(4000);
    expect(top + size).toBeGreaterThan(4000);
    expect(outside.compareDocumentPosition(blueBoundary) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(blueBoundary.compareDocumentPosition(yellowCenter) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(container.textContent).toContain("파란 현재 안전구역 경계");
    expect(container.textContent).toContain("파란 바깥 닫힌 영역");
    expect(container.textContent).toContain("노란 다음 원");
  });

  it("starts at the fight, offers the whole current circle, and resets to the local map", () => {
    host = document.createElement("div");
    document.body.append(host);
    root = createRoot(host);
    act(() => root!.render(React.createElement(BriefingMap, { mapId: "Erangel", snapshot: {
      path: [{ x: 3800, y: 3800 }], viewSize: 1000,
      blueZone: { x: 4096, y: 4096, radius: 5820, observedSeconds: 100, sourceIndex: 1, status: "waiting" },
      zone: { x: 3900, y: 3900, radius: 300 },
    } })));
    const svg = host.querySelector("svg")!;
    vi.spyOn(svg, "getBoundingClientRect").mockReturnValue({ left: 0, top: 0, width: 500, height: 500, right: 500, bottom: 500, x: 0, y: 0, toJSON: () => ({}) });
    const viewSize = () => Number(svg.getAttribute("viewBox")!.split(" ")[2]);
    const whole = () => Array.from(host.querySelectorAll("button")).find((button) => button.textContent === "현재 원 전체 보기" || button.textContent === "교전 위치 보기")!;
    expect(viewSize()).toBe(1000);
    expect(whole().classList.contains("min-h-11")).toBe(true);
    act(() => whole().click());
    expect(viewSize()).toBe(8192);
    expect(whole().textContent).toBe("교전 위치 보기");
    act(() => host.querySelector<HTMLButtonElement>('button[aria-label="지도 축소"]')!.click());
    expect(viewSize()).toBe(8192);
    act(() => host.querySelector<HTMLButtonElement>('button[aria-label="지도 확대"]')!.click());
    expect(viewSize()).toBeLessThan(8192);
    act(() => host.querySelector<HTMLButtonElement>('button[aria-label="지도 보기 초기화"]')!.click());
    expect(viewSize()).toBe(1000);
    expect(whole().textContent).toBe("현재 원 전체 보기");
  });

  it("shows sampled blue-zone states and omits them from the full-match overview", () => {
    const states = ["waiting", "shrinking", "complete", "unknown"] as const;
    const chapters = states.map((status, index) => ({ ...scenes[0], id: `zone-${status}`, title: status,
      mapSnapshot: { ...scenes[0].mapSnapshot!, blueZone: { x: 100, y: 200, radius: 600,
        observedSeconds: 120 + index * 10, sourceIndex: index, status, ...(status === "waiting" ? { countdownSeconds: 95 } : {}) } },
    }));
    const overview = { ...scenes[0].mapSnapshot!, blueZone: chapters[0].mapSnapshot.blueZone };
    mount(chapters, overview);
    const snapshot = () => JSON.parse(host.querySelector('[data-testid="scene-map"]')!.getAttribute("data-snapshot")!);
    expect(host.textContent).toContain("파란 현재 안전구역 · 02:00 관측 · 축소 대기 · 관측된 축소 시작까지 01:35");
    expect(host.textContent).toContain("남은 시간은 첫 축소 관측 기준");
    expect(snapshot().blueZone.status).toBe("waiting");
    act(() => Array.from(host.querySelectorAll("button")).find((button) => button.textContent === "전체 동선 보기")!.click());
    expect(host.textContent).not.toContain("파란 현재 안전구역");
    expect(snapshot().blueZone).toBeUndefined();
    act(() => host.querySelector<HTMLButtonElement>('button[aria-label="다음 장면"]')!.click());
    expect(snapshot().blueZone.status).toBe("shrinking");
    expect(host.textContent).toContain("02:10 관측 · 축소 중");
    act(() => host.querySelector<HTMLButtonElement>('button[aria-label="다음 장면"]')!.click());
    expect(host.textContent).toContain("02:20 관측 · 축소 완료/다음 원 대기");
    act(() => host.querySelector<HTMLButtonElement>('button[aria-label="다음 장면"]')!.click());
    expect(host.textContent).toContain("02:30 관측 · 상태 확인 불가");
  });

  it("switches between highlights and every chapter while resetting details and the map", () => {
    const chapter = { ...scenes[0], brief: { situation: "상황 요약", action: "이동 → 교전", outcome: "결과 요약" } };
    const highlight = { ...chapter, title: "연결된 핵심 장면", mapSnapshot: { path: [{ x: 8, y: 9 }], viewSize: 512 } };
    const overview = { path: [{ x: 1, y: 2 }], viewSize: 4096 };
    mount([chapter, scenes[1]], overview, [highlight]);
    const views = host.querySelectorAll<HTMLButtonElement>('[aria-label="경기 보기 선택"] button');
    expect(views[0].textContent).toBe("핵심 장면 1개");
    expect(views[0].classList.contains("max-w-full")).toBe(true);
    expect(host.querySelector('[aria-label="경기 보기 선택"]')?.classList.contains("flex-wrap")).toBe(true);
    expect(views[1].textContent).toBe("전체 흐름");
    expect(views[0].getAttribute("aria-pressed")).toBe("true");
    expect(views[1].classList.contains("min-h-11")).toBe(true);
    expect(host.querySelector("article h2")?.textContent).toBe(highlight.title);
    expect(host.querySelectorAll("button[data-scene-index]")).toHaveLength(1);
    const snapshot = () => JSON.parse(host.querySelector('[data-testid="scene-map"]')!.getAttribute("data-snapshot")!);
    expect(snapshot()).toEqual(highlight.mapSnapshot);
    const details = host.querySelector<HTMLDetailsElement>("article details")!;
    act(() => details.querySelector("summary")!.click());
    act(() => Array.from(host.querySelectorAll("button")).find((button) => button.textContent === "전체 동선 보기")!.click());
    expect(snapshot()).toEqual(overview);
    act(() => views[1].click());
    expect(views[1].getAttribute("aria-pressed")).toBe("true");
    expect(host.querySelectorAll("button[data-scene-index]")).toHaveLength(2);
    expect(host.querySelector("article h2")?.textContent).toBe(chapter.title);
    expect(host.querySelector<HTMLDetailsElement>("article details")?.open).toBe(false);
    expect(host.querySelector("article details")).not.toBe(details);
    expect(snapshot()).toEqual(chapter.mapSnapshot);
    act(() => host.querySelector<HTMLButtonElement>('button[aria-label="다음 장면"]')!.click());
    expect(host.querySelector("article h2")?.textContent).toBe(scenes[1].title);
    expect(host.querySelector('[data-testid="scene-map"]')).toBeNull();
    act(() => views[0].click());
    expect(host.querySelector("article h2")?.textContent).toBe(highlight.title);
    expect(snapshot()).toEqual(highlight.mapSnapshot);
  });

  it("shows only observed movement times in time order and labels only an exact landing point", () => {
    const movement = { landing: { timeSeconds: 0, place: "학교" }, phase: 1, revealedSeconds: 60,
      shrinkObservedSeconds: 120, insideObservedSeconds: 90, outsideMeters: 1264 };
    const exact = { ...scenes[0], movement, mapSnapshot: { ...scenes[0].mapSnapshot!, pathStartSeconds: 0 } };
    const later = { ...exact, id: "later", movement: { ...movement, shrinkObservedSeconds: null, insideObservedSeconds: null },
      mapSnapshot: { ...exact.mapSnapshot, pathStartSeconds: 10 } };
    mount([exact, later]);
    const timeline = () => host.querySelector('[aria-label="착지와 원의 기록 시각"]')!;
    expect(Array.from(timeline().querySelectorAll("time"), (item) => item.textContent)).toEqual(["00:00", "01:00", "01:30", "02:00"]);
    expect(timeline().textContent).toContain("착지 · 학교");
    expect(timeline().textContent).toContain("원 안 확인");
    expect(host.textContent).toContain("공개 때 원 밖 약 1264m");
    expect(host.textContent).toContain("정확한 진입 시각은 아닙니다");
    const snapshot = () => JSON.parse(host.querySelector('[data-testid="scene-map"]')!.getAttribute("data-snapshot")!);
    expect(snapshot().playerLabel).toBe("랭커 착지");
    act(() => host.querySelector<HTMLButtonElement>('button[aria-label="다음 장면"]')!.click());
    expect(timeline().textContent).not.toContain("축소 확인");
    expect(timeline().textContent).not.toContain("원 안 확인");
    expect(snapshot().playerLabel).toBeUndefined();
  });

  it("moves chapter selection and keyboard focus together in the compact timeline", () => {
    mount(scenes);
    const buttons = host.querySelectorAll<HTMLButtonElement>("button[data-scene-index]");
    expect(host.querySelector('[aria-label="장면 선택"]')?.classList.contains("overflow-x-auto")).toBe(true);
    expect(buttons[0].getAttribute("aria-label")).toBe("1장 착지");
    expect(buttons[0].classList.contains("min-h-11")).toBe(true);
    buttons[0].focus();
    act(() => buttons[0].dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true })));
    expect(document.activeElement).toBe(buttons[1]);
    expect(buttons[1].getAttribute("aria-current")).toBe("step");
    expect(buttons[1].getAttribute("aria-pressed")).toBe("true");
    expect(host.querySelector("article h2")?.textContent).toBe("마지막 교전");
    act(() => buttons[1].dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowLeft", bubbles: true })));
    expect(document.activeElement).toBe(buttons[0]);
    expect(host.querySelector("article h2")?.textContent).toBe("착지");
  });

  it("synchronizes the overview, displayed circle time, and collapsed observations with chapter selection", () => {
    const chapterMap = { ...scenes[0].mapSnapshot!, zoneObservedSeconds: 82,
      observations: [{ x: 100, y: 200, timeSeconds: 30, evidenceId: "a", label: "착지 위치" }] };
    const overview = { path: [{ x: 300, y: 400 }], viewSize: 4096, zoneObservedSeconds: 600 };
    mount([{ ...scenes[0], mapSnapshot: chapterMap }, scenes[1]], overview);
    expect(host.textContent).toContain("표시한 원(안전구역) · 01:22 공개");
    expect(host.querySelector("details")?.open).toBe(false);
    const toggle = Array.from(host.querySelectorAll("button")).find((button) => button.textContent === "전체 동선 보기")!;
    act(() => toggle.click());
    expect(toggle.getAttribute("aria-pressed")).toBe("true");
    expect(host.textContent).toContain("표시한 원(안전구역) · 10:00 공개");
    expect(JSON.parse(host.querySelector('[data-testid="scene-map"]')!.getAttribute("data-snapshot")!)).toEqual(overview);
    act(() => host.querySelector<HTMLButtonElement>('button[aria-label="다음 장면"]')!.click());
    expect(toggle.getAttribute("aria-pressed")).toBe("false");
    expect(host.textContent).not.toContain("표시한 원");
    expect(host.querySelector('[data-testid="scene-map"]')).toBeNull();
  });

  it("wires the page to the complete walkthrough while preserving empty-scene legacy articles", async () => {
    const story = { dayKst: "2026-09-27", mode: "duo", nickname: "winner", mapName: "Erangel", kills: 7, damage: 800, teamKills: 10,
      leaderboardRank: 2, headline: "저장된 제목", conclusion: "저장된 결론", scenes: [scenes[1]], facts: [{ id: "a", timeSeconds: 0, text: "원본 기록" }] } as DailyRankerStory;
    const overview = { path: [{ x: 1, y: 2 }], viewSize: 1000 };
    vi.mocked(getDailyRankerStory).mockResolvedValue(story);
    vi.mocked(buildDailyWalkthrough).mockReturnValue({ headline: "먼 첫 원부터 마지막 수류탄까지", summary: "1264m 밖 → 07:18 오토바이 → 08:22 진입 → Lynx → 27:53 수류탄", chapters: scenes, highlights: [{ ...scenes[1], title: "수류탄 피해부터 처치까지" }], overview,
      takeaways: [{ title: "먼 첫 원 이동", text: "이동 시작과 진입 시각을 점검하세요.", evidenceIds: ["a"] }] });
    const element = await DailyModePage({ params: Promise.resolve({ day: story.dayKst, mode: "duo" }) });
    const container = document.createElement("div");
    container.innerHTML = renderToStaticMarkup(element);
    expect(buildDailyWalkthrough).toHaveBeenCalledWith(story);
    expect(container.querySelector("h1")?.textContent).toBe("먼 첫 원부터 마지막 수류탄까지");
    expect(container.querySelector("header")?.textContent).toContain("07:18 오토바이");
    expect(container.querySelector("header")?.textContent).toContain("팀 합계 10킬");
    expect(container.textContent).not.toContain("재합류");
    expect(container.querySelector("article h2")?.textContent).toBe("수류탄 피해부터 처치까지");
    expect(container.querySelector('[aria-label="경기 보기 선택"]')?.textContent).toContain("전체 흐름");
    expect(container.textContent).toContain("장면별 핵심");
    expect(container.textContent).toContain("본인은 분석 대상 선수이며, 팀원·상대 번호는 경기 내내 같습니다.");
    expect(container.querySelector('[aria-label="이 경기의 운영 핵심"]')?.textContent).toContain("먼 첫 원 이동");
    expect(Array.from(container.querySelectorAll("details")).every((detail) => !detail.open)).toBe(true);
    expect(container.querySelector("header details")).toBeNull();
    vi.mocked(getDailyRankerStory).mockResolvedValue({ ...story, scenes: [] });
    vi.mocked(buildDailyWalkthrough).mockClear();
    expect(renderToStaticMarkup(await DailyModePage({ params: Promise.resolve({ day: story.dayKst, mode: "duo" }) }))).toContain("기존 경기 상세");
    expect(buildDailyWalkthrough).not.toHaveBeenCalled();
  });
});
