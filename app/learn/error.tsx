"use client";

export default function LearnError({ retry }: { error: Error & { digest?: string }; retry: () => void }) {
  return <main className="mx-auto max-w-5xl px-4 py-8 pb-28 text-zinc-100 sm:px-8">
    <h1 className="text-xl font-bold">경기 해설을 불러오지 못했습니다.</h1>
    <p className="mt-2 text-sm text-zinc-400">잠시 뒤 다시 시도해 주세요.</p>
    <button type="button" onClick={retry} className="mt-4 min-h-11 rounded-lg border border-zinc-700 px-4 text-sm">다시 시도</button>
  </main>;
}
