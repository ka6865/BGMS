import { normalizePlatform } from "@/lib/pubg-analysis/cacheIdentity";
import { normalizeName } from "@/lib/pubg-analysis/utils";

const DEFAULT_PAGE_SIZE = 100;
// fullResult 경로 조회는 행마다 data를 풀어야 하므로 한 번에 읽는 행 수를 제한한다.
const MAX_PAGE_SIZE = 200;
const DEFAULT_SAMPLE_LIMIT = 10;
const DEFAULT_TARGET_LIMIT = 50;
const IDENTITY_KEY_COLUMNS = "match_id, platform, player_id, created_at, updated_at";
const LEGACY_IDENTITY_KEY_COLUMNS = "match_id, player_id, created_at, updated_at";
const IDENTITY_PATH_COLUMNS = [
  "statsName:data->fullResult->stats->>name",
  "embeddedPlayerId:data->fullResult->>player_id",
  "resultPlatform:data->fullResult->>platform"
].join(", ");

export type ProcessedTelemetryIdentityMismatch = {
  match_id: string;
  platform: string;
  player_id: string;
  statsName: string;
  embeddedPlayerId: string;
  resultPlatform: string;
  hasPlatformColumn: boolean;
  canDelete: boolean;
  reason: string;
  created_at?: string | null;
  updated_at?: string | null;
};

export type ProcessedTelemetryIdentityAudit = {
  mode: "dry-run";
  table: "processed_match_telemetry";
  recentDays: number | null;
  maxRows: number | null;
  scannedRows: number;
  mismatchCount: number;
  missingPlatformColumnRows: number;
  deletionCandidateCount: number;
  samples: ProcessedTelemetryIdentityMismatch[];
  deletionTargets: ProcessedTelemetryIdentityMismatch[];
  truncated: boolean;
  generatedAt: string;
  error?: string;
};

export type ProcessedTelemetryIdentityTarget = {
  match_id: string;
  platform: string;
  player_id: string;
  reason?: string;
};

export type ProcessedTelemetryIdentityDeleteResult = {
  requested: number;
  deleted: number;
  skipped: number;
  failed: number;
  details: Array<{
    target: ProcessedTelemetryIdentityTarget;
    status: "deleted" | "skipped" | "failed";
    message: string;
  }>;
};

type AuditOptions = {
  recentDays?: number | null;
  maxRows?: number | null;
  pageSize?: number;
  sampleLimit?: number;
  targetLimit?: number;
};

export function findProcessedTelemetryIdentityMismatch(row: any): ProcessedTelemetryIdentityMismatch | null {
  const fullResult = row.data?.fullResult;
  const rowPlayerId = normalizeName(row.player_id || "");
  const hasPlatformColumn = Object.prototype.hasOwnProperty.call(row, "platform");
  const rowPlatform = normalizePlatform(row.platform);
  const statsName = normalizeName(fullResult?.stats?.name || "");
  const embeddedPlayerId = normalizeName(fullResult?.player_id || "");
  const resultPlatform = normalizePlatform(fullResult?.platform);
  const base = {
    match_id: String(row.match_id || ""),
    platform: rowPlatform,
    player_id: rowPlayerId,
    statsName,
    embeddedPlayerId,
    resultPlatform,
    hasPlatformColumn,
    canDelete: hasPlatformColumn && Boolean(row.match_id && rowPlayerId),
    created_at: row.created_at || null,
    updated_at: row.updated_at || null
  };

  if (!fullResult) {
    return { ...base, reason: "fullResult 없음" };
  }

  if (!statsName || statsName !== rowPlayerId) {
    return { ...base, reason: "row.player_id와 fullResult.stats.name 불일치" };
  }

  if (embeddedPlayerId && embeddedPlayerId !== rowPlayerId) {
    return { ...base, reason: "row.player_id와 fullResult.player_id 불일치" };
  }

  if (resultPlatform !== rowPlatform) {
    return { ...base, reason: "row.platform과 fullResult.platform 불일치" };
  }

  return null;
}

export async function auditProcessedTelemetryIdentity(
  supabase: any,
  options: AuditOptions = {}
): Promise<ProcessedTelemetryIdentityAudit> {
  const pageSize = Math.min(clampPositiveInteger(options.pageSize, DEFAULT_PAGE_SIZE), MAX_PAGE_SIZE);
  const sampleLimit = clampPositiveInteger(options.sampleLimit, DEFAULT_SAMPLE_LIMIT);
  const targetLimit = clampPositiveInteger(options.targetLimit, DEFAULT_TARGET_LIMIT);
  const maxRows = options.maxRows === null || options.maxRows === undefined
    ? null
    : Math.max(1, Number(options.maxRows) || DEFAULT_PAGE_SIZE);
  const recentDays = options.recentDays === null || options.recentDays === undefined
    ? null
    : Math.max(1, Number(options.recentDays) || 1);
  const cutoffIso = recentDays
    ? new Date(Date.now() - recentDays * 24 * 60 * 60 * 1000).toISOString()
    : null;

  const samples: ProcessedTelemetryIdentityMismatch[] = [];
  const deletionTargets: ProcessedTelemetryIdentityMismatch[] = [];
  let scannedRows = 0;
  let mismatchCount = 0;
  let missingPlatformColumnRows = 0;
  let deletionCandidateCount = 0;
  let truncated = false;
  const state: IdentityQueryState = { hasPlatformColumn: true };
  // 최근 생성 행을 먼저 보고, 기간 제한이 있으면 그 전에 생성됐지만 최근 재분석으로 갱신된 행을 이어서 본다.
  const windows: IdentityAuditWindow[] = cutoffIso ? ["created", "updated"] : ["created"];

  scan: for (const window of windows) {
    for (let from = 0; ; from += pageSize) {
      const remaining = maxRows === null ? pageSize : Math.min(pageSize, maxRows - scannedRows);
      if (remaining <= 0) {
        truncated = true;
        break scan;
      }

      const keys = await fetchIdentityKeyPage(supabase, state, window, cutoffIso, from, from + remaining - 1);
      if (keys.length === 0) break;
      const rows = await fetchIdentityRows(supabase, state, keys);

      for (const row of rows) {
        scannedRows++;
        if (!Object.prototype.hasOwnProperty.call(row, "platform")) {
          missingPlatformColumnRows++;
        }

        const mismatch = findProcessedTelemetryIdentityMismatch(row);
        if (!mismatch) continue;

        mismatchCount++;
        if (samples.length < sampleLimit) samples.push(mismatch);
        if (mismatch.canDelete) {
          deletionCandidateCount++;
          if (deletionTargets.length < targetLimit) deletionTargets.push(mismatch);
        }
      }

      if (keys.length < remaining) break;
    }
  }

  return {
    mode: "dry-run",
    table: "processed_match_telemetry",
    recentDays,
    maxRows,
    scannedRows,
    mismatchCount,
    missingPlatformColumnRows,
    deletionCandidateCount,
    samples,
    deletionTargets,
    truncated,
    generatedAt: new Date().toISOString()
  };
}

type IdentityAuditWindow = "created" | "updated";

type IdentityQueryState = { hasPlatformColumn: boolean };

type IdentityKeyRow = {
  match_id: string;
  platform?: string | null;
  player_id: string;
  created_at?: string | null;
  updated_at?: string | null;
};

type IdentityPathRow = IdentityKeyRow & {
  statsName?: string | null;
  embeddedPlayerId?: string | null;
  resultPlatform?: string | null;
};

/**
 * 감사 대상 행의 식별자만 읽는다.
 *
 * data jsonb(행당 평균 약 50KB)를 함께 읽으면 offset으로 건너뛴 행까지 풀어야 해서
 * 2026-10-20, 10-28 일일 작업이 statement timeout(57014)으로 실패했다.
 * created_at은 인덱스 역순 스캔으로 정렬 없이 읽고, updated_at 구간은 created_at 이전 행만 남겨 소량이다.
 */
async function fetchIdentityKeyPage(
  supabase: any,
  state: IdentityQueryState,
  window: IdentityAuditWindow,
  cutoffIso: string | null,
  from: number,
  to: number
): Promise<IdentityKeyRow[]> {
  const run = () => {
    const orderColumn = window === "created" ? "created_at" : "updated_at";
    let query = supabase
      .from("processed_match_telemetry")
      .select(state.hasPlatformColumn ? IDENTITY_KEY_COLUMNS : LEGACY_IDENTITY_KEY_COLUMNS)
      .order(orderColumn, { ascending: false })
      .order("match_id", { ascending: true })
      .order("player_id", { ascending: true })
      .range(from, to);
    if (cutoffIso && window === "created") query = query.gte("created_at", cutoffIso);
    if (cutoffIso && window === "updated") query = query.gte("updated_at", cutoffIso).lt("created_at", cutoffIso);
    return query;
  };

  let { data, error } = await run();
  if (error && state.hasPlatformColumn && isMissingPlatformColumnError(error)) {
    state.hasPlatformColumn = false;
    ({ data, error } = await run());
  }
  if (error) throw error;
  return (data || []) as IdentityKeyRow[];
}

/**
 * 식별 비교에 필요한 fullResult 경로만 읽어 findProcessedTelemetryIdentityMismatch 입력 형태로 되돌린다.
 *
 * 세 경로가 모두 비어 있으면 fullResult가 없는 행으로 본다. fullResult만 있고 세 필드가 모두 없는 행도
 * 같은 사유로 분류되지만, 어느 쪽이든 mismatch이고 삭제 승인 시에는 전체 data로 다시 검증한다.
 */
async function fetchIdentityRows(
  supabase: any,
  state: IdentityQueryState,
  keys: IdentityKeyRow[]
): Promise<Array<Record<string, unknown>>> {
  const matchIds = [...new Set(keys.map(key => key.match_id).filter(Boolean))];
  if (matchIds.length === 0) return [];

  const keyColumns = state.hasPlatformColumn ? IDENTITY_KEY_COLUMNS : LEGACY_IDENTITY_KEY_COLUMNS;
  const { data, error } = await supabase
    .from("processed_match_telemetry")
    .select(`${keyColumns}, ${IDENTITY_PATH_COLUMNS}`)
    .in("match_id", matchIds);
  if (error) throw error;

  const pathsByKey = new Map<string, IdentityPathRow>();
  for (const row of (data || []) as IdentityPathRow[]) {
    pathsByKey.set(identityRowKey(row), row);
  }

  // 두 조회 사이에 삭제된 행은 감사 대상에서 뺀다.
  return keys.flatMap(key => {
    const paths = pathsByKey.get(identityRowKey(key));
    if (!paths) return [];
    const { statsName, embeddedPlayerId, resultPlatform, ...row } = paths;
    const hasFullResult = [statsName, embeddedPlayerId, resultPlatform]
      .some(value => value !== null && value !== undefined);
    return [{
      ...row,
      data: hasFullResult
        ? {
            fullResult: {
              stats: { name: statsName ?? undefined },
              player_id: embeddedPlayerId ?? undefined,
              platform: resultPlatform ?? undefined
            }
          }
        : {}
    }];
  });
}

function identityRowKey(row: IdentityKeyRow) {
  return [row.match_id, row.platform ?? "", row.player_id].join("\u0000");
}

export function buildProcessedTelemetryIdentityRepairPayload(
  audit: ProcessedTelemetryIdentityAudit,
  targetLimit = DEFAULT_TARGET_LIMIT
) {
  const targets = audit.deletionTargets.slice(0, targetLimit).map(toIdentityTarget);
  return {
    title: "processed_match_telemetry identity mismatch 정리",
    cleanupType: "repair_processed_telemetry_identity",
    reason: "Agent monitor가 row.player_id/platform과 fullResult 내부 식별자가 다른 분석 캐시를 감지했습니다.",
    auditWindowDays: audit.recentDays,
    scannedRows: audit.scannedRows,
    mismatchCount: audit.mismatchCount,
    deletionCandidateCount: audit.deletionCandidateCount,
    targetCount: targets.length,
    targets,
    samples: audit.samples.map(toIdentityTargetWithEvidence),
    warnings: [
      "승인 시 targets에 포함된 identity mismatch row만 재검증 후 삭제합니다.",
      "원본 match_master_telemetry와 R2 텔레메트리는 삭제하지 않습니다.",
      "연막/회복 집계값 오염 가능 row는 자동 삭제하지 않고 재분석으로 교체합니다.",
      ...(audit.deletionCandidateCount > targets.length
        ? [`삭제 후보 ${audit.deletionCandidateCount}건 중 ${targets.length}건만 이번 승인 대상으로 제한했습니다.`]
        : [])
    ]
  };
}

export async function validateProcessedTelemetryIdentityTargets(
  supabase: any,
  targets: ProcessedTelemetryIdentityTarget[]
) {
  const valid: ProcessedTelemetryIdentityMismatch[] = [];
  const skipped: Array<{ target: ProcessedTelemetryIdentityTarget; reason: string }> = [];

  for (const target of targets) {
    if (!target.match_id || !target.platform || !target.player_id) {
      skipped.push({ target, reason: "필수 식별자 누락" });
      continue;
    }

    const { data, error } = await supabase
      .from("processed_match_telemetry")
      .select("match_id, platform, player_id, data, created_at, updated_at")
      .eq("match_id", target.match_id)
      .eq("platform", normalizePlatform(target.platform))
      .eq("player_id", normalizeName(target.player_id))
      .maybeSingle();

    if (error) {
      skipped.push({ target, reason: error.message || "조회 실패" });
      continue;
    }
    if (!data) {
      skipped.push({ target, reason: "이미 없거나 재분석으로 교체됨" });
      continue;
    }

    const mismatch = findProcessedTelemetryIdentityMismatch(data);
    if (!mismatch) {
      skipped.push({ target, reason: "현재 row는 identity mismatch가 아님" });
      continue;
    }
    valid.push(mismatch);
  }

  return { valid, skipped };
}

export async function deleteProcessedTelemetryIdentityTargets(
  supabase: any,
  targets: ProcessedTelemetryIdentityTarget[]
): Promise<ProcessedTelemetryIdentityDeleteResult> {
  const result: ProcessedTelemetryIdentityDeleteResult = {
    requested: targets.length,
    deleted: 0,
    skipped: 0,
    failed: 0,
    details: []
  };

  const validation = await validateProcessedTelemetryIdentityTargets(supabase, targets);
  validation.skipped.forEach(item => {
    result.skipped++;
    result.details.push({ target: item.target, status: "skipped", message: item.reason });
  });

  for (const mismatch of validation.valid) {
    const target = toIdentityTarget(mismatch);
    const { count, error } = await supabase
      .from("processed_match_telemetry")
      .delete({ count: "exact" })
      .eq("match_id", target.match_id)
      .eq("platform", target.platform)
      .eq("player_id", target.player_id);

    if (error) {
      result.failed++;
      result.details.push({ target, status: "failed", message: error.message || "삭제 실패" });
    } else {
      const deletedCount = count || 0;
      result.deleted += deletedCount;
      result.details.push({
        target,
        status: deletedCount > 0 ? "deleted" : "skipped",
        message: deletedCount > 0 ? `${deletedCount}개 row 삭제` : "삭제 대상 row 없음"
      });
      if (deletedCount === 0) result.skipped++;
    }
  }

  return result;
}

export function toIdentityTarget(mismatch: ProcessedTelemetryIdentityMismatch): ProcessedTelemetryIdentityTarget {
  return {
    match_id: mismatch.match_id,
    platform: normalizePlatform(mismatch.platform),
    player_id: normalizeName(mismatch.player_id),
    reason: mismatch.reason
  };
}

function toIdentityTargetWithEvidence(mismatch: ProcessedTelemetryIdentityMismatch) {
  return {
    ...toIdentityTarget(mismatch),
    statsName: mismatch.statsName,
    embeddedPlayerId: mismatch.embeddedPlayerId,
    resultPlatform: mismatch.resultPlatform,
    hasPlatformColumn: mismatch.hasPlatformColumn
  };
}

function clampPositiveInteger(value: number | undefined, fallback: number) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : fallback;
}

function isMissingPlatformColumnError(error: any) {
  const message = String(error?.message || error?.details || error?.hint || "").toLowerCase();
  return message.includes("platform") && (message.includes("column") || message.includes("schema cache"));
}
