import Link from "next/link";
import type { LolChampion } from "@/lib/lol/champions";
import { LOL_CHAMPION_TAG_LABELS } from "@/lib/lol/champions";
import {
  LOL_STAT_MIN_GAMES, LOL_STAT_POSITION_LABELS, LOL_STAT_TIER_FILTERS, lolRate,
  type LolStatBuildKind, type LolStatPosition,
} from "@/lib/lol/championStats";
import type { LolChampionDetailStats } from "@/lib/lol/championStats.server";
import type { LolBuildCatalog } from "@/lib/lol/riotSearch.server";

const CDN = "https://ddragon.leagueoflegends.com/cdn";
const MIN_MATCHUP_GAMES = 10;
const percent = (value: number | null) => value === null ? "—" : `${(value * 100).toFixed(1)}%`;
const signed = (value: number) => `${value > 0 ? "+" : ""}${Math.round(value).toLocaleString()}`;

function Icon({ src, label, size = 32, round = false }: { src: string | null; label: string; size?: number; round?: boolean }) {
  return <img loading="lazy" decoding="async" src={src ?? undefined} alt={label} title={label} width={size} height={size}
    className={`shrink-0 bg-zinc-800 ${round ? "rounded-full" : "rounded-md"}`} style={{ width: size, height: size }} />;
}

function Section({ title, note, children }: { title: string; note?: string; children: React.ReactNode }) {
  return <section aria-label={title} className="min-w-0 rounded-xl bg-zinc-900 p-4 ring-1 ring-zinc-800">
    <h2 className="text-sm font-semibold">{title}</h2>
    {note && <p className="mt-1 text-xs text-zinc-500">{note}</p>}
    <div className="mt-3">{children}</div>
  </section>;
}

export default function LolChampionDetail({ champion, champions, version, stats, catalog, position, tierFilter }: {
  champion: LolChampion; champions: LolChampion[]; version: string; stats: LolChampionDetailStats | null;
  catalog: LolBuildCatalog | null; position: LolStatPosition | null; tierFilter: string;
}) {
  const byId = new Map(champions.map(item => [item.id, item]));
  const lane = stats?.positions.find(item => item.team_position === position) ?? null;
  const builds = (kind: LolStatBuildKind) => (stats?.builds ?? []).filter(item => item.position === position && item.kind === kind);
  const item = (id: string) => ({ src: `${CDN}/${version}/img/item/${id}.png`, label: catalog?.items[id] ?? `아이템 ${id}` });
  const rune = (id: string) => catalog?.runes[id] ? { src: `${CDN}/img/${catalog.runes[id].icon}`, label: catalog.runes[id].name } : { src: null, label: `룬 ${id}` };
  const spell = (id: string) => catalog?.spells[id] ? { src: `${CDN}/${version}/img/spell/${catalog.spells[id].image}`, label: catalog.spells[id].name } : { src: null, label: `주문 ${id}` };
  const share = (games: number) => lane ? percent(lolRate(games, lane.games)) : "—";
  const rowStats = (games: number, wins: number) => <span className="ml-auto shrink-0 text-right text-xs tabular-nums text-zinc-400">
    <span className="block text-zinc-200">{games >= LOL_STAT_MIN_GAMES ? percent(lolRate(wins, games)) : "표본 부족"}</span>
    <span className="block">{share(games)} · {games.toLocaleString()}판</span>
  </span>;
  const list = (kind: LolStatBuildKind, limit: number, render: (value: string) => React.ReactNode, empty: string) => {
    const rows = builds(kind).slice(0, limit);
    return rows.length ? <ul className="space-y-2">{rows.map(row => <li key={row.value} className="flex min-w-0 items-center gap-2">
      <span className="flex min-w-0 flex-wrap items-center gap-1">{render(row.value)}</span>{rowStats(row.games, row.wins)}
    </li>)}</ul> : <p className="text-xs text-zinc-500">{empty}</p>;
  };
  const timelineNote = stats && stats.matches ? `구매·스킬 기록을 받은 ${stats.timelineMatches.toLocaleString()}경기 기준` : undefined;
  const matchups = (stats?.matchups ?? []).filter(row => row.position === position && row.games >= MIN_MATCHUP_GAMES && byId.has(row.opponent))
    .map(row => ({ ...row, winRate: row.wins / row.games }));
  const easy = [...matchups].sort((a, b) => b.winRate - a.winRate).slice(0, 5);
  const hard = [...matchups].sort((a, b) => a.winRate - b.winRate).slice(0, 5);
  const href = (next: { tier?: string; position?: string }) =>
    `/lol/kr/champions/${champion.imageId.toLowerCase()}?tier=${next.tier ?? tierFilter}${(next.position ?? position) ? `&position=${next.position ?? position}` : ""}`;

  return <main className="mx-auto w-full max-w-5xl space-y-5 px-4 py-6 text-zinc-100">
    <Link href={`/lol/kr/champions?tier=${tierFilter}${position ? `&position=${position}` : ""}`} className="inline-flex min-h-9 items-center text-sm text-zinc-400 hover:text-zinc-100">← 챔피언 목록</Link>
    <header className="flex items-center gap-4">
      <Icon src={`${CDN}/${version}/img/champion/${champion.imageId}.png`} label="" size={72} />
      <div className="min-w-0">
        <h1 className="text-xl font-bold">{champion.name}</h1>
        <p className="truncate text-sm text-zinc-400">{champion.title}</p>
        <p className="text-xs text-zinc-500">{champion.tags.map(tag => LOL_CHAMPION_TAG_LABELS[tag]).join(" · ")}</p>
      </div>
    </header>
    <nav aria-label="티어" className="flex gap-1.5 overflow-x-auto pb-1">
      {LOL_STAT_TIER_FILTERS.map(filter => <Link key={filter.id} href={href({ tier: filter.id })} aria-current={tierFilter === filter.id ? "true" : undefined} scroll={false}
        className={`inline-flex min-h-9 shrink-0 items-center rounded-lg px-3 text-[13px] font-semibold ${tierFilter === filter.id
          ? "bg-zinc-100 text-zinc-950" : "bg-zinc-900 text-zinc-400 ring-1 ring-zinc-800 hover:text-zinc-100"}`}>{filter.label}</Link>)}
    </nav>
    {!stats && <p role="status" className="text-sm text-amber-300">챔피언 통계를 불러오지 못했습니다. 잠시 후 다시 확인해 주세요.</p>}
    {stats && !stats.positions.length && <p className="text-sm text-zinc-400">이 조건의 표본을 모으는 중입니다.</p>}
    {stats && stats.positions.length > 0 && <>
      <nav aria-label="포지션" className="flex flex-wrap gap-1.5">
        {stats.positions.map(item => <Link key={item.team_position} href={href({ position: item.team_position })} scroll={false}
          aria-current={item.team_position === position ? "page" : undefined}
          className={`inline-flex min-h-9 items-center rounded-lg px-3 text-[13px] font-semibold ${item.team_position === position
            ? "bg-amber-400 text-zinc-950" : "bg-zinc-900 text-zinc-300 ring-1 ring-zinc-800 hover:bg-zinc-800"}`}>
          {LOL_STAT_POSITION_LABELS[item.team_position]} <span className="ml-1 text-[11px] opacity-70">{percent(lolRate(item.games, stats.positions.reduce((sum, row) => sum + row.games, 0)))}</span>
        </Link>)}
      </nav>
      {lane && <section aria-label="요약" className="grid grid-cols-2 gap-2 sm:grid-cols-4">
        {[
          ["승률", lane.games >= LOL_STAT_MIN_GAMES ? percent(lolRate(lane.wins, lane.games)) : "표본 부족"],
          ["픽률", percent(lolRate(lane.games, stats.matches))],
          ["밴률", percent(lolRate(stats.bans, stats.matches))],
          ["판수", lane.games.toLocaleString()],
          ["평균 KDA", `${(lane.kills / lane.games).toFixed(1)} / ${(lane.deaths / lane.games).toFixed(1)} / ${(lane.assists / lane.games).toFixed(1)}`],
          ["분당 CS", lane.duration_seconds ? (lane.cs * 60 / lane.duration_seconds).toFixed(1) : "—"],
          ["분당 피해량", lane.duration_seconds ? Math.round(lane.damage * 60 / lane.duration_seconds).toLocaleString() : "—"],
          ["15분 골드 차이", lane.gd15_count >= LOL_STAT_MIN_GAMES ? signed(lane.gd15_sum / lane.gd15_count) : "표본 부족"],
        ].map(([label, value]) => <div key={label} className="min-w-0 rounded-lg bg-zinc-900 px-3 py-2 ring-1 ring-zinc-800">
          <p className="text-[11px] text-zinc-500">{label}</p>
          <p className="truncate text-base font-semibold tabular-nums">{value}</p>
        </div>)}
      </section>}
      <p className="text-xs text-zinc-500">{stats.patch} 패치 · 솔로 랭크 {stats.matches.toLocaleString()}경기 표본. 비율 아래 줄은 이 포지션 판수 대비 선택 비율과 판수입니다.</p>
      <div className="grid gap-3 md:grid-cols-2">
        <Section title="룬">
          {list("runes", 3, value => {
            const [primary, secondary] = value.split("|");
            const [primaryStyle, primaryPerks] = primary.split(":");
            const [secondaryStyle, secondaryPerks] = (secondary ?? "").split(":");
            return <>
              {[primaryStyle, ...(primaryPerks ?? "").split(",")].map((id, index) => { const icon = rune(id); return <Icon key={`p${index}`} {...icon} size={index === 1 ? 32 : 24} round />; })}
              <span className="mx-1 h-5 w-px bg-zinc-700" />
              {[secondaryStyle, ...(secondaryPerks ?? "").split(",")].map((id, index) => { const icon = rune(id); return <Icon key={`s${index}`} {...icon} size={22} round />; })}
            </>;
          }, "룬 표본이 없습니다.")}
        </Section>
        <Section title="소환사 주문">
          {list("spells", 3, value => value.split(",").map(id => { const icon = spell(id); return <Icon key={id} {...icon} />; }), "주문 표본이 없습니다.")}
        </Section>
        <Section title="시작 아이템" note={timelineNote}>
          {list("start_items", 3, value => value.split("+").map((id, index) => { const icon = item(id); return <Icon key={`${id}-${index}`} {...icon} />; }), "구매 기록 표본이 없습니다.")}
        </Section>
        <Section title="코어 빌드" note={timelineNote}>
          {list("core_items", 5, value => value.split(">").map((id, index) => { const icon = item(id); return <span key={id} className="flex items-center gap-1">
            {index > 0 && <span className="text-zinc-600">›</span>}<Icon {...icon} />
          </span>; }), "구매 기록 표본이 없습니다.")}
        </Section>
        <Section title="스킬 순서" note={timelineNote}>
          {list("skill_order", 3, value => value.split(">").map((key, index) => <span key={key} className="flex items-center gap-1">
            {index > 0 && <span className="text-zinc-600">›</span>}
            <span className="inline-flex size-8 items-center justify-center rounded-md bg-zinc-800 text-sm font-bold">{key}</span>
          </span>), "스킬 기록 표본이 없습니다.")}
        </Section>
        <Section title="신발">
          {list("boots", 3, value => { const icon = item(value); return <><Icon {...icon} /><span className="truncate text-xs text-zinc-300">{icon.label}</span></>; }, "신발 표본이 없습니다.")}
        </Section>
        <Section title="많이 가는 아이템" note="경기 종료 시점 인벤토리 기준">
          {list("item", 8, value => { const icon = item(value); return <><Icon {...icon} /><span className="truncate text-xs text-zinc-300">{icon.label}</span></>; }, "아이템 표본이 없습니다.")}
        </Section>
        <Section title="라인 상대" note={`같은 포지션 상대와 ${MIN_MATCHUP_GAMES}판 이상 만난 경우`}>
          {matchups.length ? <div className="grid grid-cols-2 gap-3">
            {([["상대하기 쉬움", easy], ["상대하기 어려움", hard]] as const).map(([label, rows]) => <div key={label} className="min-w-0">
              <h3 className="text-xs text-zinc-400">{label}</h3>
              <ul className="mt-2 space-y-2">{rows.map(row => { const opponent = byId.get(row.opponent)!; return <li key={row.opponent}>
                <Link href={`/lol/kr/champions/${opponent.imageId.toLowerCase()}?tier=${tierFilter}&position=${position}`} className="flex min-w-0 items-center gap-2 hover:text-amber-300">
                  <Icon src={`${CDN}/${version}/img/champion/${opponent.imageId}.png`} label="" size={28} />
                  <span className="min-w-0 flex-1 truncate text-xs">{opponent.name}</span>
                  <span className="shrink-0 text-right text-xs tabular-nums">
                    <span className="block">{percent(row.winRate)}</span>
                    <span className="block text-zinc-500">{row.games}판</span>
                  </span>
                </Link>
              </li>; })}</ul>
            </div>)}
          </div> : <p className="text-xs text-zinc-500">상대 표본이 아직 부족합니다.</p>}
        </Section>
      </div>
    </>}
  </main>;
}
