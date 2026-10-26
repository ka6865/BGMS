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
  apiBase?: string;
};

function hideBrokenImage(event: React.SyntheticEvent<HTMLImageElement>) {
  event.currentTarget.hidden = true;
}

export function LolItemSlots({
  player,
  size = 20,
  dataDragonVersion,
  slotClassName,
}: {
  player?: LolPlayer;
  size?: number;
  dataDragonVersion?: string;
  // 지정하면 고정 size 대신 이 클래스로 칸 크기를 정한다(반응형 표에서 사용).
  slotClassName?: string;
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
            className={`grid place-items-center rounded bg-zinc-800 text-[8px] text-zinc-500 ${slotClassName ?? ""}`}
            style={slotClassName ? undefined : { width: size, height: size }}
          >
            {item?.id ? (
              <img
                src={`https://ddragon.leagueoflegends.com/cdn/${dataDragonVersion}/img/item/${item.id}.png`}
                alt={item.name || "아이템"}
                width={size}
                height={size}
                onError={hideBrokenImage}
                className={slotClassName ? "h-full w-full rounded" : "rounded"}
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
  dataDragonVersion,
}: {
  player?: LolPlayer;
  size?: number;
  dataDragonVersion?: string;
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
            ? `https://ddragon.leagueoflegends.com/cdn/${dataDragonVersion}/img/spell/${image}`
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

const MULTI_KILLS: Record<number, { label: string; style: string }> = {
  2: { label: "더블킬", style: "bg-sky-500/20 text-sky-200 ring-sky-400/40" },
  3: { label: "트리플킬", style: "bg-violet-500/25 text-violet-200 ring-violet-400/50" },
  4: { label: "쿼드라킬", style: "bg-rose-500/25 text-rose-200 ring-rose-400/50" },
  5: { label: "펜타킬", style: "bg-amber-400/25 text-amber-200 ring-amber-300/60" },
};

function MultiKillBadge({ count }: { count?: number }) {
  // 펜타킬 뒤 추가 처치도 펜타킬로 묶어 표시한다.
  const badge = count && count >= 2 ? MULTI_KILLS[Math.min(count, 5)] : undefined;
  if (!badge) return null;
  return (
    <span data-testid="lol-multikill" className={`inline-block rounded-full px-2 py-0.5 text-[10px] font-bold ring-1 ${badge.style}`}>
      {badge.label}
    </span>
  );
}

export const lolScoreRankLabel = (rank: number) => `${rank}${rank === 1 ? "st" : rank === 2 ? "nd" : rank === 3 ? "rd" : "th"}`;
const ordinal = lolScoreRankLabel;

export function LolScoreBadge({ player }: { player?: LolPlayer }) {
  const score = player?.score;
  if (!score) return null;
  const style = score.award === "MVP" ? "bg-amber-400/25 text-amber-200 ring-amber-300/60"
    : score.award === "ACE" ? "bg-violet-500/25 text-violet-200 ring-violet-400/50" : "bg-zinc-700/60 text-zinc-200 ring-zinc-500/40";
  return (
    <span
      data-testid="lol-score-badge"
      title={`BGMS 점수(시험판) ${score.score.toFixed(1)} · 경기 내 ${score.rank}위`}
      className={`inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[10px] font-bold ring-1 ${style}`}
    >
      <span className="tabular-nums">{score.score.toFixed(1)}</span>
      <span>{score.award ?? ordinal(score.rank)}</span>
    </span>
  );
}

function ChampionThumb({ player, dataDragonVersion }: { player: LolPlayer; dataDragonVersion?: string }) {
  return (
    <img
      src={`https://ddragon.leagueoflegends.com/cdn/${dataDragonVersion}/img/champion/${player.championImageId}.png`}
      alt=""
      width={18}
      height={18}
      onError={(event) => {
        event.currentTarget.style.visibility = "hidden";
      }}
      className="h-[18px] w-[18px] shrink-0 rounded-sm bg-zinc-800"
    />
  );
}

export default function LolMatchCard({
  match,
  ownRiotId,
  expanded,
  onToggle,
  onSearch,
  apiBase,
}: Props) {
  const dataDragonVersion = match.dataDragonVersion;
  const teams = [...(match.details?.teams ?? [])].sort(
    (a, b) => a.teamId - b.teamId,
  );
  const players = teams.flatMap((team) => team.participants);
  const ownId = ownRiotId.toLocaleLowerCase();
  const isOwn = (riotId: string) => riotId.toLocaleLowerCase() === ownId;
  const ownPlayer = players.find((player) => isOwn(player.riotId));
  const ratio = formatKdaRatio(match.kills, match.deaths, match.assists);
  // 다시하기는 승패 집계에서 빠지므로 승리·패배와 다른 색으로 구분한다.
  const tone = match.remake
    ? { card: "border-zinc-700/70 bg-zinc-800/50", bar: "bg-zinc-500", label: "text-zinc-300", button: "bg-zinc-700/40 text-zinc-300", text: "다시하기" }
    : match.win
      ? { card: "border-blue-900/60 bg-[#1e2a44]", bar: "bg-blue-500", label: "text-blue-300", button: "bg-blue-900/40 text-blue-300", text: "승리" }
      : { card: "border-red-900/60 bg-[#3a1f26]", bar: "bg-red-500", label: "text-red-300", button: "bg-red-900/40 text-red-300", text: match.win == null ? "미제공" : "패배" };

  return (
    <article
      data-testid="lol-match-card"
      className={`@container/match min-w-0 overflow-hidden rounded-xl border tabular-nums ${tone.card}`}
    >
      <div className="flex min-w-0">
        <span aria-hidden="true" className={`w-1.5 shrink-0 ${tone.bar}`} />
        <div className="grid min-w-0 flex-1 grid-cols-[minmax(0,1fr)] gap-y-2 py-2.5 pl-3 pr-2
          @min-[560px]/match:grid-cols-[88px_auto_minmax(0,1fr)] @min-[560px]/match:items-center @min-[560px]/match:gap-x-4
          @min-[900px]/match:grid-cols-[88px_auto_112px_150px_minmax(0,1fr)]">
          <div className="flex min-w-0 items-baseline gap-2 @min-[560px]/match:row-span-2 @min-[560px]/match:block">
            <p className={`truncate text-xs font-bold ${tone.label}`}>
              {getQueueLabel(match.queueId, match.gameMode)}
            </p>
            <time
              title={formatAbsoluteTime(match.gameEndTimestamp)}
              className="text-[11px] text-zinc-400 @min-[560px]/match:block"
            >
              {formatRelativeTime(match.gameEndTimestamp)}
            </time>
            <span aria-hidden="true" className="hidden @min-[560px]/match:my-1.5 @min-[560px]/match:block @min-[560px]/match:h-px @min-[560px]/match:w-10 @min-[560px]/match:bg-white/15" />
            <b className={`text-xs ${tone.label} @min-[560px]/match:block @min-[560px]/match:text-zinc-200`}>{tone.text}</b>
            <span className="text-[11px] text-zinc-400 @min-[560px]/match:block">
              {formatDuration(match.gameDuration)}
            </span>
          </div>

          <div className="flex min-w-0 items-center gap-3 @min-[560px]/match:col-start-2 @min-[560px]/match:row-start-1">
            <div className="flex items-center gap-1.5">
              <span className="relative h-12 w-12 shrink-0">
                <img
                  src={`https://ddragon.leagueoflegends.com/cdn/${dataDragonVersion}/img/champion/${match.championImageId}.png`}
                  alt={match.championNameKo}
                  title={match.championNameKo}
                  width={48}
                  height={48}
                  onError={hideBrokenImage}
                  className="h-12 w-12 rounded-full"
                />
                {ownPlayer?.championLevel && (
                  <small className="absolute -bottom-0.5 -right-0.5 grid h-5 min-w-5 place-items-center rounded-full bg-zinc-950 px-1 text-[10px] font-semibold">
                    {ownPlayer.championLevel}
                  </small>
                )}
              </span>
              <LolBuildIcons dataDragonVersion={dataDragonVersion} player={ownPlayer} size={22} />
              <div className="ml-2 min-w-0 @min-[900px]/match:hidden">
                <p className="whitespace-nowrap text-base font-bold">
                  {match.kills ?? "—"} / <span className="text-red-400">{match.deaths ?? "—"}</span> / {match.assists ?? "—"}
                </p>
                <p className="text-[11px] text-zinc-400">{ratio} 평점</p>
                <div className="mt-0.5 flex flex-wrap gap-1">
                  <LolScoreBadge player={ownPlayer} />
                  <MultiKillBadge count={match.largestMultiKill} />
                </div>
              </div>
            </div>
          </div>
          <div data-testid="lol-match-items" className="@min-[560px]/match:col-start-2 @min-[560px]/match:row-start-2 @min-[560px]/match:-mt-1">
            <LolItemSlots dataDragonVersion={dataDragonVersion} player={ownPlayer} size={22} />
          </div>

          <div className="hidden text-center @min-[900px]/match:col-start-3 @min-[900px]/match:row-span-2 @min-[900px]/match:row-start-1 @min-[900px]/match:block">
            <p className="whitespace-nowrap text-lg font-bold">
              {match.kills ?? "—"} / <span className="text-red-400">{match.deaths ?? "—"}</span> / {match.assists ?? "—"}
            </p>
            <p className="text-xs text-zinc-400">{ratio} 평점</p>
            <div className="mt-1 flex flex-wrap justify-center gap-1">
              <LolScoreBadge player={ownPlayer} />
              <MultiKillBadge count={match.largestMultiKill} />
            </div>
          </div>

          <div
            data-testid="lol-match-metrics"
            className="flex min-w-0 flex-wrap gap-x-3 gap-y-0.5 text-[11px] text-zinc-300
              @min-[560px]/match:col-start-3 @min-[560px]/match:row-span-2 @min-[560px]/match:row-start-1 @min-[560px]/match:block
              @min-[900px]/match:col-start-4 @min-[900px]/match:border-l @min-[900px]/match:border-white/10 @min-[900px]/match:pl-3"
          >
            <span data-testid="lol-match-metric" className="block whitespace-nowrap">
              관여 {formatPercent(match.killParticipationPct)}
            </span>
            <span data-testid="lol-match-metric" className="block whitespace-nowrap">
              CS {formatMetric(match.cs)} ({formatMetric(match.csPerMinute, 1)}/분)
            </span>
            <span data-testid="lol-match-metric" className="block whitespace-nowrap">
              골드/분 {formatMetric(match.goldPerMinute)}
            </span>
            {ownPlayer?.score && (
              <span
                data-testid="lol-match-score-line"
                title="BGMS 자체 지표(시험판): 인분은 우리 팀 평균 대비 기여, 팀운은 나를 뺀 팀원과 상대 팀의 골드·피해·KDA 비교"
                className="block whitespace-nowrap text-zinc-400"
              >
                인분 <b className="text-zinc-100">{ownPlayer.score.inbun.toFixed(2)}</b> · 팀운{" "}
                <b className={ownPlayer.score.teamLuck === "최고" || ownPlayer.score.teamLuck === "좋음" ? "text-sky-300"
                  : ownPlayer.score.teamLuck === "보통" ? "text-zinc-100" : "text-rose-300"}>{ownPlayer.score.teamLuck}</b>
              </span>
            )}
          </div>

          {/* 좁은 카드(모바일)에서는 10명 목록을 숨겨 카드 높이를 줄인다. 참가자는 상세 종합 탭에서 볼 수 있다. */}
          <div
            data-testid="lol-match-player-groups"
            className="hidden min-w-0 grid-cols-2 gap-x-3 text-[11px] leading-[18px]
              @min-[560px]/match:col-span-3 @min-[560px]/match:grid @min-[900px]/match:col-span-1 @min-[900px]/match:col-start-5 @min-[900px]/match:row-span-2 @min-[900px]/match:row-start-1 @min-[900px]/match:self-center"
          >
            {teams.map((team) => (
              <div
                key={team.teamId}
                aria-label={team.teamId === 100 ? "블루팀" : "레드팀"}
                className="grid min-w-0 content-start gap-0.5"
              >
                {team.participants.map((player, index) => {
                  const [gameName, tagLine] = player.riotId.split("#");
                  return (
                    <button
                      key={`${player.riotId}-${index}`}
                      data-testid="lol-match-player"
                      type="button"
                      title={`${player.riotId} · ${player.championNameKo}`}
                      onClick={() => onSearch(player.riotId, player.ref)}
                      disabled={player.riotId === "Riot ID 미제공"}
                      className={`flex min-w-0 items-center gap-1.5 text-left disabled:cursor-default ${isOwn(player.riotId) ? "font-bold text-amber-300" : "text-zinc-400 hover:text-zinc-100"}`}
                    >
                      <ChampionThumb player={player} dataDragonVersion={dataDragonVersion} />
                      <span className="min-w-0 truncate">
                        {gameName}
                        {tagLine !== undefined && <span className="sr-only">#{tagLine}</span>}
                      </span>
                    </button>
                  );
                })}
              </div>
            ))}
          </div>
        </div>
        <button
          type="button"
          aria-expanded={expanded}
          aria-controls={`lol-detail-${match.matchId}`}
          aria-label={expanded ? "상세 접기" : "경기 상세 보기"}
          onClick={onToggle}
          className={`flex w-9 shrink-0 items-end justify-center pb-3 hover:brightness-125 @min-[560px]/match:w-11 ${tone.button}`}
        >
          {expanded ? (
            <ChevronUp aria-hidden="true" size={20} />
          ) : (
            <ChevronDown aria-hidden="true" size={20} />
          )}
        </button>
      </div>

      <div className={expanded ? "px-3 pb-3" : undefined}>
        <LolMatchDetail
          match={match}
          teams={teams}
          isOwn={isOwn}
          onSearch={onSearch}
          expanded={expanded}
          apiBase={apiBase}
        />
      </div>
    </article>
  );
}
