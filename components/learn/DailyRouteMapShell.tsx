"use client";

import { useEffect, useRef, useState } from "react";
import dynamic from "next/dynamic";
import type { RoutePoint } from "./DailyRouteMap";

const DailyRouteMap = dynamic(() => import("./DailyRouteMap"), {
  ssr: false,
  loading: () => <div className="h-[280px] animate-pulse rounded-xl bg-zinc-800" aria-label="위치 지도 불러오는 중" />,
});

export function DailyRouteMapShell(props: { route: RoutePoint[]; mapName: string; nickname: string }) {
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
    }, { rootMargin: "300px" });
    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  return <div ref={containerRef}>
    {nearby ? <DailyRouteMap {...props} />
      : <div className="flex h-[280px] items-center justify-center rounded-xl border border-zinc-800 bg-zinc-900/50 text-sm text-zinc-400 sm:h-[380px]">팀 이동 지도</div>}
  </div>;
}
