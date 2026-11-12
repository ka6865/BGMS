'use client';

import Link from 'next/link';
import { CircleAlert } from 'lucide-react';

export default function PostError({ retry }: { error: Error & { digest?: string }; retry: () => void }) {
  return (
    <div role="alert" className="w-full min-h-[calc(100dvh-160px)] bg-[#121212] flex flex-col items-center justify-center p-6 text-center">
      <div className="bg-[#1a1a1a] border border-[#333] p-8 sm:p-10 rounded-2xl shadow-2xl flex flex-col items-center max-w-md w-full">
        <div className="w-16 h-16 bg-red-500/10 rounded-full flex items-center justify-center mb-6">
          <CircleAlert className="w-8 h-8 text-red-500" aria-hidden="true" />
        </div>
        <h1 className="text-xl sm:text-2xl break-keep font-black text-white mb-2">게시글을 불러오지 못했습니다</h1>
        <p className="text-[#999] text-sm break-keep leading-relaxed mb-8">일시적인 문제가 발생했습니다. 잠시 후 다시 시도해 주세요.</p>
        <div className="flex flex-col gap-3 w-full">
          <button type="button" onClick={retry} className="min-h-11 w-full py-4 bg-[#F2A900] text-black font-bold rounded-xl hover:bg-[#d49400] transition-colors">
            다시 시도
          </button>
          <Link href="/board" className="min-h-11 flex items-center justify-center text-[#999] text-xs hover:text-[#F2A900] transition-colors">게시판 목록으로 돌아가기</Link>
        </div>
      </div>
    </div>
  );
}
