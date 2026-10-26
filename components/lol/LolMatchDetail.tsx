import { useState } from "react";
import type {
  LolMatchDetails,
  LolRecentMatch,
} from "@/lib/lol/riotSearch.server";
import { formatKdaRatio, formatMetric, formatPercent } from "./lolFormat";
import { LolBuildIcons, LolItemSlots, LolScoreBadge } from "./LolMatchCard";
import { LolMatchInsightSection } from "./LolInsightCards";
import LolTeamAnalysis from "./LolTeamAnalysis";
import LolMatchBuildPanel from "./LolMatchBuild";

type Team = LolMatchDetails["teams"][number];
type Player = Team["participants"][number];
type Props = {
  match: LolRecentMatch;
  teams: Team[];
  isOwn: (riotId: string) => boolean;
  onSearch: (riotId: string, ref?: string) => void;
  expanded: boolean;
  // 빌드 탭이 타임라인을 요청할 API 기준 경로. 없으면 빌드 탭을 숨긴다.
  apiBase?: string;
};

const TABS = [
  ["overview", "종합"],
  ["team", "팀 분석"],
  ["build", "빌드"],
  ["insights", "라인전·기여"],
] as const;
type Tab = (typeof TABS)[number][0];

const OBJECTIVES = [
  ["tower", "타워"],
  ["dragon", "드래곤"],
  ["baron", "바론"],
  ["riftHerald", "전령"],
  ["horde", "유충"],
  ["inhibitor", "억제기"],
] as const;

function TeamComparison({ teams }: { teams: Team[] }) {
  if (teams.length !== 2) return null;
  const [blue, red] = teams;

  return (
    <div aria-label="총킬·골드 비교" className="grid gap-2 text-[10px]">
      <ComparisonBar
        label="총 킬"
        left={blue.totalKills}
        right={red.totalKills}
      />
      <ComparisonBar
        label="총 골드"
        left={blue.totalGold}
        right={red.totalGold}
      />
    </div>
  );
}

function ComparisonBar({
  label,
  left,
  right,
}: {
  label: string;
  left: number | null;
  right: number | null;
}) {
  const total = (left ?? 0) + (right ?? 0);
  const leftPercent = total ? ((left ?? 0) / total) * 100 : 50;

  return (
    <div className="grid grid-cols-[minmax(0,1fr)_auto_minmax(0,1fr)] items-center gap-x-3 gap-y-1">
      <span className="text-right tabular-nums">{formatMetric(left)}</span>
      <span className="text-zinc-400">{label}</span>
      <span className="tabular-nums">{formatMetric(right)}</span>
      <div
        aria-label={label}
        className="col-span-3 flex h-1.5 overflow-hidden rounded bg-zinc-800"
      >
        <span className="bg-blue-500" style={{ width: `${leftPercent}%` }} />
        <span className="flex-1 bg-red-500" />
      </div>
    </div>
  );
}

function TeamObjectives({ team }: { team: Team }) {
  return (
    <div className="grid grid-cols-3 gap-x-2 gap-y-1 text-[10px] sm:flex sm:flex-wrap sm:justify-end sm:gap-x-3">
      {OBJECTIVES.map(([key, label]) => {
        const objective = team.objectives?.[key];
        const title = `${label} ${objective?.kills ?? "미제공"}회${objective?.first ? " · 첫 획득" : ""}`;
        return (
          <span
            key={key}
            title={title}
            className="whitespace-nowrap text-zinc-300"
          >
            {label} {objective?.kills ?? "—"}
            {objective?.first && (
              <small className="ml-1 rounded bg-amber-400/15 px-1 text-amber-300">
                첫
              </small>
            )}
          </span>
        );
      })}
    </div>
  );
}

function DamageBars({
  player,
  maxDealt,
  maxTaken,
}: {
  player: Player;
  maxDealt: number;
  maxTaken: number;
}) {
  return (
    <div className="grid min-w-0 grid-cols-2 gap-1 @min-[860px]/history:grid-cols-1 @min-[860px]/history:gap-1.5">
      <DamageBar
        label="가한 피해"
        value={player.damageToChampions}
        max={maxDealt}
      />
      <DamageBar label="받은 피해" value={player.damageTaken} max={maxTaken} />
    </div>
  );
}

function DamageBar({
  label,
  value,
  max,
}: {
  label: string;
  value: number | null;
  max: number;
}) {
  const width =
    value === null || max <= 0 ? 0 : Math.min(100, (value / max) * 100);
  return (
    <div
      aria-label={`${label === "가한 피해" ? "챔피언 피해" : label} ${formatMetric(value)}`}
      title={`${label}: ${formatMetric(value)}`}
      className="min-w-0 text-[9px] leading-tight text-zinc-400"
    >
      <div className="flex justify-between gap-1">
        <span className="truncate">{label}</span>
        <span className="shrink-0 tabular-nums">{formatMetric(value)}</span>
      </div>
      <div className="mt-1 h-1 rounded bg-zinc-800">
        <div
          className="h-1 rounded bg-amber-400"
          style={{ width: `${width}%` }}
        />
      </div>
    </div>
  );
}

function PlayerRow({
  match,
  player,
  isOwn,
  maxDealt,
  maxTaken,
  onSearch,
}: {
  match: LolRecentMatch;
  player: Player;
  isOwn: boolean;
  maxDealt: number;
  maxTaken: number;
  onSearch: (riotId: string, ref?: string) => void;
}) {
  return (
    <div
      role="row"
      data-testid="lol-player-row"
      data-player-id={player.riotId}
      className={`grid min-w-0 grid-cols-[30px_36px_minmax(0,1fr)_68px] items-center gap-1 border-t border-white/10 py-1.5 first:border-0
        @min-[860px]/history:grid-cols-[34px_38px_minmax(95px,.8fr)_68px_minmax(140px,1.6fr)_75px_45px_154px]
        @min-[860px]/history:gap-2 ${isOwn ? "bg-amber-400/10" : ""}`}
      title={`골드 ${formatMetric(player.goldEarned)} · 오브젝트 피해 ${formatMetric(player.damageDealtToObjectives)} · 포탑 피해 ${formatMetric(player.damageDealtToTurrets)}`}
    >
      <span className="relative h-8 w-[30px] @min-[860px]/history:h-9 @min-[860px]/history:w-[34px]">
        <img
          src={`https://ddragon.leagueoflegends.com/cdn/${match.dataDragonVersion}/img/champion/${player.championImageId}.png`}
          alt=""
          width={36}
          height={36}
          onError={(event) => {
            event.currentTarget.hidden = true;
          }}
          className="h-full w-full rounded"
        />
        <small className="absolute -bottom-1 -right-1 rounded bg-black px-1 text-[8px]">
          {player.championLevel ?? "—"}
        </small>
      </span>
      <LolBuildIcons
        dataDragonVersion={match.dataDragonVersion}
        player={player}
        size={17}
      />
      <div className="min-w-0">
        <button
          type="button"
          onClick={() => onSearch(player.riotId, player.ref)}
          disabled={player.riotId === "Riot ID 미제공"}
          className={`block max-w-full truncate text-left text-[10px] disabled:cursor-default ${isOwn ? "font-bold text-amber-300" : "text-zinc-300 hover:text-white"}`}
        >
          {player.riotId}
        </button>
        <span className="flex min-w-0 items-center gap-1 text-[10px] text-zinc-500">
          <span className="truncate">{player.championNameKo}</span>
          <LolScoreBadge player={player} />
        </span>
      </div>
      <div className="text-center text-[9px] tabular-nums @min-[860px]/history:text-[10px]">
        <b>
          {player.kills ?? "—"}/{player.deaths ?? "—"}/{player.assists ?? "—"}
        </b>
        <span className="block text-zinc-500">
          ({formatPercent(player.killParticipationPct)}){" "}
          {formatKdaRatio(player.kills, player.deaths, player.assists)}
        </span>
      </div>

      <div className="col-span-4 grid min-w-0 grid-cols-[minmax(0,1fr)_68px_32px_124px] items-center gap-1 @min-[860px]/history:col-span-1 @min-[860px]/history:contents">
        <DamageBars player={player} maxDealt={maxDealt} maxTaken={maxTaken} />
        <div className="text-center text-[8px] leading-tight text-zinc-300 @min-[860px]/history:text-[9px]">
          <span className="block">
            제어와드 {formatMetric(player.detectorWardsPlaced)}
          </span>
          <span>
            설치 {formatMetric(player.wardsPlaced)} / 제거{" "}
            {formatMetric(player.wardsKilled)}
          </span>
        </div>
        <div className="text-center text-[9px] @min-[860px]/history:text-[10px]">
          {formatMetric(player.cs)}
          <span className="block text-zinc-500">
            {match.gameDuration && match.gameDuration >= 300
              ? player.cs === null
                ? "미제공"
                : (player.cs / (match.gameDuration / 60)).toFixed(1)
              : "—"}
            /분
          </span>
        </div>
        <div className="min-w-0 justify-self-end">
          <LolItemSlots
            dataDragonVersion={match.dataDragonVersion}
            player={player}
            size={16}
          />
        </div>
      </div>
    </div>
  );
}

export default function LolMatchDetail({
  match,
  teams,
  isOwn,
  onSearch,
  expanded,
  apiBase,
}: Props) {
  const [tab, setTab] = useState<Tab>("overview");
  const tabId = `lol-detail-${match.matchId}`;
  const hasInsights =
    !!match.insights &&
    (match.insights.laning.length > 0 ||
      match.insights.contribution.length > 0);
  const tabs = TABS.filter(([key]) => (key !== "insights" || hasInsights) && (key !== "build" || !!apiBase));
  const players = teams.flatMap((team) => team.participants);
  const maxDealt = Math.max(
    0,
    ...players.map((player) => player.damageToChampions ?? 0),
  );
  const maxTaken = Math.max(
    0,
    ...players.map((player) => player.damageTaken ?? 0),
  );

  return (
    <div
      id={`lol-detail-${match.matchId}`}
      hidden={!expanded}
      className="mt-3 border-t border-zinc-800 pt-3"
    >
      {expanded && (
        <>
          <div
            role="tablist"
            aria-label="경기 상세 탭"
            style={{
              gridTemplateColumns: `repeat(${tabs.length}, minmax(0, 1fr))`,
            }}
            className="mb-3 grid gap-1 rounded-lg bg-zinc-950/60 p-1"
          >
            {tabs.map(([key, label]) => (
              <button
                key={key}
                type="button"
                role="tab"
                id={`${tabId}-${key}-tab`}
                aria-selected={tab === key}
                aria-controls={`${tabId}-${key}`}
                onClick={() => setTab(key)}
                className={`rounded-md px-2 py-1.5 text-xs font-semibold transition ${tab === key ? "bg-zinc-700 text-white" : "text-zinc-400 hover:bg-zinc-800 hover:text-zinc-200"}`}
              >
                {label}
              </button>
            ))}
          </div>
          {hasInsights && (
            <div
              role="tabpanel"
              id={`${tabId}-insights`}
              aria-labelledby={`${tabId}-insights-tab`}
              hidden={tab !== "insights"}
            >
              <LolMatchInsightSection insights={match.insights} />
            </div>
          )}
          {apiBase && (
            <div
              role="tabpanel"
              id={`${tabId}-build`}
              aria-labelledby={`${tabId}-build-tab`}
              hidden={tab !== "build"}
            >
              <LolMatchBuildPanel
                matchId={match.matchId}
                apiBase={apiBase}
                teams={teams}
                isOwn={isOwn}
                dataDragonVersion={match.dataDragonVersion}
                active={tab === "build"}
              />
            </div>
          )}
          <div
            role="tabpanel"
            id={`${tabId}-team`}
            aria-labelledby={`${tabId}-team-tab`}
            hidden={tab !== "team"}
          >
            <LolTeamAnalysis
              teams={teams}
              dataDragonVersion={match.dataDragonVersion}
              isOwn={isOwn}
            />
          </div>
          <div
            role="tabpanel"
            id={`${tabId}-overview`}
            aria-labelledby={`${tabId}-overview-tab`}
            hidden={tab !== "overview"}
            className="grid min-w-0 gap-3"
          >
            <TeamComparison teams={teams} />
            {teams.map((team) => {
              const side =
                team.teamId === 100
                  ? "블루팀"
                  : team.teamId === 200
                    ? "레드팀"
                    : `팀 ${team.teamId}`;
              return (
                <section
                  key={team.teamId}
                  aria-label={`${side} · ${team.win ? "승리" : "패배"}`}
                  className={`min-w-0 rounded-lg border p-2 ${team.win ? "border-blue-800 bg-blue-950/45" : "border-red-800 bg-red-950/45"}`}
                >
                  <div className="mb-2 grid grid-cols-[minmax(0,1fr)_minmax(0,2fr)] items-start gap-2 text-xs font-bold sm:grid-cols-[auto_1fr]">
                    <span>
                      {side} · {team.win ? "승리" : "패배"}
                    </span>
                    <TeamObjectives team={team} />
                  </div>
                  <div
                    role="table"
                    aria-label={`${side} 참가자 상세`}
                    className="min-w-0"
                  >
                    {team.participants.map((player, index) => (
                      <PlayerRow
                        key={`${player.riotId}-${index}`}
                        match={match}
                        player={player}
                        isOwn={isOwn(player.riotId)}
                        maxDealt={maxDealt}
                        maxTaken={maxTaken}
                        onSearch={onSearch}
                      />
                    ))}
                  </div>
                </section>
              );
            })}
          </div>
        </>
      )}
    </div>
  );
}
