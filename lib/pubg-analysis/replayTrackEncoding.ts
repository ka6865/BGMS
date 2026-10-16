// 리플레이 페이로드 저장 형식(encoding v1).
// 좌표 이벤트는 선수별 열 배열(track)로 묶고, events 배열의 원래 자리에는 track 번호만 남겨
// 순서까지 그대로 복원한다. time은 timeBaseMs + relativeTimeMs와 같을 때만 생략한다.
// 규칙에 맞지 않는 좌표는 일반 이벤트로 남겨 디코딩 결과가 원본과 같도록 한다.

export const REPLAY_TRACK_ENCODING_VERSION = 1;

const POSITION_KEYS = new Set([
  "type", "time", "relativeTimeMs", "name", "teamId", "isTeam", "x", "y", "z", "health", "vehicleId",
]);

export type ReplayTrack = {
  name: string;
  teamId: number;
  isTeam: boolean;
  t: number[];
  x: number[];
  y: number[];
  z: number[];
  hp: number[];
  veh: (string | null)[];
};

export type EncodedReplayEvents = {
  encoding: { version: number; timeBaseMs: number };
  events: unknown[];
  tracks: ReplayTrack[];
};

type EventRecord = Record<string, unknown>;

const isRecord = (value: unknown): value is EventRecord =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const isFiniteNumber = (value: unknown): value is number =>
  typeof value === "number" && Number.isFinite(value);

const isoAt = (timeBaseMs: number, relativeTimeMs: number): string =>
  new Date(timeBaseMs + relativeTimeMs).toISOString();

function isDerivableTime(event: EventRecord, timeBaseMs: number): boolean {
  return Number.isInteger(event.relativeTimeMs)
    && event.time === isoAt(timeBaseMs, event.relativeTimeMs as number);
}

function isTrackablePosition(event: EventRecord, timeBaseMs: number): boolean {
  const keys = Object.keys(event);
  return event.type === "position"
    && keys.length === POSITION_KEYS.size
    && keys.every((key) => POSITION_KEYS.has(key))
    && isDerivableTime(event, timeBaseMs)
    && typeof event.name === "string"
    && isFiniteNumber(event.teamId)
    && typeof event.isTeam === "boolean"
    && isFiniteNumber(event.x)
    && isFiniteNumber(event.y)
    && isFiniteNumber(event.z)
    && isFiniteNumber(event.health)
    && (typeof event.vehicleId === "string" || event.vehicleId === null);
}

function findTimeBaseMs(events: readonly EventRecord[]): number | null {
  for (const event of events) {
    if (!Number.isInteger(event.relativeTimeMs) || typeof event.time !== "string") continue;
    const timeMs = Date.parse(event.time);
    if (Number.isFinite(timeMs)) return timeMs - (event.relativeTimeMs as number);
  }
  return null;
}

/** 원본과 같게 복원할 수 없는 입력이면 null을 반환하고, 호출자는 기존 형식으로 저장한다. */
export function encodeReplayEvents(events: readonly unknown[]): EncodedReplayEvents | null {
  // time이 없는 이벤트는 디코딩 때 time이 생겨 원본과 달라지므로 압축하지 않는다.
  if (!events.every((event) => isRecord(event) && typeof event.time === "string")) return null;
  const records = events as readonly EventRecord[];
  const timeBaseMs = findTimeBaseMs(records);
  if (timeBaseMs === null) return null;

  const tracks: ReplayTrack[] = [];
  const trackIndexByKey = new Map<string, number>();
  const encodedEvents = records.map((event): unknown => {
    if (isTrackablePosition(event, timeBaseMs)) {
      const key = JSON.stringify([event.name, event.teamId, event.isTeam]);
      let index = trackIndexByKey.get(key);
      if (index === undefined) {
        index = tracks.length;
        trackIndexByKey.set(key, index);
        tracks.push({
          name: event.name as string, teamId: event.teamId as number, isTeam: event.isTeam as boolean,
          t: [], x: [], y: [], z: [], hp: [], veh: [],
        });
      }
      const track = tracks[index];
      track.t.push(event.relativeTimeMs as number);
      track.x.push(event.x as number);
      track.y.push(event.y as number);
      track.z.push(event.z as number);
      track.hp.push(event.health as number);
      track.veh.push(event.vehicleId as string | null);
      return index;
    }
    if (!isDerivableTime(event, timeBaseMs)) return event;
    const rest = { ...event };
    delete rest.time;
    return rest;
  });

  return {
    encoding: { version: REPLAY_TRACK_ENCODING_VERSION, timeBaseMs },
    events: encodedEvents,
    tracks,
  };
}

function parseTrack(value: unknown): ReplayTrack {
  if (!isRecord(value) || typeof value.name !== "string" || !isFiniteNumber(value.teamId) || typeof value.isTeam !== "boolean") {
    throw new Error("유효하지 않은 telemetry track입니다.");
  }
  const columns = [value.t, value.x, value.y, value.z, value.hp, value.veh];
  if (!columns.every(Array.isArray)) throw new Error("유효하지 않은 telemetry track입니다.");
  const [t, x, y, z, hp, veh] = columns as unknown[][];
  const length = t.length;
  if (!columns.every((column) => (column as unknown[]).length === length)
    || !t.every((item) => Number.isInteger(item))
    || ![x, y, z, hp].every((column) => column.every(isFiniteNumber))
    || !veh.every((item) => typeof item === "string" || item === null)) {
    throw new Error("유효하지 않은 telemetry track입니다.");
  }
  return {
    name: value.name, teamId: value.teamId, isTeam: value.isTeam,
    t: t as number[], x: x as number[], y: y as number[], z: z as number[], hp: hp as number[], veh: veh as (string | null)[],
  };
}

export function decodeReplayEvents(encoding: unknown, events: unknown, tracks: unknown): unknown[] {
  if (!isRecord(encoding) || encoding.version !== REPLAY_TRACK_ENCODING_VERSION || !isFiniteNumber(encoding.timeBaseMs)) {
    throw new Error("지원하지 않는 telemetry encoding입니다.");
  }
  if (!Array.isArray(events) || !Array.isArray(tracks)) throw new Error("유효하지 않은 telemetry events입니다.");
  const timeBaseMs = encoding.timeBaseMs;
  const parsedTracks = tracks.map(parseTrack);
  const cursors = parsedTracks.map(() => 0);

  const decoded = events.map((item): unknown => {
    if (typeof item === "number") {
      const track = Number.isInteger(item) ? parsedTracks[item] : undefined;
      if (!track || cursors[item] >= track.t.length) throw new Error("유효하지 않은 telemetry track 참조입니다.");
      const i = cursors[item]++;
      return {
        type: "position",
        time: isoAt(timeBaseMs, track.t[i]),
        relativeTimeMs: track.t[i],
        name: track.name,
        teamId: track.teamId,
        isTeam: track.isTeam,
        x: track.x[i],
        y: track.y[i],
        z: track.z[i],
        health: track.hp[i],
        vehicleId: track.veh[i],
      };
    }
    if (!isRecord(item)) throw new Error("유효하지 않은 telemetry event입니다.");
    if ("time" in item || !Number.isInteger(item.relativeTimeMs)) return item;
    const time = isoAt(timeBaseMs, item.relativeTimeMs as number);
    const { type, ...rest } = item;
    return "type" in item ? { type, time, ...rest } : { time, ...rest };
  });

  if (cursors.some((cursor, index) => cursor !== parsedTracks[index].t.length)) {
    throw new Error("telemetry track 길이가 events 참조와 일치하지 않습니다.");
  }
  return decoded;
}
