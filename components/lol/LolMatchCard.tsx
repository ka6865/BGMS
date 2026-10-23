import { ChevronDown, ChevronUp } from "lucide-react";
import type {
  LolMatchDetails,
  LolRecentMatch,
} from "@/lib/lol/riotSearch.server";
import LolMatchDetail from "./LolMatchDetail";
import {
  formatAbsoluteTime,
  formatDuration,
  formatKdaRatio,
  formatMetric,
  formatPercent,
  formatRelativeTime,
  getQueueLabel,
} from "./lolFormat";

type LolPlayer = LolMatchDetails["teams"][number]["participants"][number];
type Props = {
  match: LolRecentMatch;
  ownRiotId: string;
  expanded: boolean;
  onToggle: () => void;
  onSearch: (riotId: string, ref?: string) => void;
};

function hideBrokenImage(event: React.SyntheticEvent<HTMLImageElement>) {
  event.currentTarget.hidden = true;
}

export function LolItemSlots({
  player,
  size = 20,
}: {
  player?: LolPlayer;
  size?: number;
}) {
  return (
    <div
      aria-label={`${player?.riotId ?? "본인"} 아이템`}
      className="flex shrink-0 gap-0.5"
    >
      {Array.from({ length: 7 }, (_, index) => {
        const item = player?.items?.[index];
        return (
          <span
            key={index}
            data-testid="lol-player-item-slot"
            title={item?.name || "아이템 미제공"}
            className="grid place-items-center rounded bg-zinc-800 text-[8px] text-zinc-500"
            style={{ width: size, height: size }}
          >
            {item?.id ? (
              <img
                src={`https://ddragon.leagueoflegends.com/cdn/16.21.1/img/item/${item.id}.png`}
                alt={item.name || "아이템"}
                width={size}
                height={size}
                onError={hideBrokenImage}
                className="rounded"
              />
            ) : (
              "—"
            )}
          </span>
        );
      })}
    </div>
  );
}

export function LolBuildIcons({
  player,
  size = 20,
}: {
  player?: LolPlayer;
  size?: number;
}) {
  const icons = [
    player?.spells?.[0],
    player?.spells?.[1],
    player?.runes?.keystone,
    player?.runes?.subStyle,
  ];

  return (
    <div className="grid shrink-0 grid-cols-2 gap-0.5">
      {icons.map((icon, index) => {
        const label =
          icon?.name ?? (index < 2 ? "소환사 주문 미제공" : "룬 미제공");
        const image = icon?.image;
        const src = image
          ? index < 2
            ? `https://ddragon.leagueoflegends.com/cdn/16.21.1/img/spell/${image}`
            : `https://ddragon.leagueoflegends.com/cdn/img/${image}`
          : null;
        return (
          <span
            key={index}
            title={label}
            aria-label={label}
            data-testid={
              index < 2
                ? `lol-player-spell-${index}`
                : `lol-player-rune-${index - 1}`
            }
            className="grid place-items-center overflow-hidden rounded-sm bg-zinc-800 text-[8px]"
            style={{ width: size, height: size }}
          >
            {src ? (
              <img
                src={src}
                alt=""
                width={size}
                height={size}
                onError={hideBrokenImage}
                className="rounded-sm"
              />
            ) : (
              "—"
            )}
          </span>
        );
      })}
    </div>
  );
}

export default function LolMatchCard({
  match,
  ownRiotId,
  expanded,
  onToggle,
  onSearch,
}: Props) {
  const teams = [...(match.details?.teams ?? [])].sort(
    (a, b) => a.teamId - b.teamId,
  );
  const players = teams.flatMap((team) => team.participants);
  const ownId = ownRiotId.toLocaleLowerCase();
  const isOwn = (riotId: string) => riotId.toLocaleLowerCase() === ownId;
  const ownPlayer = players.find((player) => isOwn(player.riotId));
  const ratio = formatKdaRatio(match.kills, match.deaths, match.assists);

  return (
    <article
      data-testid="lol-match-card"
      className={`@container/match min-w-0 rounded-xl border p-3 tabular-nums ${match.win ? "border-blue-950 bg-blue-950/30" : "border-red-950 bg-red-950/25"}`}
    >
      <div
        className="grid min-w-0 grid-cols-[82px_minmax(0,1fr)_32px] items-center gap-x-2 gap-y-2
          @min-[560px]/match:grid-cols-[82px_minmax(0,1fr)_152px_32px]
          @min-[900px]/match:grid-cols-[82px_minmax(100px,1fr)_minmax(205px,1.6fr)_152px_minmax(150px,1.4fr)_32px]"
      >
        <div className="flex items-center gap-2">
          <span className="relative h-10 w-10 shrink-0">
            <img
              src={`https://ddragon.leagueoflegends.com/cdn/16.21.1/img/champion/${match.championImageId}.png`}
              alt=""
              width={40}
              height={40}
              onError={hideBrokenImage}
              className="h-10 w-10 rounded-lg"
            />
            {ownPlayer?.championLevel && (
              <small className="absolute -bottom-1 -right-1 rounded bg-black px-1 text-[8px]">
                {ownPlayer.championLevel}
              </small>
            )}
          </span>
          <LolBuildIcons player={ownPlayer} size={16} />
        </div>
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
            <b
              className={`text-xs ${match.win ? "text-blue-300" : "text-red-300"}`}
            >
              {match.win == null ? "미제공" : match.win ? "승리" : "패배"}
            </b>
            <span className="truncate text-sm font-semibold">
              {match.championNameKo}
            </span>
          </div>
          <span className="block truncate text-[10px] text-zinc-500">
            {getQueueLabel(match.queueId, match.gameMode)} ·{" "}
            {formatDuration(match.gameDuration)}
          </span>
          <time
            title={formatAbsoluteTime(match.gameEndTimestamp)}
            className="block text-[10px] text-zinc-500"
          >
            {formatRelativeTime(match.gameEndTimestamp)}
          </time>
        </div>

        <div
          data-testid="lol-match-metrics"
          className="col-span-2 row-start-2 flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1
            text-[10px] text-zinc-400 @min-[560px]/match:col-span-3
            @min-[900px]/match:col-span-1 @min-[900px]/match:col-start-3 @min-[900px]/match:row-start-1 @min-[900px]/match:block"
        >
          <span className="whitespace-nowrap text-sm font-bold text-zinc-100">
            {match.kills ?? "미제공"}/{match.deaths ?? "미제공"}/{match.assists ?? "미제공"} ·{" "}
            {ratio}
          </span>
          <div className="contents @min-[900px]/match:mt-1 @min-[900px]/match:flex @min-[900px]/match:flex-wrap
            @min-[900px]/match:gap-x-2 @min-[900px]/match:gap-y-1">
            <span data-testid="lol-match-metric" className="whitespace-nowrap">
              관여 {formatPercent(match.killParticipationPct)}
            </span>
            <span data-testid="lol-match-metric" className="whitespace-nowrap">
              CS {formatMetric(match.cs)} ({formatMetric(match.csPerMinute, 1)}/분)
            </span>
            <span data-testid="lol-match-metric" className="whitespace-nowrap">
              골드/분 {formatMetric(match.goldPerMinute)}
            </span>
          </div>
        </div>

        <div
          data-testid="lol-match-items"
          className="col-span-2 row-start-3 @min-[560px]/match:col-span-1 @min-[560px]/match:col-start-3
            @min-[560px]/match:row-start-1 @min-[900px]/match:col-start-4"
        >
          <LolItemSlots player={ownPlayer} />
        </div>
        <button
          type="button"
          aria-expanded={expanded}
          aria-controls={`lol-detail-${match.matchId}`}
          aria-label={expanded ? "상세 접기" : "경기 상세 보기"}
          onClick={onToggle}
          className="col-start-3 row-span-3 row-start-1 -my-3 -mr-3 flex min-h-16 self-stretch
            items-center justify-center rounded-r-xl border border-zinc-700 bg-zinc-950/30
            text-blue-300 hover:bg-white/5 @min-[560px]/match:col-start-4 @min-[560px]/match:row-span-2
            @min-[900px]/match:col-start-6 @min-[900px]/match:row-span-1"
        >
          {expanded ? (
            <ChevronUp aria-hidden="true" size={20} />
          ) : (
            <ChevronDown aria-hidden="true" size={20} />
          )}
        </button>

        <div
          data-testid="lol-match-player-groups"
          className="hidden min-w-0 grid-cols-2 gap-2 text-[10px] leading-[14px]
            @min-[900px]/match:col-start-5 @min-[900px]/match:row-start-1 @min-[900px]/match:grid"
        >
          {teams.map((team) => (
            <div
              key={team.teamId}
              className="grid min-w-0 grid-cols-1 content-start gap-0.5"
            >
              <span className="text-zinc-600">
                {team.teamId === 100 ? "블루팀" : "레드팀"}
              </span>
              {team.participants.map((player, index) => (
                <button
                  key={`${player.riotId}-${index}`}
                  data-testid="lol-match-player"
                  type="button"
                  onClick={() => onSearch(player.riotId, player.ref)}
                  disabled={player.riotId === "Riot ID 미제공"}
                  className={`min-w-0 truncate text-left disabled:cursor-default ${isOwn(player.riotId) ? "font-bold text-amber-300" : "text-zinc-400 hover:text-zinc-100"}`}
                >
                  {player.riotId}
                </button>
              ))}
            </div>
          ))}
        </div>
      </div>

      <LolMatchDetail
        match={match}
        teams={teams}
        isOwn={isOwn}
        onSearch={onSearch}
        expanded={expanded}
      />
    </article>
  );
}
