import { buildContentPerformanceReport } from "@/lib/admin-agent/content-performance";

export type ContentDraftType = "weekly_ops" | "patch_digest" | "map_trends" | "community_notice";

export type ContentDraft = {
  draftType: ContentDraftType;
  title: string;
  category: string;
  seoTitle: string;
  summary: string;
  contentHtml: string;
  sourceFacts: Record<string, unknown>;
  suggestedTags: string[];
};

export async function buildContentDraft(
  supabase: any,
  input: { draftType?: string; hours?: number; tone?: string } = {}
): Promise<ContentDraft> {
  const draftType = normalizeDraftType(input.draftType);
  const hours = Number(input.hours || 168);
  const tone = input.tone || "친근하지만 운영자답게 정확한 존댓말";

  const [recentPosts, patchHistory, mapStats, apiErrors, aiUsage, contentPerformance] = await Promise.all([
    fetchRecentPosts(supabase),
    fetchPatchHistory(supabase),
    fetchMapStats(supabase),
    fetchApiErrors(supabase, hours),
    fetchAiUsage(supabase, hours),
    fetchContentPerformance(supabase)
  ]);

  const sourceFacts = {
    hours,
    tone,
    recentPosts,
    patchHistory,
    mapStats,
    apiErrors,
    aiUsage,
    contentPerformance
  };

  if (draftType === "patch_digest") return buildPatchDigest(sourceFacts);
  if (draftType === "map_trends") return buildMapTrends(sourceFacts);
  if (draftType === "community_notice") return buildCommunityNotice(sourceFacts);
  return buildWeeklyOps(sourceFacts);
}

function normalizeDraftType(value?: string): ContentDraftType {
  if (value === "patch_digest" || value === "map_trends" || value === "community_notice") return value;
  return "weekly_ops";
}

async function fetchRecentPosts(supabase: any) {
  const { data, error } = await supabase
    .from("posts")
    .select("id, title, category, views, likes, created_at")
    .order("created_at", { ascending: false })
    .limit(10);
  if (error) return { error: error.message, items: [] };
  return { items: data || [] };
}

async function fetchPatchHistory(supabase: any) {
  const { data, error } = await supabase
    .from("sync_history")
    .select("type, last_url, updated_at")
    .order("updated_at", { ascending: false })
    .limit(5);
  if (error) return { error: error.message, items: [] };
  return { items: data || [] };
}

async function fetchMapStats(supabase: any) {
  const { data, error } = await supabase
    .from("match_stats_raw")
    .select("map_name, kills, damage")
    .eq("is_analysis_sample", true)
    .order("created_at", { ascending: false })
    .limit(1000);
  if (error) return { error: error.message, topMaps: [] };

  const byMap: Record<string, { matches: number; kills: number; damage: number }> = {};
  (data || []).forEach((row: any) => {
    const map = row.map_name || "unknown";
    byMap[map] ||= { matches: 0, kills: 0, damage: 0 };
    byMap[map].matches += 1;
    byMap[map].kills += Number(row.kills || 0);
    byMap[map].damage += Number(row.damage || 0);
  });

  const topMaps = Object.entries(byMap)
    .map(([mapName, stats]) => ({
      mapName,
      matches: stats.matches,
      avgKills: stats.matches ? Number((stats.kills / stats.matches).toFixed(2)) : 0,
      avgDamage: stats.matches ? Number((stats.damage / stats.matches).toFixed(1)) : 0
    }))
    .sort((a, b) => b.matches - a.matches)
    .slice(0, 5);

  return { topMaps };
}

async function fetchApiErrors(supabase: any, hours: number) {
  const since = new Date(Date.now() - hours * 60 * 60 * 1000).toISOString();
  const { data, error } = await supabase
    .from("pubg_api_errors")
    .select("route, status, message, created_at")
    .gte("created_at", since)
    .order("created_at", { ascending: false })
    .limit(100);
  if (error) return { error: error.message, total: 0 };
  return { total: data?.length || 0, latest: data?.slice(0, 5) || [] };
}

async function fetchAiUsage(supabase: any, hours: number) {
  const since = new Date(Date.now() - hours * 60 * 60 * 1000).toISOString();
  const { data, error } = await supabase
    .from("ai_usage_logs")
    .select("cost_usd, model_name, analysis_type")
    .gte("created_at", since)
    .limit(500);
  if (error) return { error: error.message, totalRequests: 0, totalCostUsd: 0 };
  const totalCostUsd = (data || []).reduce((sum: number, row: any) => sum + Number(row.cost_usd || 0), 0);
  return { totalRequests: data?.length || 0, totalCostUsd: Number(totalCostUsd.toFixed(6)) };
}

async function fetchContentPerformance(supabase: any) {
  try {
    return await buildContentPerformanceReport(supabase, { days: 30, limit: 30 });
  } catch (error: any) {
    return { error: error.message || String(error), totalPosts: 0, recommendations: [] };
  }
}

function buildWeeklyOps(sourceFacts: Record<string, any>): ContentDraft {
  const topMap = sourceFacts.mapStats?.topMaps?.[0];
  const title = "[운영 리포트] 이번 주 BGMS 이용 흐름과 서비스 상태";
  const summary = `최근 ${sourceFacts.hours}시간 기준 서비스 상태와 유저 플레이 흐름을 정리한 운영 리포트 초안입니다.`;
  return makeDraft("weekly_ops", title, summary, sourceFacts, [
    paragraph("안녕하세요, BGMS 운영팀입니다. 이번 주 서비스 운영 상태와 플레이 데이터 흐름을 간단히 공유드립니다."),
    section("서비스 상태", [
      `PUBG API 에러는 ${sourceFacts.apiErrors?.total || 0}건으로 집계되었습니다.`,
      `AI 분석 요청은 ${sourceFacts.aiUsage?.totalRequests || 0}건, 비용은 약 $${sourceFacts.aiUsage?.totalCostUsd || 0}입니다.`
    ]),
    section("맵 이용 흐름", [
      topMap ? `최근 분석 데이터에서 가장 많이 등장한 맵은 ${topMap.mapName}입니다.` : "아직 충분한 맵 통계가 쌓이지 않았습니다.",
      topMap ? `${topMap.mapName}의 평균 킬은 ${topMap.avgKills}, 평균 피해량은 ${topMap.avgDamage}로 나타났습니다.` : "더 많은 매치 분석이 쌓이면 맵별 흐름을 더 자세히 공개하겠습니다."
    ]),
    ...contentPerformanceBlocks(sourceFacts),
    paragraph("앞으로도 분석 품질과 서비스 안정성을 함께 챙기겠습니다.")
  ], ["운영리포트", "BGMS", "PUBG통계"]);
}

function buildPatchDigest(sourceFacts: Record<string, any>): ContentDraft {
  const latestPatch = sourceFacts.patchHistory?.items?.[0];
  const title = "[패치 요약] 최근 PUBG 패치와 BGMS 체크 포인트";
  const summary = "최근 패치 동기화 상태와 유저가 확인하면 좋은 체크 포인트를 정리한 초안입니다.";
  return makeDraft("patch_digest", title, summary, sourceFacts, [
    paragraph("최근 PUBG 패치 흐름을 BGMS 관점에서 정리했습니다."),
    section("최근 동기화", [
      latestPatch?.last_url ? `최근 패치노트 동기화 URL: ${latestPatch.last_url}` : "최근 패치노트 동기화 기록이 아직 없습니다.",
      latestPatch?.updated_at ? `마지막 동기화 시각: ${formatDate(latestPatch.updated_at)}` : "패치노트 동기화 작업을 먼저 확인해 주세요."
    ]),
    section("플레이어 체크 포인트", [
      "패치 이후 주력 맵, 총기 밸런스, 아이템 스폰 변화를 우선 확인해 주세요.",
      "BGMS 지도와 전술 분석에서 달라진 플레이 흐름을 계속 반영하겠습니다."
    ]),
    ...contentPerformanceBlocks(sourceFacts)
  ], ["패치노트", "PUBG패치", "BGMS"]);
}

function buildMapTrends(sourceFacts: Record<string, any>): ContentDraft {
  const maps = sourceFacts.mapStats?.topMaps || [];
  const title = "[맵 트렌드] 최근 BGMS 분석 데이터에서 많이 보인 전장";
  const summary = "최근 분석 데이터 기준 인기 맵과 평균 전투 지표를 정리한 초안입니다.";
  return makeDraft("map_trends", title, summary, sourceFacts, [
    paragraph("최근 BGMS 분석 데이터에서 자주 등장한 전장을 정리했습니다."),
    maps.length
      ? `<ol>${maps.map((map: any) => `<li><strong>${escapeHtml(map.mapName)}</strong> - 분석 ${map.matches}건, 평균 킬 ${map.avgKills}, 평균 피해량 ${map.avgDamage}</li>`).join("")}</ol>`
      : paragraph("아직 충분한 매치 통계가 쌓이지 않았습니다."),
    ...contentPerformanceBlocks(sourceFacts),
    paragraph("지도별 주요 지점과 이동 루트 분석은 계속 보강하겠습니다.")
  ], ["맵트렌드", "PUBG지도", "전술분석"]);
}

function buildCommunityNotice(sourceFacts: Record<string, any>): ContentDraft {
  const title = "[공지] BGMS 최근 운영 상태 안내";
  const summary = "서비스 안정성과 예정된 운영 방향을 유저에게 공유하는 공지 초안입니다.";
  return makeDraft("community_notice", title, summary, sourceFacts, [
    paragraph("안녕하세요, BGMS 운영팀입니다. 최근 서비스 운영 상태를 안내드립니다."),
    section("운영 상태", [
      `최근 기준 PUBG API 에러는 ${sourceFacts.apiErrors?.total || 0}건입니다.`,
      `AI 분석 요청은 ${sourceFacts.aiUsage?.totalRequests || 0}건 처리되었습니다.`
    ]),
    section("안내", [
      "서비스 안정성을 위해 캐시와 분석 데이터를 꾸준히 점검하고 있습니다.",
      "불편 사항이나 개선 의견은 게시판과 제보 기능을 통해 남겨 주세요."
    ]),
    ...contentPerformanceBlocks(sourceFacts)
  ], ["공지", "운영상태", "BGMS"]);
}

function contentPerformanceBlocks(sourceFacts: Record<string, any>) {
  const performance = sourceFacts.contentPerformance;
  if (!performance || performance.error || !performance.totalPosts) return [];

  const topPost = performance.topByViews?.[0];
  const recommendations = performance.recommendations || [];
  const weeklyPlan = performance.weeklyPlan || [];
  const momentum = performance.momentum;
  return [
    section("콘텐츠 반응", [
      `최근 30일 게시글 ${performance.totalPosts}건의 총 조회수는 ${performance.totalViews || 0}회, 평균 참여율은 ${performance.averageEngagementRate || 0}%입니다.`,
      momentum ? `콘텐츠 모멘텀은 ${momentum.label}(${momentum.score})로 판단됩니다.` : "콘텐츠 모멘텀 데이터는 아직 부족합니다.",
      topPost ? `가장 조회수가 높았던 글은 "${topPost.title}"입니다.` : "아직 비교할 상위 게시글이 충분하지 않습니다.",
      weeklyPlan[0] ? `이번 주 1순위 발행 후보는 "${weeklyPlan[0].title}"입니다.` : recommendations[0] || "다음 콘텐츠는 최근 반응이 좋았던 주제와 형식을 참고해 준비하겠습니다."
    ])
  ];
}

function makeDraft(
  draftType: ContentDraftType,
  title: string,
  summary: string,
  sourceFacts: Record<string, unknown>,
  bodyBlocks: string[],
  tags: string[]
): ContentDraft {
  const contentHtml = [
    `<p>${escapeHtml(summary)}</p>`,
    ...bodyBlocks,
    `<p class="text-xs text-gray-400">이 글은 BGMS Admin Agent가 운영 데이터를 바탕으로 생성한 초안입니다. 발행 전 운영자 검토가 필요합니다.</p>`
  ].join("");

  return {
    draftType,
    title,
    category: "자유",
    seoTitle: `${title} | BGMS.KR`,
    summary,
    contentHtml,
    sourceFacts,
    suggestedTags: tags
  };
}

function paragraph(text: string) {
  return `<p>${escapeHtml(text)}</p>`;
}

function section(title: string, items: string[]) {
  return `<h3>${escapeHtml(title)}</h3><ul>${items.map((item) => `<li>${escapeHtml(item)}</li>`).join("")}</ul>`;
}

function escapeHtml(value: string) {
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}

function formatDate(value: string) {
  return new Date(value).toLocaleString("ko-KR", {
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit"
  });
}
