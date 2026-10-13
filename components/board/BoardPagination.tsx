import React from 'react';
import Link from 'next/link';
import { ChevronLeft, ChevronRight } from 'lucide-react';

interface BoardPaginationProps {
  currentPage: number;
  totalPages: number;
  pageNumbers: number[];
  buildPageLink: (page: number) => string;
}

export default function BoardPagination({
  currentPage,
  totalPages,
  pageNumbers,
  buildPageLink
}: BoardPaginationProps) {
  return (
    <div className="flex gap-1 items-center mx-auto md:mx-0">
      {currentPage > 1 ? (
        <Link href={buildPageLink(currentPage - 1)} aria-label="이전 페이지" className="w-8 h-8 flex items-center justify-center rounded-lg border border-white/10 bg-white/5 text-white/60 hover:bg-white/10 transition-colors">
          <ChevronLeft size={16} />
        </Link>
      ) : (
        <span role="link" aria-label="이전 페이지" aria-disabled="true" className="w-8 h-8 flex items-center justify-center rounded-lg border border-white/10 bg-white/5 text-white/60 opacity-50">
          <ChevronLeft size={16} />
        </span>
      )}

      {pageNumbers.map(num => (
        <Link key={num} href={buildPageLink(num)}>
          <div className={`w-8 h-8 flex items-center justify-center rounded-lg text-[13px] transition-colors ${
            currentPage === num 
            ? 'border-[#F2A900] bg-[#F2A900] text-black font-bold' 
            : 'border-white/10 bg-white/5 text-white/60 hover:bg-white/10'
          }`}>
            {num}
          </div>
        </Link>
      ))}

      {currentPage < totalPages ? (
        <Link href={buildPageLink(currentPage + 1)} aria-label="다음 페이지" className="w-8 h-8 flex items-center justify-center rounded-lg border border-white/10 bg-white/5 text-white/60 hover:bg-white/10 transition-colors">
          <ChevronRight size={16} />
        </Link>
      ) : (
        <span role="link" aria-label="다음 페이지" aria-disabled="true" className="w-8 h-8 flex items-center justify-center rounded-lg border border-white/10 bg-white/5 text-white/60 opacity-50">
          <ChevronRight size={16} />
        </span>
      )}
    </div>
  );
}
