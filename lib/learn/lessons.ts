import solo from "./solo.json";
import squad from "./squad.json";
import type { TelemetryPublicIdentity } from "../pubg-analysis/telemetryIdentity";

export type RankerScene = {
  id: string;
  title: string;
  anchorSeconds: number;
  startSeconds: number;
  fact: string;
  context?: string;
  limitation: string;
  combatEvents?: {
    timeSeconds: number;
    kind: "shot" | "damage" | "received" | "kill" | "throw";
    actor: string;
    target?: string;
    weapon?: string;
    damage?: number;
    distanceMeters?: number;
    note?: string;
  }[];
  mapSnapshot?: {
    path: { x: number; y: number }[];
    zone?: { x: number; y: number; radius: number };
    kills?: { x: number; y: number }[];
    marks?: { x: number; y: number; kind: "throw" | "opponent"; label: string }[];
    viewSize: number;
    playerLabel?: string;
  };
};

export type RankerLesson = {
  id: string;
  title: string;
  mapId: string;
  mapName: string;
  replayMapName: string;
  mapLabel: string;
  gameMode: string;
  matchId: string;
  nickname: string;
  rank: number;
  rankObservedAt: string;
  playedAt: string;
  kills: number;
  damage: number;
  briefing?: string;
  winSummary?: {
    intro: string;
    milestones: { timeSeconds: number; text: string }[];
    weapons: { name: string; kills: number }[];
    kills: { timeSeconds: number; victim: string; weapon: string; distanceMeters?: number }[];
  };
  teamTotalKills?: number;
  durationSeconds: number;
  replayIdentity: TelemetryPublicIdentity;
  scenes: RankerScene[];
};

// Reviewed, dated examples. Ranks are historical AS API observations, not mode-specific ranks.
export const rankerLessons = [solo, squad] as RankerLesson[];

export function getRankerLesson(id: string | null | undefined) {
  return rankerLessons.find((lesson) => lesson.id === id);
}

export function lessonMatchesReplay(lesson: RankerLesson, request: {
  matchId: string | null;
  nickname: string | null;
  platform: string | null;
  mode: string | null;
  mapName?: string;
}) {
  return request.matchId === lesson.matchId && request.nickname === lesson.nickname &&
    request.platform === lesson.replayIdentity.platform && request.mode === lesson.replayIdentity.mode &&
    (request.mapName === undefined || request.mapName === lesson.mapId || request.mapName === lesson.mapName);
}

export function rankerReplayHref(lesson: RankerLesson, scene = lesson.scenes[0]) {
  const query = new URLSearchParams({
    playback: lesson.matchId,
    nickname: lesson.nickname,
    platform: lesson.replayIdentity.platform,
    mode: lesson.replayIdentity.mode,
    lesson: lesson.id,
    scene: scene.id,
    t: String(scene.startSeconds),
    sidebar: "false",
  });
  return `/maps/${lesson.mapId.toLowerCase()}?${query}`;
}

export function formatLessonTime(seconds: number) {
  return `${Math.floor(seconds / 60).toString().padStart(2, "0")}:${Math.floor(seconds % 60).toString().padStart(2, "0")}`;
}

export function formatLessonDistance(meters: number) {
  return meters < 20 ? Math.round(meters) : Math.round(meters / 5) * 5;
}
