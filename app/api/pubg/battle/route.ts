import { NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";
import { normalizeName } from "@/lib/pubg-analysis/utils";
import { estimateAverageTierFromRows } from "@/lib/pubg-analysis/tierAveraging";
import { normalizePlatform } from "@/lib/pubg-analysis/cacheIdentity";

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
);

// 비교할 지표 목록
const METRICS = [
  { key: "damage",          label: "평균 딜량",       icon: "💥", unit: "",   higherIsBetter: true },
  { key: "kills",           label: "평균 킬",         icon: "🎯", unit: "킬", higherIsBetter: true },
  { key: "duel_win_rate",   label: "1:1 교전 승률",   icon: "⚔️", unit: "%",  higherIsBetter: true },
  { key: "initiative_rate", label: "선제 타격 성공률",   icon: "🚀", unit: "%",  higherIsBetter: true },
  { key: "reversal_rate",   label: "역전 성공률",     icon: "🔄", unit: "%",  higherIsBetter: true },
  { key: "counter_latency_ms", label: "반응 속도",    icon: "⚡", unit: "s",  higherIsBetter: false },
  { key: "revive_rate",     label: "부활 성공률",     icon: "💚", unit: "%",  higherIsBetter: true },
  { key: "trade_rate",      label: "복수 성공률",     icon: "🔄", unit: "%",  higherIsBetter: true },
  { key: "solo_kill_rate",  label: "솔로 킬 비중",    icon: "🔥", unit: "%",  higherIsBetter: true },
  { key: "death_phase",     label: "평균 생존 페이즈", icon: "⏱️", unit: "ph", higherIsBetter: true },
] as const;

type MetricKey = typeof METRICS[number]["key"];

function calcAvg(data: any[], key: MetricKey): number | null {
  const vals = data
    .map((d) => d[key])
    .filter((v) => v !== null && v !== undefined && v !== -1 && !isNaN(Number(v)));
  if (vals.length === 0) return null;
  const avg = vals.reduce((a, b) => a + Number(b), 0) / vals.length;
  if (key === "counter_latency_ms") {
    return Number((avg / 1000).toFixed(2));
  }
  return Number(avg.toFixed(1));
}

const MAX_COMPARE_MATCHES = 20;
const VALID_BATTLE_PLATFORMS = new Set(["steam", "kakao"]);

type ResolvedBattlePlayer = {
  nickname: string;
  playerId: string;
  platform: string;
};

async function resolveBattlePlayer(input: string, requestedPlatform?: string | null): Promise<ResolvedBattlePlayer> {
  const normalizedRequestedPlatform = requestedPlatform ? normalizePlatform(requestedPlatform) : "";
  const normalizedInput = normalizeName(input);

  if (normalizedRequestedPlatform) {
    if (!VALID_BATTLE_PLATFORMS.has(normalizedRequestedPlatform)) {
      throw new Error(`지원하지 않는 플랫폼입니다: ${requestedPlatform}`);
    }

    const { data } = await supabase
      .from("pubg_player_cache")
      .select("nickname, platform")
      .eq("lower_nickname", input.toLowerCase())
      .eq("platform", normalizedRequestedPlatform)
      .order("updated_at", { ascending: false })
      .limit(1);

    return {
      nickname: data?.[0]?.nickname || input,
      playerId: normalizedInput,
      platform: normalizedRequestedPlatform
    };
  }

  const { data } = await supabase
    .from("pubg_player_cache")
    .select("nickname, platform")
    .eq("lower_nickname", input.toLowerCase())
    .order("updated_at", { ascending: false })
    .limit(8);

  const validRows = (data || []).filter((row: any) => VALID_BATTLE_PLATFORMS.has(normalizePlatform(row.platform)));
  const platforms = Array.from(new Set(validRows.map((row: any) => normalizePlatform(row.platform))));

  if (platforms.length === 1) {
    return {
      nickname: validRows[0]?.nickname || input,
      playerId: normalizedInput,
      platform: platforms[0]
    };
  }

  if (platforms.length > 1) {
    throw new Error(`'${input}' 닉네임은 여러 플랫폼에 존재합니다. 플랫폼을 선택해 주세요.`);
  }

  throw new Error(`'${input}' 플랫폼을 확인할 수 없습니다. 전적 검색에서 플랫폼을 먼저 선택해 주세요.`);
}

export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const rawNick1 = searchParams.get("nick1")?.trim() || "";
  const rawNick2 = searchParams.get("nick2")?.trim() || "";
  const matchType = searchParams.get("matchType") || "all";
  const platform1 = searchParams.get("platform1");
  const platform2 = searchParams.get("platform2");

  if (!rawNick1 || !rawNick2) {
    return NextResponse.json({ error: "두 닉네임이 필요합니다." }, { status: 400 });
  }

  let player1: ResolvedBattlePlayer;
  let player2: ResolvedBattlePlayer;

  try {
    [player1, player2] = await Promise.all([
      resolveBattlePlayer(rawNick1, platform1),
      resolveBattlePlayer(rawNick2, platform2)
    ]);
  } catch (error: any) {
    return NextResponse.json({ error: error.message }, { status: 400 });
  }

  const nick1 = player1.playerId;
  const nick2 = player2.playerId;

  if (nick1 === nick2 && player1.platform === player2.platform) {
    return NextResponse.json({ error: "서로 다른 닉네임을 입력해 주세요." }, { status: 400 });
  }

  const SELECT_COLS = [
    "damage", "kills", "initiative_rate", "reversal_rate", "counter_latency_ms", "revive_rate", "trade_rate",
    "duel_win_rate", "solo_kill_rate", "death_phase", "tier", "score", "game_mode", "created_at", "platform",
  ].join(", ");

  const buildQuery = (player: ResolvedBattlePlayer) => {
    let q = supabase
      .from("global_benchmarks")
      .select(SELECT_COLS)
      .eq("player_id", player.playerId)
      .eq("platform", player.platform)
      .not("game_mode", "ilike", "%training%")
      .not("game_mode", "ilike", "%tdm%")
      .in("match_type", ["official", "competitive"])
      .order("created_at", { ascending: false })
      .limit(MAX_COMPARE_MATCHES);

    if (matchType === "official") {
      q = q.eq("match_type", "official");
    } else if (matchType === "competitive") {
      q = q.eq("match_type", "competitive");
    }
    return q;
  };

  const [r1, r2] = await Promise.all([
    buildQuery(player1),
    buildQuery(player2),
  ]);

  if (!r1.data?.length) {
    return NextResponse.json(
      { error: `'${rawNick1}' (${player1.platform}) 의 분석 데이터가 없습니다. 전적 분석을 먼저 실행해 주세요.` },
      { status: 404 }
    );
  }
  if (!r2.data?.length) {
    return NextResponse.json(
      { error: `'${rawNick2}' (${player2.platform}) 의 분석 데이터가 없습니다. 전적 분석을 먼저 실행해 주세요.` },
      { status: 404 }
    );
  }

  const availableRows1 = r1.data! as any[];
  const availableRows2 = r2.data! as any[];
  const comparisonMatchCount = Math.min(availableRows1.length, availableRows2.length, MAX_COMPARE_MATCHES);
  const rows1 = availableRows1.slice(0, comparisonMatchCount);
  const rows2 = availableRows2.slice(0, comparisonMatchCount);

  // 항목별 평균 계산: 두 플레이어 중 더 적은 분석 경기 수를 기준으로 동일 개수 비교
  const avg1 = Object.fromEntries(METRICS.map((m) => [m.key, calcAvg(rows1, m.key)]));
  const avg2 = Object.fromEntries(METRICS.map((m) => [m.key, calcAvg(rows2, m.key)]));

  // 항목별 승/패 판정
  const comparisons = METRICS.map((m) => {
    const v1 = avg1[m.key] as number | null;
    const v2 = avg2[m.key] as number | null;
    
    let winner: "nick1" | "nick2" | "draw" = "draw";

    if (v1 === null || v2 === null) {
      winner = "draw";
    } else {
      // 지표별 변별력을 위한 임계값 조정 (무승부 방지)
      let threshold = 0.1; 
      if (m.key === "damage") threshold = 20;
      else if (m.key === "death_phase") threshold = 0.5;
      else if (m.key === "kills") threshold = 0.1;
      else if (m.key === "counter_latency_ms") threshold = 0.15;
      
      const diff = Math.abs(v1 - v2);
      winner = diff < threshold ? "draw" : m.higherIsBetter ? (v1 > v2 ? "nick1" : "nick2") : (v1 < v2 ? "nick1" : "nick2");
    }

    return { ...m, v1: v1 ?? 0, v2: v2 ?? 0, winner };
  });

  const tier1 = estimateAverageTierFromRows(rows1);
  const tier2 = estimateAverageTierFromRows(rows2);

  const score = {
    nick1: comparisons.filter((c) => c.winner === "nick1").length,
    nick2: comparisons.filter((c) => c.winner === "nick2").length,
    draw:  comparisons.filter((c) => c.winner === "draw").length,
  };

  const overallWinner =
    score.nick1 > score.nick2 ? player1.nickname :
    score.nick2 > score.nick1 ? player2.nickname : "draw";

  return NextResponse.json({
    nick1: player1.nickname,
    nick2: player2.nickname,
    platform1: player1.platform,
    platform2: player2.platform,
    tier1, tier2,
    matchCount1: rows1.length,
    matchCount2: rows2.length,
    availableMatchCount1: availableRows1.length,
    availableMatchCount2: availableRows2.length,
    comparisonMatchCount,
    comparisons,
    score,
    overallWinner,
  });
}
