import { notFound } from "next/navigation";

// /lol 아래의 없는 주소도 LoL 레이아웃(헤더·푸터·Riot 법적 고지) 안의 404(app/lol/not-found.tsx)로 보낸다.
// 이 경로가 없으면 사이트 전체 404로 가는데, /lol에서는 공통 헤더·푸터를 숨기므로 빈 화면처럼 보인다.
export default function LolUnknownPage(): never {
  notFound();
}
