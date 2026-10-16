// lite 리플레이는 분석 엔진 규칙상 아군 전멸 30초 뒤부터 이벤트를 처리하지 않는다(AnalysisEngine의 isAfterTeamWipe).
// 다만 다른 선수의 부활·복귀 이벤트는 계속 남아 타임라인이 길어지므로, 화면에서는 "전멸 + 30초"를 lite의 끝으로 보고
// 그 시각부터 full로 경기 끝까지 이어 본다.

/** 분석 엔진이 아군 전멸 뒤에도 이벤트를 처리하는 시간. */
export const LITE_WIPE_TAIL_MS = 30_000;
/** lite 끝까지의 진행률이 이 값을 넘으면 full 리플레이 생성을 미리 요청한다(끝까지 보지 않는 재생에는 생성 비용을 쓰지 않는다). */
export const FULL_MATCH_WARMUP_PROGRESS = 0.8;
/** 재생 끝으로 보는 여유. */
const END_TOLERANCE_MS = 500;

type ReplayEvent = { type?: unknown; relativeTimeMs?: unknown; name?: unknown; victim?: unknown };

const normalize = (value: unknown): string => (typeof value === "string" ? value.trim().toLowerCase() : "");

/**
 * 아군 전원이 마지막으로 사망한 시각. 한 명이라도 마지막 사망 뒤 블루칩 재배치(create)로 살아났거나
 * 사망 기록이 없으면 전멸이 아니므로 null.
 */
export function findSquadWipeMs(events: readonly unknown[], teamNames: readonly string[]): number | null {
  const team = teamNames.map(normalize).filter(Boolean);
  if (team.length === 0) return null;
  const lastDeath = new Map<string, number>();
  const lastCreate = new Map<string, number>();
  for (const raw of events) {
    if (typeof raw !== "object" || raw === null) continue;
    const event = raw as ReplayEvent;
    if (typeof event.relativeTimeMs !== "number" || !Number.isFinite(event.relativeTimeMs)) continue;
    if (event.type === "kill") {
      const victim = normalize(event.victim);
      lastDeath.set(victim, Math.max(lastDeath.get(victim) ?? -Infinity, event.relativeTimeMs));
    } else if (event.type === "create") {
      const name = normalize(event.name);
      lastCreate.set(name, Math.max(lastCreate.get(name) ?? -Infinity, event.relativeTimeMs));
    }
  }
  let wipeMs = -Infinity;
  for (const name of team) {
    const death = lastDeath.get(name);
    if (death === undefined || death <= (lastCreate.get(name) ?? -Infinity)) return null;
    wipeMs = Math.max(wipeMs, death);
  }
  return wipeMs;
}

/** lite에서 실제로 재생할 끝 시각. 전멸하지 않았거나 full이면 데이터의 끝을 그대로 쓴다. */
export function liteReplayEndMs(mode: string | null, squadWipeMs: number | null, maxTimeMs: number): number {
  if (mode !== "lite" || squadWipeMs === null) return maxTimeMs;
  return Math.min(maxTimeMs, squadWipeMs + LITE_WIPE_TAIL_MS);
}

/** lite 끝까지 왔고 아군이 전멸했으면 경기 끝까지 이어 보기를 제안한다. */
export function shouldOfferFullMatch(input: {
  mode: string | null;
  squadWipeMs: number | null;
  currentTimeMs: number;
  maxTimeMs: number;
}): boolean {
  if (input.mode !== "lite" || input.squadWipeMs === null || input.maxTimeMs <= 0) return false;
  return input.currentTimeMs >= liteReplayEndMs(input.mode, input.squadWipeMs, input.maxTimeMs) - END_TOLERANCE_MS;
}

/** full 생성을 미리 요청할 시점인지. */
export function shouldWarmFullMatch(input: { mode: string | null; squadWipeMs: number | null; currentTimeMs: number; maxTimeMs: number }): boolean {
  if (input.mode !== "lite" || input.squadWipeMs === null || input.maxTimeMs <= 0) return false;
  return input.currentTimeMs >= liteReplayEndMs(input.mode, input.squadWipeMs, input.maxTimeMs) * FULL_MATCH_WARMUP_PROGRESS;
}
