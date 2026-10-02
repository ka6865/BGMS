"use client";

import { useEffect, useRef, useState } from "react";
import { Component, type ReactNode } from "react";
import dynamic from "next/dynamic";
import type { RankerScene } from "@/lib/learn/lessons";

const BriefingMap = dynamic(() => import("./BriefingMap"), {
  ssr: false,
  loading: () => <div role="status" className="grid aspect-square place-items-center rounded-xl border border-zinc-800 bg-zinc-900/60 text-sm text-zinc-400">장면 지도 불러오는 중</div>,
});

class MapErrorBoundary extends Component<{ children: ReactNode }, { failed: boolean }> {
  state = { failed: false };
  static getDerivedStateFromError() { return { failed: true }; }
  render() {
    return this.state.failed
      ? <div role="status" className="grid aspect-square place-items-center rounded-xl border border-zinc-800 bg-zinc-900/60 p-5 text-center text-sm leading-6 text-zinc-400">지도를 불러오지 못했습니다. 장면 해설은 계속 읽을 수 있습니다.</div>
      : this.props.children;
  }
}

export default function BriefingMapShell({ snapshot, mapId }: {
  snapshot: NonNullable<RankerScene["mapSnapshot"]>;
  mapId: string;
}) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [nearby, setNearby] = useState(false);

  useEffect(() => {
    const element = containerRef.current;
    if (!element || typeof IntersectionObserver === "undefined") {
      setNearby(true);
      return;
    }
    const observer = new IntersectionObserver(([entry]) => {
      if (entry.isIntersecting) {
        setNearby(true);
        observer.disconnect();
      }
    }, { rootMargin: "400px" });
    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  return <div ref={containerRef}>
    {snapshot.path.length === 0 ? <div role="status" className="grid aspect-square place-items-center rounded-xl border border-zinc-800 bg-zinc-900/60 p-5 text-center text-sm text-zinc-400">이 장면에는 기록된 위치가 없습니다. 해설은 계속 읽을 수 있습니다.</div>
      : nearby ? <MapErrorBoundary key={`${mapId}-${JSON.stringify(snapshot)}`}><BriefingMap snapshot={snapshot} mapId={mapId} /></MapErrorBoundary>
      : <div className="grid aspect-square place-items-center rounded-xl border border-zinc-800 bg-zinc-900/60 text-sm text-zinc-400">장면 지도</div>}
  </div>;
}
