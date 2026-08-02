import Link from 'next/link';
import { Compass, ChevronLeft } from 'lucide-react';
import type { Metadata } from 'next';

export const metadata: Metadata = {
  title: '페이지를 찾을 수 없습니다',
  robots: { index: false, follow: false },
};

/**
 * 전역 404 페이지.
 *
 * 기본 Next.js 404 화면은 영문 흰 배경이라 서비스 톤과 맞지 않으므로,
 * 게시글 없음 화면과 같은 안내 구조로 되돌아갈 경로를 함께 제시한다.
 */
export default function NotFound() {
  return (
    <div className="w-full min-h-[calc(100dvh-160px)] bg-[#121212] flex flex-col items-center justify-center p-6 text-center">
      <div className="bg-[#1a1a1a] border border-[#333] p-8 sm:p-10 rounded-2xl shadow-2xl flex flex-col items-center max-w-md w-full">
        <div className="w-16 h-16 bg-[#F2A900]/10 rounded-full flex items-center justify-center mb-6">
          <Compass className="w-8 h-8 text-[#F2A900]" aria-hidden="true" />
        </div>
        <p className="text-[#F2A900] text-xs font-black tracking-widest mb-2">404 NOT FOUND</p>
        <h1 className="text-2xl font-black text-white mb-2">페이지를 찾을 수 없습니다</h1>
        <p className="text-[#999] text-sm leading-relaxed mb-8">
          삭제되었거나 유효하지 않은 주소입니다.
          <br />
          입력하신 주소를 다시 한번 확인해 주세요.
        </p>
        <div className="flex flex-col gap-3 w-full">
          <Link
            href="/maps/erangel"
            className="flex items-center justify-center gap-2 w-full py-4 bg-[#F2A900] text-black font-bold rounded-xl hover:bg-[#d49400] transition-all active:scale-95"
          >
            <ChevronLeft className="w-4 h-4" aria-hidden="true" />
            지도로 돌아가기
          </Link>
          <div className="flex items-center justify-center gap-4 text-xs text-[#999]">
            <Link href="/stats" className="hover:text-[#F2A900] transition-colors py-2">
              AI 전적 검색
            </Link>
            <span aria-hidden="true">·</span>
            <Link href="/board" className="hover:text-[#F2A900] transition-colors py-2">
              커뮤니티
            </Link>
          </div>
        </div>
      </div>
    </div>
  );
}
