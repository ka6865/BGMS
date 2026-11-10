"use client";

import Link from "next/link";
import { useState, type SyntheticEvent } from "react";

// Riot 운영 키 심사 중에 잠긴 LoL 화면 대신 보여 준다. 심사자를 위해 영문 안내를 함께 둔다.
export default function LolPreviewGate({ next, passwordEnabled }: { next: string; passwordEnabled: boolean }) {
  const [open, setOpen] = useState(false);
  const [password, setPassword] = useState("");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState("");

  async function submit(event: SyntheticEvent) {
    event.preventDefault();
    if (pending) return;
    setPending(true);
    setError("");
    try {
      const response = await fetch("/api/lol/preview", {
        method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ password }),
      });
      if (response.ok) {
        // 새 쿠키로 proxy 검사를 다시 받도록 전체 이동한다.
        window.location.assign(next);
        return;
      }
      setError(response.status === 429 ? "시도가 많습니다. 잠시 후 다시 시도해 주세요." : response.status === 401 ? "비밀번호가 맞지 않습니다." : "확인하지 못했습니다. 다시 시도해 주세요.");
    } catch {
      setError("확인하지 못했습니다. 다시 시도해 주세요.");
    }
    setPending(false);
  }

  return (
    <main className="mx-auto flex w-full max-w-xl flex-col gap-6 px-4 py-12 text-zinc-100 sm:py-16">
      <section aria-labelledby="lol-preview-title" className="rounded-2xl border border-zinc-800 bg-zinc-900/60 p-6">
        <span className="inline-flex rounded bg-amber-400/15 px-2 py-0.5 text-xs font-bold text-amber-300 ring-1 ring-amber-400/30">개발 중</span>
        <h1 id="lol-preview-title" className="mt-3 text-xl font-bold">LoL 전적 기능을 준비하고 있습니다</h1>
        <p className="mt-2 text-sm leading-relaxed text-zinc-300">
          전적 검색, 챔피언 통계, 랭킹, 서버 상태는 Riot Games API 운영 키 심사가 끝나면 공개합니다.
        </p>
        <p lang="en" className="mt-2 text-sm leading-relaxed text-zinc-400">
          Match history, champion statistics, rankings and server status are in development while our Riot Games production API key is under review.
        </p>
        <div className="mt-5 flex flex-wrap gap-2">
          <Link href="/lol/kr/aram-mayhem" className="inline-flex min-h-11 items-center rounded-lg bg-amber-400 px-4 text-sm font-bold text-zinc-950 hover:bg-amber-300">
            증바람 증강 보기
          </Link>
          {passwordEnabled && !open && (
            <button type="button" onClick={() => setOpen(true)} className="inline-flex min-h-11 items-center rounded-lg border border-zinc-700 px-4 text-sm font-semibold text-zinc-200 hover:bg-zinc-800">
              테스트하기 <span lang="en" className="ml-1 text-zinc-400">(Test)</span>
            </button>
          )}
        </div>
        {passwordEnabled && open && (
          <form onSubmit={submit} className="mt-5 flex flex-col gap-2">
            <label htmlFor="lol-preview-password" className="text-sm font-semibold text-zinc-200">
              테스트 비밀번호 <span lang="en" className="font-normal text-zinc-400">(Test password)</span>
            </label>
            <div className="flex gap-2">
              <input
                id="lol-preview-password" type="password" autoComplete="current-password" required maxLength={200} autoFocus
                value={password} onChange={(event) => setPassword(event.target.value)}
                aria-invalid={error ? true : undefined} aria-describedby={error ? "lol-preview-error" : undefined}
                className="min-h-11 min-w-0 flex-1 rounded-lg border border-zinc-700 bg-zinc-950 px-3 text-base text-zinc-100 outline-none focus:border-amber-400"
              />
              <button type="submit" disabled={pending} className="min-h-11 shrink-0 rounded-lg bg-zinc-100 px-4 text-sm font-bold text-zinc-950 disabled:opacity-60">
                {pending ? "확인 중" : "확인"}
              </button>
            </div>
            {error && <p id="lol-preview-error" role="alert" className="text-sm text-red-400">{error}</p>}
          </form>
        )}
      </section>
    </main>
  );
}
