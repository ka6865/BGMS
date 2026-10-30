import { NextResponse } from "next/server";
import { requireAdmin } from "@/lib/server/adminGuard";
import { buildStorageHealth } from "@/lib/admin-agent/storage-health";

export async function GET() {
  const adminContext = await requireAdmin();
  if (!adminContext.ok) return adminContext.error;

  try {
    // 0. 📊 스쿼드 및 API 절약 지표 연산 (안전장치 추가)
    let totalMatches = 0;
    let squadMatches = 0;
    let estimatedSquadGroups = 0;

    try {
      const { count: totalCount, error: totalErr } = await adminContext.supabaseAdmin
        .from("processed_match_telemetry")
        .select("match_id", { count: "exact", head: true });
      if (!totalErr && totalCount !== null) {
        totalMatches = totalCount;
      }

      const { count: squadCount, error: squadErr } = await adminContext.supabaseAdmin
        .from("processed_match_telemetry")
        .select("match_id", { count: "exact", head: true })
        .filter("data->fullResult->>gameMode", "ilike", "%squad%");
      if (!squadErr && squadCount !== null) {
        squadMatches = squadCount;
      }

      const { data: recentMatches, error: recentErr } = await adminContext.supabaseAdmin
        .from("processed_match_telemetry")
        .select("data")
        .order("updated_at", { ascending: false })
        .limit(100);

      if (!recentErr && recentMatches) {
        const squadGroups = new Set<string>();
        recentMatches.forEach(m => {
          const fullResult = (m.data as any)?.fullResult;
          if (!fullResult) return;
          const mode = fullResult.gameMode || "";
          if (!mode.includes("squad")) return;

          const team = fullResult.team || [];
          const memberNames = team
            .map((t: any) => t.name)
            .filter(Boolean)
            .sort((a: string, b: string) => a.localeCompare(b));

          if (memberNames.length > 1) {
            squadGroups.add(memberNames.join(", "));
          }
        });
        estimatedSquadGroups = squadGroups.size;
      }
    } catch (squadStatsErr) {
      console.error("[Dashboard API] Squad statistics calculation error:", squadStatsErr);
    }

    // 1. 📍 맵 마커 제보 승인 대기 건수
    const { count: pendingCount, error: pendingErr } = await adminContext.supabaseAdmin
      .from("pending_markers")
      .select("id", { count: "exact", head: true });

    if (pendingErr) throw pendingErr;

    // 2. ⚡ Supabase DB / R2 스토리지 캐시 모니터링
    const storageHealth = await buildStorageHealth(adminContext.supabaseAdmin);

    // 3. 📊 PUBG API Rate Limit
    const { data: pubgStatus, error: pubgErr } = await adminContext.supabaseAdmin
      .from("pubg_api_status")
      .select("*")
      .order("updated_at", { ascending: false })
      .limit(1)
      .maybeSingle();

    if (pubgErr) throw pubgErr;

    // 4. 🤖 AI 사용량 및 7일간의 날짜별 누적 비용/토큰 통계
    const sevenDaysAgo = new Date();
    sevenDaysAgo.setDate(sevenDaysAgo.getDate() - 6); // 오늘 포함 7일
    sevenDaysAgo.setHours(0, 0, 0, 0);

    const { data: aiLogs, error: aiErr } = await adminContext.supabaseAdmin
      .from("ai_usage_logs")
      .select("created_at, cost_usd, prompt_tokens, completion_tokens")
      .gte("created_at", sevenDaysAgo.toISOString());

    if (aiErr) throw aiErr;

    const dailyStats: Record<string, { cost: number; promptTokens: number; completionTokens: number }> = {};
    for (let i = 6; i >= 0; i--) {
      const d = new Date();
      d.setDate(d.getDate() - i);
      const dateStr = d.toISOString().split("T")[0];
      dailyStats[dateStr] = { cost: 0, promptTokens: 0, completionTokens: 0 };
    }

    if (aiLogs) {
      aiLogs.forEach(log => {
        const dateStr = new Date(log.created_at).toISOString().split("T")[0];
        if (dailyStats[dateStr]) {
          dailyStats[dateStr].cost += Number(log.cost_usd || 0);
          dailyStats[dateStr].promptTokens += Number(log.prompt_tokens || 0);
          dailyStats[dateStr].completionTokens += Number(log.completion_tokens || 0);
        }
      });
    }

    const aiUsageChartData = Object.entries(dailyStats).map(([date, val]) => ({
      date,
      cost: parseFloat(val.cost.toFixed(6)),
      promptTokens: val.promptTokens,
      completionTokens: val.completionTokens
    }));

    return NextResponse.json({
      pendingMarkersCount: pendingCount || 0,
      r2Cache: {
        fileCount: storageHealth.r2.fileCount,
        totalSizeBytes: storageHealth.r2.totalSizeBytes,
        truncated: storageHealth.r2.truncated,
        scannedPages: storageHealth.r2.scannedPages,
        status: storageHealth.r2.status
      },
      storageHealth,
      pubgApi: pubgStatus ? {
        limit: pubgStatus.api_limit,
        remaining: pubgStatus.remaining,
        resetAt: pubgStatus.reset_at,
        updatedAt: pubgStatus.updated_at
      } : null,
      aiUsage: aiUsageChartData,
      squadStats: {
        totalMatches,
        squadMatches,
        estimatedSquadGroups,
        savedApiCalls: totalMatches * 2,
        savedBandwidthBytes: storageHealth.r2.totalSizeBytes
      }
    });
  } catch (error: any) {
    console.error("Dashboard API error:", error);
    return NextResponse.json({ error: "대시보드 데이터를 불러올 수 없습니다." }, { status: 500 });
  }
}
