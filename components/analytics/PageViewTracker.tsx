"use client";

import { useEffect, useRef } from "react";
import { usePathname } from "next/navigation";
import { consumeLandingAttribution, trackEvent } from "@/lib/analytics";

const PAGE_VIEW_DEDUPE_MS = 5_000;

export default function PageViewTracker() {
  const pathname = usePathname();
  const lastSentRef = useRef<{ path: string; sentAt: number } | null>(null);

  useEffect(() => {
    if (!pathname) return;
    const now = Date.now();
    const last = lastSentRef.current;
    if (last?.path === pathname && now - last.sentAt < PAGE_VIEW_DEDUPE_MS) return;

    lastSentRef.current = { path: pathname, sentAt: now };
    trackEvent({
      name: "page_view",
      params: {
        path: pathname,
        title: typeof document !== "undefined" ? document.title : undefined,
        ...consumeLandingAttribution()
      }
    });
  }, [pathname]);

  return null;
}
