import { useState } from "react";
import type {
  LolMatchDetails,
  LolRecentMatch,
} from "@/lib/lol/riotSearch.server";
import { formatKdaRatio, formatMetric, formatPercent } from "./lolFormat";
import { LolBuildIcons, LolItemSlots, LolScoreBadge, lolScoreRankLabel } from "./LolMatchCard";
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
  // 모바일은 라벨을 붙여 위아래로, 넓은 표(860px 이상)는 열 제목이 설명하므로 숫자와 막대만 나란히 둔다.
  return (
    <div role="cell" className="grid min-w-0 grid-cols-1 gap-1 @min-[860px]/history:grid-cols-2 @min-[860px]/history:gap-3">
      <DamageBar
        label="가한 피해"
        shortLabel="가한"
        value={player.damageToChampions}
        max={maxDealt}
        barClass="bg-amber-400"
      />
      <DamageBar label="받은 피해" shortLabel="받은" value={player.damageTaken} max={maxTaken} barClass="bg-zinc-400" />
    </div>
  );
}

function DamageBar({
  label,
  shortLabel,
  value,
  max,
  barClass,
}: {
  label: string;
  shortLabel: string;
  value: number | null;
  max: number;
  barClass: string;
}) {
  const width =
    value === null || max <= 0 ? 0 : Math.min(100, (value / max) * 100);
  return (
    <div
      aria-label={`${label === "가한 피해" ? "챔피언 피해" : label} ${formatMetric(value)}`}
      title={`${label}: ${formatMetric(value)}`}
      className="min-w-0 text-[10px] leading-tight text-zinc-400 @min-[860px]/history:text-xs @min-[860px]/history:text-zinc-300"
    >
      <div className="flex justify-between gap-1 @min-[860px]/history:justify-center">
        <span className="shrink-0 @min-[860px]/history:hidden">{shortLabel}</span>
        <span className="shrink-0 tabular-nums">{formatMetric(value)}</span>
      </div>
      <div className="mt-0.5 h-1 rounded bg-zinc-800 @min-[860px]/history:mt-1 @min-[860px]/history:h-1.5">
        <div
          className={`h-full rounded ${barClass}`}
          style={{ width: `${width}%` }}
        />
      </div>
    </div>
  );
}

// 넓은 표(860px 이상)의 열 너비. 머리글과 모든 행이 같은 값을 써서 열 위치가 이름 길이에 따라 흔들리지 않는다.
const TABLE_COLUMNS = "@min-[860px]/history:grid-cols-[34px_38px_minmax(110px,1fr)_88px_96px_minmax(150px,1.1fr)_60px_60px_166px]";

function kdaRatioClass(kills: number | null, deaths: number | null, assists: number | null) {
  if (kills === null || deaths === null || assists === null) return "text-zinc-300";
  const ratio = deaths === 0 ? Infinity : (kills + assists) / deaths;
  return ratio >= 5 ? "text-amber-400" : ratio >= 3 ? "text-sky-400" : "text-zinc-200";
}

function ScoreCell({ player }: { player: Player }) {
  const score = player.score;
  return (
    <div role="cell" className="hidden items-center justify-center gap-1.5 @min-[860px]/history:flex">
      {score ? (
        <>
          <b className="text-sm italic tabular-nums text-zinc-100">{score.score.toFixed(1)}</b>
          <span
            title={`BGMS 점수(시험판) · 경기 내 ${score.rank}위`}
            className={`rounded-full px-2 py-0.5 text-[11px] font-bold ${score.award === "MVP" ? "bg-amber-500/80 text-zinc-950"
              : score.award === "ACE" ? "bg-violet-500/80 text-white" : "bg-zinc-700 text-zinc-200"}`}
          >
            {score.award ?? lolScoreRankLabel(score.rank)}
          </span>
        </>
      ) : <span className="text-xs text-zinc-500">—</span>}
    </div>
  );
}

function PlayerTableHeader({ side, win }: { side: string; win: boolean }) {
  const cell = "text-center";
  return (
    <div
      role="row"
      data-testid="lol-player-table-header"
      className={`hidden min-w-0 items-center gap-2 border-b border-white/10 pb-1.5 text-[11px] text-zinc-400 @min-[860px]/history:grid ${TABLE_COLUMNS}`}
    >
      <span role="columnheader" className="col-span-3 text-left">
        <b className={win ? "text-sky-300" : "text-rose-300"}>{win ? "승리" : "패배"}</b> ({side})
      </span>
      <span role="columnheader" className={cell}>BGMS 점수</span>
      <span role="columnheader" className={cell}>KDA</span>
      <span role="columnheader" className={cell} title="왼쪽 챔피언에게 가한 피해, 오른쪽 받은 피해">피해량</span>
      <span role="columnheader" className={cell} title="위 제어와드 구매, 아래 와드 설치 / 제거">와드</span>
      <span role="columnheader" className={cell}>CS</span>
      <span role="columnheader" className={cell}>아이템</span>
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
  const csPerMinute = match.gameDuration && match.gameDuration >= 300
    ? player.cs === null ? "미제공" : (player.cs / (match.gameDuration / 60)).toFixed(1)
    : "—";
  return (
    <div
      role="row"
      data-testid="lol-player-row"
      data-player-id={player.riotId}
      className={`grid min-w-0 grid-cols-[30px_36px_minmax(0,1fr)_68px] items-center gap-1 py-1.5
        ${TABLE_COLUMNS} @min-[860px]/history:gap-2 @min-[860px]/history:py-2 ${isOwn ? "bg-amber-400/10" : ""}`}
      title={`골드 ${formatMetric(player.goldEarned)} · 오브젝트 피해 ${formatMetric(player.damageDealtToObjectives)} · 포탑 피해 ${formatMetric(player.damageDealtToTurrets)}`}
    >
      <span role="cell" className="relative h-8 w-[30px] @min-[860px]/history:h-9 @min-[860px]/history:w-[34px]">
        <img loading="lazy" decoding="async"
          src={`https://ddragon.leagueoflegends.com/cdn/${match.dataDragonVersion}/img/champion/${player.championImageId}.png`}
          alt=""
          width={36}
          height={36}
          onError={(event) => {
            event.currentTarget.hidden = true;
          }}
          className="h-full w-full rounded"
        />
        <small className="absolute -bottom-1 -right-1 rounded bg-black px-1 text-[9px]">
          {player.championLevel ?? "—"}
        </small>
      </span>
      <div role="cell">
        <LolBuildIcons
          dataDragonVersion={match.dataDragonVersion}
          player={player}
          size={17}
        />
      </div>
      <div role="cell" className="min-w-0">
        <button
          type="button"
          onClick={() => onSearch(player.riotId, player.ref)}
          disabled={player.riotId === "Riot ID 미제공"}
          className={`block min-h-6 max-w-full truncate text-left text-[11px] disabled:cursor-default @min-[860px]/history:text-[13px] ${isOwn ? "font-bold text-amber-300" : "text-zinc-200 hover:text-white"}`}
        >
          {player.riotId}
        </button>
        <span className="flex min-w-0 items-center gap-1 text-[10px] text-zinc-500 @min-[860px]/history:text-[11px]">
          <span className="truncate">{player.championNameKo}</span>
          {/* 넓은 표에서는 점수를 별도 열에 둔다. */}
          <span className="@min-[860px]/history:hidden"><LolScoreBadge player={player} /></span>
        </span>
      </div>
      <ScoreCell player={player} />
      <div role="cell" className="text-center text-[10px] tabular-nums @min-[860px]/history:text-xs">
        <span className="block @min-[860px]/history:text-zinc-300">
          <b className="@min-[860px]/history:font-normal">{player.kills ?? "—"}/{player.deaths ?? "—"}/{player.assists ?? "—"}</b>
          <span className="hidden text-zinc-400 @min-[860px]/history:inline"> ({formatPercent(player.killParticipationPct)})</span>
        </span>
        <span className="block text-zinc-500 @min-[860px]/history:hidden">
          ({formatPercent(player.killParticipationPct)}){" "}
          {formatKdaRatio(player.kills, player.deaths, player.assists)}
        </span>
        <b className={`hidden @min-[860px]/history:block ${kdaRatioClass(player.kills, player.deaths, player.assists)}`}>
          {formatKdaRatio(player.kills, player.deaths, player.assists)}
        </b>
      </div>

      <div className="col-span-4 grid min-w-0 grid-cols-[minmax(0,1fr)_72px_34px_124px] items-center gap-1 @min-[860px]/history:col-span-1 @min-[860px]/history:contents">
        <DamageBars player={player} maxDealt={maxDealt} maxTaken={maxTaken} />
        <div
          role="cell"
          title={`제어와드 ${formatMetric(player.detectorWardsPlaced)} · 와드 설치 ${formatMetric(player.wardsPlaced)} · 제거 ${formatMetric(player.wardsKilled)}`}
          className="text-center text-[10px] leading-tight text-zinc-300 @min-[860px]/history:text-xs"
        >
          <span className="block">
            <span className="@min-[860px]/history:hidden">제어와드 </span>{formatMetric(player.detectorWardsPlaced)}
          </span>
          <span className="whitespace-nowrap @min-[860px]/history:text-zinc-400">
            <span className="@min-[860px]/history:hidden">설치 </span>{formatMetric(player.wardsPlaced)}
            <span className="@min-[860px]/history:hidden">·제거 </span><span className="hidden @min-[860px]/history:inline"> / </span>
            {formatMetric(player.wardsKilled)}
          </span>
        </div>
        <div role="cell" className="text-center text-[10px] @min-[860px]/history:text-xs">
          {formatMetric(player.cs)}
          <span className="block text-zinc-500 @min-[860px]/history:text-zinc-400">
            <span className="hidden @min-[860px]/history:inline">분당 </span>{csPerMinute}<span className="@min-[860px]/history:hidden">/분</span>
          </span>
        </div>
        <div role="cell" className="min-w-0 justify-self-end @min-[860px]/history:justify-self-center">
          <LolItemSlots
            dataDragonVersion={match.dataDragonVersion}
            player={player}
            slotClassName="h-4 w-4 @min-[860px]/history:h-[22px] @min-[860px]/history:w-[22px]"
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
                className={`min-h-10 rounded-md px-2 text-xs font-semibold transition ${tab === key ? "bg-zinc-700 text-white" : "text-zinc-400 hover:bg-zinc-800 hover:text-zinc-200"}`}
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
                    {/* 넓은 표는 머리글 행에 승패와 팀을 보여 주므로 여기서는 좁은 화면에서만 표시한다. */}
                    <span className="@min-[860px]/history:invisible">
                      {side} · {team.win ? "승리" : "패배"}
                    </span>
                    <TeamObjectives team={team} />
                  </div>
                  <div
                    role="table"
                    aria-label={`${side} 참가자 상세`}
                    className="min-w-0"
                  >
                    <PlayerTableHeader side={side} win={team.win} />
                    <div role="rowgroup" className="divide-y divide-white/10">
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
