import { Metadata } from 'next';

export const metadata: Metadata = {
  title: "배그 도감 - 무기, 메타 및 탈것 정보",
  description: "배틀그라운드 무기와 탈것의 공식 정보, 패치별 총기 메타를 확인하세요.",
  alternates: {
    canonical: "/weapons",
  },
  openGraph: {
    title: "배그 도감 | BGMS",
    description: "배그 무기와 탈것 정보 및 패치별 메타 리포트를 확인하세요.",
    url: "/weapons",
    type: "website",
  }
};

export default function WeaponsLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return <>{children}</>;
}
