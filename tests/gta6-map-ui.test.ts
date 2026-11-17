// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { parseLandmarks } from "@/lib/gta6/map";

const probe = vi.hoisted(() => ({ zoom: -3, east: 17000, renders: 0, options: {} as Record<string, unknown>, handlers: new Set<() => void>() }));
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
    TileLayer: () => null,
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
  afterEach(() => { act(() => root.unmount()); host.remove(); vi.unstubAllGlobals(); });
  const render = (selected = null as (typeof places)[number] | null) => act(() => root.render(createElement(GtaMap, { places, selected, visited, onSelect })));

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
