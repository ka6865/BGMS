import React, { useMemo, useState } from "react";
import { PlayCircle } from "lucide-react";
import type { MatchReport } from "@/lib/pubg-analysis/matchReport";
import { getTranslatedWeaponName } from "@/lib/pubg-analysis/constants";
import { normalizeName } from "@/lib/pubg-analysis/utils";
import type { MatchDamageSource, MatchMyKill, MatchVersusCounts } from "@/lib/pubg-analysis/matchReport";
import {
  BODY_PART_LABELS,
  CARE_PACKAGE_LABELS,
  DAMAGE_CAUSE_LABELS,
  KNOCKED_BY_LABELS,
  FIGHT_OUTCOME_LABELS,
  buildKillTree,
  describeDeath,
  fightReplaySeconds,
  formatMatchClock,
  type KillTreeNode,
} from "@/lib/pubg-analysis/matchReportView";

const TEAM_PREVIEW = 10;
const BOT_PREVIEW = 12;

const weaponLabel = (weapon: string | null) => (weapon ? getTranslatedWeaponName(weapon) : null);
const partLabel = (part: string | null) => (part ? BODY_PART_LABELS[part] ?? null : null);

function versusText(counts: MatchVersusCounts) {
  return `처치 ${counts.kills} · 기절 ${counts.knocks} · 피해 ${counts.damage}`;
}

function killDetail(kill: MatchMyKill) {
  const parts = [
    [weaponLabel(kill.weapon), partLabel(kill.part)].filter(Boolean).join(" "),
    kill.distanceM !== null ? `${kill.distanceM}m` : null,
    kill.throughWall ? "벽 관통" : null,
    kill.knockedBy && kill.knockedBy !== "me" ? KNOCKED_BY_LABELS[kill.knockedBy] : null,
  ];
  return parts.filter(Boolean).join(" · ");
}

function sourceLabel(source: MatchDamageSource) {
  if (!source.attacker) return DAMAGE_CAUSE_LABELS[source.cause];
  const team = source.attackerTeamId !== null ? ` (팀${source.attackerTeamId})` : "";
  return `${source.attacker}${source.isBot ? " (봇)" : ""}${team}`;
}

/** 기본 지표 아래 사망 한 줄 요약. 우승했거나 사망 기록이 없으면 그리지 않는다. */
export function MatchDeathLine({ report }: { report: MatchReport }) {
  const death = report.death;
  if (!death) return null;
  const killer = death.killer ? `${death.killer}${death.killerIsBot ? " (봇)" : ""}` : null;
  const weapon = weaponLabel(death.weapon);
  return (
    <p className="mt-2 flex flex-wrap items-center gap-x-2 gap-y-1 text-[11px] text-gray-400" aria-label="사망 요약">
      <span className="rounded bg-red-500/15 px-1.5 py-0.5 font-bold text-red-300">사망 {formatMatchClock(death.timeMs)}</span>
      <span className="text-gray-200">{describeDeath(death)}</span>
      {killer && <span>· {killer}{weapon ? `, ${weapon}` : ""}</span>}
    </p>
  );
}

function FlowRow({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <li className="flex gap-3 border-b border-white/5 py-2.5 last:border-b-0">
      <span className="w-12 shrink-0 text-[11px] font-black text-gray-500">{label}</span>
      <div className="min-w-0 flex-1 text-xs text-gray-200">{children}</div>
    </li>
  );
}

/** 경기 흐름: 착지 → 교전 → 자기장 → 회복 순서로 내 경기를 시간순으로 보여준다. */
export function MatchFlowContent({
  report,
  canReplay,
  onReplayAt,
}: {
  report: MatchReport;
  canReplay: boolean;
  onReplayAt: (seconds: number) => void;
}) {
  const { landing, fights, circles, heal, versus, damageTaken, myKills } = report;
  const outsideCircles = circles.filter((circle) => circle.status === "outside");
  const [showHits, setShowHits] = useState(false);
  const hasBotWork = !!versus && (versus.bot.kills > 0 || versus.bot.knocks > 0 || versus.bot.damage > 0);
  return (
    <ul aria-label="경기 흐름">
      {landing && (
        <FlowRow label="착지">
          {formatMatchClock(landing.timeMs)} · 300m 안에 적 {landing.enemiesNear}명
          {landing.teamsNear > 0 ? ` (${landing.teamsNear}팀)` : ""} · 600m 안 {landing.enemiesFar}명
        </FlowRow>
      )}
      {fights.map((fight, index) => {
        const outcome = FIGHT_OUTCOME_LABELS[fight.outcome];
        return (
          <FlowRow key={`${fight.startMs}-${index}`} label={`교전${index + 1}`}>
            <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
              <span className="font-mono text-gray-400">{formatMatchClock(fight.startMs)}</span>
              <span>vs {fight.opponentTeamIds.map((teamId) => `팀${teamId}`).join(", ")}</span>
              <span className={`rounded px-1.5 py-0.5 text-[10px] font-black ${outcome.tone}`} title={outcome.description}>
                {outcome.label}
              </span>
              <span className="text-gray-400">
                준 피해 {fight.dealt} · 받은 피해 {fight.taken}
                {fight.openedBy === "them" ? " · 상대 선공" : ""}
              </span>
              {canReplay && (
                <button
                  type="button"
                  onClick={(event) => {
                    event.stopPropagation();
                    onReplayAt(fightReplaySeconds(fight.startMs));
                  }}
                  className="ml-auto inline-flex min-h-8 items-center gap-1 rounded-lg border border-white/10 px-2 text-[11px] font-bold text-[#F2A900] hover:bg-white/5"
                  aria-label={`교전${index + 1} 리플레이에서 보기`}
                >
                  <PlayCircle size={12} aria-hidden="true" />
                  리플레이
                </button>
              )}
            </div>
          </FlowRow>
        );
      })}
      {myKills && myKills.length > 0 && (
        <FlowRow label="내 처치">
          <ul className="flex flex-col gap-1.5" aria-label="내 처치">
            {myKills.map((kill, index) => (
              <li key={`${kill.timeMs}-${index}`} className="flex flex-wrap items-baseline gap-x-2">
                <span className="font-mono text-gray-400">{formatMatchClock(kill.timeMs)}</span>
                <span className="font-bold text-white">{kill.victim}{kill.victimIsBot ? " (봇)" : ""}</span>
                <span className="text-gray-300">{killDetail(kill)}</span>
                <span className="text-gray-500">
                  {kill.victimWeapon ? `상대 무기 ${weaponLabel(kill.victimWeapon)}` : "상대 무기 없음"}
                  {kill.victimRank ? ` · 상대 최종 #${kill.victimRank}` : ""}
                </span>
              </li>
            ))}
          </ul>
        </FlowRow>
      )}
      {versus && (
        <FlowRow label="상대">
          사람 {versusText(versus.human)}
          {hasBotWork ? <span className="text-gray-400"> · 봇 {versusText(versus.bot)}</span> : null}
        </FlowRow>
      )}
      {damageTaken && damageTaken.sources.length > 0 && (
        <FlowRow label="피격">
          <ul className="flex flex-col gap-1" aria-label="나를 맞힌 것">
            {damageTaken.sources.map((source, index) => (
              <li key={`${source.attacker ?? source.cause}-${index}`} className="flex flex-wrap items-baseline gap-x-2">
                <span className="text-white">{sourceLabel(source)}</span>
                {source.weapon && source.attacker && <span className="text-gray-400">{weaponLabel(source.weapon)}</span>}
                <span className="text-gray-300">{source.damage} ({source.hits}번)</span>
              </li>
            ))}
          </ul>
          {damageTaken.hits.length > 0 && (
            <button
              type="button"
              onClick={(event) => { event.stopPropagation(); setShowHits((value) => !value); }}
              aria-expanded={showHits}
              className="mt-1.5 min-h-8 text-[11px] font-bold text-gray-400 hover:text-white"
            >
              {showHits ? "피격 기록 접기" : `피격 기록 ${damageTaken.hits.length}건 보기`}
            </button>
          )}
          {showHits && (
            <ol className="mt-1 flex flex-col gap-0.5 text-[11px] text-gray-400" aria-label="피격 기록">
              {damageTaken.hits.map((hit, index) => (
                <li key={`${hit.timeMs}-${index}`}>
                  <span className="font-mono">{formatMatchClock(hit.timeMs)}</span>
                  {" · "}{hit.attacker ? `${hit.attacker}${hit.isBot ? " (봇)" : ""}` : DAMAGE_CAUSE_LABELS[hit.cause]}
                  {hit.attacker && hit.weapon ? ` · ${weaponLabel(hit.weapon)}` : ""}
                  {partLabel(hit.part) ? ` · ${partLabel(hit.part)}` : ""}
                  {` · ${hit.damage}`}
                </li>
              ))}
            </ol>
          )}
        </FlowRow>
      )}
      {circles.length > 0 && (
        <FlowRow label="자기장">
          {outsideCircles.length === 0
            ? `원이 정해질 때마다 안에 있었습니다 (${circles.length}번)`
            : `${circles.length}번 중 ${outsideCircles.length}번 원 밖 · `
              + outsideCircles.slice(0, 4).map((circle) => `${circle.index}번째 ${circle.outsideByM}m`).join(", ")}
        </FlowRow>
      )}
      <FlowRow label="회복">
        {heal.damageTaken === 0
          ? "받은 피해가 없습니다"
          : `받은 피해 ${heal.damageTaken} 중 ${Math.min(heal.healthRestored, heal.damageTaken)} 회복`}
        {` · 치료 ${heal.heals}번 · 부스트 ${heal.boosts}번`}
        {heal.midFightHeals > 0 ? ` · 교전 중 치료 ${heal.midFightHeals}번` : ""}
      </FlowRow>
    </ul>
  );
}

function KillTreeList({ nodes, myTeam, depth = 0 }: { nodes: KillTreeNode[]; myTeam: Set<string>; depth?: number }) {
  return (
    <ul className={depth > 0 ? "ml-3 border-l border-white/10 pl-3" : ""}>
      {nodes.map((node, index) => {
        const mine = myTeam.has(normalizeName(node.name));
        return (
          <li key={`${node.name}-${index}`} className="py-0.5">
            <span className={`text-xs ${mine ? "font-bold text-[#F2A900]" : "text-gray-200"}`}>{node.name}</span>
            {node.isBot && <span className="ml-1 text-[10px] text-gray-500">봇</span>}
            {node.timeMs !== null && (
              <span className="ml-2 text-[10px] text-gray-500">
                {formatMatchClock(node.timeMs)}{node.weapon ? ` · ${weaponLabel(node.weapon)}` : ""}
                {node.diedKnocked ? " · 기절 후 사망" : ""}
              </span>
            )}
            {node.children.length > 0 && <KillTreeList nodes={node.children} myTeam={myTeam} depth={depth + 1} />}
          </li>
        );
      })}
    </ul>
  );
}

/** 경기 전체: 팀 순위, 킬 트리, 보급, 봇 목록. 내가 죽은 뒤 이야기까지 포함한다. */
export function MatchOverviewContent({ report }: { report: MatchReport }) {
  const [showAllTeams, setShowAllTeams] = useState(false);
  const [showTree, setShowTree] = useState(false);
  const tree = useMemo(() => buildKillTree(report.kills), [report.kills]);
  const myTeam = useMemo(
    () => new Set(report.teams.filter((team) => team.isMine).flatMap((team) => team.players.map((player) => normalizeName(player.name)))),
    [report.teams],
  );
  const myTeamRow = report.teams.find((team) => team.isMine);
  const visibleTeams = showAllTeams
    ? report.teams
    : [...report.teams.slice(0, TEAM_PREVIEW), ...(myTeamRow && !report.teams.slice(0, TEAM_PREVIEW).includes(myTeamRow) ? [myTeamRow] : [])];

  return (
    <div className="flex flex-col gap-5">
      <div>
        <h4 className="mb-2 text-[11px] font-black text-gray-400">팀 순위</h4>
        <ol className="overflow-hidden rounded-2xl border border-white/5" aria-label="팀 순위">
          {visibleTeams.map((team) => (
            <li
              key={team.teamId}
              className={`flex items-center gap-3 border-b border-white/5 px-3 py-2 text-xs last:border-b-0 ${team.isMine ? "bg-[#F2A900]/10" : ""}`}
            >
              <span className="w-8 shrink-0 font-black text-gray-400">#{team.rank}</span>
              <span className="min-w-0 flex-1 truncate text-gray-200">
                {team.players.map((player) => `${player.name}${player.isBot ? " (봇)" : ""}`).join(", ")}
              </span>
              <span className="shrink-0 text-gray-400">킬 {team.kills} · 피해 {team.damage}</span>
            </li>
          ))}
        </ol>
        {report.teams.length > TEAM_PREVIEW && (
          <button
            type="button"
            onClick={(event) => { event.stopPropagation(); setShowAllTeams((value) => !value); }}
            className="mt-2 min-h-9 text-[11px] font-bold text-gray-400 hover:text-white"
          >
            {showAllTeams ? "접기" : `전체 ${report.teams.length}팀 보기`}
          </button>
        )}
      </div>

      {tree.length > 0 && (
        <div>
          <div className="mb-2 flex items-center justify-between">
            <div className="min-w-0">
              <h4 className="text-[11px] font-black text-gray-400">킬 트리 · 마지막 생존자부터</h4>
              <p className="text-[10px] text-gray-500">들여쓴 선수는 바로 위 선수가 처치했습니다. 기절한 채 죽으면 기절시킨 선수의 처치로 기록됩니다.</p>
            </div>
            <button
              type="button"
              onClick={(event) => { event.stopPropagation(); setShowTree((value) => !value); }}
              aria-expanded={showTree}
              className="min-h-9 text-[11px] font-bold text-gray-400 hover:text-white"
            >
              {showTree ? "접기" : `${report.kills.length}킬 펼치기`}
            </button>
          </div>
          {showTree && (
            <div className="max-h-96 overflow-y-auto rounded-2xl border border-white/5 p-3" aria-label="킬 트리">
              <KillTreeList nodes={tree} myTeam={myTeam} />
            </div>
          )}
        </div>
      )}

      {report.carePackages.length > 0 && (
        <div>
          <h4 className="mb-2 text-[11px] font-black text-gray-400">보급 {report.carePackages.length}개</h4>
          <ul className="flex flex-wrap gap-1.5" aria-label="보급 목록">
            {report.carePackages.map((item, index) => (
              <li key={`${item.timeMs}-${index}`} className="rounded-lg bg-white/5 px-2 py-1 text-[11px] text-gray-300">
                {CARE_PACKAGE_LABELS[item.kind]} · {item.phase}페이즈 {formatMatchClock(item.timeMs)}
              </li>
            ))}
          </ul>
        </div>
      )}

      {report.bots.length > 0 && (
        <div>
          <h4 className="mb-2 text-[11px] font-black text-gray-400">봇 {report.bots.length}명</h4>
          <p className="text-[11px] leading-relaxed text-gray-400">
            {report.bots.slice(0, BOT_PREVIEW).join(", ")}
            {report.bots.length > BOT_PREVIEW ? ` 외 ${report.bots.length - BOT_PREVIEW}명` : ""}
          </p>
        </div>
      )}
    </div>
  );
}
