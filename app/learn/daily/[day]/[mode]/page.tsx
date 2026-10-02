import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { ArrowLeft, Crosshair, Gauge } from "lucide-react";
import { getDailyRankerStory, type DailyMode } from "@/lib/learn/dailyStories";
import { buildDailyWalkthrough } from "@/lib/learn/dailyWalkthrough";
import { formatLessonTime } from "@/lib/learn/lessons";
import DailySceneViewer from "@/components/learn/DailySceneViewer";
import DailyLegacyDetail from "@/components/learn/DailyLegacyDetail";
import { formatObservedAt } from "@/components/learn/DailyStoryList";

export const dynamic = "force-dynamic";
type Props = { params: Promise<{ day: string; mode: string }> };
const MODES: DailyMode[] = ["solo", "duo", "squad"];
const MODE_NAMES: Record<DailyMode, string> = { solo: "솔로", duo: "듀오", squad: "스쿼드" };
const MAP_IDS: Record<string, string> = {
  erangel: "Erangel", baltic_main: "Erangel", 에란겔: "Erangel",
  miramar: "Miramar", desert_main: "Miramar", 미라마: "Miramar",
  taego: "Taego", tiger_main: "Taego", 태이고: "Taego",
  rondo: "Rondo", neon_main: "Rondo", 론도: "Rondo",
  vikendi: "Vikendi", dino_main: "Vikendi", 비켄디: "Vikendi",
  deston: "Deston", kiki_main: "Deston", 데스턴: "Deston",
  sanhok: "Sanhok", savage_main: "Sanhok", 사녹: "Sanhok",
  karakin: "Karakin", summerland_main: "Karakin", 카라킨: "Karakin",
  paramo: "Paramo", chimera_main: "Paramo", 파라모: "Paramo",
  haven: "Haven", heaven_main: "Haven", 헤이븐: "Haven",
};
function formatDate(value: string) {
  const [year, month, day] = value.split("-");
  return `${year}.${month}.${day}`;
}
function mapId(name: string) {
  return MAP_IDS[name.toLowerCase()] ?? name;
}
function validMode(value: string): value is DailyMode {
  return MODES.includes(value as DailyMode);
}

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { day, mode } = await params;
  if (!validMode(mode)) return { title: "전날 경기 분석 | BGMS" };
  const story = await getDailyRankerStory(day, mode);
  if (!story) return { title: "전날 경기 분석 | BGMS" };
  const walkthrough = story.scenes?.length ? buildDailyWalkthrough(story) : undefined;
  return { title: `${walkthrough?.headline ?? story.headline} | ${MODE_NAMES[mode]} 경기 분석 | BGMS`, description: walkthrough?.summary ?? story.conclusion };
}

export default async function DailyModePage({ params }: Props) {
  const { day, mode } = await params;
  if (!validMode(mode)) notFound();
  const story = await getDailyRankerStory(day, mode);
  if (!story) notFound();
  if (!Array.isArray(story.scenes) || story.scenes.length === 0) return <DailyLegacyDetail story={story} />;
  const walkthrough = buildDailyWalkthrough(story);
  const lookupTime = story.leaderboardObservedAt ? `${formatObservedAt(story.leaderboardObservedAt)} 조회` : "조회 날짜 기록 없음";

  return <main className="mx-auto w-full min-w-0 max-w-6xl px-4 py-6 pb-28 text-zinc-100 sm:px-8 sm:py-10">
    <Link href="/learn/daily" className="inline-flex min-h-11 items-center gap-2 text-sm font-medium text-emerald-300"><ArrowLeft size={17} /> 날짜·모드별 경기 목록</Link>
    <header className="mt-3 border-b border-zinc-800 pb-4">
      <p className="text-sm font-semibold text-emerald-300">{formatDate(story.dayKst)} 경기 (한국 시간) · 스팀 경쟁전 {MODE_NAMES[mode]}</p>
      <h1 className="mt-2 break-words text-2xl font-bold leading-tight tracking-tight sm:text-4xl">{walkthrough.headline}</h1>
      <p className="mt-3 max-w-4xl break-words text-sm leading-6 text-zinc-200">{walkthrough.summary}</p>
      <p className="mt-3 break-words text-xs text-zinc-400">{story.nickname} · {story.mapName}</p>
      <div className="mt-2 flex flex-wrap gap-x-4 gap-y-2 text-sm text-zinc-300">
        <span className="inline-flex items-center gap-2"><Crosshair size={16} className="text-emerald-300" />개인 {story.kills}킬</span>
        <span className="inline-flex items-center gap-2"><Gauge size={16} className="text-emerald-300" />{story.damage.toLocaleString("ko-KR")} 대미지</span>
        {mode !== "solo" && <span>팀 합계 {story.teamKills}킬</span>}
      </div>
    </header>
    <section className="mt-6" aria-label="우승 경기 장면 복기">
      <h2 className="text-lg font-bold">장면별 핵심</h2>
      <p className="mb-3 mt-1 text-sm text-zinc-400">본인은 분석 대상 선수이며, 팀원·상대 번호는 경기 내내 같습니다.</p>
      <DailySceneViewer scenes={walkthrough.chapters} highlights={walkthrough.highlights} combatScenes={walkthrough.combatScenes} overview={walkthrough.overview} mapId={mapId(story.mapName)} />
    </section>
    {walkthrough.takeaways.length > 0 && <section className="mt-8" aria-label="이 경기의 운영 핵심">
      <h2 className="text-lg font-bold">이 경기의 운영 핵심</h2>
      <ul className="mt-3 divide-y divide-zinc-800">{walkthrough.takeaways.slice(0, 3).map((takeaway, index) => <li key={`${takeaway.title}-${index}`} className="py-3">
        <h3 className="text-sm font-semibold text-emerald-300">{takeaway.title}</h3>
        <p className="mt-1 break-words text-sm leading-6 text-zinc-300">{takeaway.text}</p>
      </li>)}</ul>
    </section>}
    <section className="mt-8">
      <details className="rounded-xl border border-zinc-800 px-4">
        <summary className="flex min-h-12 cursor-pointer items-center text-sm font-semibold text-zinc-300">전체 경기 기록 {story.facts.length}건 보기</summary>
        <ol className="divide-y divide-zinc-800">{story.facts.map((fact) => <li key={fact.id} className="grid grid-cols-[3.5rem_minmax(0,1fr)] gap-3 py-3 text-sm"><span className="font-mono text-xs text-emerald-300">{formatLessonTime(fact.timeSeconds)}</span><span className="break-words text-zinc-300">{fact.text}</span></li>)}</ol>
      </details>
    </section>
    <details className="mt-4 rounded-xl border border-zinc-800 px-4 text-xs text-zinc-400">
      <summary className="flex min-h-11 cursor-pointer items-center font-semibold">순위 정보와 경기 출처</summary>
      <div className="space-y-2 pb-4 leading-5">
        <p>AS {story.leaderboardRank}위 · {lookupTime}</p>
        <p>{[story.leaderboardSeason, story.leaderboardSource].filter(Boolean).join(" · ")}</p>
        <p>조회 시점의 순위이며 경기 당시 순위를 뜻하지 않습니다.</p>
        {mode !== "solo" && story.roster?.length ? <p className="break-words">팀원: {story.roster.map((member) => member.name).join(" · ")}</p> : null}
      </div>
    </details>
  </main>;
}
