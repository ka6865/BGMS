import Link from "next/link";
import { getLolPlatformStatus } from "@/lib/lol/status.server";
import type { LolPlatformStatus } from "@/lib/lol/status";

export function LolStatusBannerContent({ status, admin = false }: { status: LolPlatformStatus; admin?: boolean }) {
  if (!status.items.length) return null;
  return <aside aria-label="LoL 서버 상태 알림" role="status" className="w-full shrink-0 break-words border-b border-amber-900 bg-amber-950/40 px-4 py-3 text-sm text-amber-200">
    <p>{status.stale ? "마지막 확인 시점의 서버 공지" : "LoL 한국 서버 공지"}</p>
    <ul className="mt-1 space-y-1">{status.items.map(item => <li key={`${item.kind}:${item.id}`}>
      {item.kind === "maintenance" ? "점검" : "장애"} · {item.title}
    </li>)}</ul>
    {!admin && <Link href="/lol/kr/status" className="mt-1 inline-flex min-h-11 items-center underline">서버 상태 자세히 보기</Link>}
  </aside>;
}

export default async function LolStatusBanner({ admin = false }: { admin?: boolean }) {
  return <LolStatusBannerContent status={await getLolPlatformStatus()} admin={admin} />;
}
