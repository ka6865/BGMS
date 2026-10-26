import { useEffect, useRef, useState } from "react";
import type { LolMatchBuild, LolPlayerBuild } from "@/lib/lol/matchBuild";
import type { LolMatchDetails } from "@/lib/lol/riotSearch.server";

type Team = LolMatchDetails["teams"][number];
type Player = Team["participants"][number];

const SKILLS = ["Q", "W", "E", "R"] as const;
const BUILD_ERROR = "빌드를 불러오지 못했습니다.";

// 선택 키는 `팀ID:팀 안 순서`다. 빌드와 상세는 같은 경기 원문 순서로 만들어지므로 순서로 맞추고, 챔피언으로 한 번 더 확인한다.
function findPlayerBuild(build: LolMatchBuild, teams: Team[], selected: string): LolPlayerBuild | undefined {
  const [teamId, slot] = selected.split(":").map(Number);
  const player = teams.find((team) => team.teamId === teamId)?.participants[slot];
  if (!player) return undefined;
  const candidate = build.players.filter((entry) => entry.teamId === teamId)[slot];
  return candidate?.championId === player.championId ? candidate
    : build.players.find((entry) => entry.teamId === teamId && entry.championId === player.championId);
}

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
    <img loading="lazy" decoding="async"
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
          <>
            {/* 좁은 화면에서는 18레벨을 9칸씩 두 줄로 나눠 가로 스크롤 없이 보여 준다. */}
            <div className="grid gap-2 sm:hidden">
              {[0, 9].filter((start) => start < build.skills.length).map((start) => (
                <SkillTable key={start} skills={build.skills.slice(start, start + 9)} offset={start} />
              ))}
            </div>
            <div className="hidden overflow-x-auto sm:block">
              <SkillTable skills={build.skills} offset={0} />
            </div>
          </>
        ) : <p className="text-xs text-zinc-500">스킬 기록이 없습니다.</p>}
      </section>
    </div>
  );
}

function SkillTable({ skills, offset }: { skills: number[]; offset: number }) {
  return (
    <table className="border-separate border-spacing-0.5 text-[10px] tabular-nums">
      <tbody>
        {SKILLS.map((label, row) => (
          <tr key={label}>
            <th scope="row" className="w-5 pr-1 text-left font-semibold text-zinc-400">{label}</th>
            {skills.map((slot, index) => (
              <td
                key={index}
                className={`h-6 w-6 min-w-6 rounded-sm text-center ${slot === row + 1
                  ? row === 3 ? "bg-amber-500 font-bold text-zinc-950" : "bg-sky-500 font-bold text-zinc-950"
                  : "bg-zinc-800/70 text-transparent"}`}
              >
                {slot === row + 1 ? offset + index + 1 : ""}
              </td>
            ))}
          </tr>
        ))}
      </tbody>
    </table>
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
  // 같은 챔피언을 여럿 고르는 모드가 있어 챔피언 대신 팀 안 순서로 소환사를 고른다.
  const own = teams.flatMap((team) => team.participants.map((player, slot) => ({ team, player, slot })))
    .find(({ player }) => isOwn(player.riotId));
  const [selected, setSelected] = useState(own ? `${own.team.teamId}:${own.slot}` : teams[0] ? `${teams[0].teamId}:0` : "");
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
        // 프록시 오류처럼 JSON이 아닌 응답은 파싱 오류 문구 대신 기본 안내를 보여 준다.
        const payload = await response.json().catch(() => null);
        if (!response.ok) throw new Error(typeof payload?.error === "string" ? payload.error : BUILD_ERROR);
        if (!Array.isArray(payload?.players)) throw new Error(BUILD_ERROR);
        if (mounted.current) setState({ status: "ready", build: payload as LolMatchBuild });
      })
      .catch((error: unknown) => {
        if (mounted.current) setState({ status: "error", message: error instanceof Error ? error.message : BUILD_ERROR });
      });
  }, [active, apiBase, matchId, attempt]);

  const build = state.status === "ready" ? findPlayerBuild(state.build, teams, selected) : undefined;
  const [selectedTeamId, selectedSlot] = selected.split(":").map(Number);
  const selectedPlayer = teams.find((team) => team.teamId === selectedTeamId)?.participants[selectedSlot];

  return (
    <section data-testid="lol-match-build" aria-label="빌드" className="grid min-w-0 gap-4">
      <div role="radiogroup" aria-label="빌드를 볼 소환사" className="flex flex-wrap gap-x-4 gap-y-2">
        {teams.map((team) => (
          <div key={team.teamId} className="flex gap-1">
            {team.participants.map((player: Player, slot: number) => {
              const key = `${team.teamId}:${slot}`;
              return (
                <button
                  key={key}
                  type="button"
                  role="radio"
                  aria-checked={selected === key}
                  aria-label={`${player.riotId} · ${player.championNameKo}`}
                  title={`${player.riotId} · ${player.championNameKo}`}
                  onClick={() => setSelected(key)}
                  className={`grid h-11 w-11 place-items-center rounded-md ${selected === key ? team.teamId === 100 ? "ring-2 ring-blue-400" : "ring-2 ring-red-400" : "opacity-60 hover:opacity-100"}`}
                >
                  <img loading="lazy" decoding="async"
                    src={`https://ddragon.leagueoflegends.com/cdn/${dataDragonVersion}/img/champion/${player.championImageId}.png`}
                    alt=""
                    width={34}
                    height={34}
                    onError={(event) => { event.currentTarget.style.visibility = "hidden"; }}
                    className="h-[34px] w-[34px] rounded bg-zinc-800"
                  />
                </button>
              );
            })}
          </div>
        ))}
      </div>
      {selectedPlayer && (
        <p data-testid="lol-match-build-selected" className="min-w-0 truncate text-xs text-zinc-300">
          <b className="text-zinc-100">{selectedPlayer.riotId.split("#")[0]}</b> · {selectedPlayer.championNameKo}
        </p>
      )}
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
