import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import solo from '@/lib/learn/solo.json';
import squad from '@/lib/learn/squad.json';
import type { RankerLesson } from '@/lib/learn/lessons';

type ReplayEvent = {
  type: string;
  relativeTimeMs: number;
  name?: string;
  attacker?: string;
  victim?: string;
  x?: number;
  y?: number;
  health?: number;
  vehicleId?: string | null;
  isTeam?: boolean;
  isTeamAttacker?: boolean;
  blueRadius?: number;
  whiteX?: number;
  whiteY?: number;
  whiteRadius?: number;
  phase?: number;
};

function replay(mode: 'solo' | 'squad') {
  return JSON.parse(readFileSync(join(process.cwd(), `public/learn/replays/2026-09-22-${mode}.json`), 'utf8')) as {
    events: ReplayEvent[];
    zoneEvents: ReplayEvent[];
  };
}

function closest(events: ReplayEvent[], seconds: number) {
  return events.reduce((best, event) =>
    Math.abs(event.relativeTimeMs / 1000 - seconds) < Math.abs(best.relativeTimeMs / 1000 - seconds) ? event : best);
}

describe('2026-09-22 briefing evidence', () => {
  it('shows all four squad personal kills with weapons from the original kill records', () => {
    const evidence = JSON.parse(readFileSync(join(process.cwd(),
      'docs/experiments/2026-09-23-ranker-content/squad-evidence.json'), 'utf8')) as {
      kills: { t: number; victim: string; weapon: string }[];
    };
    const weaponLabels: Record<string, string> = {
      WeapUMP_C: 'UMP45', WeapMk12_C: 'Mk12', WeapAUG_C: 'AUG',
    };
    expect(squad.personalKills).toHaveLength(squad.kills);
    expect(squad.personalKills).toEqual(evidence.kills.map((kill) => ({
      timeSeconds: kill.t, victim: kill.victim, weapon: weaponLabels[kill.weapon],
    })));
  });

  it.each([['solo', solo], ['squad', squad]] as const)('%s map points follow the recorded time order', (mode, rawLesson) => {
    const source = replay(mode);
    const positions = source.events.filter((event) => event.type === 'position' &&
      event.name === rawLesson.nickname && event.vehicleId !== 'DummyTransportAircraft_C');
    const squadLanding = mode === 'squad' ? JSON.parse(readFileSync(join(process.cwd(),
      'docs/experiments/2026-09-23-ranker-content/squad-evidence.json'), 'utf8')).landing as {
      t: number; location: { x: number; y: number };
    } : null;

    for (const scene of (rawLesson as RankerLesson).scenes) {
      const snapshot = scene.mapSnapshot;
      if (snapshot?.pathStartSeconds === undefined || snapshot.pathEndSeconds === undefined) continue;
      const times = snapshot.path.map((point, index) => {
        if (mode === 'squad' && scene.id === 'scene-1' && index === 0 && squadLanding) {
          expect(Math.hypot(point.x - squadLanding.location.x, point.y - squadLanding.location.y)).toBeLessThan(1);
          return squadLanding.t;
        }
        const closestPosition = positions.reduce((best, event) =>
          Math.hypot((event.x ?? 0) - point.x, (event.y ?? 0) - point.y) <
          Math.hypot((best.x ?? 0) - point.x, (best.y ?? 0) - point.y) ? event : best);
        expect(Math.hypot((closestPosition.x ?? 0) - point.x, (closestPosition.y ?? 0) - point.y),
          `${mode} ${scene.id}: map point ${index + 1}`).toBeLessThan(4);
        return closestPosition.relativeTimeMs / 1000;
      });
      expect(times, `${mode} ${scene.id}: map path order`).toEqual([...times].sort((a, b) => a - b));
      expect(times[0]).toBeCloseTo(snapshot.pathStartSeconds, 0);
      expect(times.at(-1)).toBeCloseTo(snapshot.pathEndSeconds, 0);
    }
  });

  it('separates squad knock, finish, shot, and revive records', () => {
    const source = replay('squad');
    const kindToSource: Record<string, string> = { knock: 'groggy', kill: 'kill', shot: 'shot', revive: 'revive' };
    for (const scene of (squad as RankerLesson).scenes) {
      for (const event of scene.combatEvents ?? []) {
        const sourceType = kindToSource[event.kind];
        expect(sourceType).toBeDefined();
        const matches = source.events.filter((raw) =>
          raw.type === sourceType &&
          Math.abs(raw.relativeTimeMs / 1000 - event.timeSeconds) < 0.01 &&
          (raw.attacker ?? raw.name) === event.actor &&
          (!event.target || raw.victim === event.target));
        expect(matches, `${scene.id}: ${event.kind} at ${event.timeSeconds}`).toHaveLength(1);
        if (event.actorSide) expect(matches[0].isTeamAttacker ?? matches[0].isTeam).toBe(event.actorSide === 'ally');
      }
    }
  });

  it.each([['solo', solo], ['squad', squad]] as const)('%s zone timing and nearby opponents come from replay samples', (mode, rawLesson) => {
    const lesson = rawLesson as RankerLesson;
    const source = replay(mode);
    const playerPositions = source.events.filter((event) => event.type === 'position' &&
      event.name?.toLowerCase() === lesson.nickname.toLowerCase() &&
      (event.health ?? 0) > 0 && event.vehicleId !== 'DummyTransportAircraft_C');

    for (const scene of lesson.scenes) {
      for (const round of scene.zoneAnalysis?.rounds ?? []) {
        const revealed = closest(source.zoneEvents, round.revealedSeconds);
        expect(Math.abs(revealed.relativeTimeMs / 1000 - round.revealedSeconds)).toBeLessThan(0.01);
        const phase = source.zoneEvents.filter((event) => event.phase === revealed.phase);
        expect(revealed).toBe(phase[0]);
        const shrink = phase.find((event) => (event.blueRadius ?? Infinity) < (revealed.blueRadius ?? 0) - 5);

        const start = closest(playerPositions, round.revealedSeconds);
        const after = playerPositions.filter((event) => event.relativeTimeMs >= revealed.relativeTimeMs);
        const moved = after.find((event) => Math.hypot((event.x ?? 0) - (start.x ?? 0), (event.y ?? 0) - (start.y ?? 0)) > 100);
        const inside = after.find((event) => Math.hypot((event.x ?? 0) - (revealed.whiteX ?? 0), (event.y ?? 0) - (revealed.whiteY ?? 0)) <= (revealed.whiteRadius ?? 0));
        if (!shrink || !moved || !inside) throw new Error(`${mode}: ${round.label} source sample missing`);
        expect(shrink.relativeTimeMs / 1000).toBeCloseTo(round.shrinkSeconds, 2);
        expect(moved.relativeTimeMs / 1000).toBeCloseTo(round.movedSeconds, 2);
        expect(inside.relativeTimeMs / 1000).toBeCloseTo(round.enteredSeconds, 2);
      }
      for (const opponent of scene.zoneAnalysis?.nearbyOpponents ?? []) {
        const matches = source.events.filter((event) => event.type === 'position' && !event.isTeam &&
          event.name === opponent.name && Math.abs(event.relativeTimeMs / 1000 - opponent.timeSeconds) < 0.01);
        expect(matches).toHaveLength(1);
        const player = closest(playerPositions, opponent.timeSeconds);
        expect(Math.abs(player.relativeTimeMs / 1000 - opponent.timeSeconds)).toBeLessThan(5);
        expect(Math.hypot((matches[0].x ?? 0) - (player.x ?? 0), (matches[0].y ?? 0) - (player.y ?? 0))).toBeCloseTo(opponent.distanceMeters, -1);
      }
      for (const kill of scene.mapSnapshot?.kills ?? []) {
        if (!kill.label) continue;
        const matches = source.events.filter((event) => event.type === 'kill' && event.victim === kill.label?.split(' · ')[0] &&
          Math.hypot((event.x ?? 0) - kill.x, (event.y ?? 0) - kill.y) < 1);
        expect(matches, `${scene.id}: ${kill.label}`).toHaveLength(1);
      }
    }
  });
});
