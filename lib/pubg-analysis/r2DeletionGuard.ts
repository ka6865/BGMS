/**
 * @fileoverview R2 객체 삭제 시 보호 자산을 차단하는 가드입니다.
 *
 * R2 버킷에는 삭제해도 되는 분석 캐시(JSON)와 삭제하면 복구가 어려운
 * 이미지 자산이 함께 들어 있습니다. 이미지는 crates/ 와 weapons/ 경로에만
 * 존재하며 JSON 캐시와 경로가 섞이지 않는 것을 실측으로 확인했습니다.
 *
 * 삭제 대상 판정은 반드시 이 모듈을 통과해야 합니다. 호출부에서 조건을
 * 재구현하면 보호 규칙이 어긋날 수 있습니다.
 */

/** 이미지 자산이 저장되는 경로. 이 접두사로 시작하는 키는 삭제하지 않습니다. */
export const PROTECTED_KEY_PREFIXES = ["crates/", "weapons/"] as const;

/** 이미지 확장자. 경로와 무관하게 삭제하지 않습니다. */
export const PROTECTED_EXTENSIONS = [
  ".png", ".jpg", ".jpeg", ".webp", ".gif", ".svg", ".avif", ".bmp", ".ico",
] as const;

/**
 * 정리 작업이 남기는 삭제 목록 아카이브 경로.
 * 삭제 이력 추적 수단이므로 정리 대상에서 제외합니다.
 *
 * backups/ 는 핵심 테이블 백업입니다. Supabase 무료 플랜에 자동 백업이 없어
 * 이 파일이 유일한 복구 수단이므로 어떤 정리 작업도 지우지 못하게 합니다.
 */
export const PROTECTED_KEY_PATTERNS = [
  /^telemetry-inventory\//,
  /^backups\//,
] as const;

export type DeletionGuardReason =
  | "empty-key"
  | "protected-prefix"
  | "protected-extension"
  | "protected-pattern"
  | "path-traversal";

export type DeletionGuardVerdict =
  | { allowed: true }
  | { allowed: false; reason: DeletionGuardReason };

/**
 * 키가 삭제 가능한지 판정합니다.
 * 보호 규칙에 하나라도 걸리면 삭제를 거부합니다.
 */
export function inspectDeletionKey(key: unknown): DeletionGuardVerdict {
  if (typeof key !== "string") {
    return { allowed: false, reason: "empty-key" };
  }

  const trimmed = key.trim();
  if (trimmed.length === 0) {
    return { allowed: false, reason: "empty-key" };
  }

  // 상위 경로 탈출이나 절대 경로는 의도한 대상이 아니다.
  if (trimmed.includes("..") || trimmed.startsWith("/")) {
    return { allowed: false, reason: "path-traversal" };
  }

  const lowered = trimmed.toLowerCase();

  for (const prefix of PROTECTED_KEY_PREFIXES) {
    if (lowered.startsWith(prefix)) {
      return { allowed: false, reason: "protected-prefix" };
    }
  }

  for (const extension of PROTECTED_EXTENSIONS) {
    if (lowered.endsWith(extension)) {
      return { allowed: false, reason: "protected-extension" };
    }
  }

  for (const pattern of PROTECTED_KEY_PATTERNS) {
    if (pattern.test(lowered)) {
      return { allowed: false, reason: "protected-pattern" };
    }
  }

  return { allowed: true };
}

/** 키가 삭제 가능한지 여부만 반환합니다. */
export function isDeletableKey(key: unknown): boolean {
  return inspectDeletionKey(key).allowed;
}

export type PartitionedKeys = {
  deletable: string[];
  blocked: Array<{ key: string; reason: DeletionGuardReason }>;
};

/** 키 목록을 삭제 가능 대상과 차단 대상으로 분리합니다. */
export function partitionDeletionKeys(keys: readonly unknown[]): PartitionedKeys {
  const deletable: string[] = [];
  const blocked: Array<{ key: string; reason: DeletionGuardReason }> = [];

  for (const key of keys) {
    const verdict = inspectDeletionKey(key);
    if (verdict.allowed) {
      deletable.push(String(key).trim());
    } else {
      blocked.push({ key: typeof key === "string" ? key : String(key), reason: verdict.reason });
    }
  }

  return { deletable, blocked };
}
