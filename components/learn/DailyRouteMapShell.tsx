"use client";

import dynamic from "next/dynamic";
import type { RoutePoint } from "./DailyRouteMap";

const DailyRouteMap = dynamic(() => import("./DailyRouteMap"), {
  ssr: false,
  loading: () => <div className="h-[280px] animate-pulse rounded-xl bg-zinc-800" aria-label="위치 지도 불러오는 중" />,
});

export function DailyRouteMapShell(props: { route: RoutePoint[]; mapName: string; nickname: string }) {
  return <DailyRouteMap {...props} />;
}
