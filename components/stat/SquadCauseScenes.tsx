"use client";

import { useMemo, useState } from "react";
import {
  Activity,
  AlertTriangle,
  ChevronDown,
  ChevronUp,
  CheckCircle2,
  Clock3,
  MapPinned,
  RotateCcw,
  ShieldCheck,
  Target,
  Users
} from "lucide-react";

export type SquadCauseSceneCardData = {
  id: string;
  type: string;
  matchId: string;
  mapName: string;
  mapDisplayName: string;
  timestampMs: number;
  displayTime: string;
  title: string;
  reason: string;
  severity: "good" | "warning" | "danger";
  confidence: "high" | "medium" | "low";
  actors: string[];
  facts: string[];
  metricSnapshot: {
    tradeLatencyMs?: number | null;
    benchmarkTradeLatencyMs?: number;
    deathIsolation?: number;
    minDistanceM?: number;
    smokeUsedWithin15s?: boolean;
    reviveWithin30s?: boolean;
    recoveryEvents?: number;
    affectedTeammates?: number;
    focusEventCount?: number;
    teamWipes?: number;
    isolationDangerThreshold?: number;
    minDistanceDangerMeters?: number;
  };
  replayWindow: {
    startMs: number;
    endMs: number;
  };
};

type SceneFilter = "all" | "danger" | "good";

interface SquadCauseScenesProps {
  scenes: SquadCauseSceneCardData[];
  selectedMatchId?: string;
  onSelectMatch?: (matchId: string, anchorMs: number) => void;
  teamNames?: string[];
}

const severityMeta = {
  danger: {
    label: "위험",
    icon: AlertTriangle,
    card: "border-red-500/20 bg-red-950/10",
    badge: "border-red-500/20 bg-red-500/10 text-red-300",
    iconWrap: "bg-red-500/10 text-red-300"
  },
  warning: {
    label: "주의",
    icon: ShieldCheck,
    card: "border-amber-500/20 bg-amber-950/10",
    badge: "border-amber-500/20 bg-amber-500/10 text-amber-300",
    iconWrap: "bg-amber-500/10 text-amber-300"
  },
  good: {
    label: "회복",
    icon: CheckCircle2,
    card: "border-emerald-500/20 bg-emerald-950/10",
    badge: "border-emerald-500/20 bg-emerald-500/10 text-emerald-300",
    iconWrap: "bg-emerald-500/10 text-emerald-300"
  }
} as const;

const typeLabels: Record<string, string> = {
  late_trade: "백업 지연",
  isolation_death: "고립 위험",
  no_smoke_rescue: "복구 미확인",
  focus_fire_success: "화력 집중",
  team_wipe: "적 스쿼드 전멸 기여",
  revive_save: "연막 소생",
  safe_revive_without_smoke: "연막 없는 소생 성공",
  clutch_recovery: "전력 복구",
  recall_recovery: "리콜/복귀 복구",
  team_collapse: "팀 전원 치명 이벤트"
};

function formatMsToSeconds(ms?: number | null): string | null {
  if (ms === null || ms === undefined || Number.isNaN(ms)) return null;
  return `${(ms / 1000).toFixed(1)}초`;
}

function buildMetricChips(scene: SquadCauseSceneCardData): string[] {
  const metrics = scene.metricSnapshot || {};
  const chips: string[] = [];

  const tradeLatency = formatMsToSeconds(metrics.tradeLatencyMs);
  const benchmarkTradeLatency = formatMsToSeconds(metrics.benchmarkTradeLatencyMs);
  if (tradeLatency) chips.push(`백업 ${tradeLatency}`);
  if (!tradeLatency && benchmarkTradeLatency && scene.type === "late_trade") chips.push(`기준 ${benchmarkTradeLatency}`);
  if (scene.type === "isolation_death") {
    if (typeof metrics.minDistanceM === "number") chips.push(`경기 평균 거리 ${Math.round(metrics.minDistanceM)}m`);
    if (typeof metrics.minDistanceDangerMeters === "number") chips.push(`위험 기준 ${Math.round(metrics.minDistanceDangerMeters)}m`);
    if (typeof metrics.deathIsolation === "number") chips.push(`BGMS 고립지수 ${metrics.deathIsolation.toFixed(2)}`);
  } else {
    if (typeof metrics.deathIsolation === "number") chips.push(`BGMS 고립지수 ${metrics.deathIsolation.toFixed(2)}`);
    if (typeof metrics.minDistanceM === "number") chips.push(`경기 평균 거리 ${Math.round(metrics.minDistanceM)}m`);
  }
  if (metrics.smokeUsedWithin15s === true) chips.push("연막 확인");
  if (metrics.smokeUsedWithin15s === false && scene.type !== "team_wipe") chips.push("연막 미확인");
  if (metrics.reviveWithin30s === true) chips.push("소생 확인");
  if (metrics.reviveWithin30s === false && scene.type !== "team_wipe") chips.push("소생 미확인");
  if (typeof metrics.recoveryEvents === "number") chips.push(`복구 ${metrics.recoveryEvents}건`);
  if (typeof metrics.affectedTeammates === "number") chips.push(`영향 ${metrics.affectedTeammates}명`);
  if (typeof metrics.teamWipes === "number") chips.push(`적 전멸 ${metrics.teamWipes}회`);

  return chips.slice(0, 6);
}

function getCounts(scenes: SquadCauseSceneCardData[]) {
  return {
    all: scenes.length,
    danger: scenes.filter(scene => scene.severity === "danger" || scene.severity === "warning").length,
    good: scenes.filter(scene => scene.severity === "good").length
  };
}

export default function SquadCauseScenes({ scenes, selectedMatchId, onSelectMatch, teamNames }: SquadCauseScenesProps) {
  const [filter, setFilter] = useState<SceneFilter>("all");
  const [mobileExpanded, setMobileExpanded] = useState(false);

  const counts = useMemo(() => getCounts(scenes), [scenes]);
  const filteredScenes = useMemo(() => {
    if (filter === "danger") return scenes.filter(scene => scene.severity === "danger" || scene.severity === "warning");
    if (filter === "good") return scenes.filter(scene => scene.severity === "good");
    return scenes;
  }, [filter, scenes]);

  if (!scenes.length) return null;

  const filters: Array<{ key: SceneFilter; label: string; count: number; icon: typeof Activity }> = [
    { key: "all", label: "전체", count: counts.all, icon: Activity },
    { key: "danger", label: "위험", count: counts.danger, icon: AlertTriangle },
    { key: "good", label: "복구", count: counts.good, icon: CheckCircle2 }
  ];

  return (
    <section data-testid="squad-cause-scenes" className="rounded-xl border border-zinc-800/60 bg-zinc-900/10 p-4 sm:p-5 space-y-4">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div className="flex items-start justify-between gap-3 sm:block">
          <div className="min-w-0">
            <div className="flex items-center gap-2 text-xs font-bold uppercase tracking-[0.2em] text-purple-300">
              <Target className="h-4 w-4 shrink-0" />
              Cause Scenes
            </div>
            <h4 className="mt-1 text-base font-black text-zinc-100">원인 장면 리포트</h4>
            <p className="mt-1 text-xs font-semibold text-zinc-500 sm:hidden">
              전체 {counts.all}개 · 위험 {counts.danger}개 · 복구 {counts.good}개
            </p>
          </div>

          <button
            type="button"
            aria-expanded={mobileExpanded}
            aria-controls="squad-cause-scenes-content"
            onClick={() => setMobileExpanded(prev => !prev)}
            className="inline-flex min-h-9 shrink-0 items-center justify-center gap-1.5 rounded-lg border border-zinc-800 bg-zinc-950/80 px-3 text-xs font-bold text-zinc-300 transition-colors hover:border-purple-500/30 hover:text-purple-200 sm:hidden"
          >
            {mobileExpanded ? "접기" : "펼치기"}
            {mobileExpanded ? <ChevronUp className="h-3.5 w-3.5" /> : <ChevronDown className="h-3.5 w-3.5" />}
          </button>
        </div>

        <div className={`${mobileExpanded ? "grid" : "hidden"} grid-cols-3 gap-1 rounded-lg border border-zinc-800 bg-zinc-950 p-1 sm:grid`}>
          {filters.map(item => {
            const Icon = item.icon;
            const active = filter === item.key;
            return (
              <button
                key={item.key}
                type="button"
                onClick={() => setFilter(item.key)}
                className={`flex min-h-9 items-center justify-center gap-1.5 rounded-md px-2 text-xs font-bold transition-colors ${
                  active ? "bg-purple-600 text-white" : "text-zinc-400 hover:bg-zinc-900 hover:text-zinc-100"
                }`}
              >
                <Icon className="h-3.5 w-3.5 shrink-0" />
                <span>{item.label}</span>
                <span className="text-[10px] opacity-75">{item.count}</span>
              </button>
            );
          })}
        </div>
      </div>

      <div id="squad-cause-scenes-content" className={`${mobileExpanded ? "grid" : "hidden"} grid-cols-1 gap-3 sm:grid xl:grid-cols-2`}>
        {filteredScenes.map(scene => {
          const meta = severityMeta[scene.severity];
          const Icon = meta.icon;
          const metricChips = buildMetricChips(scene);
          const isSelected = selectedMatchId === scene.matchId;

          return (
            <article
              key={scene.id}
              data-testid="squad-cause-scene-card"
              className={`min-w-0 rounded-xl border p-4 shadow-sm ${meta.card}`}
            >
              <div className="flex items-start justify-between gap-3">
                <div className="flex min-w-0 items-start gap-3">
                  <div className={`mt-0.5 rounded-lg p-2 ${meta.iconWrap}`}>
                    <Icon className="h-4 w-4" />
                  </div>
                  <div className="min-w-0">
                    <div className="flex flex-wrap items-center gap-1.5">
                      <span className={`rounded-md border px-2 py-0.5 text-[10px] font-black ${meta.badge}`}>
                        {meta.label}
                      </span>
                      <span className="rounded-md border border-zinc-800 bg-zinc-950/60 px-2 py-0.5 text-[10px] font-bold text-zinc-400">
                        {typeLabels[scene.type] || scene.type}
                      </span>
                    </div>
                    <h5 className="mt-2 break-keep text-sm font-black leading-snug text-zinc-100">
                      {scene.title}
                    </h5>
                  </div>
                </div>

                <div className="shrink-0 text-right text-[10px] font-bold text-zinc-500">
                  <div className="flex items-center justify-end gap-1">
                    <MapPinned className="h-3 w-3" />
                    <span>{scene.mapDisplayName}</span>
                  </div>
                  <div className="mt-1 flex items-center justify-end gap-1">
                    <Clock3 className="h-3 w-3" />
                    <span>{scene.displayTime}</span>
                  </div>
                </div>
              </div>

              <p className="mt-3 break-keep text-xs font-semibold leading-relaxed text-zinc-200">
                {scene.reason}
              </p>

              {scene.actors.length > 0 && (
                <div className="mt-3 flex min-w-0 flex-wrap items-center gap-1.5">
                  <Users className="h-3.5 w-3.5 shrink-0 text-zinc-500" />
                  {scene.actors.slice(0, 4).map(actor => {
                    const normActor = actor.toLowerCase().replace(/[\s\-_]/g, "");
                    const isTeammate = teamNames
                      ? teamNames.some(tName => tName.toLowerCase().replace(/[\s\-_]/g, "") === normActor)
                      : true;
                    return (
                      <span
                        key={`${scene.id}:${actor}`}
                        className={`max-w-full truncate rounded-md border px-2 py-0.5 text-[10px] font-bold ${
                          isTeammate
                            ? "border-purple-500/20 bg-purple-500/5 text-purple-300"
                            : "border-red-500/20 bg-red-500/5 text-red-300"
                        }`}
                      >
                        {isTeammate ? actor : `적: ${actor}`}
                      </span>
                    );
                  })}
                </div>
              )}

              <div className="mt-3 space-y-1.5">
                {scene.facts.slice(0, 5).map(fact => (
                  <div key={`${scene.id}:${fact}`} className="flex gap-2 text-[11px] leading-relaxed text-zinc-300">
                    <span className="mt-1.5 h-1 w-1 shrink-0 rounded-full bg-zinc-500" />
                    <span className="min-w-0 break-keep">{fact}</span>
                  </div>
                ))}
              </div>

              {metricChips.length > 0 && (
                <div className="mt-4 flex flex-wrap gap-1.5">
                  {metricChips.map(chip => (
                    <span
                      key={`${scene.id}:${chip}`}
                      className="rounded-md border border-zinc-800 bg-zinc-950/70 px-2 py-1 text-[10px] font-bold text-zinc-300"
                    >
                      {chip}
                    </span>
                  ))}
                </div>
              )}

              <div className="mt-4 flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
                <span className="text-[10px] font-bold text-zinc-500">
                  신뢰도 {scene.confidence === "high" ? "높음" : scene.confidence === "medium" ? "중간" : "낮음"}
                </span>
                {onSelectMatch && (
                  <button
                    type="button"
                    data-testid="squad-cause-scene-map-button"
                    onClick={() => onSelectMatch(scene.matchId, scene.timestampMs)}
                    className={`inline-flex min-h-9 items-center justify-center gap-1.5 rounded-lg border px-3 text-xs font-bold transition-colors ${
                      isSelected
                        ? "border-purple-500/30 bg-purple-500/15 text-purple-200"
                        : "border-zinc-800 bg-zinc-950/70 text-zinc-300 hover:border-purple-500/30 hover:text-purple-200"
                    }`}
                  >
                    <RotateCcw className="h-3.5 w-3.5" />
                    2D 맵에서 보기
                  </button>
                )}
              </div>
            </article>
          );
        })}
      </div>
    </section>
  );
}
