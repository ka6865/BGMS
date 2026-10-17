// 리플레이 데이터의 teamNames는 소문자로 정규화돼 있다. 화면 표시와 이름 일치 비교(킬피드·타임라인)를 위해
// 이벤트에 기록된 실제 표기로 되돌린다.

type NamedEvent = { type?: unknown; name?: unknown; attacker?: unknown; victim?: unknown };

/** teamNames 각 이름을 이벤트에 나온 원래 표기로 바꾼다. 찾지 못하면 그대로 둔다. */
export function restoreNameCase(teamNames: readonly string[], events: readonly unknown[]): string[] {
  const wanted = new Set(teamNames.map((name) => name.trim().toLowerCase()));
  const found = new Map<string, string>();
  const remember = (value: unknown) => {
    if (typeof value !== "string") return;
    const key = value.trim().toLowerCase();
    if (wanted.has(key) && !found.has(key)) found.set(key, value.trim());
  };
  // 좌표 이벤트의 이름이 가장 정확하므로 먼저 본다.
  for (const raw of events) {
    if (typeof raw === "object" && raw !== null && (raw as NamedEvent).type === "position") remember((raw as NamedEvent).name);
    if (found.size === wanted.size) break;
  }
  if (found.size < wanted.size) {
    for (const raw of events) {
      if (typeof raw !== "object" || raw === null) continue;
      const event = raw as NamedEvent;
      remember(event.name); remember(event.attacker); remember(event.victim);
      if (found.size === wanted.size) break;
    }
  }
  return teamNames.map((name) => found.get(name.trim().toLowerCase()) ?? name);
}
