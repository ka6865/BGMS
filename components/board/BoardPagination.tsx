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
      <Link href={currentPage > 1 ? buildPageLink(currentPage - 1) : '#'} aria-label="이전 페이지" aria-disabled={currentPage === 1} className={currentPage === 1 ? 'pointer-events-none opacity-50' : ''}>
        <div className="w-8 h-8 flex items-center justify-center rounded-lg border border-white/10 bg-white/5 text-white/60 hover:bg-white/10 transition-colors">
          <ChevronLeft size={16} />
        </div>
      </Link>

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

      <Link href={currentPage < totalPages ? buildPageLink(currentPage + 1) : '#'} aria-label="다음 페이지" aria-disabled={currentPage >= totalPages} className={currentPage >= totalPages ? 'pointer-events-none opacity-50' : ''}>
        <div className="w-8 h-8 flex items-center justify-center rounded-lg border border-white/10 bg-white/5 text-white/60 hover:bg-white/10 transition-colors">
          <ChevronRight size={16} />
        </div>
      </Link>
    </div>
  );
}
