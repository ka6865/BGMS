"use client";

import LolLegalNotice from "@/components/lol/LolLegalNotice";

export default function LolError({ retry }: { error: Error & { digest?: string }; retry: () => void }) {
  return <main className="h-full overflow-y-auto bg-zinc-950 p-6 text-zinc-100">
    <h1 className="text-xl font-bold">LoL 정보를 불러오지 못했습니다.</h1>
    <button type="button" onClick={retry} className="mt-4 min-h-11 rounded border border-zinc-700 px-4">다시 시도</button>
    <LolLegalNotice />
  </main>;
}
