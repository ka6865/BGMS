"use client";

import { useState } from "react";
import { formatLolTier } from "./lolFormat";

export default function LolTierEmblem({ tier, rank }: { tier?: string; rank?: string }) {
  const [failedTier, setFailedTier] = useState<string>();
  const label = formatLolTier(tier, rank);
  if (!tier || failedTier === tier) {
    return (
      <span data-testid="lol-tier-badge" className="min-w-0 truncate rounded-lg border border-zinc-700 bg-zinc-950 px-3 py-2 text-sm font-bold">
        {label}
      </span>
    );
  }
  return (
    <span className="flex min-w-0 items-center gap-2 lg:gap-3">
      <img
        src={`/lol/ranked-emblems/${tier.toLowerCase()}.webp`}
        alt=""
        width={64}
        height={64}
        onError={() => setFailedTier(tier)}
        className="h-10 w-10 shrink-0 object-contain lg:h-16 lg:w-16"
      />
      <span data-testid="lol-tier-label" className="truncate text-sm font-bold lg:text-base">{label}</span>
    </span>
  );
}
