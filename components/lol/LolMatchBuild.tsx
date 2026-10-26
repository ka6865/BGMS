import { useEffect, useRef, useState } from "react";
import type { LolMatchBuild, LolPlayerBuild } from "@/lib/lol/matchBuild";
import type { LolMatchDetails } from "@/lib/lol/riotSearch.server";

type Team = LolMatchDetails["teams"][number];
type Player = Team["participants"][number];

const SKILLS = ["Q", "W", "E", "R"] as const;

// 스킬을 먼저 5레벨(궁극기는 3레벨)까지 올린 순서로 선마 순서를 만든다.
function skillPriority(skills: number[]): string[] {
  const counts = [0, 0, 0, 0];
  const done: number[] = [];
  for (const slot of skills) {
    counts[slot - 1] += 1;
    if (slot !== 4 && counts[slot - 1] === 5 && !done.includes(slot)) done.push(slot);
  }
  for (const slot of skills) if (slot !== 4 && !done.includes(slot)) done.push(slot);
  return done.map((slot) => SKILLS[slot - 1]);
}

function ItemIcon({ id, version }: { id: number; version?: string }) {
  return (
    <img
      src={`https://ddragon.leagueoflegends.com/cdn/${version}/img/item/${id}.png`}
      alt=""
      width={28}
      height={28}
      onError={(event) => { event.currentTarget.style.visibility = "hidden"; }}
      className="h-7 w-7 rounded bg-zinc-800"
    />
  );
}

function PlayerBuild({ build, version }: { build: LolPlayerBuild; version?: string }) {
  const priority = skillPriority(build.skills);
  return (
    <div className="grid min-w-0 gap-5">
      <section aria-label="아이템 빌드" className="min-w-0">
        <h4 className="mb-2 text-xs font-semibold text-amber-300">아이템 빌드</h4>
        {build.items.length ? (
          <ol className="flex flex-wrap items-start gap-x-1 gap-y-3">
            {build.items.map((step, index) => (
              <li key={`${step.minute}-${index}`} className="flex items-start gap-1">
                {index > 0 && <span aria-hidden="true" className="mt-1.5 text-zinc-600">›</span>}
                <div className="grid justify-items-center gap-1 rounded-md bg-zinc-950/50 px-1.5 py-1">
                  <div className="flex gap-0.5">
                    {step.items.map((item, itemIndex) => <ItemIcon key={`${item}-${itemIndex}`} id={item} version={version} />)}
                  </div>
                  <span className="text-[10px] text-zinc-500 tabular-nums">{step.minute}분</span>
                </div>
              </li>
            ))}
          </ol>
        ) : <p className="text-xs text-zinc-500">구매 기록이 없습니다.</p>}
      </section>
      <section aria-label="스킬 순서" className="min-w-0">
        <div className="mb-2 flex flex-wrap items-baseline gap-x-3 gap-y-1">
          <h4 className="text-xs font-semibold text-amber-300">스킬 순서</h4>
          {priority.length > 0 && (
            <p className="text-xs font-semibold text-zinc-200">
              {priority.map((skill, index) => <span key={skill}>{index > 0 && <span className="mx-1 text-zinc-600">›</span>}{skill}</span>)}
            </p>
          )}
        </div>
        {build.skills.length ? (
          <div className="overflow-x-auto">
            <table className="border-separate border-spacing-0.5 text-[10px] tabular-nums">
              <tbody>
                {SKILLS.map((label, row) => (
                  <tr key={label}>
                    <th scope="row" className="w-5 pr-1 text-left font-semibold text-zinc-400">{label}</th>
                    {build.skills.map((slot, level) => (
                      <td
                        key={level}
                        className={`h-5 w-5 min-w-5 rounded-sm text-center ${slot === row + 1
                          ? row === 3 ? "bg-amber-500 font-bold text-zinc-950" : "bg-sky-500 font-bold text-zinc-950"
                          : "bg-zinc-800/70 text-transparent"}`}
                      >
                        {slot === row + 1 ? level + 1 : ""}
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : <p className="text-xs text-zinc-500">스킬 기록이 없습니다.</p>}
      </section>
    </div>
  );
}

export default function LolMatchBuildPanel({ matchId, apiBase, teams, isOwn, dataDragonVersion, active }: {
  matchId: string;
  apiBase: string;
  teams: Team[];
  isOwn: (riotId: string) => boolean;
  dataDragonVersion?: string;
  active: boolean;
}) {
  const own = teams.flatMap((team) => team.participants.map((player) => ({ team, player })))
    .find(({ player }) => isOwn(player.riotId));
  const [selected, setSelected] = useState(own ? `${own.team.teamId}:${own.player.championId}` : "");
  const [state, setState] = useState<{ status: "loading" | "error"; message?: string } | { status: "ready"; build: LolMatchBuild }>({ status: "loading" });

  const [attempt, setAttempt] = useState(0);
  const requested = useRef(-1);
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; };
  }, []);
  useEffect(() => {
    // 빌드 탭을 처음 열 때(또는 다시 시도할 때)만 타임라인을 요청하고, 탭을 옮겨도 응답은 반영한다.
    if (!active || requested.current === attempt) return;
    requested.current = attempt;
    void fetch(`${apiBase}/matches/${encodeURIComponent(matchId)}/build`, { cache: "no-store" })
      .then(async (response) => {
        const payload = await response.json();
        if (!response.ok) throw new Error(typeof payload?.error === "string" ? payload.error : "빌드를 불러오지 못했습니다.");
        if (mounted.current) setState({ status: "ready", build: payload as LolMatchBuild });
      })
      .catch((error: unknown) => {
        if (mounted.current) setState({ status: "error", message: error instanceof Error ? error.message : "빌드를 불러오지 못했습니다." });
      });
  }, [active, apiBase, matchId, attempt]);

  const build = state.status === "ready"
    ? state.build.players.find((player) => `${player.teamId}:${player.championId}` === selected) : undefined;

  return (
    <section data-testid="lol-match-build" aria-label="빌드" className="grid min-w-0 gap-4">
      <div role="radiogroup" aria-label="빌드를 볼 소환사" className="flex flex-wrap gap-x-4 gap-y-2">
        {teams.map((team) => (
          <div key={team.teamId} className="flex gap-1">
            {team.participants.map((player: Player) => {
              const key = `${team.teamId}:${player.championId}`;
              return (
                <button
                  key={key}
                  type="button"
                  role="radio"
                  aria-checked={selected === key}
                  aria-label={`${player.riotId} · ${player.championNameKo}`}
                  title={`${player.riotId} · ${player.championNameKo}`}
                  onClick={() => setSelected(key)}
                  className={`rounded-md p-0.5 ${selected === key ? team.teamId === 100 ? "ring-2 ring-blue-400" : "ring-2 ring-red-400" : "opacity-60 hover:opacity-100"}`}
                >
                  <img
                    src={`https://ddragon.leagueoflegends.com/cdn/${dataDragonVersion}/img/champion/${player.championImageId}.png`}
                    alt=""
                    width={28}
                    height={28}
                    onError={(event) => { event.currentTarget.style.visibility = "hidden"; }}
                    className="h-7 w-7 rounded bg-zinc-800"
                  />
                </button>
              );
            })}
          </div>
        ))}
      </div>
      {state.status === "ready" ? build
        ? <PlayerBuild build={build} version={dataDragonVersion} />
        : <p className="text-xs text-zinc-500">선택한 소환사의 빌드 기록이 없습니다.</p>
        : state.status === "error"
          ? (
            <p role="alert" className="text-xs text-rose-300">
              {state.message}{" "}
              <button type="button" onClick={() => { setState({ status: "loading" }); setAttempt((value) => value + 1); }} className="ml-1 underline">다시 시도</button>
            </p>
          )
          : <p role="status" className="text-xs text-zinc-400">빌드를 불러오는 중…</p>}
    </section>
  );
}
