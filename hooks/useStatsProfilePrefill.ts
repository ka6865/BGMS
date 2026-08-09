"use client";

import { useEffect, useState } from "react";
import { supabase } from "@/lib/supabase";
import { parseStatsPlatform } from "@/lib/stats/statsPageModel";
import type { StatsPlatform } from "@/types/stats-page";

export interface StatsProfilePrefill {
  nickname?: string;
  platform?: StatsPlatform;
  loaded: boolean;
}

interface KeyedStatsProfilePrefill extends StatsProfilePrefill {
  userId?: string;
}

export function useStatsProfilePrefill(userId?: string): StatsProfilePrefill {
  const [prefill, setPrefill] = useState<KeyedStatsProfilePrefill>({ loaded: true });

  useEffect(() => {
    if (!userId) return;
    let current = true;
    void supabase
      .from("profiles")
      .select("pubg_nickname, pubg_platform")
      .eq("id", userId)
      .single()
      .then(({ data }) => {
        if (!current) return;
        const nickname = typeof data?.pubg_nickname === "string"
          ? data.pubg_nickname.trim()
          : "";
        const platform = parseStatsPlatform(data?.pubg_platform) ?? "steam";
        setPrefill({
          userId,
          nickname: nickname || undefined,
          platform: nickname ? platform : undefined,
          loaded: true,
        });
      });
    return () => {
      current = false;
    };
  }, [userId]);

  if (!userId) return { loaded: true };
  if (prefill.userId !== userId) return { loaded: false };
  return { nickname: prefill.nickname, platform: prefill.platform, loaded: prefill.loaded };
}
