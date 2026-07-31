/**
 * 저장 용량 현황 타입.
 *
 * lib/admin-agent/storage-health.ts 는 AWS SDK 를 쓰는 서버 전용 모듈이라
 * 클라이언트 컴포넌트가 직접 참조하지 않도록 타입만 여기로 분리한다.
 */

export type StorageUsageStatus = "ok" | "warn" | "critical" | "unavailable";

export type ReclaimTarget = "match_stats_raw" | "pubg_player_cache";

export type StorageTableUsage = {
  table: string;
  count: number | null;
  totalBytes: number | null;
  tableBytes: number | null;
  indexBytes: number | null;
  status: StorageUsageStatus;
  error: string | null;
};

export type StorageReclaimable = {
  target: ReclaimTarget;
  label: string;
  candidateRows: number;
  estimatedBytes: number;
  detail: string;
  error: string | null;
};

export type StorageHealthSummary = {
  generatedAt: string;
  database: {
    usedBytes: number;
    limitBytes: number;
    usagePercent: number;
    status: StorageUsageStatus;
    error: string | null;
  };
  r2: {
    bucketName: string | null;
    fileCount: number;
    totalSizeBytes: number;
    limitBytes: number;
    usagePercent: number;
    scannedPages: number;
    truncated: boolean;
    configured: boolean;
    status: StorageUsageStatus;
    error: string | null;
  };
  tables: StorageTableUsage[];
  reclaimable: StorageReclaimable[];
  recommendations: string[];
};

/** 정리 실행 API 응답. */
export type StorageCompactionResult = {
  target: ReclaimTarget;
  label: string;
  detail: string;
  dryRun: boolean;
  candidateCount: number;
  deletedCount: number;
  remainingCount?: number;
  totalCount: number | null;
  hasRemaining: boolean;
  message: string;
};
