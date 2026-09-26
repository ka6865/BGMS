"use client";

import { ArrowUpRight } from "lucide-react";

export function DailyEvidenceLink({ id }: { id: string }) {
  return (
    <a
      href={`#${encodeURIComponent(id)}`}
      onClick={() => {
        const details = document.getElementById("daily-facts");
        if (details instanceof HTMLDetailsElement) details.open = true;
      }}
      className="inline-flex min-h-8 items-center gap-1 text-emerald-300 underline decoration-emerald-300/40 underline-offset-4 hover:text-emerald-200"
    >
      근거 {id} <ArrowUpRight size={12} />
    </a>
  );
}
