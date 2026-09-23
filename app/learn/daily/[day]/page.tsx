import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { ArrowLeft, Crosshair, Gauge, MapPinned, Trophy } from "lucide-react";
import { getDailyRankerStory } from "@/lib/learn/dailyStories";
import { DailyEvidenceLink } from "@/components/learn/DailyEvidenceLink";

export const dynamic = "force-dynamic";

function formatDate(date: string) {
  const [year, month, day] = date.split("-");
  return year && month && day ? `${year}.${month}.${day}` : date;
}

function formatTime(seconds: number) {
  const minutes = Math.floor(seconds / 60);
  const remainder = seconds % 60;
  return `${String(minutes).padStart(2, "0")}:${String(remainder).padStart(2, "0")}`;
}

const factKindNames: Record<string, string> = {
  landing: "착지", vehicle: "이동", kill: "개인 처치", teammate_kill: "팀원 처치",
  teammate_death: "팀원 사망", fight: "교전", zone: "자기장",
};

export async function generateMetadata({ params }: PageProps<"/learn/daily/[day]">): Promise<Metadata> {
  const { day } = await params;
  const story = await getDailyRankerStory(day);
  return story
    ? { title: `${story.headline} | 전날 경기 분석 | BGMS`, description: story.conclusion }
    : { title: "전날 경기 분석 | BGMS" };
}

export default async function DailyRankerStoryPage({ params }: PageProps<"/learn/daily/[day]">) {
  const { day } = await params;
  const story = await getDailyRankerStory(day);
  if (!story) notFound();

  const facts = [...story.facts].sort((a, b) => a.timeSeconds - b.timeSeconds);
  const killEvents = [...story.killEvents].sort((a, b) => a.timeSeconds - b.timeSeconds);
  const detailedKillsAreLong = killEvents.length > 8;
  const factIds = new Set(facts.map((fact) => fact.id));
  const evidenceIds = [...new Set(story.points.flatMap((point) => point.evidenceIds))];

  return (
    <main className="mx-auto max-w-4xl px-4 py-6 pb-28 text-zinc-100 sm:px-8 sm:py-10">
      <Link href="/learn/daily" className="inline-flex min-h-11 items-center gap-2 text-sm font-medium text-emerald-300 hover:text-emerald-200">
        <ArrowLeft size={17} /> 전날 경기 목록
      </Link>

      <header className="mt-5 border-b border-zinc-800 pb-7">
        <p className="text-sm font-semibold text-emerald-300">전날 경기 분석 · {formatDate(story.dayKst)} 경기 (KST)</p>
        <h1 className="mt-2 break-words text-3xl font-bold leading-tight tracking-tight sm:text-4xl">{story.headline}</h1>
        <p className="mt-3 break-all text-sm text-zinc-400">{story.nickname} · {story.mode === "solo" ? "솔로" : "스쿼드"} · {story.mapName} · {formatDate(story.dayKst)} 경기</p>
        <div className="mt-5 flex flex-wrap gap-x-5 gap-y-2 text-sm text-zinc-300">
          <span className="inline-flex items-center gap-2"><Trophy size={16} className="text-amber-300" />AS 리더보드 {story.leaderboardRank}위</span>
          <span className="inline-flex items-center gap-2"><Crosshair size={16} className="text-emerald-300" />{story.kills}킬</span>
          <span className="inline-flex items-center gap-2"><Gauge size={16} className="text-emerald-300" />{story.damage.toLocaleString("ko-KR")} 대미지</span>
          {story.mode === "squad" ? <span>팀 처치 {story.teamKills}</span> : null}
        </div>
        <p className="mt-3 text-xs leading-5 text-zinc-500">AS 리더보드 조회 순위입니다. 모드별 순위로 확인된 값은 아닙니다.</p>
      </header>

      <section className="mt-7 rounded-2xl border border-emerald-400/30 bg-emerald-400/5 p-5 sm:p-6" aria-labelledby="conclusion-heading">
        <p className="text-xs font-semibold uppercase tracking-[0.16em] text-emerald-300">AI가 고른 주요 사건</p>
        <h2 id="conclusion-heading" className="mt-2 text-lg font-bold">기록으로 본 우승 과정</h2>
        <p className="mt-3 break-words text-sm leading-7 text-zinc-200">{story.conclusion}</p>
        <ol className="mt-5 space-y-4">
          {story.points.map((point, index) => (
            <li key={`${index}-${point.text}`} className="min-w-0 border-t border-zinc-800/80 pt-4">
              <p className="break-words text-sm leading-7 text-zinc-200">{point.text}</p>
              {point.evidenceIds.length > 0 ? (
                <p className="mt-2 flex flex-wrap gap-x-3 gap-y-1 text-xs">
                  {point.evidenceIds.map((id) => factIds.has(id) ? <DailyEvidenceLink key={id} id={id} /> : <span key={id} className="text-zinc-500">기록 {id}</span>)}
                </p>
              ) : <p className="mt-2 text-xs text-zinc-500">연결된 세부 기록이 없습니다.</p>}
            </li>
          ))}
        </ol>
        {evidenceIds.length > 0 && evidenceIds.some((id) => !factIds.has(id)) ? <p className="mt-3 text-xs leading-5 text-zinc-500">일부 근거 식별자는 요약된 경기 기록을 가리킵니다.</p> : null}
      </section>

      <details id="daily-facts" className="mt-8 rounded-2xl border border-zinc-800 bg-zinc-900/40 px-5 py-4" aria-labelledby="facts-heading">
        <summary id="facts-heading" className="min-h-11 cursor-pointer text-base font-bold leading-11 text-zinc-200">경기 흐름 · 세부 이벤트 {facts.length}건 펼치기</summary>
        {facts.length ? (
          <ol className="mt-2 divide-y divide-zinc-800">
            {facts.map((fact) => (
              <li key={fact.id} id={fact.id} className="grid min-w-0 scroll-mt-24 grid-cols-[3.5rem_minmax(0,1fr)] gap-3 py-4">
                <span className="pt-0.5 font-mono text-xs text-emerald-300">{formatTime(fact.timeSeconds)}</span>
                <div className="min-w-0"><p className="text-[11px] font-semibold tracking-wide text-zinc-500">{factKindNames[fact.kind] ?? "기록"}</p><p className="mt-1 break-words text-sm leading-6 text-zinc-200">{fact.text}</p></div>
              </li>
            ))}
          </ol>
        ) : <p className="mt-4 text-sm text-zinc-400">표시할 상세 기록이 없습니다.</p>}
      </details>

      <section className="mt-8 grid min-w-0 gap-6 sm:grid-cols-2">
        <div className="min-w-0 rounded-2xl border border-zinc-800 bg-zinc-900/40 p-5">
          <h2 className="font-bold">개인 처치 귀속 무기</h2>
          {story.weapons.length ? <ul className="mt-3 divide-y divide-zinc-800">{story.weapons.map((weapon) => <li key={weapon.name} className="flex min-w-0 items-center justify-between gap-3 py-3 text-sm"><span className="break-words text-zinc-300">{weapon.name}</span><span className="shrink-0 font-semibold text-zinc-100">{weapon.kills}킬</span></li>)}</ul> : <p className="mt-3 text-sm text-zinc-400">표시할 무기 기록이 없습니다.</p>}
        </div>
        <div className="min-w-0 rounded-2xl border border-zinc-800 bg-zinc-900/40 p-5">
          <h2 className="inline-flex items-center gap-2 font-bold"><MapPinned size={17} className="text-emerald-300" />자기장 관측</h2>
          {story.zones.length ? <ol className="mt-3 divide-y divide-zinc-800">{story.zones.map((zone) => <li key={`${zone.phase}-${zone.observedSeconds}`} className="min-w-0 py-3 text-sm"><p className="font-semibold text-zinc-200">{zone.phase}페이즈 · 관측 {formatTime(zone.observedSeconds)}</p><p className="mt-1 break-words text-xs leading-5 text-zinc-400">{zone.outsideMeters === null ? "원 밖 거리 기록 없음" : zone.outsideMeters > 0 ? `원 경계 밖 약 ${Math.round(zone.outsideMeters)}m` : "관측 시 원 안"}{zone.firstInsideSeconds === null ? " · 원 안 첫 관측 기록 없음" : ` · 원 안 첫 관측 ${formatTime(zone.firstInsideSeconds)}`}</p></li>)}</ol> : <p className="mt-3 text-sm text-zinc-400">표시할 자기장 관측 기록이 없습니다.</p>}
        </div>
      </section>

      {killEvents.length ? (
        <section className="mt-8" aria-labelledby="kills-heading">
          <h2 id="kills-heading" className="text-xl font-bold">처치 기록</h2>
          {detailedKillsAreLong ? (
            <details className="mt-3 rounded-xl border border-zinc-800 px-4">
              <summary className="flex min-h-12 cursor-pointer items-center text-sm font-medium text-zinc-300">상세 처치 {killEvents.length}건 펼치기</summary>
              <KillList events={killEvents} />
            </details>
          ) : <KillList events={killEvents} />}
        </section>
      ) : null}

      {story.limitations.length ? (
        <section className="mt-8 rounded-2xl border border-zinc-800 bg-zinc-900/50 p-5" aria-labelledby="limits-heading">
          <h2 id="limits-heading" className="text-sm font-bold text-zinc-200">분석에서 확정할 수 없는 점</h2>
          <ul className="mt-2 list-disc space-y-1.5 pl-5 text-xs leading-6 text-zinc-400">{story.limitations.map((limitation, index) => <li key={`${index}-${limitation}`} className="break-words">{limitation}</li>)}</ul>
        </section>
      ) : null}

      <Link href="/learn/daily" className="mt-6 inline-flex min-h-11 items-center gap-2 text-sm font-medium text-emerald-300 hover:text-emerald-200"><ArrowLeft size={16} /> 다른 날짜 경기 보기</Link>
    </main>
  );
}

function KillList({ events }: { events: { timeSeconds: number; victim: string; weapon: string }[] }) {
  return <ol className="divide-y divide-zinc-800">{events.map((event, index) => <li key={`${event.timeSeconds}-${event.victim}-${index}`} className="grid min-w-0 grid-cols-[3.5rem_minmax(0,1fr)] gap-3 py-3 text-sm"><span className="font-mono text-xs text-emerald-300">{formatTime(event.timeSeconds)}</span><span className="min-w-0 break-words text-zinc-300">{event.victim} · {event.weapon}</span></li>)}</ol>;
}
