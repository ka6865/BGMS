"use client";

import { useState } from "react";
import { LOL_AUGMENT_RARITY_LABELS } from "@/lib/lol/augments/catalog";
import type { MayhemPatchNote, MayhemPatchNoteEntry } from "@/lib/lol/augments/patchNotes";

const rarityColors = { prismatic: "text-fuchsia-300", gold: "text-amber-300", silver: "text-zinc-300" } as const;
const chip = (active: boolean) => `min-h-11 rounded-lg border px-3 text-sm font-semibold transition ${active
  ? "border-amber-400 bg-amber-400/10 text-amber-300" : "border-zinc-700 text-zinc-400 hover:text-zinc-100"}`;

// 클라이언트 자료의 부동소수점 오차(0.15000000596…)를 사람이 읽는 값으로 줄인다.
const num = (value: number | null, percent = false) => value === null ? "없음" : percent ? `${Number((value * 100).toPrecision(4))}%` : String(Number(value.toPrecision(4)));

function Name({ entry }: { entry: MayhemPatchNoteEntry }) {
  return <span className="flex min-w-0 flex-wrap items-center gap-x-2">
    <span className="min-w-0 break-words font-semibold">{entry.name}</span>
    {entry.rarity && <span className={`text-xs font-medium ${rarityColors[entry.rarity]}`}>{LOL_AUGMENT_RARITY_LABELS[entry.rarity]}</span>}
  </span>;
}

export default function LolMayhemPatchNotes({ notes }: { notes: MayhemPatchNote[] }) {
  const [patch, setPatch] = useState(notes[0]?.patch ?? "");
  const note = notes.find(n => n.patch === patch) ?? notes[0];
  if (!note) return <p className="mt-6 rounded-lg border border-zinc-800 px-4 py-8 text-center text-sm text-zinc-400">아직 정리된 패치노트가 없습니다.</p>;
  return <section aria-label="증바람 패치노트" className="mt-4">
    {notes.length > 1 && <div role="group" aria-label="패치 선택" className="flex flex-wrap gap-1.5">
      {notes.map(n => <button key={n.patch} type="button" aria-pressed={n.patch === note.patch} className={chip(n.patch === note.patch)} onClick={() => setPatch(n.patch)}>{n.displayPatch}</button>)}
    </div>}
    <p className="mt-3 text-sm text-zinc-300">
      패치 {note.displayPatch}{note.publishedAt && ` · ${new Date(note.publishedAt).toLocaleDateString("ko-KR", { timeZone: "Asia/Seoul" })}`}
      {` · 신규 ${note.added.length} · 변경 ${note.changed.length} · 삭제 ${note.removed.length}`}
      {note.notesUrl && <> · <a href={note.notesUrl} target="_blank" rel="noreferrer" className="text-amber-300 underline underline-offset-2">공식 패치 노트</a></>}
    </p>
    {note.added.length > 0 && <div className="mt-4">
      <h2 className="text-sm font-bold text-emerald-300">신규 증강</h2>
      <ul className="mt-2 grid grid-cols-1 gap-2">{note.added.map(e => <li key={e.name} className="rounded-lg border border-zinc-800 bg-zinc-900/60 p-3 text-sm">
        <Name entry={e} />
        {e.lines.map(line => <p key={line.after} className="mt-1 whitespace-pre-wrap break-words leading-6 text-zinc-300">{line.after}</p>)}
      </li>)}</ul>
    </div>}
    {note.changed.length > 0 && <div className="mt-5">
      <h2 className="text-sm font-bold text-sky-300">변경된 증강</h2>
      <ul className="mt-2 grid grid-cols-1 gap-2">{note.changed.map(e => <li key={e.name} className="rounded-lg border border-zinc-800 bg-zinc-900/60 p-3 text-sm">
        <div className="flex flex-wrap items-center justify-between gap-2"><Name entry={e} /><span className="text-xs text-zinc-500">{e.fields.length ? e.fields.join("·") : "변경"}</span></div>
        {e.lines.length > 0 && <dl className="mt-2 grid gap-2 text-sm leading-6">{e.lines.map(line => <div key={line.after}>
          {line.before && <><dt className="sr-only">이전</dt><dd className="whitespace-pre-wrap break-words text-zinc-500 line-through decoration-zinc-600">{line.before}</dd></>}
          <dt className="sr-only">현재</dt><dd className="whitespace-pre-wrap break-words text-zinc-200">{line.after}</dd>
        </div>)}</dl>}
        {e.lines.length === 0 && e.values.length > 0 && <ul aria-label="세부 값 변경" className="mt-2 grid gap-1 text-sm text-zinc-400">{e.values.map(v => <li key={v.name} className="break-words">
          {v.label ?? <span className="font-mono text-zinc-500">{v.name}</span>} {num(v.before, v.percent)} → <span className="text-zinc-200">{num(v.after, v.percent)}</span>
        </li>)}</ul>}
        {e.lines.length === 0 && e.values.length === 0 && <p className="mt-1 text-xs text-zinc-500">세부 수치를 확인할 수 있는 자료가 없습니다.</p>}
      </li>)}</ul>
    </div>}
    {note.removed.length > 0 && <div className="mt-5">
      <h2 className="text-sm font-bold text-rose-300">삭제·제외된 증강</h2>
      <p className="mt-2 break-words text-sm leading-6 text-zinc-400">{note.removed.map(e => e.name).join(", ")}</p>
    </div>}
    <p className="mt-6 text-xs leading-5 text-zinc-500">게임 클라이언트 자료를 패치별로 비교하고 공식 패치 노트와 대조해 정리했습니다.</p>
  </section>;
}
