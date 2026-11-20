// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { parseLandmarks } from "@/lib/gta6/map";

const probe = vi.hoisted(() => ({ zoom: -3, east: 17000, renders: 0, options: {} as Record<string, unknown>, tileOptions: {} as Record<string, unknown>, handlers: new Set<() => void>() }));
vi.mock("react-leaflet", async () => {
  const { createElement: el, useEffect } = await import("react");
  const map = {
    getZoom: () => probe.zoom,
    getBounds: () => ({ pad: () => ({ contains: (point: number[]) => point[1] < probe.east }) }),
    fitBounds: vi.fn(), setView: vi.fn(), invalidateSize: vi.fn(), getContainer: () => document.body,
    on: (_: string, handler: () => void) => probe.handlers.add(handler),
    off: (_: string, handler: () => void) => probe.handlers.delete(handler),
  };
  return {
    useMap: () => map,
    useMapEvents: (events: Record<string, () => void>) => {
      useEffect(() => { const fn = events.moveend ?? events.zoomend; probe.handlers.add(fn); return () => { probe.handlers.delete(fn); }; }, [events]);
      return map;
    },
    MapContainer: ({ children, ...options }: { children: React.ReactNode }) => { probe.options = options; return el("div", null, children); },
    TileLayer: ({ url, maxNativeZoom, zoomOffset, attribution }: Record<string, unknown>) => {
      probe.tileOptions = { url, maxNativeZoom, zoomOffset, attribution }; return null;
    },
    CircleMarker: ({ children }: { children: React.ReactNode }) => { probe.renders++; return el("div", { "data-marker": true }, children); },
    Marker: () => null,
    Tooltip: ({ children }: { children: React.ReactNode }) => el("span", null, children),
  };
});
import GtaMap from "@/components/gta6/GtaMap";

describe("GTA6 지도 마커 갱신", () => {
  let root: Root;
  let host: HTMLDivElement;
  const places = parseLandmarks({
    L1: ["First, Vice City", [0, 0], [], "", [], [], []],
    L2: ["Second, Vice City", [100, 0], [], "", [], [], []],
    L3: ["Far, Vice City", [3000, 0], [], "", [], [], []],
  });
  const onSelect = vi.fn();
  const visited = new Set<string>();
  beforeEach(() => {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    vi.stubGlobal("ResizeObserver", class { observe() {} disconnect() {} });
    probe.zoom = -3; probe.east = 17000; probe.renders = 0; probe.handlers.clear();
    host = document.createElement("div"); document.body.append(host); root = createRoot(host);
  });
  afterEach(() => {
    act(() => root.unmount()); host.remove(); vi.unstubAllGlobals(); vi.unstubAllEnvs();
    window.history.replaceState(null, "", "/");
  });
  const render = (selected = null as (typeof places)[number] | null) => act(() => root.render(createElement(GtaMap, { places, selected, visited, onSelect })));

  it("개발 주소에서 day 타일을 요청하면 다음 확대 단계의 원본 이미지를 사용한다", () => {
    vi.stubEnv("NODE_ENV", "development");
    window.history.replaceState(null, "", "/gta6?tiles=day");
    render();
    expect(probe.tileOptions).toMatchObject({ maxNativeZoom: 1, zoomOffset: 5 });
    expect(probe.tileOptions.url).toContain("/day/{z}/{z},{y},{x}.jpg");
    expect(probe.tileOptions.attribution).toContain("Rockstar Games / Take-Two");
    expect(probe.tileOptions.attribution).not.toContain("CC BY");
    expect(host.textContent).toContain("Day");
  });

  it("개발 기본 주소는 YANIS 타일을 사용한다", () => {
    vi.stubEnv("NODE_ENV", "development");
    render();
    expect(probe.tileOptions).toMatchObject({ url: "/gta6/tiles/yanis-18/{z}/{z},{y},{x}.jpg", maxNativeZoom: 0 });
    expect(probe.tileOptions.attribution).toContain("CC BY 4.0");
  });

  it("배경을 전환해도 선택한 장소와 지도 인스턴스, 나머지 주소를 유지한다", () => {
    vi.stubEnv("NODE_ENV", "development");
    window.history.replaceState(null, "", "/gta6?preview=1#L1");
    render(places[0]);
    const map = host.querySelector('[data-testid="gta6-map"]')?.firstElementChild;
    const [yanis, day] = host.querySelectorAll<HTMLButtonElement>('[aria-label="지도 배경"] button');

    act(() => day.click());
    expect(day.getAttribute("aria-pressed")).toBe("true");
    expect(probe.tileOptions.url).toContain("/day/");
    expect(window.location.search + window.location.hash).toBe("?preview=1&tiles=day#L1");
    expect(map?.textContent).toContain("First");

    act(() => yanis.click());
    expect(yanis.getAttribute("aria-pressed")).toBe("true");
    expect(probe.tileOptions.url).toContain("/yanis-18/");
    expect(window.location.search + window.location.hash).toBe("?preview=1#L1");
    expect(host.querySelector('[data-testid="gta6-map"]')?.firstElementChild).toBe(map);
  });

  it("운영에서는 비교 주소에도 외부 타일을 요청하지 않는다", () => {
    vi.stubEnv("NODE_ENV", "production");
    window.history.replaceState(null, "", "/gta6?tiles=day");
    render();
    expect(probe.tileOptions.url).toBe("/gta6/tiles/yanis-18/{z}/{z},{y},{x}.jpg");
    expect(host.querySelector('[aria-label="지도 배경"]')).toBeNull();
  });

  it("화면 밖 장소는 그리지 않고 선택한 장소는 항상 표시한다", () => {
    render();
    expect(host.textContent).toContain("First");
    expect(host.textContent).not.toContain("Far");
    render(places[2]);
    expect(host.textContent).toContain("Far");
  });

  it("같은 반경 구간의 소수 확대에서는 기존 마커를 다시 렌더링하지 않는다", () => {
    render(); const count = probe.renders;
    probe.zoom = -2.9;
    act(() => { for (const handler of [...probe.handlers]) handler(); });
    expect(probe.renders).toBe(count);
  });

  it("이동하면 새 화면의 장소가 나타나며 연속 확대 입력을 막지 않는다", () => {
    render(); probe.east = 20000;
    act(() => { for (const handler of [...probe.handlers]) handler(); });
    expect(host.textContent).toContain("Far");
    expect(probe.options).toMatchObject({ zoomAnimation: false, zoomSnap: 0, wheelDebounceTime: 16, wheelPxPerZoomLevel: 20 });
  });
});
