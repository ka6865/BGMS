import type { Metadata } from "next";

// 개발·관리용 화면이라 검색 결과에 노출하지 않는다.
export const metadata: Metadata = { robots: { index: false, follow: false } };

export default function Layout({ children }: { children: React.ReactNode }) {
  return children;
}
