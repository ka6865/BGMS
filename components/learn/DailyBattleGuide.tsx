import type { DailyRankerStory } from "@/lib/learn/dailyStories";
import type { DailyEncounterAction, DailyWeaponFind } from "@/lib/learn/dailyCombatStory";
import DailyEncounterSnapshots from "@/components/learn/DailyEncounterSnapshots";

function time(seconds: number) {
  const value = Math.round(seconds);
  return `${String(Math.floor(value / 60)).padStart(2, "0")}:${String(value % 60).padStart(2, "0")}`;
}

function range(meters: number | null) {
  return meters === null ? "" : ` · 약 ${meters < 20 ? meters : Math.round(meters / 5) * 5}m`;
}

function actionText(action: DailyEncounterAction, allies: Set<string>, isSquad: boolean) {
  const own = isSquad ? "아군" : "랭커";
  if (action.kind === "first_hit") {
    return `첫 확인 피해: ${allies.has(action.actor) ? `${own} ` : "상대 "}${action.actor} · ${action.weapon} → ${allies.has(action.victim) ? `${own} ` : "상대 "}${action.victim}${range(action.distanceMeters)}`;
  }
  if (action.kind === "ally_down") return `${own} ${action.victim} 기절 · 상대 ${action.actor} · ${action.weapon}${range(action.distanceMeters)}`;
  if (action.kind === "knock") return `${own} ${action.actor} → 상대 ${action.victim} 기절 · ${action.weapon}${range(action.distanceMeters)}`;
  return allies.has(action.actor)
    ? `${own} ${action.actor} → 상대 ${action.victim} 처치 · ${action.weapon}${range(action.distanceMeters)}`
    : `${own} ${action.victim} 사망 · 상대 ${action.actor} · ${action.weapon}${range(action.distanceMeters)}`;
}

function sourceText(find: DailyWeaponFind) {
  if (find.source === "carepackage") return "보급 상자에서 획득";
  if (find.source === "lootbox") return `${find.owner ?? "다른 선수"}의 전리품 상자에서 획득`;
  if (find.source === "vehicle") return "차량 트렁크에서 획득";
  return "일반 줍기 기록 · 정확한 출처는 확인되지 않음";
}

function firedWeapons(weapons: string[]) {
  return weapons.join(" → ");
}

export default function DailyBattleGuide({ story }: { story: DailyRankerStory }) {
  const encounters = story.encounters ?? [];
  const roster = story.roster ?? [];
  const finds = story.weaponFinds ?? [];
  if (!encounters.length && !roster.length && !finds.length) return null;
  const allyNames = new Set(roster.map((player) => player.name));
  const used = new Set((story.teamKillEvents ?? []).map((kill) => `${kill.killer}|${kill.weapon}`));
  const firstEnd = encounters[0]?.endSeconds ?? 180;
  const selectedFinds = finds.filter((find) =>
    find.source === "carepackage"
    || (find.source === "lootbox" && used.has(`${find.player}|${find.weapon}`))
    || (find.player === story.nickname && find.timeSeconds <= firstEnd && find.timeSeconds <= 240))
    .slice(0, 12);
  const participated = encounters.filter((encounter) => encounter.rankerWeapons.length > 0
    || encounter.actions.some((action) => action.actor === story.nickname && ["first_hit", "knock", "kill"].includes(action.kind))).length;
  const isSquad = story.mode === "squad";

  return (
    <section className="mt-8 space-y-5" aria-label="등장인물과 교전 해설">
      {story.mode === "squad" && roster.length > 0 && (
        <div className="rounded-2xl border border-sky-700/50 bg-sky-950/20 p-5">
          <p className="text-xs font-semibold text-sky-200">누가 우리 팀인가</p>
          <h2 className="mt-1 text-lg font-bold">랭커와 아군</h2>
          <ul className="mt-3 grid gap-2 sm:grid-cols-2">
            {roster.map((player) => <li key={player.name} className="flex min-w-0 flex-wrap items-center gap-x-2 rounded-lg bg-zinc-900/70 px-3 py-2 text-sm">
              <span className={`break-all font-semibold ${player.isRanker ? "text-emerald-200" : "text-zinc-200"}`}>{player.name}</span>
              <span className="text-xs text-zinc-400">{player.isRanker ? "분석 대상 랭커" : "아군"} · {player.kills}킬</span>
            </li>)}
          </ul>
        </div>
      )}

      {encounters.length > 0 && (
        <div>
          <p className="text-xs font-semibold text-emerald-300">03 · 누구와 어떻게 싸웠나</p>
          <h2 className="mt-1 text-xl font-bold">누구와 어떤 교전이 있었나</h2>
          <p className="mt-2 text-sm leading-6 text-zinc-400">{isSquad ? "같은 팀으로 확인된 상대를 묶었습니다. 상대 팀 번호는 이 경기 안에서만 유효합니다." : "교전에 직접 기록된 상대와 행동을 정리했습니다."} 먼저 발견했거나 먼저 쐈는지는 알 수 없어, 텔레메트리에 처음 기록된 피해부터 보여줍니다.</p>
          <ol className="mt-4 space-y-4">
            {encounters.map((encounter, index) => {
              const visible = encounter.actions.slice(0, 8);
              const rest = encounter.actions.slice(8);
              const rankerKills = encounter.actions.filter((action) => action.kind === "kill" && action.actor === story.nickname).length;
              const otherKills = Math.max(0, encounter.teamKills - rankerKills);
              const rankerHit = encounter.actions.some((action) => action.kind === "first_hit" && action.actor === story.nickname);
              const rankerWasHit = encounter.actions.some((action) => action.kind === "first_hit" && action.victim === story.nickname);
              const summary = rankerKills > 0
                ? `랭커가 직접 ${rankerKills}명을 처치${otherKills > 0 ? ` · 팀원 처치 ${otherKills}명` : ""}${encounter.rankerWeapons.length ? ` · 이 구간 기록된 사격: ${firedWeapons(encounter.rankerWeapons)}` : ""}`
                : encounter.rankerWeapons.length > 0
                  ? `랭커 사격 기록 있음 · 이 구간 기록된 사격: ${firedWeapons(encounter.rankerWeapons)}${encounter.teamKills > 0 ? ` · ${isSquad ? `팀원 처치 ${encounter.teamKills}명` : `랭커 처치 ${encounter.teamKills}명`}` : ""}`
                  : rankerHit || rankerWasHit
                    ? `랭커가 첫 기록 피해에 직접 등장${encounter.teamKills > 0 ? ` · ${isSquad ? "팀" : "랭커"} 처치 ${encounter.teamKills}명` : ""}`
                    : encounter.teamKills > 0
                      ? `${isSquad ? `팀원 처치 ${encounter.teamKills}명` : `랭커 처치 ${encounter.teamKills}명`} · 이 장면에 랭커 사격은 기록되지 않음`
                      : isSquad ? "랭커 사격·처치 기록 없이 아군 교전이 기록됨" : "랭커의 사격·처치는 기록되지 않음";
              return <li key={encounter.id} className="min-w-0 rounded-2xl border border-zinc-800 bg-zinc-900/40 p-4 sm:p-5">
                <p className="text-xs font-semibold text-emerald-300">{String(index + 1).padStart(2, "0")} · 기록된 교전 구간 {time(encounter.startSeconds)}~{time(encounter.endSeconds)} · {isSquad ? `아군 ${encounter.teamKills}킬` : `${encounter.teamKills}킬`}</p>
                <h3 className="mt-1 break-words text-base font-bold leading-6">{isSquad ? "상대 팀" : "상대"}: {encounter.opponents.join(" · ")}</h3>
                {isSquad && encounter.opponentIdentity?.teamId !== null && encounter.opponentIdentity?.teamId !== undefined && <p className="mt-1 text-xs text-zinc-500">이 경기 상대 팀 {encounter.opponentIdentity.teamId}</p>}
                <p className="mt-1 break-words text-xs leading-5 text-zinc-400">{isSquad ? `교전에 직접 등장한 아군: ${encounter.involvedAllies?.join(" · ") ?? encounter.allies.join(" · ")}${encounter.rosterAllies?.length ? ` · 전체 팀 ${encounter.rosterAllies.join(" · ")}` : ""}` : `교전에 직접 등장한 랭커: ${encounter.involvedAllies?.join(" · ") ?? encounter.allies.join(" · ")}`}</p>
                <p className="mt-2 rounded-lg bg-zinc-950/80 px-3 py-2 text-sm leading-5 text-zinc-200">{summary}</p>
                {encounter.reengagement?.isReengagement && <p className="mt-2 text-xs leading-5 text-sky-200">같은 경기 상대{isSquad ? " 팀" : ""}과 다시 기록된 교전입니다{encounter.reengagement.gapSeconds !== null ? ` · 앞선 기록 구간 뒤 약 ${Math.round(encounter.reengagement.gapSeconds)}초` : ""}.</p>}
                {encounter.overlapsWith?.length ? <p className="mt-2 text-xs leading-5 text-amber-200">다른 상대{isSquad ? " 팀" : " 선수"} 카드와 기록 시각이 겹칩니다. 두 교전 기록 구간이 겹친다는 뜻이며, 그 시간 내내 교전이 이어졌다는 뜻은 아닙니다.</p> : null}
                {encounter.arrival && <p className="mt-3 border-l-2 border-sky-500/60 pl-3 text-sm leading-6 text-zinc-300">{encounter.arrival}</p>}
                {encounter.vehicle && <p className="mt-2 text-xs leading-5 text-zinc-400">{encounter.vehicle}</p>}
                {encounter.precontactMovement?.length > 1 && <p className="mt-2 text-xs leading-5 text-zinc-400">첫 피해 직전 약 30초 동안 {isSquad ? "아군" : "랭커"} 위치 변화: {encounter.precontactMovement.map((move) => `${move.player} 약 ${move.meters}m`).join(" · ")}. 두 위치 기록 사이의 직선 거리로, 푸시나 방어 의도를 뜻하지는 않습니다.</p>}
                <DailyEncounterSnapshots snapshots={encounter.snapshots ?? []} ownSideLabel={isSquad ? "아군" : "랭커"} />
                {index === 0 && finds.some((find) => find.player === story.nickname && find.timeSeconds <= encounter.endSeconds) && (
                  <p className="mt-2 text-sm leading-6 text-sky-200">랭커의 초반 무기 흐름: {finds.filter((find) => find.player === story.nickname && find.timeSeconds <= encounter.endSeconds && find.timeSeconds <= 240)
                    .map((find) => `${time(find.timeSeconds)} ${find.weapon} 획득`).join(" → ")}{encounter.firstRankerShot ? ` → ${time(encounter.firstRankerShot.timeSeconds)} ${encounter.firstRankerShot.weapon} 발사 확인` : ""}</p>
                )}
                {encounter.rankerWeapons.length > 0 && <p className="mt-2 text-sm leading-6 text-sky-200">이 구간 기록된 랭커 사격: {firedWeapons(encounter.rankerWeapons)}</p>}
                <details className="mt-3 rounded-xl border border-zinc-800/80">
                  <summary className="min-h-11 cursor-pointer px-3 py-2.5 text-sm text-zinc-300">전투 기록 자세히 보기 · {encounter.actions.length}개</summary>
                  <ol className="divide-y divide-zinc-800/80 border-t border-zinc-800/80 px-3">
                    {visible.map((action, actionIndex) => <li key={`${action.timeSeconds}-${action.kind}-${actionIndex}`} className="grid grid-cols-[3.1rem_minmax(0,1fr)] gap-2 py-2 text-xs leading-5">
                      <time className="font-mono tabular-nums text-zinc-500">{time(action.timeSeconds)}</time>
                      <span className="min-w-0 break-words text-zinc-300">{actionText(action, allyNames, isSquad)}</span>
                    </li>)}
                    {rest.map((action, actionIndex) => <li key={`${action.timeSeconds}-${action.kind}-rest-${actionIndex}`} className="grid grid-cols-[3.1rem_minmax(0,1fr)] gap-2 py-2 text-xs leading-5">
                      <time className="font-mono tabular-nums text-zinc-500">{time(action.timeSeconds)}</time><span className="break-words text-zinc-300">{actionText(action, allyNames, isSquad)}</span>
                    </li>)}
                  </ol>
                </details>
              </li>;
            })}
          </ol>
          <p className="mt-3 text-xs leading-5 text-zinc-500">거리는 두 선수의 위치 사이 직선 거리입니다. 차량 탑승 여부는 첫 피해 당사자의 기록이며, 건물 안팎과 엄폐물은 확인할 수 없습니다.</p>
        </div>
      )}

      {selectedFinds.length > 0 && (
        <div className="rounded-2xl border border-zinc-800 bg-zinc-900/40 p-5">
          <p className="text-xs font-semibold text-amber-300">무기는 어디서 얻었나</p>
          <h2 className="mt-1 text-lg font-bold">주요 무기 획득 경로</h2>
          <ol className="mt-3 divide-y divide-zinc-800/80">
            {selectedFinds.map((find, index) => <li key={`${find.player}-${find.weapon}-${find.timeSeconds}-${index}`} className="grid grid-cols-[3.1rem_minmax(0,1fr)] gap-2 py-2.5 text-sm leading-6">
              <time className="font-mono text-xs tabular-nums text-zinc-500">{time(find.timeSeconds)}</time>
              <span className="min-w-0 break-words text-zinc-300"><strong className="text-zinc-100">{find.player}</strong> · {find.weapon} · {sourceText(find)}</span>
            </li>)}
          </ol>
          <p className="mt-3 text-xs leading-5 text-zinc-500">무기를 주운 기록과 실제 쏜 기록은 별개입니다. 획득만 확인된 총을 교전에 사용했다고 쓰지 않습니다.</p>
        </div>
      )}

      <p className="rounded-xl border border-zinc-800 bg-zinc-900/40 p-4 text-xs leading-6 text-zinc-400">
        이 경기에서 랭커의 사격이나 피해·처치가 기록된 교전은 {participated}개 구간입니다. 평소 교전을 좋아하는 성향인지는 한 경기만으로 판단할 수 없습니다.
      </p>
    </section>
  );
}
