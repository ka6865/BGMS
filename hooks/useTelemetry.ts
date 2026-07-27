// BGMS Refreshed V2
import { useState, useEffect, useRef, useCallback } from "react";
import { fetchTelemetryPayload } from "../lib/pubg-analysis/fetchTelemetryPayload";
import type { TelemetryMode, TelemetryPlatform } from "../lib/pubg-analysis/telemetryIdentity";

export interface TelemetryEvent {
  type: "position" | "enemy_position" | "ride" | "leave" | "kill" | "groggy" | "took_damage" | "shot" | "revive" | "create" | "throw" | "throw_explode" | "grenade" | "smoke" | "damage";
  time: string;
  name?: string;
  accountId?: string;
  x: number;
  y: number;
  z?: number;
  vX?: number; 
  vY?: number; 
  vehicle?: string;
  vehicleId?: string; // 🎯 실시간 차량 동기화 보정을 위한 차량 ID 필드 추가
  attacker?: string;
  victim?: string;
  detail?: string;
  weapon?: string;    
  distance?: number | null; 
  victimX?: number; 
  victimY?: number; 
  teamId?: number;
  health?: number;
  character?: { accountId?: string };
  attackerTeamId?: number;
  victimTeamId?: number;
  isTeamAttacker?: boolean;
  isTeamVictim?: boolean;
  relativeTimeMs: number;  
  assistants?: string[];
  isSystem?: boolean;
}

export interface PlayerState {
  name: string;
  accountId?: string; // 🎯 계정 ID 필드 추가
  x: number;
  y: number;
  isDead: boolean;
  isGroggy: boolean;
  isInVehicle: boolean;
  isEnemy?: boolean;
  teamId?: number;
  health: number;
  kills: number;
  assists?: number;
  color?: string;
  vehicleId?: string;
  lastUpdateMs?: number;
  lastDeathMs?: number;
  deathX?: number; 
  deathY?: number; 
}

const TEAM_COLORS = [
  "#F2A900", "#34A853", "#3b82f6", "#ef4444", "#a855f7", "#ec4899", "#06b6d4", "#8b5cf6",
  "#f97316", "#10b981", "#3b82f6", "#f43f5e", "#fbbf24", "#22c55e", "#6366f1", "#d946ef"
];

const UNKNOWN_ENEMY_TEAM_ID = 0;

function normalizePlayerName(name: string): string {
  return name.trim().toLowerCase();
}

function resolveEventTeamId(ev: TelemetryEvent, rawName: string, isEnemy: boolean): number | undefined {
  const normalizedRawName = normalizePlayerName(rawName);
  const eventName = typeof ev.name === "string" ? normalizePlayerName(ev.name) : "";
  const attackerName = typeof ev.attacker === "string" ? normalizePlayerName(ev.attacker) : "";
  const victimName = typeof ev.victim === "string" ? normalizePlayerName(ev.victim) : "";

  if (eventName === normalizedRawName) return ev.teamId;
  if (attackerName === normalizedRawName) {
    if (ev.attackerTeamId != null) return ev.attackerTeamId;
    return ev.isTeamAttacker ? ev.teamId : undefined;
  }
  if (victimName === normalizedRawName) {
    if (ev.victimTeamId != null) return ev.victimTeamId;
    return ev.isTeamVictim ? ev.teamId : undefined;
  }

  return isEnemy ? undefined : ev.teamId;
}

export function useTelemetry(
  matchId: string | null,
  nickname: string | null,
  playbackPlatform: TelemetryPlatform | null,
  playbackMode: TelemetryMode | null,
  mapName: string,
) {
  const [events, setEvents] = useState<TelemetryEvent[]>([]);
  const [teammates, setTeammates] = useState<string[]>([]);
  const [teamNames, setTeamNames] = useState<string[]>([]); 
  const [zoneEvents, setZoneEvents] = useState<any[]>([]); 
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [isPlaying, setIsPlaying] = useState(false);
  const [playbackSpeed, setPlaybackSpeed] = useState(1);
  const [currentTimeMs, setCurrentTimeMs] = useState(0); 
  const [maxTimeMs, setMaxTimeMs] = useState(0);
  const [isFullMode, setIsFullMode] = useState(false);
  const teamColorMapRef = useRef<Record<number, string>>({});
  const lastUpdateRef = useRef<number>(0);
  const timerRef = useRef<number | null>(null);
  const statesRef = useRef<Record<string, PlayerState>>({});
  const lastProcessedTimeRef = useRef<number>(-1);
  const lastEventIndexRef = useRef<number>(0);
  const historyPosRef = useRef<Record<string, { x: number, y: number, time: number, health: number }>>({});
  const futurePosRef = useRef<Record<string, { x: number, y: number, time: number, health: number } | null>>({});
  const [currentStates, setCurrentStates] = useState<Record<string, PlayerState>>({});

  const resetTelemetryState = useCallback(() => {
    if (timerRef.current !== null) cancelAnimationFrame(timerRef.current);
    timerRef.current = null;
    setEvents([]);
    setTeammates([]);
    setTeamNames([]);
    setZoneEvents([]);
    setLoading(false);
    setError(null);
    setIsPlaying(false);
    setCurrentTimeMs(0);
    setMaxTimeMs(0);
    setIsFullMode(false);
    setCurrentStates({});
    teamColorMapRef.current = {};
    statesRef.current = {};
    lastProcessedTimeRef.current = -1;
    lastEventIndexRef.current = 0;
    historyPosRef.current = {};
    futurePosRef.current = {};
  }, []);

  const fetchTelemetry = useCallback(async (
    full: boolean = false,
    controller: AbortController,
  ) => {
    resetTelemetryState();
    if (!matchId || !nickname || !playbackPlatform || !playbackMode || !mapName) return;
    setLoading(true);
    try {
      const data = await fetchTelemetryPayload({
        matchId,
        nickname,
        platform: playbackPlatform,
        mapName,
        mode: full ? "full" : playbackMode,
      }, { signal: controller.signal });
      if (controller.signal.aborted) return;

      const evs = data.events as TelemetryEvent[];
      setEvents(evs);
      setTeammates(data.teammates || []);
      setTeamNames(data.teamNames || []);
      setZoneEvents(data.zoneEvents || []);
      setIsFullMode(full);

      const teamColorMap: Record<number, string> = {};
      let colorIdx = 0;
      evs.forEach((ev: any) => {
        if (ev.teamId != null && !teamColorMap[ev.teamId]) {
          if ((data.teammates || []).includes(ev.accountId) || (data.teamNames || []).includes(ev.name)) {
             teamColorMap[ev.teamId] = "#F2A900"; 
          } else {
             teamColorMap[ev.teamId] = TEAM_COLORS[colorIdx % TEAM_COLORS.length];
             colorIdx++;
          }
        }
      });
      teamColorMapRef.current = teamColorMap;

      if (evs.length > 0) {
        // 배열이 완벽히 정렬되지 않았을 수 있으므로 reduce로 안전하게 최대값 탐색
        const maxMs = evs.reduce((max: number, e: any) => Math.max(max, e.relativeTimeMs || 0), 0);
        setMaxTimeMs(maxMs);
      } else {
        setMaxTimeMs(0);
      }
    } catch (error: unknown) {
      if (controller.signal.aborted) return;
      setError(error instanceof Error ? error.message : "텔레메트리 요청에 실패했습니다.");
    } finally {
      if (!controller.signal.aborted) setLoading(false);
    }
  }, [matchId, nickname, playbackPlatform, playbackMode, mapName, resetTelemetryState]);

  useEffect(() => {
    const controller = new AbortController();
    void fetchTelemetry(playbackMode === "full", controller);
    return () => controller.abort();
  }, [fetchTelemetry, playbackMode]);

  // 🎯 React 19 대응: 마운트 시점에 안전하게 초기값 할당 (Purity 보장)
  useEffect(() => {
    lastUpdateRef.current = Date.now();
  }, []);

  useEffect(() => {
    if (!isPlaying) {
      if (timerRef.current) cancelAnimationFrame(timerRef.current);
      return;
    }
    lastUpdateRef.current = Date.now();
    const loop = () => {
      const now = Date.now();
      const deltaMs = now - lastUpdateRef.current;
      lastUpdateRef.current = now;
      setCurrentTimeMs((prev) => {
        const nextTime = Math.min(prev + deltaMs * playbackSpeed, maxTimeMs);
        if (nextTime >= maxTimeMs) setIsPlaying(false);
        return nextTime;
      });
      timerRef.current = requestAnimationFrame(loop);
    };
    timerRef.current = requestAnimationFrame(loop);
    return () => { if (timerRef.current) cancelAnimationFrame(timerRef.current); };
  }, [isPlaying, playbackSpeed, maxTimeMs]);

  useEffect(() => {
    if (events.length === 0) {
      setCurrentStates({});
      return;
    }

    const isJump = Math.abs(currentTimeMs - lastProcessedTimeRef.current) > 2000 || currentTimeMs < lastProcessedTimeRef.current;
    
    if (isJump) {
      statesRef.current = {};
      teamNames.forEach(name => {
        const pname = normalizePlayerName(name);
        statesRef.current[pname] = {
          name, x: -9999, y: -9999, isDead: false, isGroggy: false, isInVehicle: false, health: 100, kills: 0, assists: 0, isEnemy: false
        };
      });
      lastEventIndexRef.current = 0;
      historyPosRef.current = {};
      futurePosRef.current = {};
    }

    const states = statesRef.current;
    const evs = events as any[];
    let i = lastEventIndexRef.current;

    while (i < evs.length && evs[i].relativeTimeMs <= currentTimeMs) {
      const ev = evs[i];
      const involved = new Set<string>();
      if (typeof ev.name === "string") involved.add(ev.name);
      if (typeof ev.victim === "string") involved.add(ev.victim);
      if (typeof ev.attacker === "string") involved.add(ev.attacker);
      if (Array.isArray(ev.assistants)) {
        ev.assistants.forEach((a: any) => {
          const aName = typeof a === "string" ? a : a.name;
          if (typeof aName === "string") involved.add(aName);
        });
      }

      involved.forEach(rawName => {
        if (typeof rawName !== "string") return;
        const pname = normalizePlayerName(rawName);
        if (!pname) return;
        
        if (!states[pname] && !ev.isSystem) {
          const isEnemy = !teamNames.map(t => normalizePlayerName(t)).includes(pname);
          const teamId = resolveEventTeamId(ev, rawName, isEnemy);
          states[pname] = { 
            name: rawName, 
            accountId: ev.character?.accountId || ev.accountId,
            x: -9999, y: -9999, isDead: false, isGroggy: false, isInVehicle: false, 
            health: 100, kills: 0, assists: 0, teamId: teamId ?? (isEnemy ? UNKNOWN_ENEMY_TEAM_ID : 999),
            color: isEnemy ? (teamColorMapRef.current[teamId ?? UNKNOWN_ENEMY_TEAM_ID] || "#ffffff") : "#F2A900",
            isEnemy: isEnemy
          };
        }
        const s = states[pname];
        if (!s) return;
        if (ev.type === "position" && ev.name === rawName) {
          s.x = ev.x; s.y = ev.y; s.health = ev.health ?? s.health; s.lastUpdateMs = ev.relativeTimeMs;
          historyPosRef.current[pname] = { x: ev.x, y: ev.y, time: ev.relativeTimeMs, health: s.health };
          futurePosRef.current[pname] = null;

          // 🎯 차량 동승 유령 버그 해결: LogPlayerPosition 이벤트의 vehicleId 존재 여부에 맞춰 실시간 상태 보정
          if (ev.vehicleId) {
            s.isInVehicle = true;
            s.vehicleId = ev.vehicleId;
          } else {
            s.isInVehicle = false;
            s.vehicleId = undefined;
          }
        } else if (ev.type === "ride" && ev.name === rawName) {
          s.isInVehicle = true; s.vehicleId = ev.vehicle;
        } else if (ev.type === "leave" && ev.name === rawName) {
          s.isInVehicle = false; s.vehicleId = undefined;
        } else if (ev.type === "kill" || ev.type === "groggy") {
          if (ev.victim === rawName) {
            if (ev.type === "kill") {
              s.isDead = true; s.isGroggy = false; s.health = 0; s.lastDeathMs = ev.relativeTimeMs; 
              s.deathX = ev.victimX || s.x || 0; s.deathY = ev.victimY || s.y || 0;
            } else {
              s.isGroggy = true; s.isDead = false; s.health = 0;
            }
          }
          if (ev.attacker === rawName) {
            if (ev.type === "kill") s.kills = (s.kills || 0) + 1;
          }
          if (ev.assistants && Array.isArray(ev.assistants)) {
            const isAsst = ev.assistants.some((a: any) => {
              if (typeof a === "string") return a.trim().toLowerCase() === pname;
              const aName = (a.name || "").trim().toLowerCase();
              const aId = a.accountId || a.playerId;
              return aName === pname || (aId && aId === s.accountId);
            });
            if (isAsst) s.assists = (s.assists || 0) + 1;
          }
        } else if ((ev.type === "revive" || ev.type === "create") && (ev.victim === rawName || ev.name === rawName)) {
          s.isGroggy = false; s.isDead = false; if (ev.type === "revive") s.health = 10;
        }
      });
      i++;
    }

    lastEventIndexRef.current = i;
    lastProcessedTimeRef.current = currentTimeMs;

    const interpolatedStates: Record<string, PlayerState> = {};
    for (const pname in states) {
      const s = { ...states[pname] };
      if (!s.isDead) {
        if (!futurePosRef.current[pname]) {
          for (let j = i; j < evs.length; j++) {
            const nextEv = evs[j];
            if (nextEv.type === "position" && (nextEv.name || "").trim().toLowerCase() === pname) {
              futurePosRef.current[pname] = { x: nextEv.x, y: nextEv.y, time: nextEv.relativeTimeMs, health: nextEv.health || 100 };
              break;
            }
          }
        }
        const p = historyPosRef.current[pname];
        const n = futurePosRef.current[pname];
        if (p && n && p.time < n.time && p.time <= currentTimeMs && n.time > currentTimeMs) {
          const ratio = (currentTimeMs - p.time) / (n.time - p.time);
          s.x = p.x + (n.x - p.x) * ratio;
          s.y = p.y + (n.y - p.y) * ratio;
          s.health = p.health + (n.health - p.health) * ratio;
        }
      }
      interpolatedStates[pname] = s;
    }

    setCurrentStates(interpolatedStates);
  }, [currentTimeMs, events, teamNames, nickname, teammates]);

  return {
    events,
    teammates,
    teamNames,
    zoneEvents,
    loading,
    error,
    isPlaying,
    setIsPlaying,
    playbackSpeed,
    setPlaybackSpeed,
    currentTimeMs,
    setCurrentTimeMs,
    maxTimeMs,
    currentStates,
    isFullMode,
  };
}
