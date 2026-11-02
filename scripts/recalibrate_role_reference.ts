/**
 * 칭호 기준 분포(lib/pubg-analysis/roleReference.ts) 재산출 스크립트.
 *
 * - 운영 DB는 읽기만 한다(select). 쓰기·삭제·migration·Gemini 호출은 없다.
 * - 판정 경로는 전적 요약 라우트와 같다: 계산 5 듀오·스쿼드 경기 중 최근 10경기를 selectRecentMatches로 고르고,
 *   selectBestMatches(5)로 점수 상위 5경기를 뽑은 뒤 aggregateMatches로 집계한다.
 *   라우트의 HTTP 요청 단위 후보(요청 matchIds) 대신 DB의 계산 5 행을 후보로 쓰므로 표본 정의는 근사다.
 * - 대용량 스캔은 created_at 12시간 창으로 나눠 읽는다(14일 한 번 스캔은 statement timeout 위험).
 * - 기본은 dry-run이다. 파일은 --cache, --json, --ts 로 명시한 경로에만 쓰고 저장소 파일은 건드리지 않는다.
 *   기준 표를 반영하는 일은 --ts 결과를 보고 사람이 roleReference.ts 생성 구간에 붙여 넣는다.
 *
 * 사용 예:
 *   npx tsx scripts/recalibrate_role_reference.ts --env-file <메인 checkout>/.env.local --cache <경로>/population.json
 *   npx tsx scripts/recalibrate_role_reference.ts --reuse-cache --cache <경로>/population.json --json <경로>/out.json --ts <경로>/tables.ts
 */
import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { aggregateMatches } from "../lib/pubg-analysis/matchAggregate";
import {
  RECENT_MATCH_SELECTION_VERSION,
  normalizeBenchmarkScore,
  normalizeMatchId,
  selectBestMatches,
  selectRecentMatches,
  type RecentMatchCandidate,
} from "../lib/pubg-analysis/recentMatchSelection";
import { getValidFullResultForMatch, hasSupportedCalculation, isFullResultForPlayerPlatform } from "../lib/pubg-analysis/cacheIdentity";
import { isAiSummaryEligibleMatch } from "../lib/pubg-analysis/matchEligibility";
import { POPULATION_EVIDENCE_VERSION, RESULT_VERSION } from "../lib/pubg-analysis/constants";
import { dominantTierScope, tierScopeOfMode } from "../lib/pubg-analysis/tierAveraging";
import {
  ROLE_REFERENCE_PERCENTILES,
  ROLE_REFERENCE_QUANTILES,
  ROLE_REFERENCE_VERSION,
  ROLE_SCORE_QUANTILES,
  type RoleMetricKey,
  type RoleScoreKey,
} from "../lib/pubg-analysis/roleReference";
import {
  buildMetricTables,
  buildScoreTables,
  calibrationWeights,
  evaluateRoleReference,
  searchedMedianPercentiles,
  type CalibrationPlayer,
  type CalibrationSource,
} from "../lib/pubg-analysis/roleReferenceCalibration";

const WINDOW_DAYS = 14;
const WINDOW_HOURS = 12;
const PAGE_SIZE = 500;
const TOP_N_MATCHES = 10;
const MIN_RECORDS_PER_PLAYER = 3;
const FETCH_CONCURRENCY = 8;

interface Options {
  envFile: string;
  cache: string | null;
  fromSample: string | null;
  reuseCache: boolean;
  json: string | null;
  ts: string | null;
  days: number;
  windowHours: number;
}

function parseArgs(argv: string[]): Options {
  const value = (flag: string) => {
    const index = argv.indexOf(flag);
    return index >= 0 ? argv[index + 1] ?? null : null;
  };
  const days = Number(value("--days") ?? WINDOW_DAYS);
  const windowHours = Number(value("--window-hours") ?? WINDOW_HOURS);
  if (!Number.isFinite(days) || days <= 0 || !Number.isFinite(windowHours) || windowHours <= 0) {
    throw new Error("--days 와 --window-hours 는 양수여야 합니다.");
  }
  return {
    envFile: value("--env-file") ?? `${process.cwd()}/.env.local`,
    cache: value("--cache"),
    fromSample: value("--from-sample"),
    reuseCache: argv.includes("--reuse-cache"),
    json: value("--json"),
    ts: value("--ts"),
    days,
    windowHours,
  };
}

/** 두 키만 읽는다. 다른 환경 값은 출력하거나 로그에 남기지 않는다. */
function readServiceEnv(envFile: string): { url: string; key: string } {
  if (!existsSync(envFile)) throw new Error(`env 파일이 없습니다: ${envFile}`);
  const text = readFileSync(envFile, "utf8");
  const read = (name: string) => {
    const match = text.match(new RegExp(`^${name}=["']?(.*?)["']?$`, "m"));
    return match ? match[1] : "";
  };
  const url = read("NEXT_PUBLIC_SUPABASE_URL");
  const key = read("SUPABASE_SERVICE_ROLE_KEY");
  if (!url || !key) throw new Error("env 파일에 NEXT_PUBLIC_SUPABASE_URL 또는 SUPABASE_SERVICE_ROLE_KEY가 없습니다.");
  return { url, key };
}

async function fetchAll<T>(
  build: (from: number, to: number) => PromiseLike<{ data: T[] | null; error: unknown }>,
  pageSize = 1000,
): Promise<T[]> {
  const rows: T[] = [];
  for (let from = 0; ; from += pageSize) {
    const { data, error } = await build(from, from + pageSize - 1);
    if (error) throw error;
    rows.push(...(data ?? []));
    if ((data ?? []).length < pageSize) break;
  }
  return rows;
}

// 라우트의 normalizedMatchMode와 같은 규칙이다.
function normalizedMatchMode(match: any): string {
  const rawMode = match?.gameMode ?? match?.game_mode ?? match?.mode ?? match?.matchInfo?.mode;
  return String(rawMode ?? "").trim().toLowerCase();
}

// 라우트의 groups 분류와 같은 규칙으로 주 모드를 고른다.
function groupOf(match: any): string {
  const gm = normalizedMatchMode(match) || "squad";
  if (gm === "solo-squad") return "solo-squad";
  if (gm === "solo-duo") return "solo-duo";
  if (gm.includes("solo")) return "solo";
  if (gm.includes("duo")) return "duo";
  return "squad";
}

const GROUP_ORDER = ["solo", "duo", "squad", "solo-duo", "solo-squad"];

function mainModeOf(matches: any[]): string {
  const counts = new Map<string, number>(GROUP_ORDER.map((key) => [key, 0]));
  for (const match of matches) counts.set(groupOf(match), (counts.get(groupOf(match)) ?? 0) + 1);
  return [...counts.entries()].sort((a, b) => b[1] - a[1])[0][0];
}

// 라우트의 hasCompatiblePopulationEvidence와 같은 조건이다.
const hasPopulationEvidence = (fullResult: Record<string, unknown>) =>
  Number(fullResult.populationEvidenceVersion) === POPULATION_EVIDENCE_VERSION;

interface IndexRow {
  player_id: string;
  platform: string;
  match_id: string;
  at: string | null;
  created_at: string;
  mode: string | null;
  calc: string | null;
}

async function collectIndex(sb: SupabaseClient, days: number, windowHours: number): Promise<IndexRow[]> {
  const rows: IndexRow[] = [];
  const end = Date.now();
  const start = end - days * 86_400_000;
  for (let from = start; from < end; from += windowHours * 3_600_000) {
    const to = Math.min(end, from + windowHours * 3_600_000);
    const windowRows = await fetchAll<IndexRow>((rangeFrom, rangeTo) => sb.from("processed_match_telemetry")
      .select("player_id, platform, match_id, created_at, at:data->fullResult->>createdAt, mode:data->fullResult->>gameMode, calc:data->fullResult->>calculationVersion")
      .gte("created_at", new Date(from).toISOString())
      .lt("created_at", new Date(to).toISOString())
      .order("created_at", { ascending: true })
      .range(rangeFrom, rangeTo) as unknown as PromiseLike<{ data: IndexRow[] | null; error: unknown }>, PAGE_SIZE);
    rows.push(...windowRows.filter((row) => row.calc === "5" && /duo|squad/.test(String(row.mode ?? "").toLowerCase())));
  }
  return rows;
}

interface PopulationPlayer {
  key: string;
  playerId: string;
  platform: string;
  source: CalibrationSource;
  candidateCount: number;
  selectedCount: number;
  bestCount: number;
  mainMode: string;
  score: number | null;
  stats: any;
  // 선택된 최근 경기(최대 10)의 경기별 필드. 생존·순위·팀 피해 점검과 후속 지표에 쓴다.
  selectedMeta: PerMatchRecord[];
}

export interface PerMatchRecord {
  matchId: string | null;
  mode: string;
  calc: string | null;
  // 점수 상위 5경기 안에 들었는지
  inBest: boolean;
  winPlace: number | null;
  totalTeams: number | null;
  enemyTeamWipes: number | null;
  teamDamageShare: number | null;
  timeSurvived: number | null;
  deathPhase: number | null;
  damageDealt: number | null;
  goldenTime: { early: number; mid1: number; mid2: number; late: number } | null;
  distance: { short: number; mid: number; long: number } | null;
}

function candidateFromRow(row: { match_id: string; player_id: string; platform: string; data: any }, index: number) {
  const fullResult = getValidFullResultForMatch(row, {
    matchId: row.match_id,
    playerId: row.player_id,
    platform: row.platform,
    minResultVersion: 0,
  }) as Record<string, any> | null;
  if (!fullResult) return null;
  if (!(fullResult.v === RESULT_VERSION && hasSupportedCalculation(fullResult))) return null;
  if (!hasPopulationEvidence(fullResult)) return null;
  if (!isFullResultForPlayerPlatform(fullResult, row.player_id, row.platform)) return null;
  const canonicalId = normalizeMatchId(fullResult.matchId ?? row.match_id);
  if (!canonicalId) return null;
  const value = { ...fullResult, matchId: canonicalId };
  const candidate: RecentMatchCandidate<any> = {
    id: canonicalId,
    createdAt: fullResult.createdAt ? String(fullResult.createdAt) : null,
    matchType: fullResult.matchType ? String(fullResult.matchType) : null,
    gameMode: fullResult.gameMode ? String(fullResult.gameMode) : null,
    mapName: fullResult.mapName ? String(fullResult.mapName) : null,
    sourceIndex: index,
    value,
  };
  return candidate;
}

async function collectPopulation(sb: SupabaseClient, days: number, windowHours: number): Promise<PopulationPlayer[]> {
  const index = await collectIndex(sb, days, windowHours);
  const byPlayer = new Map<string, IndexRow[]>();
  for (const row of index) {
    const key = `${String(row.player_id).toLowerCase()}|${row.platform}`;
    if (!byPlayer.has(key)) byPlayer.set(key, []);
    byPlayer.get(key)!.push(row);
  }
  const eligible = [...byPlayer.entries()]
    .filter(([, rows]) => rows.length >= MIN_RECORDS_PER_PLAYER)
    .map(([key, rows]) => [key, rows
      .sort((a, b) => String(b.at ?? b.created_at).localeCompare(String(a.at ?? a.created_at)))
      .slice(0, TOP_N_MATCHES)] as const);
  console.info(`계산 5 듀오·스쿼드 행 ${index.length}개, ${byPlayer.size}명 중 ${eligible.length}명(3경기 이상) 판정 대상`);

  const cohort = await fetchAll<{ nickname: string; platform: string; last_rank: unknown }>((from, to) =>
    sb.from("pubg_benchmark_cohort").select("nickname, platform, last_rank").range(from, to));
  const sourceOfCohort = new Map<string, CalibrationSource>();
  for (const row of cohort) {
    const key = `${String(row.nickname).toLowerCase()}|${String(row.platform).toLowerCase()}`;
    // 리더보드 명단(last_rank 있음)은 엘리트, 나머지 명단은 무작위 표본
    sourceOfCohort.set(key, row.last_rank !== null && row.last_rank !== undefined ? "elite" : "sampled");
  }
  const searched = await fetchAll<{ lower_nickname: string; platform: string }>((from, to) =>
    sb.from("pubg_player_cache").select("lower_nickname, platform").gt("search_count", 0).range(from, to));
  const searchedKeys = new Set(searched.map((row) => `${String(row.lower_nickname).toLowerCase()}|${String(row.platform).toLowerCase()}`));

  const players: PopulationPlayer[] = [];
  for (let offset = 0; offset < eligible.length; offset += FETCH_CONCURRENCY) {
    const batch = eligible.slice(offset, offset + FETCH_CONCURRENCY);
    const results = await Promise.all(batch.map(async ([key, rows]) => {
      const [playerId, platform] = key.split("|");
      const data = await fetchAll<{ match_id: string; player_id: string; platform: string; data: any }>((from, to) =>
        sb.from("processed_match_telemetry")
          .select("match_id, player_id, platform, data")
          .eq("platform", platform)
          .eq("player_id", playerId)
          .in("match_id", rows.map((row) => row.match_id))
          .range(from, to));
      return buildPlayerRecord({ key, playerId, platform, source: sourceOfCohort.get(key) ?? (searchedKeys.has(key) ? "searched" : "other"), rows: data });
    }));
    for (const result of results) if (result) players.push(result);
    if ((offset / FETCH_CONCURRENCY) % 10 === 0) console.info(`진행 ${Math.min(offset + FETCH_CONCURRENCY, eligible.length)}/${eligible.length}`);
  }
  return players;
}

const numberOrNull = (value: unknown): number | null => {
  const parsed = typeof value === "number" ? value : typeof value === "string" && value.trim() !== "" ? Number(value) : Number.NaN;
  return Number.isFinite(parsed) ? parsed : null;
};

/** 한 플레이어의 DB 행(processed_match_telemetry)에서 판정 기록을 만든다. collect와 from-sample이 같이 쓴다. */
function buildPlayerRecord(input: {
  key: string;
  playerId: string;
  platform: string;
  source: CalibrationSource;
  rows: Array<{ match_id: string; player_id: string; platform: string; data: any }>;
}): PopulationPlayer | null {
  const { key, playerId, platform, source, rows } = input;
  const candidates = rows
    .map((row, rowIndex) => candidateFromRow(row, rowIndex))
    .filter((candidate): candidate is RecentMatchCandidate<any> => Boolean(candidate))
    .filter((candidate) => isAiSummaryEligibleMatch(candidate.value));
  const selection = selectRecentMatches(candidates, { limit: TOP_N_MATCHES, selectionVersion: RECENT_MATCH_SELECTION_VERSION });
  const best = selectBestMatches(selection.selected);
  const bestIds = new Set(best.map((candidate) => String(candidate.id)));
  const bestValues = best.map(({ value }) => value);
  if (bestValues.length === 0) return null;
  const mainMode = mainModeOf(bestValues);
  // 라우트의 티어 평균: 최고 점수 5경기 중 다수 점수 범위(solo/team)만 평균한다.
  const scope = dominantTierScope(bestValues.map((match) => tierScopeOfMode(normalizedMatchMode(match))));
  const scoped = bestValues.filter((match) => tierScopeOfMode(normalizedMatchMode(match)) === scope);
  const score = scoped.length > 0
    ? scoped.reduce((sum, match) => sum + normalizeBenchmarkScore(match?.benchmark?.score), 0) / scoped.length
    : null;
  return {
    key,
    playerId,
    platform,
    source,
    candidateCount: candidates.length,
    selectedCount: selection.selected.length,
    bestCount: bestValues.length,
    mainMode,
    score,
    stats: aggregateMatches(bestValues),
    selectedMeta: selection.selected.map(({ id, value }) => ({
      matchId: value?.matchId ?? null,
      mode: normalizedMatchMode(value),
      calc: value?.calculationVersion === undefined ? null : String(value.calculationVersion),
      inBest: bestIds.has(String(id)),
      winPlace: numberOrNull(value?.stats?.winPlace),
      totalTeams: numberOrNull(value?.totalTeams),
      enemyTeamWipes: numberOrNull(value?.tradeStats?.enemyTeamWipes),
      teamDamageShare: numberOrNull(value?.teamImpact?.teamDamageShare),
      timeSurvived: numberOrNull(value?.stats?.timeSurvived),
      deathPhase: numberOrNull(value?.deathPhase),
      damageDealt: numberOrNull(value?.stats?.processedDamageDealt ?? value?.stats?.damageDealt),
      goldenTime: value?.goldenTimeDamage
        ? { early: numberOrNull(value.goldenTimeDamage.early) ?? 0, mid1: numberOrNull(value.goldenTimeDamage.mid1) ?? 0, mid2: numberOrNull(value.goldenTimeDamage.mid2) ?? 0, late: numberOrNull(value.goldenTimeDamage.late) ?? 0 }
        : null,
      distance: value?.itemUseStats?.distanceDamage
        ? { short: numberOrNull(value.itemUseStats.distanceDamage.short) ?? 0, mid: numberOrNull(value.itemUseStats.distanceDamage.mid) ?? 0, long: numberOrNull(value.itemUseStats.distanceDamage.long) ?? 0 }
        : null,
    })),
  };
}

/** 저장된 표본의 경기 ID로 같은 행을 다시 읽어 기록을 만든다(기간 창 이동 없이 같은 표본을 재현한다). */
async function refreshPopulation(sb: SupabaseClient, sample: PopulationPlayer[]): Promise<PopulationPlayer[]> {
  const players: PopulationPlayer[] = [];
  for (let offset = 0; offset < sample.length; offset += FETCH_CONCURRENCY) {
    const batch = sample.slice(offset, offset + FETCH_CONCURRENCY);
    const results = await Promise.all(batch.map(async (previous) => {
      const ids = previous.selectedMeta.map((match) => match.matchId).filter((id): id is string => Boolean(id));
      const data = await fetchAll<{ match_id: string; player_id: string; platform: string; data: any }>((from, to) =>
        sb.from("processed_match_telemetry")
          .select("match_id, player_id, platform, data")
          .eq("platform", previous.platform)
          .eq("player_id", previous.playerId)
          .in("match_id", ids)
          .range(from, to));
      return buildPlayerRecord({ key: previous.key, playerId: previous.playerId, platform: previous.platform, source: previous.source, rows: data });
    }));
    for (const result of results) if (result) players.push(result);
    console.info(`재조회 ${Math.min(offset + FETCH_CONCURRENCY, sample.length)}/${sample.length}`);
  }
  return players;
}

function toCalibrationPlayers(population: PopulationPlayer[]): CalibrationPlayer[] {
  return population.map((player) => ({
    key: player.key,
    source: player.source,
    mainMode: player.mainMode,
    score: player.score,
    stats: player.stats,
  }));
}

function summarizeSources(population: PopulationPlayer[]) {
  const counts: Record<string, number> = {};
  for (const player of population) counts[player.source] = (counts[player.source] ?? 0) + 1;
  return counts;
}

function renderTs(metrics: Record<RoleMetricKey, readonly number[]>, scores: Record<RoleScoreKey, readonly number[]>, header: string[]): string {
  const row = (name: string, values: readonly number[]) => `  ${name}: [${values.join(", ")}],`;
  const metricKeys = Object.keys(metrics) as RoleMetricKey[];
  const scoreKeys = Object.keys(scores) as RoleScoreKey[];
  return [
    ...header.map((line) => `// ${line}`),
    `// levels: [${ROLE_REFERENCE_PERCENTILES.join(", ")}]`,
    `export const ROLE_REFERENCE_QUANTILES: Record<RoleMetricKey, readonly number[]> = {`,
    ...metricKeys.map((key) => row(key, metrics[key])),
    "};",
    "export const ROLE_SCORE_QUANTILES: Record<RoleScoreKey, readonly number[]> = {",
    ...scoreKeys.map((key) => row(key, scores[key])),
    "};",
  ].join("\n") + "\n";
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  let population: PopulationPlayer[];
  let collectedAt: string;
  if (options.reuseCache && options.cache && existsSync(options.cache)) {
    const cached = JSON.parse(readFileSync(options.cache, "utf8"));
    population = cached.players;
    collectedAt = cached.collectedAt;
    console.info(`캐시 사용: ${options.cache} (${population.length}명, 수집 ${collectedAt})`);
  } else {
    const env = readServiceEnv(options.envFile);
    const sb = createClient(env.url, env.key, { auth: { persistSession: false, autoRefreshToken: false } });
    collectedAt = new Date().toISOString();
    if (options.fromSample) {
      // 저장된 표본과 같은 플레이어·경기 ID만 다시 읽는다. 기간 창을 새로 잡지 않는다.
      const sample = JSON.parse(readFileSync(options.fromSample, "utf8")).players as PopulationPlayer[];
      population = await refreshPopulation(sb, sample);
      console.info(`표본 재조회: ${options.fromSample} -> ${population.length}명`);
    } else {
      population = await collectPopulation(sb, options.days, options.windowHours);
    }
    if (options.cache) {
      mkdirSync(dirname(options.cache), { recursive: true });
      writeFileSync(options.cache, JSON.stringify({ collectedAt, windowDays: options.days, players: population }));
      console.info(`표본 캐시 저장: ${options.cache}`);
    }
  }

  const players = toCalibrationPlayers(population);
  const weights = calibrationWeights(players);
  const weightList = weights?.weights ?? null;
  const levels = ROLE_REFERENCE_PERCENTILES;
  // 보류 지표(reactionSec)만 이전 표를 쓴다. 나머지는 표본에서 새로 계산하며, 표본이 부족하면 실패한다.
  const metricFallback: Partial<Record<RoleMetricKey, readonly number[]>> = { reactionSec: ROLE_REFERENCE_QUANTILES.reactionSec };
  // 선봉 복합은 반격 시간 보류로 표본이 없어 이전 표를 쓴다.
  const scoreFallback: Partial<Record<RoleScoreKey, readonly number[]>> = { pointMan: ROLE_SCORE_QUANTILES.pointMan };

  // 1차: 지표 분위수(B' 가중·무가중). 2차: 그 지표 표로 역할 점수 분위수.
  const metricsWeighted = buildMetricTables(players, weightList, metricFallback, levels);
  const metricsUnweighted = buildMetricTables(players, null, metricFallback, levels);
  const scoresWeighted = buildScoreTables(players, weightList, { levels, metrics: metricsWeighted.quantiles, scores: ROLE_SCORE_QUANTILES }, scoreFallback);
  const scoresUnweighted = buildScoreTables(players, null, { levels, metrics: metricsUnweighted.quantiles, scores: ROLE_SCORE_QUANTILES }, scoreFallback);
  const finalWeighted = { levels, metrics: metricsWeighted.quantiles, scores: scoresWeighted.quantiles };

  const pending: RoleMetricKey[] = ["reactionSec"];
  const evaluations = [
    evaluateRoleReference(players, { population: "검색 사용자", tables: finalWeighted, weights: null, pendingReferenceMetrics: pending, filter: (p) => p.source === "searched" }),
    evaluateRoleReference(players, { population: "B' 가중 전체", tables: finalWeighted, weights: weightList, pendingReferenceMetrics: pending }),
    evaluateRoleReference(players, { population: "무가중 전체", tables: finalWeighted, weights: null, pendingReferenceMetrics: pending }),
  ];
  const report = {
    generatedBy: "scripts/recalibrate_role_reference.ts",
    referenceVersion: ROLE_REFERENCE_VERSION,
    collectedAt,
    windowDays: options.days,
    population: { total: players.length, sources: summarizeSources(population), mainModes: countBy(population, (p) => p.mainMode) },
    weights: weights ? { targetShare: weights.targetShare, sampleShare: weights.sampleShare, effectiveSampleSize: weights.effectiveSampleSize, searchedCount: weights.searchedCount } : null,
    coverage: { metricsWeighted: metricsWeighted.coverage, scoresWeighted: scoresWeighted.coverage },
    evaluations,
    searchedMedianPercentiles: searchedMedianPercentiles(players, finalWeighted),
    tables: { weighted: finalWeighted, unweightedMetrics: metricsUnweighted.quantiles, unweightedScores: scoresUnweighted.quantiles },
  };
  console.info(JSON.stringify({ population: report.population, weights: report.weights, evaluations }, null, 2));
  if (options.json) {
    mkdirSync(dirname(options.json), { recursive: true });
    writeFileSync(options.json, JSON.stringify(report, null, 2));
    console.info(`분석 결과 저장: ${options.json}`);
  }
  if (options.ts) {
    mkdirSync(dirname(options.ts), { recursive: true });
    writeFileSync(options.ts, renderTs(finalWeighted.metrics, finalWeighted.scores, [
      `산출 ${new Intl.DateTimeFormat("sv-SE", { timeZone: "Asia/Seoul" }).format(new Date())}(한국 시각), 표본 ${players.length}명, 계산 5 듀오·스쿼드, B' 가중 분위수`,
    ]));
    console.info(`기준 표(TS) 저장: ${options.ts}`);
  }
  if (!options.json && !options.ts) console.info("dry-run: 파일을 쓰지 않았습니다. --json, --ts 경로를 주면 저장합니다.");
}

function countBy<T>(rows: readonly T[], key: (row: T) => string): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const row of rows) counts[key(row)] = (counts[key(row)] ?? 0) + 1;
  return counts;
}

main().catch((error) => {
  console.error("재산출 실패:", error instanceof Error ? error.message : error);
  process.exit(1);
});
