import Link from "next/link";
import LolLegalNotice from "@/components/lol/LolLegalNotice";

export default function LolNotFound() {
  return <main className="h-full overflow-y-auto bg-zinc-950 p-6 text-zinc-100">
    <h1 className="text-xl font-bold">LoL 페이지를 찾을 수 없습니다.</h1>
    <Link className="mt-4 inline-block" href="/lol/kr">LoL 검색으로 이동</Link>
    <LolLegalNotice />
  </main>;
}
