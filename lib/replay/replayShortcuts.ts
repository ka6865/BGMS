// 2D 리플레이 키보드 조작과 장면 공유 링크 규칙.

export const REPLAY_STEP_MS = 5_000;
export const REPLAY_LONG_STEP_MS = 30_000;

export type ReplayKeyAction = { kind: "toggle" } | { kind: "seek"; deltaMs: number } | null;

/** 입력 중인 필드에서는 단축키를 쓰지 않는다. */
export function isTypingTarget(target: EventTarget | null): boolean {
  if (!target || typeof target !== "object") return false;
  const element = target as { tagName?: unknown; isContentEditable?: unknown };
  const tag = typeof element.tagName === "string" ? element.tagName.toUpperCase() : "";
  return tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT" || element.isContentEditable === true;
}

/** 포커스된 버튼·링크에서는 스페이스가 그 버튼을 누르므로 재생 토글과 겹치지 않게 한다. */
export function isActivationTarget(target: EventTarget | null): boolean {
  if (!target || typeof target !== "object") return false;
  const tag = (target as { tagName?: unknown }).tagName;
  return typeof tag === "string" && (tag.toUpperCase() === "BUTTON" || tag.toUpperCase() === "A");
}

/** 스페이스는 재생/정지, 좌우 방향키는 5초(Shift와 함께 30초) 이동. */
export function replayKeyAction(key: string, shiftKey: boolean): ReplayKeyAction {
  if (key === " " || key === "Spacebar") return { kind: "toggle" };
  const step = shiftKey ? REPLAY_LONG_STEP_MS : REPLAY_STEP_MS;
  if (key === "ArrowRight") return { kind: "seek", deltaMs: step };
  if (key === "ArrowLeft") return { kind: "seek", deltaMs: -step };
  return null;
}

/** 지금 보는 리플레이 주소에 현재 시각(초)을 붙인 공유 링크. */
export function buildReplayShareUrl(href: string, currentTimeMs: number): string {
  const url = new URL(href);
  url.searchParams.set("t", String(Math.max(0, Math.floor(currentTimeMs / 1000))));
  return url.toString();
}

/** ? 키(Shift+/)는 사용법을 연다. */
export function isHelpKey(key: string): boolean {
  return key === "?";
}

export const REPLAY_HELP_SEEN_KEY = "bgms.replay.helpSeen";
