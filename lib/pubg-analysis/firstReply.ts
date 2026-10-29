/** 기존 첫 피격→첫 반격 명중 간격. 점수·과거 저장 열 호환용이다. */
export function rawFirstReplyLatencyMs(result: any): number | null {
  const count = Number(result?.duelStats?.firstReplyWithin3sCount);
  const sum = Number(result?.duelStats?.firstReplyLatencySumMs);
  return Number.isInteger(count) && count > 0 && Number.isFinite(sum) && sum >= 0 ? sum / count : null;
}

export type FirstReplyEvidence = {
  version: 1;
  eligibleCount: number;
  alreadyFiringCount: number;
  unknownCount: number;
  within3sCount: number;
  latencySumMs: number;
  noReplyCount: number;
};

export function readFirstReplyEvidence(result: any): FirstReplyEvidence | null {
  const e = result?.duelStats?.firstReplyEvidence;
  if (e?.version !== 1 || !['eligibleCount','alreadyFiringCount','unknownCount','within3sCount','latencySumMs','noReplyCount'].every(k => Number.isInteger(e[k]) && e[k] >= 0)
    || e.eligibleCount !== e.within3sCount + e.noReplyCount || e.latencySumMs >= e.within3sCount * 3000 && e.within3sCount > 0
    || e.within3sCount === 0 && e.latencySumMs !== 0) return null;
  return e;
}

/** 코칭에는 발사 근거로 피격 전 사격을 구분한 값만 쓴다. */
export function firstReplyLatencyMs(result: any): number | null {
  const e = readFirstReplyEvidence(result);
  return e && e.within3sCount > 0 ? e.latencySumMs / e.within3sCount : null;
}

/** 기존 실패 지표와 같은 경기 단위 정의. 제외·불명확 교전은 분모에도 넣지 않는다. */
export function firstReplyFailureRate(result: any): number | null {
  const e = readFirstReplyEvidence(result);
  return !e || e.eligibleCount === 0 ? null : e.within3sCount === 0 ? 100 : 0;
}

type Shot = { id: unknown; weapon: string; ts: number };
type Entry = { hit: number; status: 'clear' | 'firing' | 'unknown'; reply?: number; linked?: boolean };

/** 기존 교전 판정 지점을 사용하고, 독립적으로 사격 문맥만 관측한다. */
export class FirstReplyEvidenceCollector {
  private shots: Shot[] = [];
  private hasAttackLogs = false;
  private entries = new Map<object, Entry>();

  attack(event: any, ts: number) {
    const weapon = event.weapon;
    if (event.attackType !== 'Weapon' || weapon?.category !== 'Weapon' || !['Main','Handgun'].includes(weapon.subCategory) || !weapon.itemId) return;
    this.hasAttackLogs = true;
    this.shots = this.shots.filter(s => ts - s.ts <= 3500);
    if (this.shots.some(s => s.id === event.attackId && s.ts === ts)) return;
    this.shots.push({ id: event.attackId, weapon: weapon.itemId, ts });
  }

  begin(session: object, ts: number) {
    const recent = this.shots.filter(s => ts - s.ts >= 0 && ts - s.ts <= 300);
    const last = recent.at(-1), previous = recent.at(-2);
    // 최근 연사 문맥의 보수적 확인 창이며, 반사신경 하한으로 시간을 자르지 않는다.
    const firing = last && previous && last.weapon === previous.weapon && last.ts > previous.ts && last.ts - previous.ts <= 200 && ts - last.ts <= 200;
    this.entries.set(session, { hit: ts, status: firing ? 'firing' : recent.length ? 'unknown' : 'clear' });
  }

  reply(session: object, event: any, ts: number) {
    const entry = this.entries.get(session);
    if (!entry || entry.reply !== undefined) return;
    entry.reply = ts;
    entry.linked = event.attackId !== undefined && this.shots.some(s => s.id === event.attackId && s.ts > entry.hit && s.ts <= ts);
  }

  result(): FirstReplyEvidence {
    const result: FirstReplyEvidence = { version: 1, eligibleCount: 0, alreadyFiringCount: 0, unknownCount: 0, within3sCount: 0, latencySumMs: 0, noReplyCount: 0 };
    for (const e of this.entries.values()) {
      if (e.status === 'firing') { result.alreadyFiringCount++; continue; }
      if (e.status === 'unknown' || !this.hasAttackLogs || e.reply !== undefined && e.reply - e.hit < 3000 && !e.linked) { result.unknownCount++; continue; }
      result.eligibleCount++;
      if (e.reply !== undefined && e.reply >= e.hit && e.reply - e.hit < 3000) {
        result.within3sCount++; result.latencySumMs += e.reply - e.hit;
      } else result.noReplyCount++;
    }
    return result;
  }
}
