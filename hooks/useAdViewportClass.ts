"use client";

import { useSyncExternalStore } from "react";

export type AdViewportClass = "unknown" | "mobile" | "tablet" | "desktop" | "wide";

export interface AdMediaQuerySnapshot {
  min768: boolean;
  min1280: boolean;
  min1600: boolean;
}

const AD_MEDIA_QUERIES = [
  "(min-width: 768px)",
  "(min-width: 1280px)",
  "(min-width: 1600px)",
] as const;

export function resolveAdViewportClass(snapshot: AdMediaQuerySnapshot): Exclude<AdViewportClass, "unknown"> {
  if (snapshot.min1600) return "wide";
  if (snapshot.min1280) return "desktop";
  if (snapshot.min768) return "tablet";
  return "mobile";
}

function readAdViewportSnapshot(): AdViewportClass {
  if (typeof window === "undefined" || typeof window.matchMedia !== "function") return "unknown";
  const [min768, min1280, min1600] = AD_MEDIA_QUERIES.map((query) => window.matchMedia(query).matches);
  return resolveAdViewportClass({ min768, min1280, min1600 });
}

function subscribeToAdMediaQueries(onStoreChange: () => void): () => void {
  if (typeof window === "undefined" || typeof window.matchMedia !== "function") return () => {};
  const mediaQueries = AD_MEDIA_QUERIES.map((query) => window.matchMedia(query));
  for (const mediaQuery of mediaQueries) {
    if (typeof mediaQuery.addEventListener === "function") mediaQuery.addEventListener("change", onStoreChange);
    else mediaQuery.addListener(onStoreChange);
  }
  return () => {
    for (const mediaQuery of mediaQueries) {
      if (typeof mediaQuery.removeEventListener === "function") mediaQuery.removeEventListener("change", onStoreChange);
      else mediaQuery.removeListener(onStoreChange);
    }
  };
}

export function useAdViewportClass(): AdViewportClass {
  return useSyncExternalStore(subscribeToAdMediaQueries, readAdViewportSnapshot, () => "unknown");
}
