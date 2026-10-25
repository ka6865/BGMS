import Link from "next/link";
import LolLegalNotice from "./LolLegalNotice";
import type { LolPlatformStatus } from "@/lib/lol/status";

export default function LolStatusView({ status }: { status: LolPlatformStatus }) {
  return <main className="mx-auto w-full max-w-4xl space-y-5 break-words px-4 py-6 text-zinc-100">
    <header><h1 className="text-xl font-bold">LoL 한국 서버 상태</h1>
      <nav aria-label="LoL 공개 메뉴" className="mt-2 flex flex-wrap gap-4 text-sm text-sky-300">
        <Link href="/lol/kr" className="inline-flex min-h-11 items-center">전적 검색</Link>
        <Link href="/lol/kr/ladder" className="inline-flex min-h-11 items-center">랭크 컷 기록</Link>
      </nav>
    </header>
    <p role="status" className="text-sm text-zinc-300">{!status.available ? "현재 서버 상태를 확인할 수 없습니다. 잠시 후 다시 확인해 주세요."
      : status.stale ? "최신 상태를 확인하지 못했습니다. 아래는 마지막 확인 시점의 공지입니다."
        : status.items.length ? "진행 중이거나 예정된 서버 공지가 있습니다." : "현재 등록된 점검·장애 공지가 없습니다."}</p>
    {status.fetchedAt && <p className="text-xs text-zinc-400">마지막 확인: {new Date(status.fetchedAt).toLocaleString("ko-KR", { timeZone: "Asia/Seoul" })} KST · 5분 캐시</p>}
    <ul className="space-y-4">{status.items.map(item => <li key={`${item.kind}:${item.id}`} className="space-y-2 border-t border-zinc-800 pt-4">
      <h2 className="font-medium text-amber-200">{item.kind === "maintenance" ? "점검" : "장애"} · {item.title}</h2>
      {item.message && <p className="whitespace-pre-wrap text-sm leading-relaxed text-zinc-300">{item.message}</p>}
    </li>)}</ul>
    <a href="https://status.riotgames.com/lol?region=kr&locale=ko_KR" className="inline-flex min-h-11 items-center text-sm text-sky-300 underline">Riot 공식 서버 상태</a>
    <LolLegalNotice />
  </main>;
}
