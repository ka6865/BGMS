import type { LolMatchDetails } from "@/lib/lol/riotSearch.server";
import { formatMetric } from "./lolFormat";

type Team = LolMatchDetails["teams"][number];
type Player = Team["participants"][number];

const METRICS = [
  ["챔피언 처치", (player: Player) => player.kills],
  ["골드 획득량", (player: Player) => player.goldEarned],
  ["챔피언에게 가한 피해량", (player: Player) => player.damageToChampions],
  ["와드 설치", (player: Player) => player.wardsPlaced],
  ["받은 피해량", (player: Player) => player.damageTaken],
  ["CS", (player: Player) => player.cs],
] as const;

const sum = (values: Array<number | null>) =>
  values.reduce<number>((total, value) => total + (value ?? 0), 0);

function Donut({ left, right }: { left: number; right: number }) {
  const total = left + right;
  // 원둘레를 100으로 맞춰 블루팀 비율을 그대로 dasharray에 사용한다.
  const blue = total > 0 ? (left / total) * 100 : 50;
  return (
    <div className="relative h-[84px] w-[84px] shrink-0 sm:h-24 sm:w-24">
      <svg viewBox="0 0 36 36" className="h-full w-full -rotate-90" aria-hidden>
        <circle
          cx="18"
          cy="18"
          r="15.9155"
          fill="none"
          strokeWidth="3.4"
          className="stroke-red-500"
        />
        <circle
          cx="18"
          cy="18"
          r="15.9155"
          fill="none"
          strokeWidth="3.4"
          strokeDasharray={`${blue} ${100 - blue}`}
          className="stroke-blue-500"
        />
      </svg>
      <div className="absolute inset-0 grid place-content-center text-center text-[11px] font-bold leading-tight tabular-nums sm:text-xs">
        <span className="text-blue-400">{formatMetric(left)}</span>
        <span className="mx-auto my-0.5 h-px w-8 bg-zinc-700" />
        <span className="text-red-400">{formatMetric(right)}</span>
      </div>
    </div>
  );
}

function PlayerBars({
  players,
  pick,
  max,
  color,
  imageUrl,
  isOwn,
}: {
  players: Player[];
  pick: (player: Player) => number | null;
  max: number;
  color: string;
  imageUrl: (player: Player) => string;
  isOwn: (riotId: string) => boolean;
}) {
  return (
    <ul className="grid min-w-0 flex-1 gap-1">
      {players.map((player, index) => {
        const value = pick(player);
        const width =
          value === null || max <= 0 ? 0 : Math.min(100, (value / max) * 100);
        return (
          <li
            key={`${player.riotId}-${index}`}
            title={`${player.riotId} · ${player.championNameKo}: ${formatMetric(value)}`}
            className="flex min-w-0 items-center gap-1"
          >
            <img loading="lazy" decoding="async"
              src={imageUrl(player)}
              alt=""
              width={18}
              height={18}
              onError={(event) => {
                event.currentTarget.style.visibility = "hidden";
              }}
              className={`h-[18px] w-[18px] shrink-0 rounded-sm bg-zinc-800 ${isOwn(player.riotId) ? "ring-1 ring-amber-300" : ""}`}
            />
            <div className="relative h-[18px] min-w-0 flex-1 overflow-hidden rounded-sm bg-zinc-800">
              <div
                className={`h-full ${color}`}
                style={{ width: `${width}%` }}
              />
              <span className="absolute inset-y-0 right-1 flex items-center text-[10px] font-semibold tabular-nums text-white [text-shadow:0_1px_1px_rgb(0_0_0/0.8)]">
                {formatMetric(value)}
              </span>
            </div>
          </li>
        );
      })}
    </ul>
  );
}

export default function LolTeamAnalysis({
  teams,
  dataDragonVersion,
  isOwn,
}: {
  teams: Team[];
  dataDragonVersion?: string;
  isOwn: (riotId: string) => boolean;
}) {
  if (teams.length !== 2)
    return (
      <p className="text-xs text-zinc-400">
        팀 정보가 부족해 비교할 수 없습니다.
      </p>
    );
  const [blue, red] = teams;
  const imageUrl = (player: Player) =>
    `https://ddragon.leagueoflegends.com/cdn/${dataDragonVersion}/img/champion/${player.championImageId}.png`;
  const side = (team: Team) =>
    `${team.teamId === 100 ? "블루팀" : "레드팀"} · ${team.win ? "승리" : "패배"}`;

  return (
    <section
      data-testid="lol-team-analysis"
      aria-label="팀 분석"
      className="min-w-0"
    >
      <p className="mb-3 flex justify-center gap-4 text-[11px] text-zinc-400">
        <span>
          <i className="mr-1 inline-block h-2 w-2 rounded-full bg-blue-500 align-middle" />
          {side(blue)}
        </span>
        <span>
          <i className="mr-1 inline-block h-2 w-2 rounded-full bg-red-500 align-middle" />
          {side(red)}
        </span>
      </p>
      <div className="grid min-w-0 gap-x-6 gap-y-5 @min-[860px]/history:grid-cols-2">
        {METRICS.map(([label, pick]) => {
          const max = Math.max(
            0,
            ...[...blue.participants, ...red.participants].map(
              (player) => pick(player) ?? 0,
            ),
          );
          return (
            <section key={label} aria-label={label} className="min-w-0">
              <h4 className="mb-2 text-center text-xs font-bold">{label}</h4>
              <div className="flex min-w-0 items-center gap-2">
                <PlayerBars
                  players={blue.participants}
                  pick={pick}
                  max={max}
                  color="bg-blue-500"
                  imageUrl={imageUrl}
                  isOwn={isOwn}
                />
                <Donut
                  left={sum(blue.participants.map(pick))}
                  right={sum(red.participants.map(pick))}
                />
                <PlayerBars
                  players={red.participants}
                  pick={pick}
                  max={max}
                  color="bg-red-500"
                  imageUrl={imageUrl}
                  isOwn={isOwn}
                />
              </div>
            </section>
          );
        })}
      </div>
    </section>
  );
}
