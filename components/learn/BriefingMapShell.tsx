"use client";

import { useEffect, useRef, useState } from "react";
import dynamic from "next/dynamic";
import type { RankerScene } from "@/lib/learn/lessons";

const BriefingMap = dynamic(() => import("./BriefingMap"), { ssr: false });

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
    {nearby ? <BriefingMap snapshot={snapshot} mapId={mapId} />
      : <div className="grid aspect-square place-items-center rounded-xl border border-zinc-800 bg-zinc-900/60 text-sm text-zinc-400">장면 지도</div>}
  </div>;
}
