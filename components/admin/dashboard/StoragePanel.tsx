"use client";

import { Database, HardDrive, Loader2, RefreshCw, Search, Trash2 } from "lucide-react";
import type { ReclaimTarget, StorageCompactionResult, StorageHealthSummary } from "@/types/storage-health";

export default function StoragePanel({
  storageHealth, storageLoading, storageError, compactionPending, compactionPreview,
  onRefresh, onPreview, onApply,
}: {
  storageHealth: StorageHealthSummary | null;
  storageLoading: boolean;
  storageError: string | null;
  compactionPending: ReclaimTarget | null;
  compactionPreview: Partial<Record<ReclaimTarget, StorageCompactionResult>>;
  onRefresh: () => void;
  onPreview: (target: ReclaimTarget) => void;
  onApply: (target: ReclaimTarget) => void;
}) {
  return (
    <section className="space-y-3">
      <div className="rounded-lg border border-zinc-800 bg-zinc-900 p-4">
        <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
          <div>
            <h2 className="text-base font-bold text-zinc-100">데이터 관리</h2>
            <p className="mt-1 text-xs text-zinc-500">
              저장 용량과 정리 대상을 확인합니다. 정리는 대상 건수를 먼저 확인한 뒤 실행합니다.
            </p>
          </div>
          <button
            onClick={onRefresh}
            disabled={storageLoading}
            className="inline-flex shrink-0 items-center gap-2 rounded-md border border-sky-500/30 bg-sky-500/10 px-3 py-2 text-xs font-semibold text-sky-300 disabled:opacity-50"
          >
            {storageLoading ? <Loader2 className="h-4 w-4 animate-spin" /> : <RefreshCw className="h-4 w-4" />}
            새로 조회
          </button>
        </div>
        {storageHealth && (
          <p className="mt-3 text-[11px] text-zinc-500">
            조회 시각 {new Date(storageHealth.generatedAt).toLocaleString("ko-KR")}
          </p>
        )}
      </div>

      {storageError && (
        <div className="rounded-lg border border-red-500/25 bg-red-500/5 p-4 text-xs text-red-200">
          {storageError}
        </div>
      )}

      {storageLoading && !storageHealth && (
        <div className="flex items-center gap-2 rounded-lg border border-zinc-800 bg-zinc-900 p-4 text-xs text-zinc-400">
          <Loader2 className="h-4 w-4 animate-spin" />
          용량을 조회하고 있습니다. R2 버킷 전체를 훑기 때문에 몇 초 걸립니다.
        </div>
      )}

      {storageHealth && (
        <>
          <div className="grid gap-3 sm:grid-cols-2">
            <UsageCard
              label="Supabase DB"
              icon={Database}
              usedBytes={storageHealth.database.usedBytes}
              limitBytes={storageHealth.database.limitBytes}
              usagePercent={storageHealth.database.usagePercent}
              status={storageHealth.database.status}
              error={storageHealth.database.error}
            />
            <UsageCard
              label="Cloudflare R2"
              icon={HardDrive}
              usedBytes={storageHealth.r2.totalSizeBytes}
              limitBytes={storageHealth.r2.limitBytes}
              usagePercent={storageHealth.r2.usagePercent}
              status={storageHealth.r2.status}
              error={storageHealth.r2.error}
              detail={`파일 ${storageHealth.r2.fileCount.toLocaleString()}개`}
            />
          </div>

          <section className="rounded-lg border border-zinc-800 bg-zinc-900 p-4">
            <h3 className="text-sm font-bold text-zinc-100">정리로 회수할 수 있는 용량</h3>
            <p className="mt-1 text-xs text-zinc-500">
              삭제는 되돌릴 수 없습니다. 먼저 대상 건수를 확인하면 실행 버튼이 나타납니다.
            </p>
            <div className="mt-3 space-y-3">
              {storageHealth.reclaimable.map((item) => (
                <ReclaimRow
                  key={item.target}
                  item={item}
                  preview={compactionPreview[item.target] ?? null}
                  pending={compactionPending === item.target}
                  onPreview={() => onPreview(item.target)}
                  onApply={() => onApply(item.target)}
                />
              ))}
            </div>
          </section>

          <section className="rounded-lg border border-zinc-800 bg-zinc-900 p-4">
            <h3 className="text-sm font-bold text-zinc-100">테이블 용량</h3>
            <p className="mt-1 text-xs text-zinc-500">큰 순서입니다. 인덱스 크기를 포함합니다.</p>
            <div className="mt-3 space-y-1.5">
              {storageHealth.tables.map((table) => (
                <TableUsageRow key={table.table} table={table} />
              ))}
            </div>
          </section>

          {storageHealth.recommendations.length > 0 && (
            <section className="rounded-lg border border-zinc-800 bg-zinc-900 p-4">
              <h3 className="text-sm font-bold text-zinc-100">점검 결과</h3>
              <div className="mt-2 space-y-2">
                {storageHealth.recommendations.map((item, index) => (
                  <p key={`${item}-${index}`} className="rounded-md bg-zinc-950 p-2 text-xs leading-relaxed text-zinc-400">
                    {item}
                  </p>
                ))}
              </div>
            </section>
          )}
        </>
      )}
    </section>
  );
}

/** 용량 사용률 카드. 임계값에 따라 색을 바꿔 위험 상태를 눈에 띄게 한다. */
function UsageCard({
  label,
  icon: Icon,
  usedBytes,
  limitBytes,
  usagePercent,
  status,
  error,
  detail
}: {
  label: string;
  icon: typeof Database;
  usedBytes: number;
  limitBytes: number;
  usagePercent: number;
  status: string;
  error: string | null;
  detail?: string;
}) {
  const tone = status === "critical"
    ? "border-red-500/30 bg-red-500/5"
    : status === "warn"
      ? "border-amber-500/25 bg-amber-500/5"
      : status === "unavailable"
        ? "border-zinc-800 bg-zinc-900"
        : "border-emerald-500/25 bg-emerald-500/5";
  const barTone = status === "critical"
    ? "bg-red-400"
    : status === "warn"
      ? "bg-amber-400"
      : "bg-emerald-400";

  return (
    <div className={`rounded-lg border p-4 ${tone}`}>
      <div className="flex items-center gap-2">
        <Icon className="h-4 w-4 text-zinc-400" />
        <p className="text-xs font-semibold text-zinc-300">{label}</p>
      </div>
      {error ? (
        <p className="mt-3 text-xs text-zinc-500">조회 실패: {error}</p>
      ) : (
        <>
          <p className="mt-2 text-xl font-bold text-zinc-100">
            {formatStorageBytes(usedBytes)}
            <span className="ml-1 text-xs font-normal text-zinc-500">/ {formatStorageBytes(limitBytes)}</span>
          </p>
          <div
            className="mt-2 h-1.5 overflow-hidden rounded-full bg-zinc-800"
            role="progressbar"
            aria-label={`${label} 사용률`}
            aria-valuenow={Math.round(usagePercent)}
            aria-valuemin={0}
            aria-valuemax={100}
          >
            <div className={`h-full ${barTone}`} style={{ width: `${Math.min(100, Math.max(0, usagePercent))}%` }} />
          </div>
          <p className="mt-2 text-[11px] text-zinc-500">
            {usagePercent.toFixed(1)}% 사용{detail ? ` · ${detail}` : ""}
          </p>
        </>
      )}
    </div>
  );
}

/** 정리 대상 한 줄. dry-run 을 거치지 않으면 실행 버튼을 만들지 않는다. */
function ReclaimRow({
  item,
  preview,
  pending,
  onPreview,
  onApply
}: {
  item: StorageHealthSummary["reclaimable"][number];
  preview: StorageCompactionResult | null;
  pending: boolean;
  onPreview: () => void;
  onApply: () => void;
}) {
  // dry-run 결과가 있고 지울 것이 남아 있을 때만 실행을 허용한다.
  const canApply = Boolean(preview && preview.candidateCount > 0);

  return (
    <div className="rounded-md border border-zinc-800 bg-zinc-950 p-3">
      <div className="flex flex-col gap-2 sm:flex-row sm:items-start sm:justify-between">
        <div className="min-w-0">
          <p className="text-xs font-semibold text-zinc-200">{item.label}</p>
          <p className="mt-1 text-[11px] leading-relaxed text-zinc-500">{item.detail}</p>
        </div>
        <div className="shrink-0 text-right">
          {item.error ? (
            <p className="text-[11px] text-red-300">조회 실패</p>
          ) : (
            <>
              <p className="text-sm font-bold text-zinc-100">{formatStorageBytes(item.estimatedBytes)}</p>
              <p className="text-[11px] text-zinc-500">{item.candidateRows.toLocaleString()}건</p>
            </>
          )}
        </div>
      </div>

      {preview && (
        <p className="mt-2 rounded bg-zinc-900 p-2 text-[11px] leading-relaxed text-amber-200">
          {preview.message}
        </p>
      )}

      {!item.error && item.candidateRows > 0 && (
        <div className="mt-3 flex flex-wrap gap-2">
          <button
            onClick={onPreview}
            disabled={pending}
            className="inline-flex items-center gap-1.5 rounded border border-zinc-700 bg-zinc-900 px-2.5 py-1.5 text-[11px] font-semibold text-zinc-300 disabled:opacity-50"
          >
            {pending ? <Loader2 className="h-3 w-3 animate-spin" /> : <Search className="h-3 w-3" />}
            대상 확인
          </button>
          {canApply && (
            <button
              onClick={onApply}
              disabled={pending}
              className="inline-flex items-center gap-1.5 rounded border border-red-500/30 bg-red-500/10 px-2.5 py-1.5 text-[11px] font-semibold text-red-200 disabled:opacity-50"
            >
              <Trash2 className="h-3 w-3" />
              정리 실행
            </button>
          )}
        </div>
      )}
    </div>
  );
}

/** 테이블 한 줄. 크기와 행수를 함께 보여준다. */
function TableUsageRow({ table }: { table: StorageHealthSummary["tables"][number] }) {
  return (
    <div className="flex items-center justify-between gap-3 rounded bg-zinc-950 px-3 py-2">
      <p className="min-w-0 truncate text-[11px] text-zinc-300">{table.table}</p>
      <div className="shrink-0 text-right">
        {table.totalBytes === null ? (
          <p className="text-[11px] text-zinc-500">
            {table.count === null ? "조회 실패" : `${table.count.toLocaleString()}행`}
          </p>
        ) : (
          <p className="text-[11px] text-zinc-400">
            <span className="font-semibold text-zinc-200">{formatStorageBytes(table.totalBytes)}</span>
            {table.indexBytes !== null && (
              <span className="ml-1 text-zinc-600">인덱스 {formatStorageBytes(table.indexBytes)}</span>
            )}
            {table.count !== null && <span className="ml-1 text-zinc-600">{table.count.toLocaleString()}행</span>}
          </p>
        )}
      </div>
    </div>
  );
}

/** 화면 표기용 용량 포맷. 서버의 formatBytes 와 같은 규칙을 쓴다. */
function formatStorageBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return "0MB";
  const mb = bytes / (1024 * 1024);
  if (mb >= 1024) return `${(mb / 1024).toFixed(2)}GB`;
  if (mb >= 1) return `${mb.toFixed(1)}MB`;
  return `${Math.max(1, Math.round(bytes / 1024))}KB`;
}

