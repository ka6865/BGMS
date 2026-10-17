// 경기 상세의 "경기 흐름"과 "경기 전체" 섹션에 쓰는 판정 묶음.
// 분석 엔진의 이벤트 패스를 그대로 관찰하며, 라이트 모드의 전멸 후 컷오프와 무관하게 모든 이벤트를 본다.
// 거리는 텔레메트리 좌표(cm)를 m로 바꿔 계산하고, 판정 기준은 docs/operations/2026-10-17-match-report.md에 적는다.
import { classifyDamageCause, isCombatDamageCause, type ReplayDamageCause } from "./replayEventKinds";
import { FIGHT_GAP_MS } from "@/lib/replay/replayEngagements";
import { normalizeName } from "./utils";

export const MATCH_REPORT_VERSION = 2;

/** 사망 직전 이 시간 안에 우리 팀과 싸운 적 팀이 둘 이상이면 써드파티로 본다. */
export const THIRD_PARTY_WINDOW_MS = 60_000;
/** 마지막 교전이 시작되기 전 이 시간 동안의 이동 거리로 이동 중이었는지 본다. */
export const ROTATION_WINDOW_MS = 30_000;
export const ROTATION_MIN_DISTANCE_M = 150;
/** 상대가 먼저 쐈고 우리 팀이 킬러 팀에 준 피해가 이 값보다 작으면 기습으로 본다. */
export const AMBUSH_MAX_DEALT = 100;
/** 사망 순간 가장 가까운 생존 팀원이 이보다 멀면 고립으로 본다. */
export const ISOLATION_MIN_DISTANCE_M = 100;
export const LANDING_NEAR_M = 300;
export const LANDING_FAR_M = 600;
const MAX_FIGHTS = 20;
const MAX_OPPONENT_NAMES = 6;
const MAX_DAMAGE_SOURCES = 8;
const MAX_DAMAGE_HITS = 60;
const TEAMMATE_POSITION_MAX_AGE_MS = 30_000;

export type MatchFightOutcome = "won" | "traded" | "lost" | "brokeOff";

export type MatchFight = {
  startMs: number;
  endMs: number;
  opponentTeamIds: number[];
  opponents: string[];
  dealt: number;
  taken: number;
  enemyDowns: number;
  teamDowns: number;
  openedBy: "us" | "them";
  outcome: MatchFightOutcome;
};

export type MatchDeathType =
  | "zone"
  | "bledOut"
  | "thirdParty"
  | "rotating"
  | "ambushed"
  | "isolated"
  | "outfought"
  | "other";

export type MatchDeath = {
  timeMs: number;
  phase: number;
  type: MatchDeathType;
  killer: string | null;
  killerTeamId: number | null;
  killerIsBot: boolean;
  weapon: string | null;
  cause: ReplayDamageCause;
  distanceM: number | null;
  knockedAtMs: number | null;
  teamsInLastMinute: number;
  movedBeforeFightM: number | null;
  inVehicle: boolean;
  nearestTeammateM: number | null;
  openedBy: "us" | "them" | null;
};

export type MatchCircleStatus = {
  index: number;
  phase: number;
  timeMs: number;
  status: "inside" | "outside";
  outsideByM: number | null;
};

export type MatchHealReport = {
  damageTaken: number;
  healthRestored: number;
  heals: number;
  boosts: number;
  midFightHeals: number;
};

export type MatchLandingReport = {
  timeMs: number;
  enemiesNear: number;
  enemiesFar: number;
  teamsNear: number;
};

export type MatchKill = {
  timeMs: number;
  killer: string | null;
  killerTeamId: number | null;
  victim: string;
  victimTeamId: number | null;
  victimIsBot: boolean;
  weapon: string | null;
  cause: ReplayDamageCause;
  /** 기절한 채 출혈·팀 전멸로 사망. 처치자는 기절시킨 선수로 기록된다. */
  diedKnocked?: boolean;
};

export type MatchTeamRow = {
  teamId: number;
  rank: number;
  kills: number;
  damage: number;
  players: { name: string; kills: number; damage: number; isBot: boolean }[];
  isMine: boolean;
};

export type MatchCarePackage = {
  timeMs: number;
  phase: number;
  kind: "redBox" | "blueChip" | "small" | "flare" | "other";
};

export type MatchVersusCounts = { kills: number; knocks: number; damage: number };

/** 내가 사람과 봇에게 각각 낸 처치·기절·피해. */
export type MatchVersusSplit = { human: MatchVersusCounts; bot: MatchVersusCounts };

export type MatchDamageSource = {
  /** 공격자 이름. 자기장·낙하처럼 공격자가 없으면 null. */
  attacker: string | null;
  attackerTeamId: number | null;
  isBot: boolean;
  cause: ReplayDamageCause;
  /** 가장 많이 맞은 무기 클래스 이름. */
  weapon: string | null;
  damage: number;
  hits: number;
};

export type MatchDamageHit = {
  timeMs: number;
  attacker: string | null;
  isBot: boolean;
  cause: ReplayDamageCause;
  weapon: string | null;
  /** damageReason(HeadShot·TorsoShot 등). 부위가 없으면 null. */
  part: string | null;
  damage: number;
};

export type MatchMyKill = {
  timeMs: number;
  victim: string;
  victimTeamId: number | null;
  victimIsBot: boolean;
  /** 상대 최종 순위(팀 순위). */
  victimRank: number | null;
  /** 상대가 들고 있던 무기 클래스 이름. */
  victimWeapon: string | null;
  weapon: string | null;
  part: string | null;
  distanceM: number | null;
  throughWall: boolean;
  /** 그 상대를 기절시킨 쪽. 기절 없이 바로 처치했으면 null. */
  knockedBy: "me" | "team" | "other" | null;
};

export type MatchReport = {
  version: number;
  landing: MatchLandingReport | null;
  fights: MatchFight[];
  death: MatchDeath | null;
  circles: MatchCircleStatus[];
  heal: MatchHealReport;
  kills: MatchKill[];
  teams: MatchTeamRow[];
  carePackages: MatchCarePackage[];
  bots: string[];
  /** 버전 2부터 있다. */
  versus?: MatchVersusSplit;
  damageTaken?: { sources: MatchDamageSource[]; hits: MatchDamageHit[] };
  myKills?: MatchMyKill[];
};

type Actor = Record<string, any> | null | undefined;
type Point = { t: number; x: number; y: number; inVehicle: boolean };
type Engagement = {
  t: number;
  enemyTeamId: number;
  enemyName: string;
  byUs: boolean;
  amount: number;
  enemyDown: string | null;
  teamDown: string | null;
};

/** 분석 엔진이 넘겨주는 우리 팀 식별 정보. buildMappings 이후 값을 읽는다. */
export type MatchReportIdentity = {
  lowerNickname: string;
  myAccountId: string;
  teamNames: ReadonlySet<string>;
  teamAccountIds: ReadonlySet<string>;
};

const finite = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value);
const round = (value: number) => Math.round(value);
const distanceM = (a: { x: number; y: number }, b: { x: number; y: number }) => Math.hypot(a.x - b.x, a.y - b.y) / 100;
const actorName = (actor: Actor) => normalizeName(typeof actor?.name === "string" ? actor.name : "");
const displayName = (actor: Actor) => (typeof actor?.name === "string" ? actor.name.trim() : "");
const actorTeam = (actor: Actor): number | null => (finite(actor?.teamId) ? actor!.teamId : null);
const isBotActor = (actor: Actor) => typeof actor?.accountId === "string" && actor.accountId.startsWith("ai.");
const causerName = (value: unknown): string | null => (typeof value === "string" && value && value !== "None" ? value : null);
/** victimWeapon은 WeapACE32_C_9처럼 인스턴스 번호가 붙으므로 클래스 이름만 남긴다. */
const weaponClass = (value: unknown): string | null => {
  const name = causerName(value);
  return name ? name.replace(/_C_\d+$/, "_C") : null;
};
const bodyPart = (value: unknown): string | null => (typeof value === "string" && value.endsWith("Shot") ? value : null);
const emptyCounts = (): MatchVersusCounts => ({ kills: 0, knocks: 0, damage: 0 });
const phaseOf = (event: Record<string, any>) => {
  const raw = event.common?.isGame ?? event.Common?.IsGame;
  return finite(raw) ? Math.max(0, Math.floor(raw)) : 0;
};

function carePackageKind(id: unknown): MatchCarePackage["kind"] {
  const value = typeof id === "string" ? id.toLowerCase() : "";
  if (value.includes("flare")) return "flare";
  if (value.includes("bluechip")) return "blueChip";
  if (value.includes("smallpackage")) return "small";
  if (value.includes("redbox")) return "redBox";
  return "other";
}

export class MatchReportCollector {
  private startTime: number | null = null;
  private readonly landings: { name: string; teamId: number | null; x: number; y: number; t: number }[] = [];
  private myLanding: { x: number; y: number; t: number } | null = null;
  private readonly engagements: Engagement[] = [];
  private readonly myTrack: Point[] = [];
  private readonly teamLast = new Map<string, Point>();
  private readonly teamDead = new Set<string>();
  private readonly knockedAt = new Map<string, number>();
  private readonly kills: MatchKill[] = [];
  private readonly carePackages: MatchCarePackage[] = [];
  private readonly circles: MatchCircleStatus[] = [];
  private lastWarningRadius: number | null = null;
  private myAlive = true;
  private myLastDeath: { event: Record<string, any>; t: number } | null = null;
  private readonly healthTrace: { t: number; health: number }[] = [];
  private readonly reviveTimes: number[] = [];
  private readonly healUses: number[] = [];
  private boosts = 0;
  private readonly versus: MatchVersusSplit = { human: emptyCounts(), bot: emptyCounts() };
  private readonly takenHits: MatchDamageHit[] = [];
  private readonly takenSources = new Map<string, MatchDamageSource & { weapons: Map<string, number> }>();
  private readonly myKills: (Omit<MatchMyKill, "victimRank"> & { victimKey: string })[] = [];
  private readonly knockers = new Map<string, "me" | "team" | "other">();
  private damageTaken = 0;

  constructor(private readonly identity: MatchReportIdentity) {}

  private isMe(actor: Actor): boolean {
    if (!actor) return false;
    if (typeof actor.accountId === "string" && actor.accountId === this.identity.myAccountId) return true;
    return actorName(actor) === this.identity.lowerNickname;
  }

  private isTeam(actor: Actor): boolean {
    if (!actor) return false;
    if (typeof actor.accountId === "string" && this.identity.teamAccountIds.has(actor.accountId)) return true;
    const name = actorName(actor);
    return name.length > 0 && this.identity.teamNames.has(name);
  }

  private rel(ts: number) {
    return this.startTime === null ? 0 : ts - this.startTime;
  }

  observe(event: Record<string, any>, ts: number): void {
    if (!Number.isFinite(ts)) return;
    switch (event._T) {
      case "LogMatchStart":
        this.startTime = ts;
        return;
      case "LogParachuteLanding":
        this.observeLanding(event, ts);
        return;
      case "LogPlayerPosition":
        this.observePosition(event, ts);
        return;
      case "LogGameStatePeriodic":
        this.observeGameState(event, ts);
        return;
      case "LogPlayerTakeDamage":
        this.observeDamage(event, ts);
        return;
      case "LogPlayerMakeGroggy":
        this.observeGroggy(event, ts);
        return;
      case "LogPlayerKillV2":
        this.observeKill(event, ts);
        return;
      case "LogPlayerRevive":
        if (this.isMe(event.victim)) this.reviveTimes.push(this.rel(ts));
        if (this.isTeam(event.victim)) this.knockedAt.delete(actorName(event.victim));
        return;
      case "LogPlayerRecall":
      case "LogPlayerRedeploy":
      case "LogPlayerRedeployBRStart":
        this.observeRecall(event);
        return;
      case "LogHeal":
        if (this.isMe(event.character) && this.myAlive && finite(event.character?.health)) {
          this.healthTrace.push({ t: this.rel(ts), health: event.character.health });
        }
        return;
      case "LogItemUse":
        this.observeItemUse(event, ts);
        return;
      case "LogCarePackageLand":
        this.carePackages.push({ timeMs: this.rel(ts), phase: phaseOf(event), kind: carePackageKind(event.itemPackage?.itemPackageId) });
        return;
      default:
        return;
    }
  }

  private observeLanding(event: Record<string, any>, ts: number) {
    const actor = event.character;
    const location = actor?.location;
    if (!finite(location?.x) || !finite(location?.y)) return;
    const name = actorName(actor);
    // 재배치 뒤의 두 번째 낙하는 착지 판정에 쓰지 않는다.
    if (this.landings.some((landing) => landing.name === name)) return;
    const point = { name, teamId: actorTeam(actor), x: location.x, y: location.y, t: this.rel(ts) };
    this.landings.push(point);
    if (this.isMe(actor) && !this.myLanding) this.myLanding = point;
  }

  private observePosition(event: Record<string, any>, ts: number) {
    const actor = event.character;
    if (!this.isTeam(actor)) return;
    const location = actor.location;
    if (!finite(location?.x) || !finite(location?.y)) return;
    const point = { t: this.rel(ts), x: location.x, y: location.y, inVehicle: actor.isInVehicle === true };
    this.teamLast.set(actorName(actor), point);
    if (this.isMe(actor) && this.myAlive) {
      this.myTrack.push(point);
      if (finite(actor.health)) this.healthTrace.push({ t: point.t, health: actor.health });
    }
  }

  private observeGameState(event: Record<string, any>, ts: number) {
    const state = event.gameState;
    const radius = state?.poisonGasWarningRadius;
    const center = state?.poisonGasWarningPosition;
    if (!finite(radius) || radius <= 0 || !finite(center?.x) || !finite(center?.y)) return;
    if (this.lastWarningRadius !== null && Math.abs(radius - this.lastWarningRadius) < 1) return;
    this.lastWarningRadius = radius;
    if (!this.myAlive) return;
    const me = this.myTrack[this.myTrack.length - 1];
    if (!me) return;
    const gap = distanceM(me, center) - radius / 100;
    this.circles.push({
      index: this.circles.length + 1,
      phase: phaseOf(event),
      timeMs: this.rel(ts),
      status: gap <= 0 ? "inside" : "outside",
      outsideByM: gap > 0 ? round(gap) : null,
    });
  }

  private engagementSides(attacker: Actor, victim: Actor) {
    const attackerTeam = this.isTeam(attacker);
    const victimTeam = this.isTeam(victim);
    if (attackerTeam === victimTeam) return null;
    const enemy = attackerTeam ? victim : attacker;
    const enemyTeamId = actorTeam(enemy);
    if (enemyTeamId === null) return null;
    return { byUs: attackerTeam, enemy, enemyTeamId };
  }

  private observeDamage(event: Record<string, any>, ts: number) {
    const damage = finite(event.damage) ? event.damage : 0;
    if (damage <= 0) return;
    const cause = classifyDamageCause(event.damageTypeCategory, event.damageCauserName);
    if (this.isMe(event.victim) && this.myAlive) this.recordTaken(event, ts, damage, cause);
    if (this.isMe(event.attacker) && !this.isTeam(event.victim) && isCombatDamageCause(cause)) {
      this.versus[isBotActor(event.victim) ? "bot" : "human"].damage += damage;
    }
    if (!isCombatDamageCause(cause)) return;
    const sides = this.engagementSides(event.attacker, event.victim);
    if (!sides) return;
    this.engagements.push({
      t: this.rel(ts),
      enemyTeamId: sides.enemyTeamId,
      enemyName: displayName(sides.enemy),
      byUs: sides.byUs,
      amount: damage,
      enemyDown: null,
      teamDown: null,
    });
  }

  private observeGroggy(event: Record<string, any>, ts: number) {
    const victim = event.victim;
    if (this.isTeam(victim)) this.knockedAt.set(actorName(victim), this.rel(ts));
    if (!this.isTeam(victim)) {
      this.knockers.set(actorName(victim), this.isMe(event.attacker) ? "me" : this.isTeam(event.attacker) ? "team" : "other");
      if (this.isMe(event.attacker)) this.versus[isBotActor(victim) ? "bot" : "human"].knocks += 1;
    }
    const sides = this.engagementSides(event.attacker, victim);
    if (!sides) return;
    this.engagements.push({
      t: this.rel(ts),
      enemyTeamId: sides.enemyTeamId,
      enemyName: displayName(sides.enemy),
      byUs: sides.byUs,
      amount: 0,
      enemyDown: sides.byUs ? actorName(victim) : null,
      teamDown: sides.byUs ? null : actorName(victim),
    });
  }

  private observeKill(event: Record<string, any>, ts: number) {
    const victim = event.victim;
    const killer = event.killer ?? event.finisher;
    const info = event.killerDamageInfo ?? event.finishDamageInfo;
    const t = this.rel(ts);
    const victimName = displayName(victim);
    if (victimName) {
      this.kills.push({
        timeMs: t,
        killer: displayName(killer) || null,
        killerTeamId: actorTeam(killer),
        victim: victimName,
        victimTeamId: actorTeam(victim),
        victimIsBot: isBotActor(victim),
        weapon: typeof info?.damageCauserName === "string" && info.damageCauserName !== "None" ? info.damageCauserName : null,
        cause: classifyDamageCause(info?.damageTypeCategory, info?.damageCauserName),
        diedKnocked: classifyDamageCause(event.finishDamageInfo?.damageTypeCategory, event.finishDamageInfo?.damageCauserName) === "bleed",
      });
    }
    if (this.isMe(event.killer) && victimName && !this.isTeam(victim)) this.recordMyKill(event, t);
    if (this.isTeam(victim)) this.teamDead.add(actorName(victim));
    if (this.isMe(victim)) {
      this.myAlive = false;
      this.myLastDeath = { event, t };
    }
    // 기절 뒤 확킬은 교전별 이름 집합에서 한 번으로 합쳐진다.
    const victimKey = actorName(victim);
    const sides = this.engagementSides(killer, victim);
    if (!sides) return;
    this.engagements.push({
      t,
      enemyTeamId: sides.enemyTeamId,
      enemyName: displayName(sides.enemy),
      byUs: sides.byUs,
      amount: 0,
      enemyDown: sides.byUs ? victimKey : null,
      teamDown: sides.byUs ? null : victimKey,
    });
  }

  private observeRecall(event: Record<string, any>) {
    const actors = [event.character, event.recalledPlayer, ...(Array.isArray(event.recalledPlayers) ? event.recalledPlayers : [])]
      .map((item: any) => (item && typeof item === "object" && "character" in item ? item.character : item));
    for (const actor of actors) {
      if (!this.isTeam(actor)) continue;
      this.teamDead.delete(actorName(actor));
      if (this.isMe(actor)) {
        this.myAlive = true;
        this.myLastDeath = null;
      }
    }
  }

  private observeItemUse(event: Record<string, any>, ts: number) {
    if (!this.isMe(event.character) || !this.myAlive) return;
    const sub = typeof event.item?.subCategory === "string" ? event.item.subCategory.toLowerCase() : "";
    if (sub === "heal") this.healUses.push(this.rel(ts));
    else if (sub === "boost") this.boosts += 1;
  }

  private recordTaken(event: Record<string, any>, ts: number, damage: number, cause: ReplayDamageCause) {
    this.damageTaken += damage;
    const attacker = event.attacker && !this.isMe(event.attacker) ? event.attacker : null;
    const name = attacker ? displayName(attacker) || null : null;
    const weapon = causerName(event.damageCauserName);
    const isBot = isBotActor(attacker);
    if (this.takenHits.length < MAX_DAMAGE_HITS) {
      this.takenHits.push({ timeMs: this.rel(ts), attacker: name, isBot, cause, weapon, part: bodyPart(event.damageReason), damage: round(damage) });
    }
    const key = name ? `p:${name.toLowerCase()}` : `c:${cause}`;
    const source = this.takenSources.get(key) ?? {
      attacker: name, attackerTeamId: actorTeam(attacker), isBot, cause, weapon: null, damage: 0, hits: 0, weapons: new Map<string, number>(),
    };
    source.damage += damage;
    source.hits += 1;
    if (weapon) source.weapons.set(weapon, (source.weapons.get(weapon) ?? 0) + damage);
    this.takenSources.set(key, source);
  }

  private recordMyKill(event: Record<string, any>, t: number) {
    const victim = event.victim;
    const info = event.killerDamageInfo ?? event.finishDamageInfo;
    const victimKey = actorName(victim);
    const isBot = isBotActor(victim);
    this.versus[isBot ? "bot" : "human"].kills += 1;
    this.myKills.push({
      timeMs: t,
      victim: displayName(victim),
      victimKey,
      victimTeamId: actorTeam(victim),
      victimIsBot: isBot,
      victimWeapon: weaponClass(event.victimWeapon),
      weapon: causerName(info?.damageCauserName),
      part: bodyPart(info?.damageReason),
      distanceM: finite(info?.distance) && info.distance >= 0 ? round(info.distance / 100) : null,
      throughWall: info?.isThroughPenetrableWall === true,
      knockedBy: this.knockers.get(victimKey) ?? null,
    });
  }

  private buildDamageTaken(): NonNullable<MatchReport["damageTaken"]> {
    const sources = [...this.takenSources.values()]
      .sort((a, b) => b.damage - a.damage)
      .slice(0, MAX_DAMAGE_SOURCES)
      .map(({ weapons, ...source }) => ({
        ...source,
        damage: round(source.damage),
        weapon: [...weapons.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? null,
      }));
    return { sources, hits: this.takenHits };
  }

  private buildMyKills(participants: readonly any[], rosters: readonly any[]): MatchMyKill[] {
    const rankByName = new Map<string, number>();
    const byId = new Map(participants.map((participant) => [participant?.id, participant]));
    for (const roster of rosters) {
      const rank = roster?.attributes?.stats?.rank;
      if (!finite(rank)) continue;
      for (const ref of roster?.relationships?.participants?.data ?? []) {
        const name = byId.get(ref?.id)?.attributes?.stats?.name;
        if (typeof name === "string") rankByName.set(normalizeName(name), rank);
      }
    }
    return this.myKills.map(({ victimKey, ...kill }) => ({ ...kill, victimRank: rankByName.get(victimKey) ?? null }));
  }

  private buildFights(): MatchFight[] {
    const sorted = [...this.engagements].sort((a, b) => a.t - b.t);
    const groups: Engagement[][] = [];
    for (const item of sorted) {
      const current = groups[groups.length - 1];
      if (current && item.t - current[current.length - 1].t <= FIGHT_GAP_MS) current.push(item);
      else groups.push([item]);
    }
    return groups.slice(0, MAX_FIGHTS).map((group) => {
      const enemyDowns = new Set(group.map((item) => item.enemyDown).filter((name): name is string => !!name));
      const teamDowns = new Set(group.map((item) => item.teamDown).filter((name): name is string => !!name));
      const opponents = [...new Set(group.map((item) => item.enemyName).filter(Boolean))].slice(0, MAX_OPPONENT_NAMES);
      const outcome: MatchFightOutcome = enemyDowns.size > 0
        ? (teamDowns.size > 0 ? "traded" : "won")
        : (teamDowns.size > 0 ? "lost" : "brokeOff");
      return {
        startMs: group[0].t,
        endMs: group[group.length - 1].t,
        opponentTeamIds: [...new Set(group.map((item) => item.enemyTeamId))].sort((a, b) => a - b),
        opponents,
        dealt: round(group.filter((item) => item.byUs).reduce((sum, item) => sum + item.amount, 0)),
        taken: round(group.filter((item) => !item.byUs).reduce((sum, item) => sum + item.amount, 0)),
        enemyDowns: enemyDowns.size,
        teamDowns: teamDowns.size,
        openedBy: group[0].byUs ? "us" : "them",
        outcome,
      };
    });
  }

  private buildDeath(fights: MatchFight[]): MatchDeath | null {
    if (!this.myLastDeath) return null;
    const { event, t } = this.myLastDeath;
    const killer = event.killer ?? event.finisher;
    const info = event.killerDamageInfo ?? event.finishDamageInfo;
    const finishInfo = event.finishDamageInfo ?? info;
    const cause = classifyDamageCause(info?.damageTypeCategory, info?.damageCauserName);
    const finishCause = classifyDamageCause(finishInfo?.damageTypeCategory, finishInfo?.damageCauserName);
    const killerTeamId = actorTeam(killer);
    const knockedAtMs = this.knockedAt.get(this.identity.lowerNickname) ?? null;

    const recentTeams = new Set(this.engagements
      .filter((item) => item.t >= t - THIRD_PARTY_WINDOW_MS && item.t <= t)
      .map((item) => item.enemyTeamId));

    const lastFight = [...fights].reverse().find((fight) => fight.startMs <= t && fight.endMs >= t - FIGHT_GAP_MS) ?? null;
    const fightStart = lastFight?.startMs ?? t;
    const window = this.myTrack.filter((point) => point.t >= fightStart - ROTATION_WINDOW_MS && point.t <= fightStart);
    let moved: number | null = null;
    if (window.length >= 2) {
      moved = 0;
      for (let i = 1; i < window.length; i++) moved += distanceM(window[i - 1], window[i]);
      moved = round(moved);
    }
    const inVehicle = window.length > 0 && window[window.length - 1].inVehicle;

    const me = this.myTrack[this.myTrack.length - 1];
    let nearestTeammateM: number | null = null;
    if (me) {
      for (const [name, point] of this.teamLast) {
        if (name === this.identity.lowerNickname || this.teamDead.has(name)) continue;
        if (t - point.t > TEAMMATE_POSITION_MAX_AGE_MS) continue;
        const gap = round(distanceM(me, point));
        nearestTeammateM = nearestTeammateM === null ? gap : Math.min(nearestTeammateM, gap);
      }
    }

    const dealtToKiller = killerTeamId === null ? 0 : this.engagements
      .filter((item) => item.byUs && item.enemyTeamId === killerTeamId && item.t >= fightStart && item.t <= t)
      .reduce((sum, item) => sum + item.amount, 0);
    const killerOpened = killerTeamId !== null && this.engagements
      .find((item) => item.t >= fightStart && item.t <= t && item.enemyTeamId === killerTeamId)?.byUs === false;

    let type: MatchDeathType = "outfought";
    if (cause === "zone" || finishCause === "zone") type = "zone";
    else if (finishCause === "bleed" && knockedAtMs !== null) type = "bledOut";
    else if (recentTeams.size >= 2) type = "thirdParty";
    else if (inVehicle || (moved !== null && moved >= ROTATION_MIN_DISTANCE_M)) type = "rotating";
    else if (killerOpened && dealtToKiller < AMBUSH_MAX_DEALT) type = "ambushed";
    else if (nearestTeammateM !== null && nearestTeammateM > ISOLATION_MIN_DISTANCE_M) type = "isolated";
    else if (killerTeamId === null) type = "other";

    return {
      timeMs: t,
      phase: phaseOf(event),
      type,
      killer: displayName(killer) || null,
      killerTeamId,
      killerIsBot: isBotActor(killer),
      weapon: typeof info?.damageCauserName === "string" && info.damageCauserName !== "None" ? info.damageCauserName : null,
      cause,
      distanceM: finite(info?.distance) && info.distance >= 0 ? round(info.distance / 100) : null,
      knockedAtMs,
      teamsInLastMinute: recentTeams.size,
      movedBeforeFightM: moved,
      inVehicle,
      nearestTeammateM,
      openedBy: lastFight ? lastFight.openedBy : null,
    };
  }

  private buildHeal(fights: MatchFight[]): MatchHealReport {
    const trace = [...this.healthTrace].sort((a, b) => a.t - b.t);
    let restored = 0;
    for (let i = 1; i < trace.length; i++) {
      const gain = trace[i].health - trace[i - 1].health;
      if (gain <= 0) continue;
      // 부활로 체력이 다시 생긴 구간은 회복으로 세지 않는다.
      if (this.reviveTimes.some((time) => time > trace[i - 1].t - 1_000 && time <= trace[i].t + 1_000)) continue;
      restored += gain;
    }
    const midFightHeals = this.healUses.filter((time) => fights.some((fight) => time >= fight.startMs && time <= fight.endMs)).length;
    return {
      damageTaken: round(this.damageTaken),
      healthRestored: round(restored),
      heals: this.healUses.length,
      boosts: this.boosts,
      midFightHeals,
    };
  }

  private buildLanding(): MatchLandingReport | null {
    const mine = this.myLanding;
    if (!mine) return null;
    const myName = this.identity.lowerNickname;
    const others = this.landings.filter((landing) => landing.name !== myName && !this.identity.teamNames.has(landing.name));
    const near = others.filter((landing) => distanceM(landing, mine) <= LANDING_NEAR_M);
    const far = others.filter((landing) => distanceM(landing, mine) <= LANDING_FAR_M);
    return {
      timeMs: mine.t,
      enemiesNear: near.length,
      enemiesFar: far.length,
      teamsNear: new Set(near.map((landing) => landing.teamId ?? -1)).size,
    };
  }

  private buildTeams(participants: readonly any[], rosters: readonly any[]): MatchTeamRow[] {
    const byId = new Map(participants.map((participant) => [participant?.id, participant]));
    return rosters
      .map((roster) => {
        const players = (roster?.relationships?.participants?.data ?? [])
          .map((ref: any) => byId.get(ref?.id)?.attributes?.stats)
          .filter(Boolean)
          .map((stats: any) => ({
            name: String(stats.name ?? ""),
            kills: finite(stats.kills) ? stats.kills : 0,
            damage: finite(stats.damageDealt) ? round(stats.damageDealt) : 0,
            isBot: typeof stats.playerId === "string" && stats.playerId.startsWith("ai."),
          }));
        return {
          teamId: finite(roster?.attributes?.stats?.teamId) ? roster.attributes.stats.teamId : 0,
          rank: finite(roster?.attributes?.stats?.rank) ? roster.attributes.stats.rank : 0,
          kills: players.reduce((sum: number, player: { kills: number }) => sum + player.kills, 0),
          damage: players.reduce((sum: number, player: { damage: number }) => sum + player.damage, 0),
          players,
          isMine: players.some((player: { name: string }) => this.identity.teamNames.has(normalizeName(player.name))),
        };
      })
      .filter((team) => team.players.length > 0)
      .sort((a, b) => (a.rank || 999) - (b.rank || 999));
  }

  result(participants: readonly any[] = [], rosters: readonly any[] = []): MatchReport {
    const fights = this.buildFights();
    const bots = participants
      .map((participant) => participant?.attributes?.stats)
      .filter((stats: any) => typeof stats?.playerId === "string" && stats.playerId.startsWith("ai."))
      .map((stats: any) => String(stats.name ?? ""))
      .filter(Boolean)
      .sort((a: string, b: string) => a.localeCompare(b));
    return {
      version: MATCH_REPORT_VERSION,
      landing: this.buildLanding(),
      fights,
      death: this.buildDeath(fights),
      circles: this.circles,
      heal: this.buildHeal(fights),
      kills: [...this.kills].sort((a, b) => a.timeMs - b.timeMs),
      teams: this.buildTeams(participants, rosters),
      carePackages: this.carePackages,
      bots,
      versus: {
        human: { ...this.versus.human, damage: round(this.versus.human.damage) },
        bot: { ...this.versus.bot, damage: round(this.versus.bot.damage) },
      },
      damageTaken: this.buildDamageTaken(),
      myKills: this.buildMyKills(participants, rosters),
    };
  }
}
