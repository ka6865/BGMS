import type { DailyRankerStory } from "@/lib/learn/dailyStories";
import type { DailyEncounterAction, DailyWeaponFind } from "@/lib/learn/dailyCombatStory";

function time(seconds: number) {
  const value = Math.round(seconds);
  return `${String(Math.floor(value / 60)).padStart(2, "0")}:${String(value % 60).padStart(2, "0")}`;
}

function range(meters: number | null) {
  return meters === null ? "" : ` · 약 ${meters < 20 ? meters : Math.round(meters / 5) * 5}m`;
}

function actionText(action: DailyEncounterAction, allies: Set<string>) {
  if (action.kind === "first_hit") {
    return `첫 확인 피해: ${allies.has(action.actor) ? "아군 " : "상대 "}${action.actor} · ${action.weapon} → ${allies.has(action.victim) ? "아군 " : "상대 "}${action.victim}${range(action.distanceMeters)}`;
  }
  if (action.kind === "ally_down") return `아군 ${action.victim} 기절 · 상대 ${action.actor} · ${action.weapon}${range(action.distanceMeters)}`;
  if (action.kind === "knock") return `아군 ${action.actor} → 상대 ${action.victim} 기절 · ${action.weapon}${range(action.distanceMeters)}`;
  return allies.has(action.actor)
    ? `아군 ${action.actor} → 상대 ${action.victim} 처치 · ${action.weapon}${range(action.distanceMeters)}`
    : `아군 ${action.victim} 사망 · 상대 ${action.actor} · ${action.weapon}${range(action.distanceMeters)}`;
}

function sourceText(find: DailyWeaponFind) {
  if (find.source === "carepackage") return "보급 상자에서 획득";
  if (find.source === "lootbox") return `${find.owner ?? "다른 선수"}의 전리품 상자에서 획득`;
  if (find.source === "vehicle") return "차량 트렁크에서 획득";
  return "일반 줍기 기록 · 정확한 출처는 확인되지 않음";
}

function firedWeapons(weapons: string[]) {
  if (weapons.length <= 3) return weapons.join(" → ");
  return `${[...new Set(weapons)].join("·")}를 번갈아 발사 · 마지막 ${weapons.at(-2)} → ${weapons.at(-1)}`;
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
          <h2 className="mt-1 text-xl font-bold">상대 팀별 교전</h2>
          <p className="mt-2 text-sm leading-6 text-zinc-400">같은 팀으로 확인된 상대를 묶었습니다. 먼저 본 사람이나 먼저 방아쇠를 당긴 사람은 알 수 없어, 처음 확인된 피해부터 보여줍니다.</p>
          <ol className="mt-4 space-y-4">
            {encounters.map((encounter, index) => {
              const visible = encounter.actions.slice(0, 8);
              const rest = encounter.actions.slice(8);
              return <li key={encounter.id} className="min-w-0 rounded-2xl border border-zinc-800 bg-zinc-900/40 p-4 sm:p-5">
                <p className="text-xs font-semibold text-emerald-300">{String(index + 1).padStart(2, "0")} · {time(encounter.startSeconds)}~{time(encounter.endSeconds)} · 아군 {encounter.teamKills}킬</p>
                <h3 className="mt-1 break-words text-base font-bold leading-6">상대 팀: {encounter.opponents.join(" · ")}</h3>
                <p className="mt-1 break-words text-xs leading-5 text-zinc-400">교전에 기록된 아군: {encounter.allies.join(" · ")}</p>
                {encounter.arrival && <p className="mt-3 border-l-2 border-sky-500/60 pl-3 text-sm leading-6 text-zinc-300">{encounter.arrival}</p>}
                {encounter.vehicle && <p className="mt-2 text-xs leading-5 text-zinc-400">{encounter.vehicle}</p>}
                {encounter.precontactMovement?.length > 1 && <p className="mt-2 text-xs leading-5 text-zinc-400">첫 피해 직전 약 30초 동안 아군 위치 변화: {encounter.precontactMovement.map((move) => `${move.player} 약 ${move.meters}m`).join(" · ")}. 두 위치 기록 사이의 직선 거리로, 푸시나 방어 의도를 뜻하지는 않습니다.</p>}
                {index === 0 && finds.some((find) => find.player === story.nickname && find.timeSeconds <= encounter.endSeconds) && (
                  <p className="mt-2 text-sm leading-6 text-sky-200">랭커의 초반 무기 흐름: {finds.filter((find) => find.player === story.nickname && find.timeSeconds <= encounter.endSeconds && find.timeSeconds <= 240)
                    .map((find) => `${time(find.timeSeconds)} ${find.weapon} 획득`).join(" → ")}{encounter.firstRankerShot ? ` → ${time(encounter.firstRankerShot.timeSeconds)} ${encounter.firstRankerShot.weapon} 발사 확인` : ""}</p>
                )}
                {encounter.rankerWeapons.length > 0 && <p className="mt-2 text-sm leading-6 text-sky-200">랭커가 실제 쏜 총: {firedWeapons(encounter.rankerWeapons)}</p>}
                <ol className="mt-3 divide-y divide-zinc-800/80 border-t border-zinc-800/80">
                  {visible.map((action, actionIndex) => <li key={`${action.timeSeconds}-${action.kind}-${actionIndex}`} className="grid grid-cols-[3.1rem_minmax(0,1fr)] gap-2 py-2 text-xs leading-5">
                    <time className="font-mono tabular-nums text-zinc-500">{time(action.timeSeconds)}</time>
                    <span className="min-w-0 break-words text-zinc-300">{actionText(action, allyNames)}</span>
                  </li>)}
                </ol>
                {rest.length > 0 && <details className="mt-1 text-xs text-zinc-400"><summary className="min-h-11 cursor-pointer py-2">나머지 {rest.length}개 기록 보기</summary>
                  <ol className="divide-y divide-zinc-800/80">{rest.map((action, actionIndex) => <li key={`${action.timeSeconds}-${action.kind}-${actionIndex}`} className="grid grid-cols-[3.1rem_minmax(0,1fr)] gap-2 py-2 leading-5"><time className="font-mono tabular-nums">{time(action.timeSeconds)}</time><span className="break-words">{actionText(action, allyNames)}</span></li>)}</ol>
                </details>}
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
