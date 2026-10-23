"use client";

import { useState } from "react";

export default function LolTierEmblem({ tier, rank }: { tier?: string; rank?: string }) {
  const [failedTier, setFailedTier] = useState<string>();
  const label = tier ? `${tier} ${rank ?? ""}`.trim() : "Unranked";
  if (!tier || failedTier === tier) {
    return (
      <span data-testid="lol-tier-badge" className="rounded-lg border border-zinc-700 bg-zinc-950 px-3 py-2 text-sm font-bold">
        {label}
      </span>
    );
  }
  return (
    <span className="flex min-w-0 items-center gap-3">
      <img
        src={`/lol/ranked-emblems/${tier.toLowerCase()}.webp`}
        alt=""
        width={64}
        height={64}
        onError={() => setFailedTier(tier)}
        className="h-16 w-16 shrink-0 object-contain"
      />
      <span data-testid="lol-tier-label" className="truncate text-base font-bold">{label}</span>
    </span>
  );
}
