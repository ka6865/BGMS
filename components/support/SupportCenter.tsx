"use client";

import Link from "next/link";
import { useMemo, useState } from "react";

type Faq = { id: string; category: string; question: string; answer: string };

export default function SupportCenter({
  faqs,
  isAuthenticated,
}: {
  faqs: Faq[];
  isAuthenticated: boolean;
}) {
  const [category, setCategory] = useState("all");
  const [query, setQuery] = useState("");
  const [openId, setOpenId] = useState<string | null>(faqs[0]?.id ?? null);
  const visibleFaqs = useMemo(() => faqs.filter((faq) => (
    (category === "all" || faq.category === category)
    && (!query.trim() || `${faq.question} ${faq.answer}`.toLowerCase().includes(query.trim().toLowerCase()))
  )), [category, faqs, query]);

  return (
    <main className="mx-auto w-full max-w-5xl px-4 py-10 text-white sm:px-6">
      <div className="mb-8 flex flex-col gap-5 rounded-3xl border border-white/10 bg-white/[0.03] p-6 shadow-2xl sm:flex-row sm:items-end sm:justify-between">
        <div>
          <p className="mb-2 text-xs font-bold uppercase tracking-[0.24em] text-amber-400">BGMS Support</p>
          <h1 className="text-3xl font-black tracking-tight">고객센터</h1>
          <p className="mt-2 text-sm text-white/55">자주 묻는 질문을 확인하고, 관리자에게 비공개로 문의하세요.</p>
        </div>
        <div className="flex flex-wrap gap-2">
          {isAuthenticated ? (
            <>
              <Link href="/support/new" className="rounded-xl bg-amber-400 px-4 py-2.5 text-sm font-black text-black hover:bg-amber-300">1:1 문의하기</Link>
              <Link href="/support?tab=my" className="rounded-xl border border-white/15 px-4 py-2.5 text-sm font-bold text-white/80 hover:bg-white/10">내 문의</Link>
            </>
          ) : (
            <Link href="/login?next=/support/new" className="rounded-xl bg-amber-400 px-4 py-2.5 text-sm font-black text-black hover:bg-amber-300">로그인 후 1:1 문의</Link>
          )}
        </div>
      </div>

      <section className="rounded-3xl border border-white/10 bg-[#171717] p-5 sm:p-7">
        <div className="mb-5 flex flex-col gap-3 sm:flex-row">
          <label className="sr-only" htmlFor="faq-search">FAQ 검색</label>
          <input id="faq-search" value={query} onChange={(event) => setQuery(event.target.value)} placeholder="FAQ 검색" className="min-h-11 flex-1 rounded-xl border border-white/10 bg-black/20 px-3 text-sm outline-none focus:border-amber-400/60" />
          <label className="sr-only" htmlFor="faq-category">FAQ 카테고리</label>
          <select id="faq-category" value={category} onChange={(event) => setCategory(event.target.value)} className="min-h-11 rounded-xl border border-white/10 bg-black/20 px-3 text-sm outline-none focus:border-amber-400/60">
            <option value="all">전체</option>
            <option value="stats">전적</option>
            <option value="account">계정</option>
            <option value="community">커뮤니티</option>
            <option value="feature">기능</option>
          </select>
        </div>
        <div className="divide-y divide-white/10">
          {visibleFaqs.map((faq) => {
            const open = openId === faq.id;
            return (
              <div key={faq.id} className="py-1">
                <button type="button" className="flex w-full items-center justify-between gap-4 py-4 text-left text-sm font-bold text-white/90" onClick={() => setOpenId(open ? null : faq.id)} aria-expanded={open}>
                  <span>{faq.question}</span><span className="text-lg text-amber-400">{open ? "−" : "+"}</span>
                </button>
                {open && <p className="whitespace-pre-wrap pb-4 pr-8 text-sm leading-6 text-white/60">{faq.answer}</p>}
              </div>
            );
          })}
          {visibleFaqs.length === 0 && <p className="py-10 text-center text-sm text-white/45">조건에 맞는 FAQ가 없습니다.</p>}
        </div>
      </section>
    </main>
  );
}
